import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isAssignedToBot } from "./assignee.ts";
import { buildCiMarkdown, CI_LOG_FILE, type CiInspection, flakeComment, inspectCi, recordCiHandled } from "./ci.ts";
import type { ClaimRecord } from "./claim.ts";
import {
  acquireClaim,
  claimFilePath,
  conflictStatePath,
  deleteClaim,
  followUpStatePath,
  isPidAlive,
  readClaim,
  stuckStatePath,
  writeClaim,
} from "./claim.ts";
import {
  CONFLICT_TIMEOUT_MS,
  MAX_CONFLICT_ROUNDS,
  mergeDefaultIntoWorktree,
  readConflictState,
  shouldIncrementRound,
  writeConflictState,
} from "./conflict.ts";
import { resolveEngine, throwIfEngineFailed } from "./engine.ts";
import { isJumiInternalBody, isJumiWorkerBody, loginInList } from "./followup_webhook.ts";
import { FORGE_COMMITTER_EMAIL, FORGE_COMMITTER_NAME } from "./forge.ts";
import { openCodeEngine } from "./git.ts";
import type { IssueApi } from "./gitea_issues.ts";
import { isEligibleWorkerPR, resolveWorkerPullRequest, upsertWorkerComment } from "./gitea_issues.ts";
import { buildTaskMarkdown, HEARTBEAT_INTERVAL_MS, type ImplementOptions } from "./implement.ts";
import { gateShipAfterOpenCode, jobWithIssue, snapshotFromJob } from "./issue_recheck.ts";
import type { Comment, InlineComment, Pull, PullReview } from "./ports.ts";
import {
  appendStuckFingerprint,
  evaluateStuck,
  fingerprintCiChecks,
  fingerprintError,
  fingerprintFollowUpText,
  readStuckState,
  stuckComment,
} from "./stuck.ts";
import type { IssueJob } from "./types.ts";
import { parseCheckLine } from "./verdict.ts";
import { gitConfigArgs, gitEnv, runGit, validateCloneUrl, workerOpenCodeChildEnv } from "./workspace.ts";

export { FOLLOWUP_PROMPT } from "./git.ts";

export const FOLLOWUP_TIMEOUT_MS = 60 * 60 * 1000;
export const MAX_FOLLOWUP_ROUNDS = 3;
export const FEEDBACK_MAX_BYTES = 32 * 1024;

export type FollowUpResult =
  | { status: "pushed"; prNumber: number; htmlUrl: string }
  | { status: "no-changes" }
  | { status: "skipped"; reason: string }
  | { status: "cancelled" };

export interface HandledReviewFinding {
  id: number;
  sha: string;
}

export interface FollowUpState {
  prNumber: number;
  round: number;
  lastHeadSha: string;
  handledCommentIds: number[];
  handledReviewIds: number[];
  handledReviewFindings: HandledReviewFinding[];
  updatedAt: string;
}

function logDefault(message: string) {
  console.log(`[followup] ${message}`);
}

function assertSafeSegment(value: string, label: string): string {
  if (!value || value === "." || value === ".." || /[\\/\0]/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function loginEquals(login: string | undefined, botUsername: string): boolean {
  return typeof login === "string" && login.toLowerCase() === botUsername.toLowerCase();
}

export { followUpStatePath };

export async function readFollowUpState(path: string): Promise<FollowUpState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return emptyFollowUpState();
    const state = parsed as FollowUpState;
    return {
      prNumber: typeof state.prNumber === "number" ? state.prNumber : 0,
      round: typeof state.round === "number" ? state.round : 0,
      lastHeadSha: typeof state.lastHeadSha === "string" ? state.lastHeadSha : "",
      handledCommentIds: Array.isArray(state.handledCommentIds)
        ? state.handledCommentIds.filter((id): id is number => typeof id === "number")
        : [],
      handledReviewIds: Array.isArray(state.handledReviewIds)
        ? state.handledReviewIds.filter((id): id is number => typeof id === "number")
        : [],
      handledReviewFindings: parseHandledReviewFindings(state.handledReviewFindings),
      updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : "",
    };
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return emptyFollowUpState();
    return emptyFollowUpState();
  }
}

function emptyFollowUpState(): FollowUpState {
  return {
    prNumber: 0,
    round: 0,
    lastHeadSha: "",
    handledCommentIds: [],
    handledReviewIds: [],
    handledReviewFindings: [],
    updatedAt: "",
  };
}

function parseHandledReviewFindings(value: unknown): HandledReviewFinding[] {
  if (!Array.isArray(value)) return [];
  const findings: HandledReviewFinding[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as { id?: unknown; sha?: unknown };
    if (typeof rec.id === "number" && typeof rec.sha === "string" && rec.sha) {
      findings.push({ id: rec.id, sha: rec.sha });
    }
  }
  return findings;
}

function reviewFindingKey(id: number, sha: string): string {
  return `${id}:${sha.toLowerCase()}`;
}

function uniqueReviewFindings(findings: HandledReviewFinding[]): HandledReviewFinding[] {
  const seen = new Set<string>();
  const out: HandledReviewFinding[] = [];
  for (const finding of findings) {
    const key = reviewFindingKey(finding.id, finding.sha);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: finding.id, sha: finding.sha.toLowerCase() });
  }
  return out;
}

export async function writeFollowUpState(path: string, state: FollowUpState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

export async function deleteFollowUpState(
  home: string,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<void> {
  await deleteClaim(followUpStatePath(home, owner, repo, issueNumber));
}

export function isInScopeHumanComment(
  comment: { body?: string | null; user?: { login?: string } },
  botUsername: string,
  ignoreLogins: readonly string[] = []
): boolean {
  const body = comment.body ?? "";
  if (!body.trim()) return false;
  if (isJumiInternalBody(body)) return false;
  if (loginEquals(comment.user?.login, botUsername)) return false;
  if (loginInList(comment.user?.login, ignoreLogins)) return false;
  return true;
}

const REVIEW_MARKER = "<!-- jumi-review:";
const REVIEWED_COMMIT_RE = /^Reviewed commit:\s*`([0-9a-fA-F]+)`\s*$/i;
const POINTER_STUB_RE = /^(please\s+)?address(\s+the)?\s+(earlier|previous|last)\s+review\.?$/i;

function hasFailureCheckTrailer(body: string): boolean {
  const lines = body.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    return parseCheckLine(line)?.state === "failure";
  }
  return false;
}

export function parseReviewedCommitSha(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const match = REVIEWED_COMMIT_RE.exec(line.trim());
    if (match) return match[1];
  }
  return undefined;
}

function commitMatchesHead(stickySha: string, headSha: string): boolean {
  const sticky = stickySha.toLowerCase();
  const head = headSha.toLowerCase();
  if (!sticky || !head) return false;
  if (sticky === head) return true;
  return sticky.length < head.length && head.startsWith(sticky);
}

export function isPointerStubBody(body: string | null | undefined): boolean {
  const text = (body ?? "").trim();
  if (!text) return true;
  return POINTER_STUB_RE.test(text);
}

export function isJumiReviewSticky(comment: { body?: string | null }): boolean {
  const body = comment.body ?? "";
  if (!body.trim()) return false;
  if (!body.includes(REVIEW_MARKER)) return false;
  if (!hasFailureCheckTrailer(body)) return false;
  if (isJumiWorkerBody(body)) return false;
  return Boolean(parseReviewedCommitSha(body));
}

export interface ReviewFindingMatchOpts {
  extraHeadShas?: readonly string[];
  anyReviewedCommit?: boolean;
}

export function isJumiReviewFinding(
  comment: { body?: string | null },
  headSha: string,
  opts: ReviewFindingMatchOpts = {}
): boolean {
  if (!isJumiReviewSticky(comment)) return false;
  const stickySha = parseReviewedCommitSha(comment.body ?? "");
  if (!stickySha) return false;
  if (opts.anyReviewedCommit) return true;
  if (commitMatchesHead(stickySha, headSha)) return true;
  return (opts.extraHeadShas ?? []).some((sha) => commitMatchesHead(stickySha, sha));
}

function isJumiReviewInline(
  comment: { body?: string | null; user?: { login?: string } },
  botUsername: string
): boolean {
  const body = comment.body ?? "";
  if (!body.trim() || !body.includes(REVIEW_MARKER) || isJumiWorkerBody(body)) return false;
  return loginEquals(comment.user?.login, botUsername);
}

export function pickLatestJumiReview(stickies: readonly Comment[], headSha: string): Comment | undefined {
  if (stickies.length === 0) return undefined;
  const byDate = (a: Comment, b: Comment) => (a.created_at ?? "").localeCompare(b.created_at ?? "");
  const currentHead = stickies.filter((comment) => {
    const sha = parseReviewedCommitSha(comment.body ?? "");
    return sha !== undefined && commitMatchesHead(sha, headSha);
  });
  const pool = currentHead.length ? currentHead : stickies;
  return [...pool].sort(byDate).at(-1);
}

function isPointerStubWake(trigger: IssueJob["trigger"] | undefined, triggerBody: string): boolean {
  const event = trigger?.event ?? "";
  const commentEvent =
    event === "issue_comment" || event === "pull_request_comment" || trigger?.commentId !== undefined;
  if (!commentEvent) return false;
  return isPointerStubBody(triggerBody);
}

export function isInScopeFollowUpComment(
  comment: { body?: string | null; user?: { login?: string } },
  botUsername: string,
  headSha: string,
  ignoreLogins: readonly string[] = [],
  findingOpts: ReviewFindingMatchOpts = {}
): boolean {
  return (
    isJumiReviewFinding(comment, headSha, findingOpts) || isInScopeHumanComment(comment, botUsername, ignoreLogins)
  );
}

export function prHeadChangedReason(from: string, to: string): string {
  return `PR head changed from ${from} to ${to}`;
}

export function parsePrHeadChangedReason(reason: string): { from: string; to: string } | undefined {
  const match = /^PR head changed from (\S+) to (\S+)$/.exec(reason.trim());
  if (!match?.[1] || !match[2]) return undefined;
  return { from: match[1], to: match[2] };
}

export function isRequestChangesReview(review: PullReview): boolean {
  const blob = `${review.state ?? ""} ${review.type ?? ""}`.toLowerCase();
  return (
    blob.includes("request") ||
    blob.includes("reject") ||
    blob.includes("request_changes") ||
    blob.includes("pull_request_review_rejected")
  );
}

export function isCommentReview(review: PullReview): boolean {
  const blob = `${review.state ?? ""} ${review.type ?? ""}`.toLowerCase();
  return blob.includes("comment");
}

export interface FollowUpItems {
  comments: Comment[];
  inlines: InlineComment[];
  reviews: PullReview[];
  jumiStickies: Comment[];
  jumiInlines: InlineComment[];
}

export async function collectFollowUpItems(
  api: IssueApi,
  owner: string,
  repo: string,
  prNumber: number,
  botUsername: string,
  headSha: string,
  ignoreLogins: readonly string[] = [],
  findingOpts: ReviewFindingMatchOpts = {}
): Promise<FollowUpItems> {
  const [rawComments, rawReviews, rawInlines] = await Promise.all([
    api.listIssueComments(owner, repo, prNumber),
    api.listPullReviews(owner, repo, prNumber),
    api.listPullReviewComments(owner, repo, prNumber).catch((err: unknown): InlineComment[] => {
      logDefault(
        `inline review comments unavailable for ${owner}/${repo}#${prNumber}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return [];
    }),
  ]);
  return {
    comments: rawComments.filter((comment) =>
      isInScopeFollowUpComment(comment, botUsername, headSha, ignoreLogins, findingOpts)
    ),
    inlines: rawInlines.filter((comment) => isInScopeHumanComment(comment, botUsername, ignoreLogins)),
    reviews: rawReviews.filter(
      (review) =>
        (isRequestChangesReview(review) || isCommentReview(review)) &&
        isInScopeHumanComment(
          { body: review.body ?? review.content ?? "", user: review.user },
          botUsername,
          ignoreLogins
        )
    ),
    jumiStickies: rawComments.filter(isJumiReviewSticky),
    jumiInlines: rawInlines.filter((comment) => isJumiReviewInline(comment, botUsername)),
  };
}

function reviewFindingFromComment(comment: { id: number; body?: string | null }): HandledReviewFinding | undefined {
  const body = comment.body ?? "";
  if (!body.includes(REVIEW_MARKER)) return undefined;
  const sha = parseReviewedCommitSha(body);
  if (!sha) return undefined;
  return { id: comment.id, sha };
}

function withoutPointerStubs(items: FollowUpItems): FollowUpItems {
  return {
    ...items,
    comments: items.comments.filter((comment) => !isPointerStubBody(comment.body)),
  };
}

function briefInlines(items: FollowUpItems): InlineComment[] {
  const seen = new Set<number>();
  const out: InlineComment[] = [];
  for (const comment of [...items.inlines, ...items.jumiInlines]) {
    if (seen.has(comment.id)) continue;
    seen.add(comment.id);
    out.push(comment);
  }
  return out;
}

function hasUnhandledFollowUpItems(
  items: { comments: Comment[]; inlines: InlineComment[]; reviews: PullReview[] },
  state: Pick<FollowUpState, "handledCommentIds" | "handledReviewIds" | "handledReviewFindings">
): boolean {
  const handledComments = new Set(state.handledCommentIds);
  const handledReviews = new Set(state.handledReviewIds);
  const handledFindings = new Set(
    state.handledReviewFindings.map((finding) => reviewFindingKey(finding.id, finding.sha))
  );
  const unhandledComments = items.comments.some((comment) => {
    const finding = reviewFindingFromComment(comment);
    if (finding) return !handledFindings.has(reviewFindingKey(finding.id, finding.sha));
    return !handledComments.has(comment.id);
  });
  const unhandledInlines = items.inlines.some((comment) => !handledComments.has(comment.id));
  const unhandledReviews = items.reviews.some((review) => !handledReviews.has(review.id));
  return unhandledComments || unhandledInlines || unhandledReviews;
}

export async function needsFollowUp(opts: {
  api: IssueApi;
  owner: string;
  repo: string;
  pr: Pull;
  issueNumber: number;
  botUsername: string;
  home: string;
  maxFollowupRounds?: number;
  followupIgnoreLogins?: readonly string[];
}): Promise<boolean> {
  const state = await readFollowUpState(followUpStatePath(opts.home, opts.owner, opts.repo, opts.issueNumber));
  if (state.round >= (opts.maxFollowupRounds ?? MAX_FOLLOWUP_ROUNDS)) return false;
  const items = await collectFollowUpItems(
    opts.api,
    opts.owner,
    opts.repo,
    opts.pr.number,
    opts.botUsername,
    opts.pr.head.sha,
    opts.followupIgnoreLogins
  );
  if (!hasUnhandledFollowUpItems(items, state)) return false;
  if (state.lastHeadSha && state.lastHeadSha === opts.pr.head.sha && !hasUnhandledFollowUpItems(items, state)) {
    return false;
  }
  return true;
}

interface FeedbackItem {
  kind: "comment" | "inline" | "review";
  id: number;
  createdAt: string;
  text: string;
}

export function buildFeedbackMarkdown(opts: {
  pr: Pull;
  trigger?: IssueJob["trigger"];
  triggerBody?: string;
  comments: Comment[];
  inlines: InlineComment[];
  reviews: PullReview[];
  lastReview?: Comment;
}): { markdown: string; commentIds: number[]; reviewIds: number[] } {
  const header = [
    `# Review feedback`,
    ``,
    `PR: ${opts.pr.html_url}`,
    `Number: ${opts.pr.number}`,
    `Head SHA: ${opts.pr.head.sha}`,
    `Head ref: ${opts.pr.head.ref}`,
    ``,
  ].join("\n");

  const triggerLines = ["## Trigger", ""];
  if (opts.trigger) {
    triggerLines.push(`Event: ${opts.trigger.event}`);
    triggerLines.push(`Sender: ${opts.trigger.sender}`);
    if (opts.trigger.commentId !== undefined) triggerLines.push(`Comment id: ${opts.trigger.commentId}`);
    if (opts.trigger.reviewId !== undefined) triggerLines.push(`Review id: ${opts.trigger.reviewId}`);
    triggerLines.push("");
    const triggerBody = (opts.triggerBody ?? opts.trigger.body ?? "").trim();
    triggerLines.push(triggerBody ? triggerBody : "(no trigger body)");
  } else {
    triggerLines.push("Event: assigned");
    triggerLines.push("");
  }
  triggerLines.push("");
  const triggerSection = triggerLines.join("\n");

  const lastReviewSection = opts.lastReview ? `## Last review\n\n${opts.lastReview.body.trimEnd()}\n\n` : "";

  const extras: FeedbackItem[] = [];
  for (const comment of opts.comments) {
    if (opts.trigger?.commentId === comment.id) continue;
    if (opts.lastReview?.id === comment.id) continue;
    extras.push({
      kind: "comment",
      id: comment.id,
      createdAt: comment.created_at ?? "",
      text: `### Comment ${comment.id} by ${comment.user?.login ?? "unknown"}\n\n${comment.body}\n`,
    });
  }
  for (const comment of opts.inlines) {
    extras.push({
      kind: "inline",
      id: comment.id,
      createdAt: comment.created_at ?? "",
      text: `### Inline ${comment.id} by ${comment.user?.login ?? "unknown"}${comment.path ? ` on ${comment.path}` : ""}\n\n${comment.body}\n`,
    });
  }
  for (const review of opts.reviews) {
    if (opts.trigger?.reviewId === review.id) continue;
    extras.push({
      kind: "review",
      id: review.id,
      createdAt: review.submitted_at ?? review.updated_at ?? review.created_at ?? "",
      text: `### Review ${review.id} by ${review.user?.login ?? "unknown"}\n\n${review.body ?? review.content ?? ""}\n`,
    });
  }
  extras.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const encoder = new TextEncoder();
  const otherHeader = "## Other comments\n\n";
  const prefix = header + triggerSection + lastReviewSection;
  const fit: FeedbackItem[] = [...extras];
  const sizeOf = (items: FeedbackItem[]) => {
    const extra = items.length ? otherHeader + items.map((item) => item.text).join("\n") : "";
    return encoder.encode(prefix + extra).byteLength;
  };
  const isJumiReviewText = (item: FeedbackItem) => item.text.includes(REVIEW_MARKER);
  while (fit.length > 0 && sizeOf(fit) > FEEDBACK_MAX_BYTES) {
    const dropIdx = fit.findIndex((item) => !isJumiReviewText(item));
    if (dropIdx >= 0) fit.splice(dropIdx, 1);
    else fit.shift();
  }

  let markdown = prefix + (fit.length ? otherHeader + fit.map((item) => item.text).join("\n") : "");
  if (encoder.encode(markdown).byteLength > FEEDBACK_MAX_BYTES) {
    markdown = markdown.slice(0, FEEDBACK_MAX_BYTES);
  }

  const commentIds = new Set<number>();
  const reviewIds = new Set<number>();
  if (opts.trigger?.commentId !== undefined) commentIds.add(opts.trigger.commentId);
  if (opts.trigger?.reviewId !== undefined) reviewIds.add(opts.trigger.reviewId);
  if (opts.lastReview && markdown.includes("## Last review")) commentIds.add(opts.lastReview.id);
  for (const item of fit) {
    const marker =
      item.kind === "comment"
        ? `### Comment ${item.id}`
        : item.kind === "inline"
          ? `### Inline ${item.id}`
          : `### Review ${item.id}`;
    if (!markdown.includes(marker)) continue;
    if (item.kind === "review") reviewIds.add(item.id);
    else commentIds.add(item.id);
  }
  return { markdown, commentIds: [...commentIds], reviewIds: [...reviewIds] };
}

function triggerBodyFromItems(
  trigger: IssueJob["trigger"] | undefined,
  items: { comments: Comment[]; inlines: InlineComment[]; reviews: PullReview[] }
): string {
  if (!trigger) return "";
  if (typeof trigger.body === "string" && trigger.body.trim()) return trigger.body;
  if (trigger.commentId !== undefined) {
    const comment =
      items.comments.find((entry) => entry.id === trigger.commentId) ??
      items.inlines.find((entry) => entry.id === trigger.commentId);
    if (comment?.body) return comment.body;
  }
  if (trigger.reviewId !== undefined) {
    const review = items.reviews.find((entry) => entry.id === trigger.reviewId);
    if (review) return review.body ?? review.content ?? "";
  }
  return "";
}

function reviewFindingMatchOptsForJob(job: IssueJob, headSha: string): ReviewFindingMatchOpts {
  const extraHeadShas = job.headSha && job.headSha.toLowerCase() !== headSha.toLowerCase() ? [job.headSha] : undefined;
  return {
    extraHeadShas,
    anyReviewedCommit: job.trigger?.event === "review-failure",
  };
}

export async function implementFollowUp(opts: ImplementOptions): Promise<FollowUpResult> {
  const log = opts.logger ?? logDefault;
  const now = () => opts.now?.() ?? new Date();
  const pidAlive = opts.pidAlive ?? isPidAlive;
  const git = opts.gitRunner ?? runGit;
  const engine = resolveEngine(opts, openCodeEngine);
  const owner = assertSafeSegment(opts.job.owner, "owner");
  const repo = assertSafeSegment(opts.job.repo, "repo");
  const issueNumber = opts.job.issueNumber;
  const worktree = join(opts.workdir, owner, repo, String(issueNumber));
  const barePath = join(opts.workdir, "_cache", owner, `${repo}.git`);
  const claimPath = claimFilePath(opts.home, owner, repo, issueNumber);
  const statePath = followUpStatePath(opts.home, owner, repo, issueNumber);
  const sanitizeEnv = opts.sanitizeOpenCodeEnv ?? true;
  const useClaim = opts.useClaim !== false;
  const maxFollowupRounds = opts.maxFollowupRounds ?? MAX_FOLLOWUP_ROUNDS;
  const maxConflictRounds = opts.maxConflictRounds ?? MAX_CONFLICT_ROUNDS;
  const timeoutMs = opts.timeoutMs ?? FOLLOWUP_TIMEOUT_MS;
  const conflictTimeoutMs = opts.conflictTimeoutMs ?? CONFLICT_TIMEOUT_MS;
  const forgetClaim = async () => {
    if (useClaim) await deleteClaim(claimPath);
  };

  throwIfAborted(opts.abortSignal);

  const startedAt = now().toISOString();
  if (useClaim) {
    const existingClaim = await readClaim(claimPath);
    if (existingClaim?.terminal) await forgetClaim();
  }

  const claim: ClaimRecord = {
    pid: 0,
    startedAt,
    heartbeatAt: startedAt,
    worktree,
    branch: "",
    issueUpdatedAt: opts.job.issueUpdatedAt,
    headShaAtStart: "",
    terminal: false,
  };
  if (useClaim) {
    const acquired = await acquireClaim(claimPath, claim, { pidAlive, nowMs: now().getTime() });
    if (!acquired) {
      return { status: "skipped", reason: "claim is live" };
    }
  }

  const sticky = (body: string, index: number) =>
    upsertWorkerComment(opts.api, owner, repo, issueNumber, opts.botUsername, body, { index });

  try {
    const currentIssue = await opts.api.getIssue(owner, repo, issueNumber);
    if (!isAssignedToBot(currentIssue, opts.botUsername) || currentIssue.state !== "open") {
      await forgetClaim();
      return { status: "cancelled" };
    }
  } catch (err) {
    await forgetClaim();
    return { status: "skipped", reason: `failed to load issue: ${err instanceof Error ? err.message : String(err)}` };
  }

  const pr = await resolveWorkerPullRequest(opts.api, owner, repo, issueNumber, opts.botUsername, opts.job.prNumber);
  if (!pr || !isEligibleWorkerPR(pr, owner, repo)) {
    await forgetClaim();
    return { status: "skipped", reason: "no open jumi closing PR" };
  }
  if (opts.job.headSha && pr.head.sha && opts.job.headSha !== pr.head.sha) {
    log(`PR head moved from ${opts.job.headSha} to ${pr.head.sha}; continuing on current head`);
  }
  const findingOpts = reviewFindingMatchOptsForJob(opts.job, pr.head.sha);

  const branch = pr.head.ref;
  claim.branch = branch;
  if (!branch || branch === opts.job.defaultBranch) {
    await forgetClaim();
    return { status: "skipped", reason: "refusing to follow up on the default branch" };
  }

  const state = await readFollowUpState(statePath);
  const pendingItems = await collectFollowUpItems(
    opts.api,
    owner,
    repo,
    pr.number,
    opts.botUsername,
    pr.head.sha,
    opts.followupIgnoreLogins,
    findingOpts
  );
  const pendingTriggerBody = triggerBodyFromItems(opts.job.trigger, pendingItems);
  const pendingLastReview = pickLatestJumiReview(pendingItems.jumiStickies, pr.head.sha);
  const hasInjectedReview = Boolean(pendingLastReview) || pendingItems.jumiInlines.length > 0;
  let hasFeedback = hasUnhandledFollowUpItems(withoutPointerStubs(pendingItems), state);
  if (!hasFeedback && isPointerStubWake(opts.job.trigger, pendingTriggerBody) && hasInjectedReview) {
    hasFeedback = true;
  }
  let ci: CiInspection = { sha: pr.head.sha, pending: false, failed: [], unhandled: [] };
  try {
    ci = await inspectCi({
      api: opts.api,
      owner,
      repo,
      sha: pr.head.sha,
      home: opts.home,
      issueNumber,
    });
  } catch (err) {
    log(`CI inspect failed for ${owner}/${repo}#${issueNumber}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const ciWake = !ci.pending && ci.unhandled.length > 0;
  if (
    (opts.job.trigger?.commentId !== undefined && state.handledCommentIds.includes(opts.job.trigger.commentId)) ||
    (opts.job.trigger?.reviewId !== undefined && state.handledReviewIds.includes(opts.job.trigger.reviewId))
  ) {
    if (!ciWake) {
      await forgetClaim();
      return { status: "skipped", reason: "comment already handled" };
    }
  }
  if (hasFeedback && state.round >= maxFollowupRounds) {
    if (!ciWake) {
      await sticky("stuck: too many follow-up rounds", pr.number);
      await forgetClaim();
      return { status: "skipped", reason: "stuck: too many follow-up rounds" };
    }
    hasFeedback = false;
  }
  if (!hasFeedback) {
    if (ci.pending) {
      await forgetClaim();
      return { status: "skipped", reason: "CI still pending" };
    }
    if (!ciWake) {
      await forgetClaim();
      return { status: "skipped", reason: "no unhandled feedback" };
    }
    if (ci.unhandled.every((check) => check.flake)) {
      await sticky(flakeComment(ci.unhandled), pr.number);
      await recordCiHandled({
        home: opts.home,
        owner,
        repo,
        issueNumber,
        prNumber: pr.number,
        sha: pr.head.sha,
        checks: ci.unhandled,
        now,
      });
      await forgetClaim();
      return { status: "skipped", reason: "CI infra flake" };
    }
  }
  const conflictPath = conflictStatePath(opts.home, owner, repo, issueNumber);
  const previousConflict = await readConflictState(conflictPath);
  if (previousConflict.round >= maxConflictRounds) {
    await sticky("stuck: cannot resolve conflicts", pr.number);
    await forgetClaim();
    return { status: "skipped", reason: "stuck: cannot resolve conflicts" };
  }

  const feedbackPreview = buildFeedbackMarkdown({
    pr,
    trigger: opts.job.trigger,
    triggerBody: pendingTriggerBody,
    comments: pendingItems.comments,
    inlines: briefInlines(pendingItems),
    reviews: pendingItems.reviews,
    lastReview: pendingLastReview,
  });
  const findingHash = hasFeedback ? fingerprintFollowUpText(feedbackPreview.markdown) : undefined;
  const ciHash = hasFeedback ? undefined : fingerprintCiChecks(ci.unhandled);
  const currentFingerprint = findingHash
    ? { kind: "action" as const, hash: findingHash }
    : ciHash
      ? { kind: "ci" as const, hash: ciHash }
      : undefined;
  const stuckPath = stuckStatePath(opts.home, owner, repo, issueNumber);
  const stuckReason = evaluateStuck((await readStuckState(stuckPath)).fingerprints, currentFingerprint);
  if (stuckReason) {
    await sticky(stuckComment(stuckReason), pr.number);
    await forgetClaim();
    return { status: "skipped", reason: stuckComment(stuckReason) };
  }

  const configArgs = gitConfigArgs();
  const env = gitEnv({ giteaUrl: opts.giteaUrl, username: opts.botUsername, token: opts.giteaToken });
  const runConfiguredGit = (args: string[], runOpts: { cwd: string; env: Record<string, string | undefined> }) =>
    git([...configArgs, ...args], runOpts);
  const detachWorktree = async () => {
    try {
      await runConfiguredGit(["worktree", "remove", "--force", worktree], { cwd: barePath, env });
    } catch {
      // Already gone or never added.
    }
    await rm(worktree, { recursive: true, force: true }).catch(() => undefined);
  };

  const heartbeatMs = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  let heartbeatStopped = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let claimWrites: Promise<void> = Promise.resolve();
  const serializeClaim = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = claimWrites.then(fn, fn);
    claimWrites = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
  const stopHeartbeat = async () => {
    heartbeatStopped = true;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    await serializeClaim(async () => undefined);
  };
  heartbeat =
    heartbeatMs > 0 && useClaim
      ? setInterval(() => {
          void serializeClaim(async () => {
            if (heartbeatStopped) return;
            const current = await readClaim(claimPath);
            if (heartbeatStopped || !current || current.terminal || current.startedAt !== claim.startedAt) return;
            current.heartbeatAt = now().toISOString();
            await writeClaim(claimPath, current);
          }).catch(() => undefined);
        }, heartbeatMs)
      : undefined;

  let handledCommentIds = [...state.handledCommentIds];
  let handledReviewIds = [...state.handledReviewIds];
  const handledReviewFindings = [...state.handledReviewFindings];
  if (opts.job.trigger?.commentId !== undefined) handledCommentIds.push(opts.job.trigger.commentId);
  if (opts.job.trigger?.reviewId !== undefined) handledReviewIds.push(opts.job.trigger.reviewId);

  let followUpEngineRan = false;
  const persistCi = async () => {
    if (!followUpEngineRan || ci.failed.length === 0) return;
    await recordCiHandled({
      home: opts.home,
      owner,
      repo,
      issueNumber,
      prNumber: pr.number,
      sha: pr.head.sha,
      checks: ci.failed,
      now,
    });
  };

  const recordAttempt = async (headSha: string) => {
    const uniqueComments = [...new Set(handledCommentIds)];
    const uniqueReviews = [...new Set(handledReviewIds)];
    await writeFollowUpState(statePath, {
      prNumber: pr.number,
      round: hasFeedback ? state.round + 1 : state.round,
      lastHeadSha: headSha,
      handledCommentIds: uniqueComments,
      handledReviewIds: uniqueReviews,
      handledReviewFindings: uniqueReviewFindings(handledReviewFindings),
      updatedAt: now().toISOString(),
    });
    if (currentFingerprint) {
      await appendStuckFingerprint(stuckPath, currentFingerprint, now);
    }
    await persistCi();
  };

  let attemptedHeadSha = "";
  let attemptedBaseSha = "";
  let prefixMergeThrew = false;

  try {
    throwIfAborted(opts.abortSignal);
    const cloneUrl = validateCloneUrl(opts.job.cloneUrl, opts.giteaUrl);
    await mkdir(dirname(barePath), { recursive: true });
    if (await pathExists(barePath)) {
      log(`Fetching ${owner}/${repo} cache`);
      await runConfiguredGit(["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*"], { cwd: barePath, env });
    } else {
      log(`Cloning ${owner}/${repo} into bare cache`);
      await runConfiguredGit(["clone", "--bare", cloneUrl, barePath], { cwd: dirname(barePath), env });
      await runConfiguredGit(["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*"], { cwd: barePath, env });
    }
    throwIfAborted(opts.abortSignal);

    const originRef = `refs/remotes/origin/${branch}`;
    const originExists = await runConfiguredGit(["show-ref", "--verify", "--quiet", originRef], {
      cwd: barePath,
      env,
    })
      .then(() => true)
      .catch(() => false);
    if (!originExists) {
      await stopHeartbeat();
      await forgetClaim();
      await detachWorktree();
      return { status: "skipped", reason: `missing branch ${branch}` };
    }
    if (!(await pathExists(join(worktree, ".git")))) {
      await mkdir(dirname(worktree), { recursive: true });
      log(`Adding worktree ${worktree} from origin/${branch}`);
      await runConfiguredGit(["worktree", "add", "-B", branch, worktree, `origin/${branch}`], {
        cwd: barePath,
        env,
      });
    } else {
      await runConfiguredGit(["checkout", branch], { cwd: worktree, env });
      await runConfiguredGit(["reset", "--hard", `origin/${branch}`], { cwd: worktree, env });
    }
    await mkdir(worktree, { recursive: true });
    throwIfAborted(opts.abortSignal);

    const headSha = (await runConfiguredGit(["rev-parse", "HEAD"], { cwd: worktree, env })).trim();
    const baseSha = (
      await runConfiguredGit(["rev-parse", `origin/${opts.job.defaultBranch}`], { cwd: worktree, env })
    ).trim();
    attemptedHeadSha = headSha;
    attemptedBaseSha = baseSha;
    await serializeClaim(async () => {
      if (heartbeatStopped || !useClaim) return;
      claim.headShaAtStart = headSha;
      claim.heartbeatAt = now().toISOString();
      await writeClaim(claimPath, claim);
    });

    if (
      previousConflict.lastHeadSha &&
      previousConflict.lastBaseSha &&
      previousConflict.lastHeadSha === headSha &&
      previousConflict.lastBaseSha === baseSha
    ) {
      await stopHeartbeat();
      await forgetClaim();
      await detachWorktree();
      return { status: "skipped", reason: "same head and base already attempted" };
    }

    const currentIssue = await opts.api.getIssue(owner, repo, issueNumber);
    const taskJob: IssueJob = {
      ...opts.job,
      title: currentIssue.title,
      body: currentIssue.body ?? "",
      htmlUrl: currentIssue.html_url,
    };
    const mergeResult = await mergeDefaultIntoWorktree({
      git: runConfiguredGit,
      env,
      worktree,
      defaultBranch: opts.job.defaultBranch,
      headRef: branch,
      job: taskJob,
      pr,
      model: opts.model,
      home: opts.home,
      sanitizeOpenCodeEnv: sanitizeEnv,
      extraEnv: workerOpenCodeChildEnv(
        {
          giteaUrl: opts.giteaUrl,
          username: opts.botUsername,
          token: opts.giteaToken,
        },
        worktree
      ),
      maxOutputBytes: opts.maxOutputBytes,
      timeoutMs: conflictTimeoutMs,
      openCodeRunner: engine,
      helmRunner: opts.helmRunner,
      logger: log,
      abortSignal: opts.abortSignal,
      jobId: opts.jobId ?? opts.job.delivery,
      ciMarkdown: ci.failed.length ? buildCiMarkdown({ sha: pr.head.sha, checks: ci.failed }) : undefined,
      onPid: async (pid) => {
        await opts.onPid?.(pid);
        await serializeClaim(async () => {
          if (heartbeatStopped || !useClaim) return;
          const current = await readClaim(claimPath);
          if (heartbeatStopped || !current || current.terminal) return;
          current.pid = pid;
          current.heartbeatAt = now().toISOString();
          await writeClaim(claimPath, current);
        });
      },
    }).catch((err: unknown) => {
      prefixMergeThrew = true;
      throw err;
    });
    const persistConflictAttempt = async (result: typeof mergeResult) => {
      if (!shouldIncrementRound(result)) return;
      await writeConflictState(conflictPath, {
        prNumber: pr.number,
        round: previousConflict.round + 1,
        lastHeadSha: result.headSha,
        lastBaseSha: result.baseSha,
        updatedAt: now().toISOString(),
      });
    };
    if (mergeResult.status === "stuck") {
      await persistConflictAttempt(mergeResult);
      await sticky("stuck: cannot resolve conflicts", pr.number);
      await stopHeartbeat();
      await serializeClaim(async () => {
        await forgetClaim();
      });
      await detachWorktree();
      return { status: "skipped", reason: "stuck: cannot resolve conflicts" };
    }

    throwIfAborted(opts.abortSignal);
    await writeFile(join(worktree, "JUMI_TASK.md"), buildTaskMarkdown(taskJob));
    if (hasFeedback) {
      const items = await collectFollowUpItems(
        opts.api,
        owner,
        repo,
        pr.number,
        opts.botUsername,
        pr.head.sha,
        opts.followupIgnoreLogins,
        findingOpts
      );
      const briefReview = pickLatestJumiReview(items.jumiStickies, pr.head.sha) ?? pendingLastReview;
      const feedback = buildFeedbackMarkdown({
        pr,
        trigger: opts.job.trigger,
        triggerBody: triggerBodyFromItems(opts.job.trigger, items),
        comments: items.comments,
        inlines: briefInlines(items),
        reviews: items.reviews,
        lastReview: briefReview,
      });
      handledCommentIds = [...handledCommentIds, ...feedback.commentIds];
      handledReviewIds = [...handledReviewIds, ...feedback.reviewIds];
      const findingById = new Map<number, HandledReviewFinding>();
      for (const comment of [...items.comments, ...items.jumiStickies]) {
        const finding = reviewFindingFromComment(comment);
        if (finding) findingById.set(finding.id, finding);
      }
      if (briefReview) {
        const finding = reviewFindingFromComment(briefReview);
        if (finding) findingById.set(finding.id, finding);
      }
      handledCommentIds = handledCommentIds.filter((id) => {
        const finding = findingById.get(id);
        if (!finding) return true;
        handledReviewFindings.push(finding);
        return false;
      });
      await writeFile(join(worktree, "JUMI_FEEDBACK.md"), feedback.markdown);
    } else if (pendingLastReview || pendingItems.jumiInlines.length > 0) {
      await writeFile(
        join(worktree, "JUMI_FEEDBACK.md"),
        buildFeedbackMarkdown({
          pr,
          trigger: opts.job.trigger,
          triggerBody: pendingTriggerBody,
          comments: [],
          inlines: pendingItems.jumiInlines,
          reviews: [],
          lastReview: pendingLastReview,
        }).markdown
      );
    } else {
      await writeFile(
        join(worktree, "JUMI_FEEDBACK.md"),
        "# Review feedback\n\nNo review comments this round. Address JUMI_CI.md.\n"
      );
    }
    if (ci.failed.length) {
      await writeFile(join(worktree, CI_LOG_FILE), buildCiMarkdown({ sha: pr.head.sha, checks: ci.failed }));
    }
    await sticky(hasFeedback ? "Jumi is addressing review comments." : "Jumi is addressing CI failure.", pr.number);

    const runEngine = async (label: string) => {
      throwIfAborted(opts.abortSignal);
      log(label);
      followUpEngineRan = true;
      throwIfEngineFailed(
        await engine({
          model: opts.model,
          workdir: worktree,
          home: opts.home,
          sanitizeEnv,
          extraEnv: workerOpenCodeChildEnv(
            {
              giteaUrl: opts.giteaUrl,
              username: opts.botUsername,
              token: opts.giteaToken,
            },
            worktree
          ),
          timeoutMs,
          maxOutputBytes: opts.maxOutputBytes,
          reviewLabel: `${owner}/${repo}#${issueNumber}`,
          trace: {
            kind: "follow-up",
            owner,
            repo,
            sha: pr.head.sha,
            jobId: opts.jobId ?? opts.job.delivery,
          },
          logger: log,
          abortSignal: opts.abortSignal,
          onPid: async (pid) => {
            await opts.onPid?.(pid);
            await serializeClaim(async () => {
              if (heartbeatStopped || !useClaim) return;
              const current = await readClaim(claimPath);
              if (heartbeatStopped || !current || current.terminal) return;
              current.pid = pid;
              current.heartbeatAt = now().toISOString();
              await writeClaim(claimPath, current);
            });
          },
        })
      );
    };

    await runEngine(`Running OpenCode follow-up for ${owner}/${repo}#${issueNumber} PR ${pr.number}`);

    const gate = await gateShipAfterOpenCode({
      api: opts.api,
      owner,
      repo,
      issueNumber,
      botUsername: opts.botUsername,
      snapshot: snapshotFromJob(taskJob),
      closerPrNumber: pr.number,
      continueOpenCode: async (issue) => {
        await writeFile(join(worktree, "JUMI_TASK.md"), buildTaskMarkdown(jobWithIssue(taskJob, issue)));
        await runEngine(`Re-running OpenCode after issue change for ${owner}/${repo}#${issueNumber} PR ${pr.number}`);
      },
    });
    if (gate.action === "skip") {
      await stopHeartbeat();
      await serializeClaim(async () => {
        await forgetClaim();
      });
      if (!gate.keepLocalWork) await detachWorktree();
      return { status: "skipped", reason: gate.reason };
    }

    throwIfAborted(opts.abortSignal);
    await rm(join(worktree, "JUMI_TASK.md"), { force: true });
    await rm(join(worktree, "JUMI_FEEDBACK.md"), { force: true });
    await rm(join(worktree, CI_LOG_FILE), { force: true });
    await rm(join(worktree, ".jumi-tmp"), { recursive: true, force: true });
    const porcelain = (await runConfiguredGit(["status", "--porcelain"], { cwd: worktree, env })).trim();
    if (!porcelain) {
      const aheadText = (
        await runConfiguredGit(["rev-list", "--count", `origin/${branch}..HEAD`], {
          cwd: worktree,
          env,
        })
      ).trim();
      const ahead = Number(aheadText);
      if (!Number.isFinite(ahead) || ahead <= 0) {
        const sha = (await runConfiguredGit(["rev-parse", "HEAD"], { cwd: worktree, env })).trim();
        await stopHeartbeat();
        await sticky("no follow-up changes", pr.number);
        await recordAttempt(sha || pr.head.sha);
        await serializeClaim(async () => {
          await forgetClaim();
        });
        await detachWorktree();
        return { status: "no-changes" };
      }
    }

    if (porcelain) {
      const commitEnv = {
        ...env,
        GIT_AUTHOR_NAME: FORGE_COMMITTER_NAME,
        GIT_AUTHOR_EMAIL: FORGE_COMMITTER_EMAIL,
        GIT_COMMITTER_NAME: FORGE_COMMITTER_NAME,
        GIT_COMMITTER_EMAIL: FORGE_COMMITTER_EMAIL,
      };
      await runConfiguredGit(["add", "-A"], { cwd: worktree, env: commitEnv });
      await runConfiguredGit(["commit", "-m", `Address review on #${pr.number}: ${gate.snapshot.title}`], {
        cwd: worktree,
        env: commitEnv,
      });
    }
    try {
      await runConfiguredGit(["push", "-u", "origin", branch], { cwd: worktree, env });
    } catch (err) {
      await runConfiguredGit(["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
        cwd: worktree,
        env,
      }).catch(() => undefined);
      const remoteSha = (
        await runConfiguredGit(["rev-parse", `origin/${branch}`], { cwd: worktree, env }).catch(() => "")
      ).trim();
      if (remoteSha && remoteSha !== attemptedHeadSha) {
        await stopHeartbeat();
        await serializeClaim(async () => {
          await forgetClaim();
        });
        await detachWorktree();
        return {
          status: "skipped",
          reason: prHeadChangedReason(opts.job.headSha || attemptedHeadSha, remoteSha),
        };
      }
      throw err;
    }
    throwIfAborted(opts.abortSignal);
    await persistConflictAttempt(mergeResult);

    const sha = (await runConfiguredGit(["rev-parse", "HEAD"], { cwd: worktree, env })).trim();
    await sticky(`Pushed follow-up to ${pr.html_url}`, pr.number);
    await recordAttempt(sha || pr.head.sha);
    await stopHeartbeat();
    await serializeClaim(async () => {
      await forgetClaim();
    });
    await detachWorktree();
    return { status: "pushed", prNumber: pr.number, htmlUrl: pr.html_url };
  } catch (err) {
    if (isAbortError(err) || opts.abortSignal?.aborted) {
      await stopHeartbeat();
      await detachWorktree();
      return { status: "cancelled" };
    }
    await sticky(`Jumi failed: ${err instanceof Error ? err.message : String(err)}`, pr.number).catch(() => undefined);
    const errorHash = fingerprintError(err instanceof Error ? err.message : String(err));
    if (errorHash) {
      await appendStuckFingerprint(stuckPath, { kind: "error", hash: errorHash }, now).catch(() => undefined);
    }
    if (prefixMergeThrew && attemptedHeadSha && attemptedBaseSha) {
      await writeConflictState(conflictPath, {
        prNumber: pr.number,
        round: previousConflict.round + 1,
        lastHeadSha: attemptedHeadSha,
        lastBaseSha: attemptedBaseSha,
        updatedAt: now().toISOString(),
      }).catch(() => undefined);
    }
    await writeFollowUpState(statePath, {
      prNumber: pr.number,
      round: hasFeedback ? state.round + 1 : state.round,
      lastHeadSha: pr.head.sha,
      handledCommentIds: state.handledCommentIds,
      handledReviewIds: state.handledReviewIds,
      handledReviewFindings: state.handledReviewFindings,
      updatedAt: now().toISOString(),
    }).catch(() => undefined);
    await persistCi().catch(() => undefined);
    await stopHeartbeat();
    await serializeClaim(async () => {
      await forgetClaim();
    }).catch(() => undefined);
    await detachWorktree();
    throw err;
  } finally {
    await stopHeartbeat();
  }
}
