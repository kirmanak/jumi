import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PickupPolicy } from "./assignee.ts";
import { claimFilePath, deleteClaim, isPidAlive, readClaim } from "./claim.ts";
import {
  attachIssueWorktree,
  beginClaimedWorktree,
  commitIfDirty,
  commitsAheadOf,
  ensureBareCache,
  isClaimedEarlyResult,
  openClaimedLoop,
  pushClaimedBranch,
  recheckAssignedAndOpen,
  runClaimedLoop,
  skipClaimedWork,
  stripSentinels,
  throwIfAborted,
  worktreePorcelain,
} from "./claimed_worktree.ts";
import type { ConflictResult } from "./conflict.ts";
import {
  BLOCKED_BY_FILE,
  BLOCKED_BY_REJECTED_STUCK,
  blockedOnComment,
  checkIssueBlockers,
  collectCandidateQueue,
  formatQueueMarkdown,
  parseBlockedByArtifact,
  QUEUE_FILE,
  type QueueCandidate,
  validateYield,
} from "./dependencies.ts";
import { type Engine, throwIfEngineFailed } from "./engine.ts";
import type { FollowUpResult } from "./followup.ts";
import { BLOCKED_BY_REJECTED_PROMPT, IMPLEMENT_YIELD_PROMPT, openCodeEngine } from "./git.ts";
import { closesIssuePattern, pullRequestClosesIssue, upsertWorkerComment } from "./gitea_issues.ts";
import { gateShipAfterOpenCode, jobWithIssue, type ShipGate, snapshotFromJob } from "./issue_recheck.ts";
import { isJumiCloserForIssue, runCloserWork } from "./pickup.ts";
import type { IssueApi } from "./ports.ts";
import { isQuotaError, isQuotaText, QUOTA_STUCK_TEXT } from "./quota.ts";
import { type SkipLatchStore, skipLatchesFor } from "./skip_latches.ts";
import {
  appendStuckLatchFingerprint,
  evaluateStuck,
  fingerprintError,
  isQuotaStuck,
  markQuotaStuckLatch,
  readStuckLatch,
  stuckComment,
} from "./stuck.ts";
import type { IssueJob } from "./types.ts";
import { type GitAuthResolver, type GitRunner, workerOpenCodeChildEnv } from "./workspace.ts";

export { HEARTBEAT_INTERVAL_MS } from "./claimed_worktree.ts";
export { BLOCKED_BY_REJECTED_PROMPT, IMPLEMENT_PROMPT, IMPLEMENT_YIELD_PROMPT } from "./git.ts";

const PR_BODY_MAX_CHARS = 8000;
const PR_DESCRIPTION_FILE = "JUMI_PR.md";

export type OpenCodeRunner = Engine;

export type HelmRunner = (args: string[], opts: { cwd: string }) => Promise<string>;

export type ImplementResult =
  | { status: "pr"; htmlUrl: string; prNumber: number }
  | { status: "no-changes" }
  | { status: "skipped"; reason: string }
  | { status: "cancelled" };

export interface ImplementOptions extends PickupPolicy {
  api: IssueApi;
  job: IssueJob;
  giteaUrl: string;
  giteaToken: string;
  followupIgnoreLogins?: readonly string[];
  model: string;
  variant?: string;
  fallbackModel?: string;
  fallbackVariant?: string;
  remainingLeaseMs?: () => number | Promise<number>;
  extendLease?: () => Promise<boolean>;
  home: string;
  workdir: string;
  timeoutMs?: number;
  followupTimeoutMs?: number;
  conflictTimeoutMs?: number;
  maxFollowupRounds?: number;
  maxConflictRounds?: number;
  maxOutputBytes?: number;
  sanitizeOpenCodeEnv?: boolean;
  heartbeatIntervalMs?: number;
  abortSignal?: AbortSignal;
  gitRunner?: GitRunner;
  gitAuthResolver?: GitAuthResolver;
  engine?: Engine;
  openCodeRunner?: Engine;
  helmRunner?: HelmRunner;
  now?: () => Date;
  pid?: number;
  pidAlive?: (pid: number) => boolean;
  logger?: (message: string) => void;
  useClaim?: boolean;
  onPid?: (pid: number) => void | Promise<void>;
  jobId?: string;
  skipLatches?: SkipLatchStore;
}

function logDefault(message: string) {
  console.log(`[implement] ${message}`);
}

export function issueBranchName(issueNumber: number, title: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task";
  return `jumi/issue-${issueNumber}-${slug}`;
}

export function issueJobKey(job: { owner: string; repo: string; issueNumber: number }): string {
  return `${job.owner}/${job.repo}#${job.issueNumber}`;
}

export function buildTaskMarkdown(job: IssueJob): string {
  return `# ${job.title}\n\n${job.body}\n\n${job.htmlUrl}\n`;
}

export function buildPullRequestBody(issueNumber: number, fileContents: string | null | undefined): string {
  const fallback = `Fixes #${issueNumber}`;
  if (fileContents == null) return fallback;
  let text = fileContents.replaceAll("\0", "").trim();
  if (!text) return fallback;
  if (text.length > PR_BODY_MAX_CHARS) text = text.slice(0, PR_BODY_MAX_CHARS);
  if (closesIssuePattern(issueNumber).test(text)) return text;
  return `${text}\n\n${fallback}`;
}

async function readPullRequestDescription(worktree: string): Promise<string | null> {
  const path = join(worktree, PR_DESCRIPTION_FILE);
  try {
    const info = await lstat(path);
    if (!info.isFile()) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export async function implementIssue(
  opts: ImplementOptions
): Promise<ImplementResult | FollowUpResult | ConflictResult> {
  const log = opts.logger ?? logDefault;
  const branch = issueBranchName(opts.job.issueNumber, opts.job.title);
  const claimed = await beginClaimedWorktree({
    ...opts,
    fallbackEngine: openCodeEngine,
    branch,
  });
  if (isClaimedEarlyResult(claimed)) return claimed;
  const { owner, repo, issueNumber, worktree, barePath, sanitizeEnv, engine, now, forgetClaim } = claimed;

  const pulls = await opts.api.listOpenPulls(owner, repo);
  const jumiCloser = pulls.find((pr) => isJumiCloserForIssue(pr, owner, repo, issueNumber, opts.botUsername));
  if (jumiCloser) {
    await forgetClaim();
    return runCloserWork(opts, jumiCloser);
  }
  if (pulls.some((pr) => pullRequestClosesIssue(pr, issueNumber))) {
    await forgetClaim();
    return { status: "skipped", reason: `open PR already closes #${issueNumber}` };
  }

  const assigned = await recheckAssignedAndOpen(claimed, opts);
  if (assigned) return assigned;

  try {
    const blockers = await checkIssueBlockers(opts.api, owner, repo, issueNumber);
    if (blockers.status === "stuck") {
      await upsertWorkerComment(opts.api, owner, repo, issueNumber, opts.botUsername, blockers.reason);
      await forgetClaim();
      return { status: "skipped", reason: blockers.reason };
    }
    if (blockers.status === "blocked") {
      const reason = blockedOnComment(blockers.blockers, owner, repo);
      await upsertWorkerComment(opts.api, owner, repo, issueNumber, opts.botUsername, reason);
      await forgetClaim();
      return { status: "skipped", reason };
    }
  } catch (err) {
    await forgetClaim();
    return {
      status: "skipped",
      reason: `failed to load dependencies: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const latches = skipLatchesFor(opts);
  const latchKey = { owner, repo, issueNumber };
  const stuckState = await readStuckLatch(latches, latchKey);
  if (isQuotaStuck(stuckState)) {
    await upsertWorkerComment(opts.api, owner, repo, issueNumber, opts.botUsername, QUOTA_STUCK_TEXT);
    await forgetClaim();
    return { status: "skipped", reason: QUOTA_STUCK_TEXT };
  }
  const stuckReason = evaluateStuck(stuckState.fingerprints);
  if (stuckReason) {
    await upsertWorkerComment(opts.api, owner, repo, issueNumber, opts.botUsername, stuckComment(stuckReason));
    await forgetClaim();
    return { status: "skipped", reason: stuckComment(stuckReason) };
  }

  let queue: QueueCandidate[] = [];
  try {
    queue = await collectCandidateQueue({
      api: opts.api,
      owner,
      repo,
      issueNumber,
      botUsername: opts.botUsername,
      body: opts.job.body,
      pulls,
    });
  } catch (err) {
    await forgetClaim();
    return {
      status: "skipped",
      reason: `failed to load candidate queue: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const loop = openClaimedLoop(claimed, opts);

  return runClaimedLoop(
    loop,
    opts.abortSignal,
    async () => {
      await ensureBareCache(loop, {
        cloneUrl: opts.job.cloneUrl,
        giteaUrl: opts.giteaUrl,
        abortSignal: opts.abortSignal,
        log,
      });
      const headSha = await attachIssueWorktree(loop, {
        branch,
        defaultBranch: opts.job.defaultBranch,
        abortSignal: opts.abortSignal,
        log,
      });
      await loop.stampHeadSha(headSha);

      throwIfAborted(opts.abortSignal);
      const writeTaskFiles = async () => {
        await writeFile(join(worktree, "JUMI_TASK.md"), buildTaskMarkdown(opts.job));
        if (queue.length > 0) {
          await writeFile(join(worktree, QUEUE_FILE), formatQueueMarkdown(queue, owner, repo));
        } else {
          await rm(join(worktree, QUEUE_FILE), { force: true }).catch(() => undefined);
        }
        await rm(join(worktree, BLOCKED_BY_FILE), { force: true }).catch(() => undefined);
      };
      await writeTaskFiles();
      await upsertWorkerComment(
        opts.api,
        owner,
        repo,
        issueNumber,
        opts.botUsername,
        "Jumi is implementing this issue."
      );

      const runEngine = async (
        label: string,
        kind: "implement" | "follow-up" = "implement",
        prompt?: string
      ): Promise<ImplementResult | undefined> => {
        throwIfAborted(opts.abortSignal);
        log(label);
        const result = await engine({
          model: opts.model,
          variant: opts.variant,
          workdir: worktree,
          home: opts.home,
          sanitizeEnv,
          extraEnv: workerOpenCodeChildEnv(loop.auth, worktree),
          timeoutMs: opts.timeoutMs,
          maxOutputBytes: opts.maxOutputBytes,
          reviewLabel: `${owner}/${repo}#${issueNumber}`,
          trace: {
            kind,
            owner,
            repo,
            sha: headSha,
            jobId: opts.jobId ?? opts.job.delivery,
          },
          ...(prompt != null ? { prompt } : {}),
          logger: log,
          abortSignal: opts.abortSignal,
          onPid: loop.engineOnPid(opts.onPid),
        });
        // Gate on the message: only the quota path returns engine `stuck`
        // today, but a future non-quota producer must not set the quota flag.
        if (result.status === "stuck" && isQuotaText(result.message)) {
          await upsertWorkerComment(opts.api, owner, repo, issueNumber, opts.botUsername, QUOTA_STUCK_TEXT);
          await markQuotaStuckLatch(latches, latchKey, QUOTA_STUCK_TEXT, now).catch(() => undefined);
          return skipClaimedWork(loop, QUOTA_STUCK_TEXT);
        }
        throwIfEngineFailed(result);
        return undefined;
      };

      const addWorktreeFromDefault = async () => {
        await mkdir(dirname(worktree), { recursive: true });
        await loop.runConfiguredGit(["worktree", "add", "-B", branch, worktree, `origin/${opts.job.defaultBranch}`], {
          cwd: barePath,
          env: loop.env,
        });
        await mkdir(worktree, { recursive: true });
      };

      const deleteRefIfPresent = async (ref: string) => {
        if (!(await loop.refExists(ref))) return;
        await loop.runConfiguredGit(["update-ref", "-d", ref], { cwd: barePath, env: loop.env });
      };

      const deletePushedIssueBranch = async () => {
        if (branch === opts.job.defaultBranch) return;
        await loop.detachWorktree();
        await deleteRefIfPresent(`refs/heads/${branch}`);
        try {
          await loop.runConfiguredGit(["push", "origin", "--delete", branch], { cwd: barePath, env: loop.env });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!/remote ref does not exist/i.test(msg)) throw err;
        }
        await deleteRefIfPresent(`refs/remotes/origin/${branch}`);
        await loop.runConfiguredGit(["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*"], {
          cwd: barePath,
          env: loop.env,
        });
        if (await loop.refExists(`refs/remotes/origin/${branch}`)) {
          throw new Error(`failed to delete origin/${branch}`);
        }
      };

      const readBlockedBy = async () => {
        const path = join(worktree, BLOCKED_BY_FILE);
        try {
          const info = await lstat(path);
          if (!info.isFile()) return parseBlockedByArtifact(null, owner, repo);
          return parseBlockedByArtifact(await readFile(path, "utf8"), owner, repo);
        } catch {
          return parseBlockedByArtifact(null, owner, repo);
        }
      };

      const skipBlocked = async (reason: string) => {
        await upsertWorkerComment(opts.api, owner, repo, issueNumber, opts.botUsername, reason);
        return skipClaimedWork(loop, reason);
      };

      const applyValidYield = async (blocker: { owner: string; repo: string; number: number }) => {
        try {
          await opts.api.createIssueDependency(owner, repo, issueNumber, {
            owner: blocker.owner,
            repo: blocker.repo,
            number: blocker.number,
          });
        } catch (err) {
          await deletePushedIssueBranch().catch(() => undefined);
          return skipBlocked(`failed to set dependency: ${err instanceof Error ? err.message : String(err)}`);
        }
        await deletePushedIssueBranch().catch(() => undefined);
        return skipBlocked(blockedOnComment([blocker], owner, repo));
      };

      const resetAfterRejectedYield = async () => {
        await deletePushedIssueBranch();
        await addWorktreeFromDefault();
        await writeTaskFiles();
      };

      const handleYield = async (rejectedOnce: boolean): Promise<ImplementResult | "continue" | "retry"> => {
        if (queue.length === 0) return "continue";
        const artifact = await readBlockedBy();
        if (!artifact.present) return "continue";
        const decision = validateYield(artifact.parsed, queue, owner, repo, issueNumber);
        if (decision.ok) return applyValidYield(decision.blocker);
        if (!rejectedOnce) return "retry";
        await deletePushedIssueBranch();
        return skipBlocked(BLOCKED_BY_REJECTED_STUCK);
      };

      const quotaSkip = await runEngine(
        `Running OpenCode for ${owner}/${repo}#${issueNumber}`,
        "implement",
        queue.length > 0 ? IMPLEMENT_YIELD_PROMPT : undefined
      );
      if (quotaSkip) return quotaSkip;

      const firstYield = await handleYield(false);
      if (firstYield === "retry") {
        log(`blocked-by rejected, implement ${owner}/${repo}#${issueNumber}`);
        await resetAfterRejectedYield();
        const quotaRetry = await runEngine(
          `Re-running OpenCode after blocked-by rejected for ${owner}/${repo}#${issueNumber}`,
          "implement",
          BLOCKED_BY_REJECTED_PROMPT
        );
        if (quotaRetry) return quotaRetry;
        const secondYield = await handleYield(true);
        if (secondYield === "retry") return skipBlocked(BLOCKED_BY_REJECTED_STUCK);
        if (secondYield !== "continue") return secondYield;
      } else if (firstYield !== "continue") {
        return firstYield;
      }

      let gate: ShipGate;
      try {
        gate = await gateShipAfterOpenCode({
          api: opts.api,
          owner,
          repo,
          issueNumber,
          botUsername: opts.botUsername,
          snapshot: snapshotFromJob(opts.job),
          continueOpenCode: async (issue) => {
            await writeFile(join(worktree, "JUMI_TASK.md"), buildTaskMarkdown(jobWithIssue(opts.job, issue)));
            const quotaContinued = await runEngine(
              `Re-running OpenCode after issue change for ${owner}/${repo}#${issueNumber}`,
              "follow-up"
            );
            if (quotaContinued) throw new Error(QUOTA_STUCK_TEXT);
          },
        });
      } catch (err) {
        if (isQuotaError(err)) {
          return skipClaimedWork(loop, QUOTA_STUCK_TEXT);
        }
        throw err;
      }
      if (gate.action === "skip") {
        return skipClaimedWork(loop, gate.reason, { detach: !gate.keepLocalWork });
      }
      const liveJob = jobWithIssue(opts.job, gate.issue);

      throwIfAborted(opts.abortSignal);
      const prFileContents = await readPullRequestDescription(worktree);
      await stripSentinels(worktree, [PR_DESCRIPTION_FILE, "JUMI_TASK.md", QUEUE_FILE, BLOCKED_BY_FILE]);
      const porcelain = await worktreePorcelain(loop);
      if (!porcelain && (await commitsAheadOf(loop, `origin/${opts.job.defaultBranch}`)) <= 0) {
        await loop.stopHeartbeat();
        await upsertWorkerComment(opts.api, owner, repo, issueNumber, opts.botUsername, "no changes");
        await loop.stampTerminalClaim(opts.api);
        await loop.detachWorktree();
        return { status: "no-changes" };
      }

      if (branch === opts.job.defaultBranch) {
        throw new Error("refusing to commit on the default branch");
      }

      await commitIfDirty(loop, porcelain, `Implement #${issueNumber}: ${liveJob.title}`);
      throwIfAborted(opts.abortSignal);
      await pushClaimedBranch(loop, branch);
      throwIfAborted(opts.abortSignal);

      const pr = await opts.api.createPullRequest(owner, repo, {
        title: liveJob.title,
        body: buildPullRequestBody(issueNumber, prFileContents),
        head: branch,
        base: opts.job.defaultBranch,
      });
      await upsertWorkerComment(opts.api, owner, repo, issueNumber, opts.botUsername, `Opened ${pr.html_url}`);
      await loop.stopHeartbeat();
      await loop.forgetSerialized();
      await loop.detachWorktree();
      return { status: "pr", htmlUrl: pr.html_url, prNumber: pr.number };
    },
    async (err) => {
      if (isQuotaError(err)) {
        await upsertWorkerComment(opts.api, owner, repo, issueNumber, opts.botUsername, QUOTA_STUCK_TEXT).catch(
          () => undefined
        );
        await markQuotaStuckLatch(latches, latchKey, QUOTA_STUCK_TEXT, now).catch(() => undefined);
        await loop.stopHeartbeat();
        await loop.forgetSerialized().catch(() => undefined);
        await loop.detachWorktree();
        return;
      }
      await upsertWorkerComment(
        opts.api,
        owner,
        repo,
        issueNumber,
        opts.botUsername,
        `Jumi failed: ${err instanceof Error ? err.message : String(err)}`
      ).catch(() => undefined);
      const errorHash = fingerprintError(err instanceof Error ? err.message : String(err));
      if (errorHash) {
        await appendStuckLatchFingerprint(latches, latchKey, { kind: "error", hash: errorHash }, now).catch(
          () => undefined
        );
      }
      await loop.stopHeartbeat();
      await loop.stampTerminalClaim(opts.api).catch(() => undefined);
      await loop.detachWorktree();
    }
  );
}

export async function cancelIssueWork(opts: {
  api: IssueApi;
  owner: string;
  repo: string;
  issueNumber: number;
  botUsername: string;
  home: string;
  pidAlive?: (pid: number) => boolean;
  killPid?: (pid: number) => void;
  skipLatches?: SkipLatchStore;
}): Promise<void> {
  const claimPath = claimFilePath(opts.home, opts.owner, opts.repo, opts.issueNumber);
  const claim = await readClaim(claimPath);
  const pidAlive = opts.pidAlive ?? isPidAlive;
  const killPid = opts.killPid ?? ((pid: number) => process.kill(pid));
  if (claim && claim.pid > 0 && claim.pid !== process.pid && pidAlive(claim.pid)) {
    try {
      killPid(claim.pid);
    } catch {
      // Child may have already exited.
    }
  }
  await upsertWorkerComment(opts.api, opts.owner, opts.repo, opts.issueNumber, opts.botUsername, "stopped");
  await deleteClaim(claimPath);
  await skipLatchesFor(opts).delete({
    owner: opts.owner,
    repo: opts.repo,
    issueNumber: opts.issueNumber,
  });
}
