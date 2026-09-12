import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { byteLength, formatBytes, logDiagnostic, sampleMemory } from "./diagnostics.ts";
import { type Engine, resolveEngine, throwIfEngineFailed } from "./engine.ts";
import { openCodeEngine } from "./git.ts";
import { extractClosingIssueNumbers } from "./gitea_issues.ts";
import type {
  CheckPayload,
  Comment,
  CreatePullReviewComment,
  InlineComment,
  Pull,
  PullFile,
  PullReview,
  Repo,
  ReviewApi,
  Task,
} from "./ports.ts";
import { buildIncompleteWritePrompt, buildPROpenedPrompt } from "./prompt.ts";
import {
  CONTRACT_PATH,
  contractEnvIssues,
  formatContractEnvIssue,
  parseContract,
  REVIEWER_LOADER_PATH,
  WORKER_LOADER_PATH,
} from "./release.ts";
import { DEFAULT_MAX_THREAD_BYTES, fitReviewThread, mapReviewThread } from "./review_context.ts";
import {
  appendStuckFingerprint,
  evaluateStuck,
  fingerprintError,
  fingerprintReviewArtifact,
  readStuckState,
  reviewStuckStatePath,
  stuckComment,
  upsertStuckComment,
  upsertStuckText,
} from "./stuck.ts";
import type { ReviewJob } from "./types.ts";
import { findingFingerprint, parseReviewFindings, parseReviewOutput, stripFindingLines } from "./verdict.ts";
import {
  checkoutPullRequestWorkspace,
  type GitAuthResolver,
  type GitRunner,
  resolveGitAuth,
  runGit,
} from "./workspace.ts";

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

export type { ReviewApi } from "./ports.ts";

export type OpenCodeRunner = Engine;
export type WorkspacePreparer = (opts: {
  workdir: string;
  repo: Repo;
  pr: Pull;
  giteaUrl: string;
  username: string;
  token: string;
  embedTokenInUrl?: boolean;
  authorName?: string;
  authorEmail?: string;
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
  gitAuthResolver?: GitAuthResolver;
  home?: string;
  sanitizeOpenCodeEnv?: boolean;
  timeoutMs?: number;
  maxFiles?: number;
  maxPatchBytes?: number;
  maxThreadBytes?: number;
  maxOutputBytes?: number;
  engine?: Engine;
  openCodeRunner?: Engine;
  workspacePreparer?: WorkspacePreparer;
  gitRunner?: GitRunner;
  logger?: (message: string) => void;
  persistResult?: (result: PersistReviewResult) => Promise<void>;
  abortSignal?: AbortSignal;
  jobId?: string;
  maxIncompleteRetries?: number;
}

export type PersistReviewResult =
  | { kind: "markdown"; markdown: string }
  | { kind: "skip"; reason: string }
  | { kind: "error"; error: string };

export interface ReviewResult {
  status: "posted" | "updated" | "skipped";
  reason?: string;
  commentId?: number;
}

export interface PublishReviewOptions {
  api: ReviewApi;
  owner: string;
  repo: string;
  prNumber: number;
  expectedHeadSha: string;
  botUsername: string;
  resultMarkdown?: string | null;
  resultReason?: string | null;
  error?: string | null;
  logger?: (message: string) => void;
}

const encoder = new TextEncoder();

function defaultLog(message: string) {
  console.log(`[review] ${message}`);
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const err = new Error("cancelled");
  err.name = "AbortError";
  throw err;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message === "cancelled");
}

export function reviewJobKey(job: ReviewJob): string {
  return `${job.owner}/${job.repo}#${job.prNumber}:${job.headSha}`;
}

function markerFor(owner: string, repo: string, prNumber: number): string {
  return `<!-- jumi-review:${owner}/${repo}#${prNumber} -->`;
}

function buildCommentBody(marker: string, headSha: string, output: string, checkLine?: string): string {
  const body = `${marker}\n### Jumi OpenCode review\n\nReviewed commit: \`${headSha}\`\n\n${output.trim()}`;
  if (!checkLine) return body;
  return `${body.trimEnd()}\n\n${checkLine}`;
}

function needsSingleFilePath(text: string): boolean {
  for (const original of text.split(/\r?\n/)) {
    const line = original.trim().replace(/^(?:[-*]|\d+\.)\s+/, "");
    if (/^L\d+:\s+\S/.test(line)) return true;
  }
  return false;
}

async function resolveSingleFilePath(
  api: ReviewApi,
  owner: string,
  repo: string,
  prNumber: number,
  log: (message: string) => void
): Promise<string | undefined> {
  try {
    const files = await api.getPRFiles(owner, repo, prNumber);
    const names = [...new Set(files.map((file) => file.filename).filter((name) => typeof name === "string" && name))];
    if (names.length === 1) return names[0];
  } catch (err) {
    log(`inline single-file path unavailable: ${errorMessage(err)}`);
  }
  return undefined;
}

function isPendingPullReview(review: PullReview): boolean {
  const blob = `${review.state ?? ""} ${review.type ?? ""}`.toLowerCase();
  return blob.includes("pending");
}

function isBotPullReview(review: PullReview, botUsername: string): boolean {
  const login = review.user?.login;
  if (!login) return false;
  return login.toLowerCase() === botUsername.toLowerCase();
}

type PullReviewEvent = "APPROVED" | "REQUEST_CHANGES" | "COMMENT";

function loginEquals(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  return left.toLowerCase() === right.toLowerCase();
}

function reviewEventForVerdict(
  state: "success" | "failure",
  prAuthor: string | undefined,
  botUsername: string
): PullReviewEvent {
  if (loginEquals(prAuthor, botUsername)) return "COMMENT";
  return state === "success" ? "APPROVED" : "REQUEST_CHANGES";
}

function isSelfReviewRejection(err: unknown, prAuthor: string | undefined, botUsername: string): boolean {
  if (loginEquals(prAuthor, botUsername)) return true;
  const message = errorMessage(err).toLowerCase();
  return /own pull|not allowed to (?:approve|reject|review)|author of (?:the )?pull|poster of (?:the )?pull/.test(
    message
  );
}

function isResolvedInline(comment: InlineComment): boolean {
  return comment.resolved === true || comment.resolver != null;
}

function commentFingerprint(comment: { path?: string; body?: string | null }, marker: string): string | undefined {
  if (!comment.path) return undefined;
  if (!(comment.body ?? "").includes(marker)) return undefined;
  const text = findingFingerprint(comment.path, comment.body ?? "");
  return text.endsWith("\n") ? undefined : text;
}

function isPendingInline(comment: InlineComment, reviews: PullReview[]): boolean {
  const reviewId = comment.pull_request_review_id;
  if (reviewId == null) return false;
  const review = reviews.find((item) => item.id === reviewId);
  return review != null && isPendingPullReview(review);
}

async function submitPendingBotReviews(opts: {
  api: ReviewApi;
  owner: string;
  repo: string;
  prNumber: number;
  marker: string;
  botUsername: string;
  log: (message: string) => void;
}): Promise<boolean> {
  let submitted = false;
  try {
    const reviews = await opts.api.listPullReviews(opts.owner, opts.repo, opts.prNumber);
    for (const review of reviews) {
      if (!isPendingPullReview(review) || !isBotPullReview(review, opts.botUsername)) continue;
      try {
        await opts.api.submitPullReview(opts.owner, opts.repo, opts.prNumber, review.id, opts.marker);
        submitted = true;
      } catch (err) {
        opts.log(`pending review ${review.id} not submitted: ${errorMessage(err)}`);
      }
    }
  } catch (err) {
    opts.log(`pending reviews unavailable: ${errorMessage(err)}`);
  }
  return submitted;
}

async function submitPendingAndRefreshPosted(
  opts: {
    api: ReviewApi;
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    marker: string;
    botUsername: string;
    log: (message: string) => void;
  },
  posted: Set<string>,
  attempted: CreatePullReviewComment[],
  existingIds: Set<number>
): Promise<void> {
  const submitted = await submitPendingBotReviews(opts);

  let leftover: InlineComment[] = [];
  try {
    leftover = await opts.api.listPullReviewComments(opts.owner, opts.repo, opts.prNumber);
  } catch (err) {
    opts.log(`existing inlines unavailable: ${errorMessage(err)}`);
  }
  let reviews: PullReview[] = [];
  try {
    reviews = await opts.api.listPullReviews(opts.owner, opts.repo, opts.prNumber);
  } catch (err) {
    opts.log(`existing reviews unavailable: ${errorMessage(err)}`);
  }

  for (const key of leftoverAttemptedFingerprints(leftover, attempted, opts.marker, existingIds, reviews, submitted)) {
    posted.add(key);
  }
}

async function reconcileReviewInlines(opts: {
  api: ReviewApi;
  owner: string;
  repo: string;
  prNumber: number;
  marker: string;
  findings: Array<{ path: string; body: string }>;
  existing: InlineComment[];
  reviews: PullReview[];
  log: (message: string) => void;
}): Promise<Set<string>> {
  const current = new Set(opts.findings.map((finding) => findingFingerprint(finding.path, finding.body)));
  const byFingerprint = new Map<string, InlineComment[]>();
  for (const comment of opts.existing) {
    const fingerprint = commentFingerprint(comment, opts.marker);
    if (!fingerprint) continue;
    const list = byFingerprint.get(fingerprint) ?? [];
    list.push(comment);
    byFingerprint.set(fingerprint, list);
  }

  const open = new Set<string>();
  for (const [fingerprint, comments] of byFingerprint) {
    const published = comments.filter((comment) => !isPendingInline(comment, opts.reviews));
    const unresolved = published.filter((comment) => !isResolvedInline(comment));
    if (!current.has(fingerprint)) {
      for (const comment of comments.filter((item) => !isResolvedInline(item))) {
        try {
          await opts.api.resolvePullComment(opts.owner, opts.repo, comment.id);
        } catch (err) {
          opts.log(`resolve skipped ${comment.id}: ${errorMessage(err)}`);
        }
      }
      continue;
    }
    if (unresolved.length > 0) {
      open.add(fingerprint);
      continue;
    }
    if (published.length === 0) continue;
    const latest = published[published.length - 1];
    try {
      await opts.api.unresolvePullComment(opts.owner, opts.repo, latest.id);
      open.add(fingerprint);
    } catch (err) {
      opts.log(`unresolve skipped ${latest.id}: ${errorMessage(err)}`);
    }
  }
  return open;
}

async function postPullReview(opts: {
  api: ReviewApi;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  marker: string;
  comment: string;
  botUsername: string;
  prAuthor: string | undefined;
  event: PullReviewEvent;
  body: string;
  checkLine?: string;
  singleFilePath?: string;
  log: (message: string) => void;
}): Promise<boolean> {
  const findings = parseReviewFindings(opts.comment, { singleFilePath: opts.singleFilePath });

  await submitPendingBotReviews(opts);

  let existing: InlineComment[] = [];
  try {
    existing = await opts.api.listPullReviewComments(opts.owner, opts.repo, opts.prNumber);
  } catch (err) {
    opts.log(`existing inlines unavailable: ${errorMessage(err)}`);
  }
  let reviews: PullReview[] = [];
  try {
    reviews = await opts.api.listPullReviews(opts.owner, opts.repo, opts.prNumber);
  } catch (err) {
    opts.log(`existing reviews unavailable: ${errorMessage(err)}`);
  }
  const existingIds = new Set(existing.map((comment) => comment.id));

  const posted = await reconcileReviewInlines({
    api: opts.api,
    owner: opts.owner,
    repo: opts.repo,
    prNumber: opts.prNumber,
    marker: opts.marker,
    findings,
    existing,
    reviews,
    log: opts.log,
  });

  const comments: CreatePullReviewComment[] = [];
  const queued = new Set<string>();
  for (const finding of findings) {
    const fingerprint = findingFingerprint(finding.path, finding.body);
    if (posted.has(fingerprint) || queued.has(fingerprint)) continue;
    queued.add(fingerprint);
    comments.push({
      path: finding.path,
      new_position: finding.line,
      body: `${finding.body}\n\n${opts.marker}`,
    });
  }

  const create = (event: PullReviewEvent, reviewComments: CreatePullReviewComment[], reviewBody = opts.body) =>
    opts.api.createPullReview(opts.owner, opts.repo, opts.prNumber, {
      commit_id: opts.headSha,
      event,
      ...(reviewBody ? { body: reviewBody } : {}),
      ...(reviewComments.length > 0 ? { comments: reviewComments } : {}),
    });

  const createWithFallback = async (
    event: PullReviewEvent,
    reviewComments: CreatePullReviewComment[],
    reviewBody?: string
  ): Promise<PullReviewEvent> => {
    const post = (ev: PullReviewEvent) =>
      reviewBody === undefined ? create(ev, reviewComments) : create(ev, reviewComments, reviewBody);
    try {
      await post(event);
      return event;
    } catch (err) {
      if (event !== "COMMENT" && isSelfReviewRejection(err, opts.prAuthor, opts.botUsername)) {
        opts.log(`review event ${event} rejected as self-review, falling back to COMMENT`);
        await post("COMMENT");
        return "COMMENT";
      }
      throw err;
    }
  };

  try {
    await createWithFallback(opts.event, comments);
    return true;
  } catch (err) {
    if (comments.length === 0) {
      opts.log(`review event skipped: ${errorMessage(err)}`);
      return false;
    }
    opts.log(`batch inlines rejected, retrying individually: ${errorMessage(err)}`);
    await submitPendingAndRefreshPosted(opts, posted, comments, existingIds);
    for (const comment of comments) {
      const fingerprint = commentFingerprint(comment, opts.marker);
      if (fingerprint && posted.has(fingerprint)) continue;
      try {
        await create("COMMENT", [comment], "");
        if (fingerprint) posted.add(fingerprint);
      } catch (inner) {
        await submitPendingAndRefreshPosted(opts, posted, comments, existingIds);
        if (fingerprint && posted.has(fingerprint)) continue;
        opts.log(`inline skipped ${comment.path}:${comment.new_position}: ${errorMessage(inner)}`);
      }
    }
    try {
      await createWithFallback(
        opts.event,
        [],
        buildCommentBody(
          opts.marker,
          opts.headSha,
          stripFindingLines(opts.comment, { singleFilePath: opts.singleFilePath, posted }),
          opts.checkLine
        )
      );
      return true;
    } catch (eventErr) {
      opts.log(`review event skipped: ${errorMessage(eventErr)}`);
      return false;
    }
  }
}

function leftoverAttemptedFingerprints(
  comments: InlineComment[],
  attempted: CreatePullReviewComment[],
  marker: string,
  existingIds: Set<number>,
  reviews: PullReview[],
  submitted: boolean
): Set<string> {
  const attemptedKeys = new Set(
    attempted.flatMap((comment) => {
      const key = commentFingerprint(comment, marker);
      return key ? [key] : [];
    })
  );
  return new Set(
    comments.flatMap((comment) => {
      if (existingIds.has(comment.id)) return [];
      const key = commentFingerprint(comment, marker);
      if (!key || !attemptedKeys.has(key)) return [];
      if (submitted) return [key];
      const reviewId = comment.pull_request_review_id;
      const review = reviewId == null ? undefined : reviews.find((item) => item.id === reviewId);
      if (review && !isPendingPullReview(review)) return [key];
      return [];
    })
  );
}

const CHECK_CONTEXT = "jumi/opencode-review";
const MAX_STATUS_DESCRIPTION_BYTES = 255;
const REVIEW_ARTIFACT = "JUMI_REVIEW.md";
const DEFAULT_MAX_OUTPUT_BYTES = 80_000;
export const MAX_INCOMPLETE_RETRIES = 2;
export const INCOMPLETE_REVIEW_STUCK = "stuck: incomplete review";

function unquotePorcelainPath(path: string): string {
  let value = path;
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1).replace(/\\([n"\\])/g, (_, ch: string) => (ch === "n" ? "\n" : ch));
  }
  if (value.endsWith("/")) value = value.slice(0, -1);
  return value;
}

function porcelainPaths(line: string): string[] {
  if (line.length < 4) return [unquotePorcelainPath(line)];
  const rest = line.slice(3);
  const arrow = " -> ";
  const idx = rest.indexOf(arrow);
  const parts = idx === -1 ? [rest] : [rest.slice(0, idx), rest.slice(idx + arrow.length)];
  return parts.map(unquotePorcelainPath);
}

function isReviewEngineTempPath(path: string): boolean {
  return path === ".jumi-tmp" || path.startsWith(".jumi-tmp/");
}

function porcelainAllowsOnlyReviewArtifact(porcelain: string): boolean {
  for (const line of porcelain.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (porcelainPaths(line).some((path) => path !== REVIEW_ARTIFACT && !isReviewEngineTempPath(path))) return false;
  }
  return true;
}

async function hasOpenCodeSession(workspace: string): Promise<boolean> {
  try {
    const info = await lstat(join(workspace, ".jumi-tmp", "opencode-session.db"));
    return info.isFile();
  } catch {
    return false;
  }
}

function porcelainIncludesReviewArtifact(porcelain: string): boolean {
  for (const line of porcelain.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (porcelainPaths(line).some((path) => path === REVIEW_ARTIFACT)) return true;
  }
  return false;
}

type ReviewArtifactRead = { status: "ok"; content: string } | { status: "missing" } | { status: "too_large" };

async function readReviewArtifact(worktree: string, maxOutputBytes: number): Promise<ReviewArtifactRead> {
  const path = join(worktree, REVIEW_ARTIFACT);
  try {
    const info = await lstat(path);
    if (!info.isFile()) return { status: "missing" };
    if (info.size > maxOutputBytes) return { status: "too_large" };
    return { status: "ok", content: await readFile(path, "utf8") };
  } catch {
    return { status: "missing" };
  }
}

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
  api: ReviewApi,
  owner: string,
  repo: string,
  headSha: string,
  state: CheckPayload["state"],
  description: string,
  targetUrl?: string
): Promise<void> {
  await api.createCommitStatus(owner, repo, headSha, {
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
  verdict?: { state: CheckPayload["state"]; description: string }
): { state: CheckPayload["state"]; description: string } {
  if (result.status === "skipped") {
    if (result.reason?.startsWith("Incomplete review:")) {
      return { state: "failure", description: result.reason };
    }
    return { state: "warning", description: statusDescriptionForSkip(result) };
  }

  return verdict ?? parseReviewOutput("").verdict;
}

export function isPersonalJumiRepo(owner: string, repo: string): boolean {
  return owner === "personal" && repo === "jumi";
}

export function applyContractEnvGate(markdown: string, findings: string[]): string {
  if (findings.length === 0) return markdown;
  const parsed = parseReviewOutput(markdown);
  const lines = findings.map((finding) => `deploy/contract.md:1: 🟡 risk: ${finding}.`);
  const comment = [parsed.comment.trim(), lines.join("\n")].filter(Boolean).join("\n\n");
  return `${comment}\n<!-- jumi-check: failure; contract env drift -->\n`;
}

async function gatePersonalJumiContractEnv(
  owner: string,
  repo: string,
  workspace: string,
  markdown: string
): Promise<string> {
  if (!isPersonalJumiRepo(owner, repo)) return markdown;
  try {
    const [contractMd, reviewerSrc, workerSrc] = await Promise.all([
      readFile(join(workspace, CONTRACT_PATH), "utf8"),
      readFile(join(workspace, REVIEWER_LOADER_PATH), "utf8"),
      readFile(join(workspace, WORKER_LOADER_PATH), "utf8"),
    ]);
    const issues = contractEnvIssues(parseContract(contractMd), reviewerSrc, workerSrc);
    return applyContractEnvGate(markdown, issues.map(formatContractEnvIssue));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return applyContractEnvGate(markdown, [`failed to parse loader env against deploy/contract.md: ${message}`]);
  }
}

function skipReasonForPR(pr: Pull): string | undefined {
  if (pr.state !== "open") return `PR is ${pr.state}`;
  if (pr.merged) return "PR is already merged";
  if (/\[(skip review|no review)\]/i.test(pr.title) || /^\s*(wip|\[wip\])/i.test(pr.title)) {
    return "PR title disables review";
  }
}

export function skipReasonForHeadChange(pr: Pull, expectedHeadSha: string): string | undefined {
  if (pr.head.sha === expectedHeadSha) return undefined;
  return `PR head changed from ${expectedHeadSha} to ${pr.head.sha}`;
}

export function isTerminalSkipReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return reason.startsWith("Incomplete review:") || reason.startsWith("PR head changed from ");
}

function prepareFiles(
  files: PullFile[],
  maxFiles: number,
  maxPatchBytes: number
): { files: PullFile[]; notes: string[] } {
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
): Promise<{ comments: Comment[]; note?: string }> {
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
): Promise<{ issue: Task; comments: Comment[] } | { note: string }> {
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

export async function publishReviewResult(opts: PublishReviewOptions): Promise<ReviewResult> {
  const log = opts.logger ?? defaultLog;
  const pr = await opts.api.getPR(opts.owner, opts.repo, opts.prNumber);
  const reviewLabel = `${opts.owner}/${opts.repo}#${opts.prNumber}`;
  const skipReason = skipReasonForPR(pr) ?? skipReasonForHeadChange(pr, opts.expectedHeadSha);
  if (skipReason) {
    const result: ReviewResult = { status: "skipped", reason: skipReason };
    const { state, description } = statusForResult(result);
    await postReviewStatus(opts.api, opts.owner, opts.repo, opts.expectedHeadSha, state, description, pr.html_url);
    return result;
  }

  if (opts.error && !opts.resultMarkdown) {
    await postReviewStatus(opts.api, opts.owner, opts.repo, opts.expectedHeadSha, "failure", opts.error, pr.html_url);
    return { status: "skipped", reason: opts.error };
  }

  if (!opts.resultMarkdown) {
    const reason = opts.resultReason ?? "Incomplete review: no output";
    const result: ReviewResult = { status: "skipped", reason };
    if (reason === "Incomplete review: no output") {
      await upsertStuckText(opts.api, opts.owner, opts.repo, pr.number, opts.botUsername, INCOMPLETE_REVIEW_STUCK);
    }
    const { state, description } = statusForResult(result);
    await postReviewStatus(opts.api, opts.owner, opts.repo, opts.expectedHeadSha, state, description, pr.html_url);
    return result;
  }

  const marker = markerFor(opts.owner, opts.repo, pr.number);
  const parsed = parseReviewOutput(opts.resultMarkdown);
  const singleFilePath = needsSingleFilePath(parsed.comment)
    ? await resolveSingleFilePath(opts.api, opts.owner, opts.repo, pr.number, log)
    : undefined;
  const writeup = buildCommentBody(
    marker,
    opts.expectedHeadSha,
    stripFindingLines(parsed.comment, { singleFilePath }),
    parsed.checkLine
  );
  const stickyBody = buildCommentBody(marker, opts.expectedHeadSha, parsed.comment, parsed.checkLine);

  let result: ReviewResult | undefined;
  if (!parsed.verdict.incomplete) {
    try {
      const landed = await postPullReview({
        api: opts.api,
        owner: opts.owner,
        repo: opts.repo,
        prNumber: pr.number,
        headSha: opts.expectedHeadSha,
        marker,
        comment: parsed.comment,
        botUsername: opts.botUsername,
        prAuthor: pr.user?.login,
        event: reviewEventForVerdict(parsed.verdict.state, pr.user?.login, opts.botUsername),
        body: writeup,
        checkLine: parsed.checkLine,
        singleFilePath,
        log,
      });
      if (landed) result = { status: "posted" };
    } catch (err) {
      log(`pull review not posted: ${errorMessage(err)}`);
    }
  }

  if (!result) {
    await logParentDiag(log, "post_find_sticky", {
      review: reviewLabel,
      body_bytes: byteLength(stickyBody),
      body_bytes_h: formatBytes(byteLength(stickyBody)),
    });
    const existing = await opts.api.findStickyIssueComment(opts.owner, opts.repo, pr.number, opts.botUsername, marker);
    await logParentDiag(log, "post_sticky_result", {
      review: reviewLabel,
      sticky_id: existing?.id ?? null,
      sticky_found: Boolean(existing),
    });
    if (existing) {
      await logParentDiag(log, "post_comment_update", { review: reviewLabel, sticky_id: existing.id });
      const updated = await opts.api.updateIssueComment(opts.owner, opts.repo, existing.id, stickyBody);
      result = { status: "updated", commentId: updated.id };
    } else {
      await logParentDiag(log, "post_comment_create", { review: reviewLabel });
      const created = await opts.api.createIssueComment(opts.owner, opts.repo, pr.number, stickyBody);
      result = { status: "posted", commentId: created.id };
    }
  }

  const { state, description } = statusForResult(result, parsed.verdict);
  await postReviewStatus(opts.api, opts.owner, opts.repo, opts.expectedHeadSha, state, description, pr.html_url);
  await logParentDiag(log, "post_review_done", { review: reviewLabel, status: result.status });
  return result;
}

export async function reviewPullRequest(opts: ReviewOptions): Promise<ReviewResult> {
  const log = opts.logger ?? defaultLog;
  const engine = resolveEngine(opts, openCodeEngine);
  throwIfAborted(opts.abortSignal);
  const repoFullName = `${opts.owner}/${opts.repo}`;
  const pr = await opts.api.getPR(opts.owner, opts.repo, opts.prNumber);
  const reviewedHeadSha = opts.expectedHeadSha ?? pr.head.sha;

  const initialSkipReason = skipReasonForPR(pr) ?? skipReasonForHeadChange(pr, reviewedHeadSha);
  if (initialSkipReason) return { status: "skipped", reason: initialSkipReason };

  if (opts.home) {
    const stuckPath = reviewStuckStatePath(opts.home, opts.owner, opts.repo, opts.prNumber);
    const stuckReason = evaluateStuck((await readStuckState(stuckPath)).fingerprints);
    if (stuckReason) {
      await opts.persistResult?.({ kind: "skip", reason: stuckComment(stuckReason) });
      await upsertStuckComment(opts.api, opts.owner, opts.repo, opts.prNumber, opts.botUsername, stuckReason);
      return { status: "skipped", reason: stuckComment(stuckReason) };
    }
  }

  await postReviewStatus(
    opts.api,
    opts.owner,
    opts.repo,
    reviewedHeadSha,
    "pending",
    "Jumi review is running",
    pr.html_url
  );

  let persisted = false;
  let persistFailed = false;
  const persistOutcome = async (result: PersistReviewResult): Promise<void> => {
    if (!opts.persistResult) return;
    try {
      await opts.persistResult(result);
      persisted = true;
    } catch (err) {
      persistFailed = true;
      throw err;
    }
  };
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
    const linkedIssues: Array<{ issue: Task; comments: Comment[] }> = [];
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
    const gitAuth = await resolveGitAuth(opts);
    await prepareWorkspace({
      workdir: opts.workspace,
      repo: repoInfo,
      pr,
      giteaUrl: opts.giteaUrl,
      username: gitAuth.username,
      token: gitAuth.token,
      embedTokenInUrl: gitAuth.embedTokenInUrl,
      authorName: gitAuth.authorName,
      authorEmail: gitAuth.authorEmail,
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

    const git = opts.gitRunner ?? runGit;
    const gitCmdEnv: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      GIT_TERMINAL_PROMPT: "0",
    };
    let taskTracked = false;
    try {
      taskTracked =
        (await git(["ls-files", "--", "JUMI_TASK.md"], { cwd: opts.workspace, env: gitCmdEnv })).trim() !== "";
    } catch {
      taskTracked = false;
    }

    const restoreTaskFile = async () => {
      if (taskTracked) {
        await git(["checkout", "--", "JUMI_TASK.md"], { cwd: opts.workspace, env: gitCmdEnv });
      } else {
        await rm(join(opts.workspace, "JUMI_TASK.md"), { force: true }).catch(() => undefined);
      }
    };

    const runOpenCode = async (extra?: { prompt: string; continueSession: boolean }) => {
      throwIfAborted(opts.abortSignal);
      await writeFile(join(opts.workspace, "JUMI_TASK.md"), extra?.prompt ?? prompt);
      log(`Running OpenCode for ${repoFullName}#${pr.number}`);
      const engineResult = await engine({
        model: opts.model,
        workdir: opts.workspace,
        home: opts.home,
        sanitizeEnv: opts.sanitizeOpenCodeEnv,
        timeoutMs: opts.timeoutMs,
        maxOutputBytes: opts.maxOutputBytes,
        reviewLabel,
        logger: log,
        abortSignal: opts.abortSignal,
        ...(extra?.continueSession ? { continueSession: true } : {}),
        trace: {
          kind: "review",
          owner: opts.owner,
          repo: opts.repo,
          sha: reviewedHeadSha,
          jobId: opts.jobId,
        },
      });
      throwIfEngineFailed(engineResult);

      await logParentDiag(log, "post_opencode", {
        review: reviewLabel,
        output_bytes: byteLength(engineResult.stdout ?? ""),
        output_bytes_h: formatBytes(byteLength(engineResult.stdout ?? "")),
      });

      await restoreTaskFile();
      return engineResult;
    };

    let lastStdout = (await runOpenCode()).stdout;
    const artifactPath = join(opts.workspace, REVIEW_ARTIFACT);
    const persistSkipAndStatus = async (
      reason: string,
      htmlUrl?: string,
      stuckText?: string
    ): Promise<ReviewResult> => {
      const result: ReviewResult = { status: "skipped", reason };
      await persistOutcome({ kind: "skip", reason });
      if (stuckText) {
        await upsertStuckText(opts.api, opts.owner, opts.repo, opts.prNumber, opts.botUsername, stuckText);
      }
      const { state, description } = statusForResult(result);
      await postReviewStatus(opts.api, opts.owner, opts.repo, reviewedHeadSha, state, description, htmlUrl);
      return result;
    };
    try {
      const extraCap = opts.maxIncompleteRetries ?? MAX_INCOMPLETE_RETRIES;
      let extrasUsed = 0;
      while (true) {
        await logParentDiag(log, "post_fetch_pr", { review: reviewLabel });
        const currentPR = await opts.api.getPR(opts.owner, opts.repo, opts.prNumber);
        const currentSkipReason = skipReasonForPR(currentPR) ?? skipReasonForHeadChange(currentPR, reviewedHeadSha);
        if (currentSkipReason) return await persistSkipAndStatus(currentSkipReason, currentPR.html_url);

        const headAfter = (await git(["rev-parse", "HEAD"], { cwd: opts.workspace, env: gitCmdEnv })).trim();
        if (headAfter !== reviewedHeadSha) {
          return await persistSkipAndStatus("Incomplete review: HEAD moved", currentPR.html_url);
        }

        const porcelain = await git(["status", "--porcelain"], { cwd: opts.workspace, env: gitCmdEnv });
        if (!porcelainAllowsOnlyReviewArtifact(porcelain)) {
          return await persistSkipAndStatus("Incomplete review: dirty tree", currentPR.html_url);
        }

        const noArtifact = !porcelainIncludesReviewArtifact(porcelain);
        const artifact = noArtifact
          ? ({ status: "missing" } as const)
          : await readReviewArtifact(opts.workspace, opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
        if (artifact.status === "too_large") {
          return await persistSkipAndStatus("Incomplete review: output too large", currentPR.html_url);
        }
        if (artifact.status !== "missing" && artifact.content.trim()) {
          const markdown = await gatePersonalJumiContractEnv(opts.owner, opts.repo, opts.workspace, artifact.content);
          await persistOutcome({ kind: "markdown", markdown });
          if (opts.home) {
            const actionHash = fingerprintReviewArtifact(markdown);
            if (actionHash) {
              await appendStuckFingerprint(reviewStuckStatePath(opts.home, opts.owner, opts.repo, opts.prNumber), {
                kind: "action",
                hash: actionHash,
              });
            }
          }
          return await publishReviewResult({
            api: opts.api,
            owner: opts.owner,
            repo: opts.repo,
            prNumber: opts.prNumber,
            expectedHeadSha: reviewedHeadSha,
            botUsername: opts.botUsername,
            resultMarkdown: markdown,
            logger: log,
          });
        }

        if (extrasUsed >= extraCap) {
          return await persistSkipAndStatus(
            "Incomplete review: no output",
            currentPR.html_url,
            INCOMPLETE_REVIEW_STUCK
          );
        }
        extrasUsed++;
        log(`Incomplete review: no output; write-only OpenCode retry (${extrasUsed}/${extraCap})`);
        await rm(artifactPath, { recursive: true, force: true }).catch(() => undefined);
        const continueSession = await hasOpenCodeSession(opts.workspace);
        const writePrompt = buildIncompleteWritePrompt(continueSession ? undefined : lastStdout);
        lastStdout = (await runOpenCode({ prompt: writePrompt, continueSession })).stdout;
      }
    } finally {
      await rm(artifactPath, { recursive: true, force: true }).catch(() => undefined);
      await rm(join(opts.workspace, ".jumi-tmp"), { recursive: true, force: true }).catch(() => undefined);
    }
  } catch (err) {
    if (isAbortError(err) || opts.abortSignal?.aborted) throw err;
    if (!persisted && !persistFailed) {
      const message = `Jumi review failed: ${err instanceof Error ? err.message : String(err)}`;
      await opts.persistResult?.({ kind: "error", error: message });
      if (opts.home) {
        const errorHash = fingerprintError(message);
        if (errorHash) {
          await appendStuckFingerprint(reviewStuckStatePath(opts.home, opts.owner, opts.repo, opts.prNumber), {
            kind: "error",
            hash: errorHash,
          }).catch(() => undefined);
        }
      }
      await postReviewStatus(opts.api, opts.owner, opts.repo, reviewedHeadSha, "failure", message, pr.html_url);
    }
    throw err;
  }
}
