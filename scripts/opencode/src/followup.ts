import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isAssignedToBot } from "./assignee.ts";
import type { ClaimRecord } from "./claim.ts";
import {
  acquireClaim,
  claimFilePath,
  deleteClaim,
  followUpStatePath,
  isPidAlive,
  readClaim,
  writeClaim,
} from "./claim.ts";
import { isJumiInternalBody } from "./followup_webhook.ts";
import { runOpenCode } from "./git.ts";
import type { IssueApi } from "./gitea_issues.ts";
import { findOpenJumiClosingPullRequest, upsertWorkerComment } from "./gitea_issues.ts";
import { buildTaskMarkdown, HEARTBEAT_INTERVAL_MS, type ImplementOptions } from "./implement.ts";
import type { GiteaComment, GiteaPR, GiteaPullReview, GiteaPullReviewComment, IssueJob } from "./types.ts";
import { gitConfigArgs, gitEnv, gitOpenCodeChildEnv, runGit, validateCloneUrl } from "./workspace.ts";

export const FOLLOWUP_TIMEOUT_MS = 60 * 60 * 1000;
export const MAX_FOLLOWUP_ROUNDS = 3;
export const FEEDBACK_MAX_BYTES = 32 * 1024;
const COMMIT_NAME = "jumi";
const COMMIT_EMAIL = "jumi@noreply.kirmanak.stream";

export const FOLLOWUP_PROMPT = `Read JUMI_TASK.md (original issue) and JUMI_FEEDBACK.md (review comments).
Address the feedback in this repository on the current branch.
Do not reopen product decisions already specified in JUMI_TASK.md.
Do not force-push. Do not ask questions. Do not open a pull request.
When the feedback is addressed, stop.`;

export type FollowUpResult =
  | { status: "pushed"; prNumber: number; htmlUrl: string }
  | { status: "no-changes" }
  | { status: "skipped"; reason: string }
  | { status: "cancelled" };

export interface FollowUpState {
  prNumber: number;
  round: number;
  lastHeadSha: string;
  handledCommentIds: number[];
  handledReviewIds: number[];
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
      updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : "",
    };
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return emptyFollowUpState();
    return emptyFollowUpState();
  }
}

function emptyFollowUpState(): FollowUpState {
  return { prNumber: 0, round: 0, lastHeadSha: "", handledCommentIds: [], handledReviewIds: [], updatedAt: "" };
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
  botUsername: string
): boolean {
  const body = comment.body ?? "";
  if (!body.trim()) return false;
  if (isJumiInternalBody(body)) return false;
  if (loginEquals(comment.user?.login, botUsername)) return false;
  return true;
}

export function isRequestChangesReview(review: GiteaPullReview): boolean {
  const blob = `${review.state ?? ""} ${review.type ?? ""}`.toLowerCase();
  return (
    blob.includes("request") ||
    blob.includes("reject") ||
    blob.includes("request_changes") ||
    blob.includes("pull_request_review_rejected")
  );
}

export function isCommentReview(review: GiteaPullReview): boolean {
  const blob = `${review.state ?? ""} ${review.type ?? ""}`.toLowerCase();
  return blob.includes("comment");
}

export async function collectFollowUpItems(
  api: IssueApi,
  owner: string,
  repo: string,
  prNumber: number,
  botUsername: string
): Promise<{ comments: GiteaComment[]; inlines: GiteaPullReviewComment[]; reviews: GiteaPullReview[] }> {
  const [rawComments, rawReviews, rawInlines] = await Promise.all([
    api.listIssueComments(owner, repo, prNumber),
    api.listPullReviews(owner, repo, prNumber),
    api.listPullReviewComments(owner, repo, prNumber).catch((err: unknown): GiteaPullReviewComment[] => {
      logDefault(
        `inline review comments unavailable for ${owner}/${repo}#${prNumber}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return [];
    }),
  ]);
  return {
    comments: rawComments.filter((comment) => isInScopeHumanComment(comment, botUsername)),
    inlines: rawInlines.filter((comment) => isInScopeHumanComment(comment, botUsername)),
    reviews: rawReviews.filter(
      (review) =>
        (isRequestChangesReview(review) || isCommentReview(review)) &&
        isInScopeHumanComment({ body: review.body ?? review.content ?? "", user: review.user }, botUsername)
    ),
  };
}

function hasUnhandledFollowUpItems(
  items: { comments: GiteaComment[]; inlines: GiteaPullReviewComment[]; reviews: GiteaPullReview[] },
  state: Pick<FollowUpState, "handledCommentIds" | "handledReviewIds">
): boolean {
  const handledComments = new Set(state.handledCommentIds);
  const handledReviews = new Set(state.handledReviewIds);
  const unhandledComments = [...items.comments, ...items.inlines].some((comment) => !handledComments.has(comment.id));
  const unhandledReviews = items.reviews.some((review) => !handledReviews.has(review.id));
  return unhandledComments || unhandledReviews;
}

export async function needsFollowUp(opts: {
  api: IssueApi;
  owner: string;
  repo: string;
  pr: GiteaPR;
  issueNumber: number;
  botUsername: string;
  home: string;
}): Promise<boolean> {
  const state = await readFollowUpState(followUpStatePath(opts.home, opts.owner, opts.repo, opts.issueNumber));
  if (state.round >= MAX_FOLLOWUP_ROUNDS) return false;
  const items = await collectFollowUpItems(opts.api, opts.owner, opts.repo, opts.pr.number, opts.botUsername);
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
  pr: GiteaPR;
  trigger?: IssueJob["trigger"];
  triggerBody?: string;
  comments: GiteaComment[];
  inlines: GiteaPullReviewComment[];
  reviews: GiteaPullReview[];
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
    triggerLines.push("Event: scan");
    triggerLines.push("");
  }
  triggerLines.push("");
  const triggerSection = triggerLines.join("\n");

  const extras: FeedbackItem[] = [];
  for (const comment of opts.comments) {
    if (opts.trigger?.commentId === comment.id) continue;
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
  const fit: FeedbackItem[] = [...extras];
  const sizeOf = (items: FeedbackItem[]) => {
    const extra = items.length ? otherHeader + items.map((item) => item.text).join("\n") : "";
    return encoder.encode(header + triggerSection + extra).byteLength;
  };
  while (fit.length > 0 && sizeOf(fit) > FEEDBACK_MAX_BYTES) fit.shift();

  let markdown = header + triggerSection + (fit.length ? otherHeader + fit.map((item) => item.text).join("\n") : "");
  if (encoder.encode(markdown).byteLength > FEEDBACK_MAX_BYTES) {
    markdown = markdown.slice(0, FEEDBACK_MAX_BYTES);
  }

  const commentIds = new Set<number>();
  const reviewIds = new Set<number>();
  if (opts.trigger?.commentId !== undefined) commentIds.add(opts.trigger.commentId);
  if (opts.trigger?.reviewId !== undefined) reviewIds.add(opts.trigger.reviewId);
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
  items: { comments: GiteaComment[]; inlines: GiteaPullReviewComment[]; reviews: GiteaPullReview[] }
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

export async function implementFollowUp(opts: ImplementOptions): Promise<FollowUpResult> {
  const log = opts.logger ?? logDefault;
  const now = () => opts.now?.() ?? new Date();
  const pidAlive = opts.pidAlive ?? isPidAlive;
  const git = opts.gitRunner ?? runGit;
  const openCodeRunner = opts.openCodeRunner ?? runOpenCode;
  const owner = assertSafeSegment(opts.job.owner, "owner");
  const repo = assertSafeSegment(opts.job.repo, "repo");
  const issueNumber = opts.job.issueNumber;
  const worktree = join(opts.workdir, owner, repo, String(issueNumber));
  const barePath = join(opts.workdir, "_cache", owner, `${repo}.git`);
  const claimPath = claimFilePath(opts.home, owner, repo, issueNumber);
  const statePath = followUpStatePath(opts.home, owner, repo, issueNumber);
  const sanitizeEnv = opts.sanitizeOpenCodeEnv ?? true;

  throwIfAborted(opts.abortSignal);

  const startedAt = now().toISOString();
  const existingClaim = await readClaim(claimPath);
  if (existingClaim?.terminal) await deleteClaim(claimPath);

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
  const acquired = await acquireClaim(claimPath, claim, { pidAlive, nowMs: now().getTime() });
  if (!acquired) {
    return { status: "skipped", reason: "claim is live" };
  }

  const sticky = (body: string, index: number) =>
    upsertWorkerComment(opts.api, owner, repo, issueNumber, opts.botUsername, body, { index });

  try {
    const currentIssue = await opts.api.getIssue(owner, repo, issueNumber);
    if (!isAssignedToBot(currentIssue, opts.botUsername) || currentIssue.state !== "open") {
      await deleteClaim(claimPath);
      return { status: "cancelled" };
    }
  } catch (err) {
    await deleteClaim(claimPath);
    return { status: "skipped", reason: `failed to load issue: ${err instanceof Error ? err.message : String(err)}` };
  }

  const pr = await findOpenJumiClosingPullRequest(opts.api, owner, repo, issueNumber, opts.botUsername);
  if (!pr) {
    await deleteClaim(claimPath);
    return { status: "skipped", reason: "no open jumi closing PR" };
  }

  const branch = pr.head.ref;
  claim.branch = branch;
  if (!branch || branch === opts.job.defaultBranch) {
    await deleteClaim(claimPath);
    return { status: "skipped", reason: "refusing to follow up on the default branch" };
  }

  const state = await readFollowUpState(statePath);
  if (state.round >= MAX_FOLLOWUP_ROUNDS) {
    await sticky("stuck: too many follow-up rounds", pr.number);
    await deleteClaim(claimPath);
    return { status: "skipped", reason: "stuck: too many follow-up rounds" };
  }
  if (
    (opts.job.trigger?.commentId !== undefined && state.handledCommentIds.includes(opts.job.trigger.commentId)) ||
    (opts.job.trigger?.reviewId !== undefined && state.handledReviewIds.includes(opts.job.trigger.reviewId))
  ) {
    await deleteClaim(claimPath);
    return { status: "skipped", reason: "comment already handled" };
  }
  const pendingItems = await collectFollowUpItems(opts.api, owner, repo, pr.number, opts.botUsername);
  if (!hasUnhandledFollowUpItems(pendingItems, state)) {
    await deleteClaim(claimPath);
    return { status: "skipped", reason: "no unhandled feedback" };
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
    heartbeatMs > 0
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
  if (opts.job.trigger?.commentId !== undefined) handledCommentIds.push(opts.job.trigger.commentId);
  if (opts.job.trigger?.reviewId !== undefined) handledReviewIds.push(opts.job.trigger.reviewId);

  const recordAttempt = async (headSha: string) => {
    const uniqueComments = [...new Set(handledCommentIds)];
    const uniqueReviews = [...new Set(handledReviewIds)];
    await writeFollowUpState(statePath, {
      prNumber: pr.number,
      round: state.round + 1,
      lastHeadSha: headSha,
      handledCommentIds: uniqueComments,
      handledReviewIds: uniqueReviews,
      updatedAt: now().toISOString(),
    });
  };

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
      await deleteClaim(claimPath);
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
    await serializeClaim(async () => {
      if (heartbeatStopped) return;
      claim.headShaAtStart = headSha;
      claim.heartbeatAt = now().toISOString();
      await writeClaim(claimPath, claim);
    });

    const currentIssue = await opts.api.getIssue(owner, repo, issueNumber);
    const taskJob: IssueJob = {
      ...opts.job,
      title: currentIssue.title,
      body: currentIssue.body ?? "",
      htmlUrl: currentIssue.html_url,
    };
    const items = await collectFollowUpItems(opts.api, owner, repo, pr.number, opts.botUsername);
    const feedback = buildFeedbackMarkdown({
      pr,
      trigger: opts.job.trigger,
      triggerBody: triggerBodyFromItems(opts.job.trigger, items),
      comments: items.comments,
      inlines: items.inlines,
      reviews: items.reviews,
    });
    handledCommentIds = [...handledCommentIds, ...feedback.commentIds];
    handledReviewIds = [...handledReviewIds, ...feedback.reviewIds];

    throwIfAborted(opts.abortSignal);
    await writeFile(join(worktree, "JUMI_TASK.md"), buildTaskMarkdown(taskJob));
    await writeFile(join(worktree, "JUMI_FEEDBACK.md"), feedback.markdown);
    await sticky("Jumi is addressing review comments.", pr.number);

    throwIfAborted(opts.abortSignal);
    log(`Running OpenCode follow-up for ${owner}/${repo}#${issueNumber} PR ${pr.number}`);
    await openCodeRunner(FOLLOWUP_PROMPT, {
      model: opts.model,
      workdir: worktree,
      configPath: opts.opencodeConfig,
      home: opts.home,
      sanitizeEnv,
      extraEnv: gitOpenCodeChildEnv({
        giteaUrl: opts.giteaUrl,
        username: opts.botUsername,
        token: opts.giteaToken,
      }),
      timeoutMs: FOLLOWUP_TIMEOUT_MS,
      maxOutputBytes: opts.maxOutputBytes,
      reviewLabel: `${owner}/${repo}#${issueNumber}`,
      logger: log,
      onPid: async (pid) => {
        await serializeClaim(async () => {
          if (heartbeatStopped) return;
          const current = await readClaim(claimPath);
          if (heartbeatStopped || !current || current.terminal) return;
          current.pid = pid;
          current.heartbeatAt = now().toISOString();
          await writeClaim(claimPath, current);
        });
      },
    });

    throwIfAborted(opts.abortSignal);
    await rm(join(worktree, "JUMI_TASK.md"), { force: true });
    await rm(join(worktree, "JUMI_FEEDBACK.md"), { force: true });
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
          await deleteClaim(claimPath);
        });
        await detachWorktree();
        return { status: "no-changes" };
      }
    }

    if (porcelain) {
      const commitEnv = {
        ...env,
        GIT_AUTHOR_NAME: COMMIT_NAME,
        GIT_AUTHOR_EMAIL: COMMIT_EMAIL,
        GIT_COMMITTER_NAME: COMMIT_NAME,
        GIT_COMMITTER_EMAIL: COMMIT_EMAIL,
      };
      await runConfiguredGit(["add", "-A"], { cwd: worktree, env: commitEnv });
      await runConfiguredGit(["commit", "-m", `Address review on #${pr.number}: ${opts.job.title}`], {
        cwd: worktree,
        env: commitEnv,
      });
    }
    await runConfiguredGit(["push", "-u", "origin", branch], { cwd: worktree, env });
    throwIfAborted(opts.abortSignal);

    const sha = (await runConfiguredGit(["rev-parse", "HEAD"], { cwd: worktree, env })).trim();
    await sticky(`Pushed follow-up to ${pr.html_url}`, pr.number);
    await recordAttempt(sha || pr.head.sha);
    await stopHeartbeat();
    await serializeClaim(async () => {
      await deleteClaim(claimPath);
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
    await writeFollowUpState(statePath, {
      prNumber: pr.number,
      round: state.round + 1,
      lastHeadSha: pr.head.sha,
      handledCommentIds: state.handledCommentIds,
      handledReviewIds: state.handledReviewIds,
      updatedAt: now().toISOString(),
    }).catch(() => undefined);
    await stopHeartbeat();
    await serializeClaim(async () => {
      await deleteClaim(claimPath);
    }).catch(() => undefined);
    await detachWorktree();
    throw err;
  } finally {
    await stopHeartbeat();
  }
}
