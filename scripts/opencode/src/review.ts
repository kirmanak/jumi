import type { OpenCodeRunOptions } from "./git.ts";
import { runOpenCode } from "./git.ts";
import { buildPROpenedPrompt } from "./prompt.ts";
import type { GiteaComment, GiteaCommitStatusPayload, GiteaPR, GiteaPRFile, GiteaRepo, ReviewJob } from "./types.ts";

export interface ReviewApi {
  getRepo(owner: string, repo: string): Promise<GiteaRepo>;
  getPR(owner: string, repo: string, index: number): Promise<GiteaPR>;
  getPRFiles(owner: string, repo: string, index: number): Promise<GiteaPRFile[]>;
  getIssueComments(owner: string, repo: string, index: number): Promise<GiteaComment[]>;
  createIssueComment(owner: string, repo: string, index: number, body: string): Promise<GiteaComment>;
  updateIssueComment(owner: string, repo: string, commentId: number, body: string): Promise<GiteaComment>;
  createCommitStatus(
    owner: string,
    repo: string,
    sha: string,
    status: GiteaCommitStatusPayload
  ): Promise<GiteaCommitStatusPayload>;
}

export type OpenCodeRunner = (prompt: string, opts: OpenCodeRunOptions) => Promise<string>;

export interface ReviewOptions {
  api: ReviewApi;
  owner: string;
  repo: string;
  prNumber: number;
  expectedHeadSha?: string;
  model: string;
  workspace: string;
  botUsername: string;
  opencodeConfig?: string;
  home?: string;
  sanitizeOpenCodeEnv?: boolean;
  timeoutMs?: number;
  maxFiles?: number;
  maxPatchBytes?: number;
  maxOutputBytes?: number;
  openCodeRunner?: OpenCodeRunner;
  logger?: (message: string) => void;
}

export interface ReviewResult {
  status: "posted" | "updated" | "skipped";
  reason?: string;
  commentId?: number;
}

const encoder = new TextEncoder();

function defaultLog(message: string) {
  console.log(`[review] ${message}`);
}

export function reviewJobKey(job: ReviewJob): string {
  return `${job.owner}/${job.repo}#${job.prNumber}:${job.headSha}`;
}

function markerFor(owner: string, repo: string, prNumber: number): string {
  return `<!-- jumi-review:${owner}/${repo}#${prNumber} -->`;
}

function buildCommentBody(marker: string, headSha: string, output: string): string {
  return `${marker}\n### Jumi OpenCode review\n\nReviewed commit: \`${headSha}\`\n\n${output.trim()}`;
}

const CHECK_CONTEXT = "jumi/opencode-review";
const MAX_STATUS_DESCRIPTION_BYTES = 255;

function truncateStatusDescription(description: string): string {
  const bytes = encoder.encode(description);
  if (bytes.byteLength <= MAX_STATUS_DESCRIPTION_BYTES) return description;
  const suffix = "…";
  const budget = MAX_STATUS_DESCRIPTION_BYTES - encoder.encode(suffix).byteLength;
  const chars: string[] = [];
  let used = 0;

  for (const char of description) {
    const charBytes = encoder.encode(char).byteLength;
    if (used + charBytes > budget) break;
    chars.push(char);
    used += charBytes;
  }

  return `${chars.join("").replace(/\p{Mark}+$/u, "")}${suffix}`;
}

async function postReviewStatus(
  opts: ReviewOptions,
  headSha: string,
  state: GiteaCommitStatusPayload["state"],
  description: string,
  targetUrl?: string
): Promise<void> {
  await opts.api.createCommitStatus(opts.owner, opts.repo, headSha, {
    state,
    context: CHECK_CONTEXT,
    description: truncateStatusDescription(description),
    target_url: targetUrl,
  });
}

function statusDescriptionForResult(result: ReviewResult): string {
  if (result.status === "posted") return "Jumi review posted";
  if (result.status === "updated") return "Jumi review updated";
  return `Jumi review skipped: ${result.reason ?? "not needed"}`;
}

function statusStateForResult(result: ReviewResult): GiteaCommitStatusPayload["state"] {
  return result.status === "skipped" ? "warning" : "success";
}

function skipReasonForPR(pr: GiteaPR): string | undefined {
  if (pr.state !== "open") return `PR is ${pr.state}`;
  if (pr.merged) return "PR is already merged";
  if (/\[(skip review|no review)\]/i.test(pr.title) || /^\s*(wip|\[wip\])/i.test(pr.title)) {
    return "PR title disables review";
  }
}

function skipReasonForHeadChange(pr: GiteaPR, expectedHeadSha: string): string | undefined {
  if (pr.head.sha === expectedHeadSha) return undefined;
  return `PR head changed from ${expectedHeadSha} to ${pr.head.sha}`;
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function prepareFiles(
  files: GiteaPRFile[],
  maxFiles: number,
  maxPatchBytes: number
): { files: GiteaPRFile[]; notes: string[] } {
  const notes: string[] = [];
  const selected = files.slice(0, maxFiles);
  if (files.length > selected.length) {
    notes.push(`Only the first ${selected.length} of ${files.length} changed files are included.`);
  }

  let remainingPatchBytes = maxPatchBytes;
  const prepared = selected.map((file) => {
    if (!file.patch) return file;
    const patchBytes = byteLength(file.patch);
    if (patchBytes <= remainingPatchBytes) {
      remainingPatchBytes -= patchBytes;
      return file;
    }

    if (remainingPatchBytes <= 0) {
      notes.push(`Patch for ${file.filename} was omitted because the patch budget was exhausted.`);
      return { ...file, patch: undefined };
    }

    const truncated = new TextDecoder().decode(encoder.encode(file.patch).slice(0, remainingPatchBytes));
    notes.push(`Patch for ${file.filename} was truncated to fit the patch budget.`);
    remainingPatchBytes = 0;
    return { ...file, patch: `${truncated}\n[patch truncated]` };
  });

  return { files: prepared, notes };
}

export async function reviewPullRequest(opts: ReviewOptions): Promise<ReviewResult> {
  const log = opts.logger ?? defaultLog;
  const openCodeRunner = opts.openCodeRunner ?? runOpenCode;
  const repoFullName = `${opts.owner}/${opts.repo}`;
  const pr = await opts.api.getPR(opts.owner, opts.repo, opts.prNumber);
  const reviewedHeadSha = opts.expectedHeadSha ?? pr.head.sha;

  const initialSkipReason = skipReasonForPR(pr) ?? skipReasonForHeadChange(pr, reviewedHeadSha);
  if (initialSkipReason) return { status: "skipped", reason: initialSkipReason };

  await postReviewStatus(opts, reviewedHeadSha, "pending", "Jumi review is running", pr.html_url);

  try {
    log(`Fetching ${repoFullName}#${pr.number} files`);
    const [repoInfo, prFiles] = await Promise.all([
      opts.api.getRepo(opts.owner, opts.repo),
      opts.api.getPRFiles(opts.owner, opts.repo, pr.number),
    ]);

    const { files, notes } = prepareFiles(prFiles, opts.maxFiles ?? 100, opts.maxPatchBytes ?? 500_000);

    const prompt = buildPROpenedPrompt({
      repo: repoInfo,
      pr,
      prFiles: files,
      reviewNotes: notes,
    });

    log(`Running OpenCode for ${repoFullName}#${pr.number}`);
    const output = await openCodeRunner(prompt, {
      model: opts.model,
      workdir: opts.workspace,
      configPath: opts.opencodeConfig,
      home: opts.home,
      sanitizeEnv: opts.sanitizeOpenCodeEnv,
      timeoutMs: opts.timeoutMs,
      maxOutputBytes: opts.maxOutputBytes,
    });

    if (!output.trim()) {
      const result: ReviewResult = { status: "skipped", reason: "OpenCode produced no output" };
      await postReviewStatus(
        opts,
        reviewedHeadSha,
        statusStateForResult(result),
        statusDescriptionForResult(result),
        pr.html_url
      );
      return result;
    }

    const currentPR = await opts.api.getPR(opts.owner, opts.repo, opts.prNumber);
    const currentSkipReason = skipReasonForPR(currentPR) ?? skipReasonForHeadChange(currentPR, reviewedHeadSha);
    if (currentSkipReason) {
      const result: ReviewResult = { status: "skipped", reason: currentSkipReason };
      await postReviewStatus(
        opts,
        reviewedHeadSha,
        statusStateForResult(result),
        statusDescriptionForResult(result),
        currentPR.html_url
      );
      return result;
    }

    const marker = markerFor(opts.owner, opts.repo, currentPR.number);
    const body = buildCommentBody(marker, reviewedHeadSha, output);
    const comments = await opts.api.getIssueComments(opts.owner, opts.repo, currentPR.number);
    const existing = comments.find(
      (comment) => comment.user.login === opts.botUsername && comment.body.includes(marker)
    );

    if (existing) {
      const updated = await opts.api.updateIssueComment(opts.owner, opts.repo, existing.id, body);
      const result: ReviewResult = { status: "updated", commentId: updated.id };
      await postReviewStatus(
        opts,
        reviewedHeadSha,
        statusStateForResult(result),
        statusDescriptionForResult(result),
        currentPR.html_url
      );
      return result;
    }

    const created = await opts.api.createIssueComment(opts.owner, opts.repo, currentPR.number, body);
    const result: ReviewResult = { status: "posted", commentId: created.id };
    await postReviewStatus(
      opts,
      reviewedHeadSha,
      statusStateForResult(result),
      statusDescriptionForResult(result),
      currentPR.html_url
    );
    return result;
  } catch (err) {
    await postReviewStatus(
      opts,
      reviewedHeadSha,
      "failure",
      `Jumi review failed: ${err instanceof Error ? err.message : String(err)}`,
      pr.html_url
    );
    throw err;
  }
}
