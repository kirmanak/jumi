import { byteLength, formatBytes, logDiagnostic, sampleMemory } from "./diagnostics.ts";
import type { OpenCodeRunOptions } from "./git.ts";
import { runOpenCode } from "./git.ts";
import { extractClosingIssueNumbers } from "./gitea_issues.ts";
import { buildPROpenedPrompt } from "./prompt.ts";
import { DEFAULT_MAX_THREAD_BYTES, fitReviewThread, mapReviewThread } from "./review_context.ts";
import type {
  GiteaComment,
  GiteaCommitStatusPayload,
  GiteaIssue,
  GiteaPR,
  GiteaPRFile,
  GiteaRepo,
  ReviewJob,
} from "./types.ts";
import { parseReviewOutput } from "./verdict.ts";
import { checkoutPullRequestWorkspace } from "./workspace.ts";

async function logParentDiag(
  log: (message: string) => void,
  event: string,
  fields: Record<string, string | number | boolean | null | undefined>
): Promise<void> {
  const mem = await sampleMemory(process.pid);
  logDiagnostic(log, event, {
    ...fields,
    parent_rss_bytes: mem.rssBytes,
    parent_rss_h: formatBytes(mem.rssBytes),
    cgroup_bytes: mem.cgroupBytes,
    cgroup_h: formatBytes(mem.cgroupBytes),
  });
}

export interface ReviewApi {
  getRepo(owner: string, repo: string): Promise<GiteaRepo>;
  getPR(owner: string, repo: string, index: number): Promise<GiteaPR>;
  getPRFiles(owner: string, repo: string, index: number): Promise<GiteaPRFile[]>;
  getIssue(owner: string, repo: string, index: number): Promise<GiteaIssue>;
  listIssueComments(owner: string, repo: string, index: number): Promise<GiteaComment[]>;
  findStickyIssueComment(
    owner: string,
    repo: string,
    index: number,
    botUsername: string,
    marker: string
  ): Promise<{ id: number } | undefined>;
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
export type WorkspacePreparer = (opts: {
  workdir: string;
  repo: GiteaRepo;
  pr: GiteaPR;
  giteaUrl: string;
  username: string;
  token: string;
  logger?: (message: string) => void;
}) => Promise<void>;

export interface ReviewOptions {
  api: ReviewApi;
  owner: string;
  repo: string;
  prNumber: number;
  expectedHeadSha?: string;
  model: string;
  workspace: string;
  giteaUrl: string;
  giteaToken: string;
  botUsername: string;
  opencodeConfig?: string;
  home?: string;
  sanitizeOpenCodeEnv?: boolean;
  timeoutMs?: number;
  maxFiles?: number;
  maxPatchBytes?: number;
  maxThreadBytes?: number;
  maxOutputBytes?: number;
  openCodeRunner?: OpenCodeRunner;
  workspacePreparer?: WorkspacePreparer;
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

function statusDescriptionForSkip(result: ReviewResult): string {
  return `Jumi review skipped: ${result.reason ?? "not needed"}`;
}

function statusForResult(
  result: ReviewResult,
  verdict?: { state: GiteaCommitStatusPayload["state"]; description: string }
): { state: GiteaCommitStatusPayload["state"]; description: string } {
  if (result.status === "skipped") {
    if (result.reason === "OpenCode produced no output") {
      return { state: "failure", description: "Incomplete review: no output" };
    }
    return { state: "warning", description: statusDescriptionForSkip(result) };
  }

  return verdict ?? parseReviewOutput("").verdict;
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function loadPrComments(
  api: ReviewApi,
  owner: string,
  repo: string,
  prNumber: number
): Promise<{ comments: GiteaComment[]; note?: string }> {
  try {
    return { comments: await api.listIssueComments(owner, repo, prNumber) };
  } catch (err) {
    return { comments: [], note: `Failed to load PR comments: ${errorMessage(err)}` };
  }
}

async function loadLinkedIssue(
  api: ReviewApi,
  owner: string,
  repo: string,
  id: number
): Promise<{ issue: GiteaIssue; comments: GiteaComment[] } | { note: string }> {
  try {
    const [issue, comments] = await Promise.all([
      api.getIssue(owner, repo, id),
      api.listIssueComments(owner, repo, id),
    ]);
    return { issue, comments };
  } catch (err) {
    return { note: `Failed to load linked issue #${id}: ${errorMessage(err)}` };
  }
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
    const [repoInfo, prFiles, prCommentResult] = await Promise.all([
      opts.api.getRepo(opts.owner, opts.repo),
      opts.api.getPRFiles(opts.owner, opts.repo, pr.number),
      loadPrComments(opts.api, opts.owner, opts.repo, pr.number),
    ]);

    const ids = extractClosingIssueNumbers(pr);
    const linkedResults = await Promise.all(ids.map((id) => loadLinkedIssue(opts.api, opts.owner, opts.repo, id)));
    const notes: string[] = [];
    if (prCommentResult.note) notes.push(prCommentResult.note);
    const linkedIssues: Array<{ issue: GiteaIssue; comments: GiteaComment[] }> = [];
    for (const result of linkedResults) {
      if ("note" in result) {
        notes.push(result.note);
        continue;
      }
      linkedIssues.push({ issue: result.issue, comments: result.comments });
    }
    const prComments = prCommentResult.comments;
    const thread = mapReviewThread({ prComments, linkedIssues });

    const maxFiles = opts.maxFiles ?? 100;
    const maxPatchBytes = opts.maxPatchBytes ?? 500_000;
    const maxThreadBytes = opts.maxThreadBytes ?? DEFAULT_MAX_THREAD_BYTES;
    const rawPatchBytes = prFiles.reduce((sum, file) => sum + (file.patch ? byteLength(file.patch) : 0), 0);
    const { files, notes: fileNotes } = prepareFiles(prFiles, maxFiles, maxPatchBytes);
    notes.push(...fileNotes);
    const includedPatchBytes = files.reduce((sum, file) => sum + (file.patch ? byteLength(file.patch) : 0), 0);
    const reviewLabel = `${repoFullName}#${pr.number}`;

    logDiagnostic(log, "review_files", {
      review: reviewLabel,
      head: reviewedHeadSha,
      files_total: prFiles.length,
      files_included: files.length,
      max_files: maxFiles,
      raw_patch_bytes: rawPatchBytes,
      raw_patch_bytes_h: formatBytes(rawPatchBytes),
      included_patch_bytes: includedPatchBytes,
      included_patch_bytes_h: formatBytes(includedPatchBytes),
      max_patch_bytes: maxPatchBytes,
      notes: notes.length,
    });

    const fitted = fitReviewThread(thread, maxThreadBytes);
    if (fitted.truncated) {
      notes.push(`Thread context truncated to maxThreadBytes (dropped ${fitted.droppedCommentBodies} comment bodies).`);
    }
    logDiagnostic(log, "review_thread", {
      review: reviewLabel,
      pr_comments: fitted.thread.comments.length,
      linked_issues: fitted.thread.linkedIssues.length,
      linked_issue_comments: fitted.thread.linkedIssues.reduce((sum, issue) => sum + issue.comments.length, 0),
      thread_bytes: fitted.threadBytes,
      thread_bytes_h: formatBytes(fitted.threadBytes),
      max_thread_bytes: maxThreadBytes,
      truncated: fitted.truncated,
    });

    const prepareWorkspace = opts.workspacePreparer ?? checkoutPullRequestWorkspace;
    await prepareWorkspace({
      workdir: opts.workspace,
      repo: repoInfo,
      pr,
      giteaUrl: opts.giteaUrl,
      username: opts.botUsername,
      token: opts.giteaToken,
      logger: log,
    });

    const prompt = buildPROpenedPrompt({
      repo: repoInfo,
      pr,
      prFiles: files,
      reviewNotes: notes,
      thread: fitted.thread,
    });

    logDiagnostic(log, "review_prompt", {
      review: reviewLabel,
      prompt_bytes: byteLength(prompt),
      prompt_bytes_h: formatBytes(byteLength(prompt)),
      model: opts.model,
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
      reviewLabel,
      logger: log,
    });

    await logParentDiag(log, "post_opencode", {
      review: reviewLabel,
      output_bytes: byteLength(output),
      output_bytes_h: formatBytes(byteLength(output)),
    });

    if (!output.trim()) {
      const result: ReviewResult = { status: "skipped", reason: "OpenCode produced no output" };
      const { state, description } = statusForResult(result);
      await postReviewStatus(opts, reviewedHeadSha, state, description, pr.html_url);
      return result;
    }

    await logParentDiag(log, "post_fetch_pr", { review: reviewLabel });
    const currentPR = await opts.api.getPR(opts.owner, opts.repo, opts.prNumber);
    const currentSkipReason = skipReasonForPR(currentPR) ?? skipReasonForHeadChange(currentPR, reviewedHeadSha);
    if (currentSkipReason) {
      const result: ReviewResult = { status: "skipped", reason: currentSkipReason };
      const { state, description } = statusForResult(result);
      await postReviewStatus(opts, reviewedHeadSha, state, description, currentPR.html_url);
      return result;
    }

    const marker = markerFor(opts.owner, opts.repo, currentPR.number);
    const parsed = parseReviewOutput(output);
    const body = buildCommentBody(marker, reviewedHeadSha, parsed.comment);
    await logParentDiag(log, "post_find_sticky", {
      review: reviewLabel,
      body_bytes: byteLength(body),
      body_bytes_h: formatBytes(byteLength(body)),
    });
    const existing = await opts.api.findStickyIssueComment(
      opts.owner,
      opts.repo,
      currentPR.number,
      opts.botUsername,
      marker
    );
    await logParentDiag(log, "post_sticky_result", {
      review: reviewLabel,
      sticky_id: existing?.id ?? null,
      sticky_found: Boolean(existing),
    });

    if (existing) {
      await logParentDiag(log, "post_comment_update", { review: reviewLabel, sticky_id: existing.id });
      const updated = await opts.api.updateIssueComment(opts.owner, opts.repo, existing.id, body);
      const result: ReviewResult = { status: "updated", commentId: updated.id };
      const { state, description } = statusForResult(result, parsed.verdict);
      await postReviewStatus(opts, reviewedHeadSha, state, description, currentPR.html_url);
      await logParentDiag(log, "post_review_done", { review: reviewLabel, status: result.status });
      return result;
    }

    await logParentDiag(log, "post_comment_create", { review: reviewLabel });
    const created = await opts.api.createIssueComment(opts.owner, opts.repo, currentPR.number, body);
    const result: ReviewResult = { status: "posted", commentId: created.id };
    const { state, description } = statusForResult(result, parsed.verdict);
    await postReviewStatus(opts, reviewedHeadSha, state, description, currentPR.html_url);
    await logParentDiag(log, "post_review_done", { review: reviewLabel, status: result.status });
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
