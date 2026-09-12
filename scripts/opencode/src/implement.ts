import { access, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PickupPolicy } from "./assignee.ts";
import {
  ciStatePath,
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
  beginClaimedWorktree,
  isAbortError,
  isClaimedEarlyResult,
  recheckAssignedAndOpen,
  throwIfAborted,
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
import {
  closesIssuePattern,
  isAssignedForeignPR,
  pullRequestClosesIssue,
  upsertWorkerComment,
} from "./gitea_issues.ts";
import { gateShipAfterOpenCode, jobWithIssue, snapshotFromJob } from "./issue_recheck.ts";
import { isJumiCloserForIssue, runCloserWork } from "./pickup.ts";
import type { IssueApi } from "./ports.ts";
import {
  appendStuckFingerprint,
  deleteStuckState,
  evaluateStuck,
  fingerprintError,
  readStuckState,
  stuckComment,
} from "./stuck.ts";
import type { IssueJob } from "./types.ts";
import {
  type GitAuth,
  type GitAuthResolver,
  type GitRunner,
  gitConfigArgs,
  gitEnv,
  gitRemoteUrl,
  resolveGitAuth,
  validateCloneUrl,
  workerOpenCodeChildEnv,
} from "./workspace.ts";

export { BLOCKED_BY_REJECTED_PROMPT, IMPLEMENT_PROMPT, IMPLEMENT_YIELD_PROMPT } from "./git.ts";

export const HEARTBEAT_INTERVAL_MS = 30_000;
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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
  const {
    owner,
    repo,
    issueNumber,
    worktree,
    barePath,
    claimPath,
    claim,
    useClaim,
    sanitizeEnv,
    engine,
    git,
    now,
    forgetClaim,
  } = claimed;

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
  if (pulls.some((pr) => isAssignedForeignPR(pr, owner, repo, opts.botUsername))) {
    await forgetClaim();
    return { status: "skipped", reason: "assigned PR is the job for this repo" };
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

  const stuckPath = stuckStatePath(opts.home, owner, repo, issueNumber);
  const stuckReason = evaluateStuck((await readStuckState(stuckPath)).fingerprints);
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

  const configArgs = gitConfigArgs();
  let auth: GitAuth = { giteaUrl: opts.giteaUrl, username: opts.botUsername, token: opts.giteaToken };
  let env = gitEnv(auth);
  const refreshGitAuth = async () => {
    auth = await resolveGitAuth(opts);
    env = gitEnv(auth);
  };
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
  const stampTerminalClaim = async () => {
    if (!useClaim) return;
    let updatedAt = claim.issueUpdatedAt;
    try {
      const current = await opts.api.getIssue(owner, repo, issueNumber);
      if (current.updated_at) updatedAt = current.updated_at;
    } catch {
      // Keep the timestamp we already have.
    }
    await serializeClaim(async () => {
      claim.pid = 0;
      claim.terminal = true;
      claim.issueUpdatedAt = updatedAt;
      claim.heartbeatAt = now().toISOString();
      await writeClaim(claimPath, claim);
    });
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

  try {
    throwIfAborted(opts.abortSignal);
    await refreshGitAuth();
    const cloneUrl = validateCloneUrl(opts.job.cloneUrl, opts.giteaUrl);
    await mkdir(dirname(barePath), { recursive: true });
    if (await pathExists(barePath)) {
      log(`Fetching ${owner}/${repo} cache`);
      await runConfiguredGit(["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*"], { cwd: barePath, env });
    } else {
      log(`Cloning ${owner}/${repo} into bare cache`);
      await runConfiguredGit(["clone", "--bare", gitRemoteUrl(cloneUrl, auth), barePath], {
        cwd: dirname(barePath),
        env,
      });
      if (auth.embedTokenInUrl) {
        await runConfiguredGit(["remote", "set-url", "origin", cloneUrl], { cwd: barePath, env });
      }
      await runConfiguredGit(["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*"], { cwd: barePath, env });
    }
    throwIfAborted(opts.abortSignal);

    const refExists = async (ref: string) => {
      try {
        await runConfiguredGit(["show-ref", "--verify", "--quiet", ref], { cwd: barePath, env });
        return true;
      } catch {
        return false;
      }
    };

    if (!(await pathExists(join(worktree, ".git")))) {
      await mkdir(dirname(worktree), { recursive: true });
      if (await refExists(`refs/heads/${branch}`)) {
        log(`Adding worktree ${worktree} from existing ${branch}`);
        await runConfiguredGit(["worktree", "add", worktree, branch], { cwd: barePath, env });
      } else if (await refExists(`refs/remotes/origin/${branch}`)) {
        log(`Adding worktree ${worktree} from origin/${branch}`);
        await runConfiguredGit(["worktree", "add", "-B", branch, worktree, `origin/${branch}`], {
          cwd: barePath,
          env,
        });
      } else {
        log(`Adding worktree ${worktree} on ${branch}`);
        await runConfiguredGit(["worktree", "add", "-B", branch, worktree, `origin/${opts.job.defaultBranch}`], {
          cwd: barePath,
          env,
        });
      }
    }
    await mkdir(worktree, { recursive: true });
    await runConfiguredGit(["checkout", "-B", branch], { cwd: worktree, env });
    throwIfAborted(opts.abortSignal);

    const headSha = (await runConfiguredGit(["rev-parse", "HEAD"], { cwd: worktree, env })).trim();
    await serializeClaim(async () => {
      if (heartbeatStopped || !useClaim) return;
      claim.headShaAtStart = headSha;
      claim.heartbeatAt = now().toISOString();
      await writeClaim(claimPath, claim);
    });

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
    await upsertWorkerComment(opts.api, owner, repo, issueNumber, opts.botUsername, "Jumi is implementing this issue.");

    const runEngine = async (label: string, kind: "implement" | "follow-up" = "implement", prompt?: string) => {
      throwIfAborted(opts.abortSignal);
      log(label);
      throwIfEngineFailed(
        await engine({
          model: opts.model,
          workdir: worktree,
          home: opts.home,
          sanitizeEnv,
          extraEnv: workerOpenCodeChildEnv(auth, worktree),
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

    const addWorktreeFromDefault = async () => {
      await mkdir(dirname(worktree), { recursive: true });
      await runConfiguredGit(["worktree", "add", "-B", branch, worktree, `origin/${opts.job.defaultBranch}`], {
        cwd: barePath,
        env,
      });
      await mkdir(worktree, { recursive: true });
    };

    const deleteRefIfPresent = async (ref: string) => {
      if (!(await refExists(ref))) return;
      await runConfiguredGit(["update-ref", "-d", ref], { cwd: barePath, env });
    };

    const deletePushedIssueBranch = async () => {
      if (branch === opts.job.defaultBranch) return;
      await detachWorktree();
      await deleteRefIfPresent(`refs/heads/${branch}`);
      try {
        await runConfiguredGit(["push", "origin", "--delete", branch], { cwd: barePath, env });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/remote ref does not exist/i.test(msg)) throw err;
      }
      await deleteRefIfPresent(`refs/remotes/origin/${branch}`);
      await runConfiguredGit(["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*"], { cwd: barePath, env });
      if (await refExists(`refs/remotes/origin/${branch}`)) {
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
      await stopHeartbeat();
      await serializeClaim(async () => {
        await forgetClaim();
      });
      await detachWorktree();
      return { status: "skipped" as const, reason };
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

    await runEngine(
      `Running OpenCode for ${owner}/${repo}#${issueNumber}`,
      "implement",
      queue.length > 0 ? IMPLEMENT_YIELD_PROMPT : undefined
    );

    const firstYield = await handleYield(false);
    if (firstYield === "retry") {
      log(`blocked-by rejected, implement ${owner}/${repo}#${issueNumber}`);
      await resetAfterRejectedYield();
      await runEngine(
        `Re-running OpenCode after blocked-by rejected for ${owner}/${repo}#${issueNumber}`,
        "implement",
        BLOCKED_BY_REJECTED_PROMPT
      );
      const secondYield = await handleYield(true);
      if (secondYield === "retry") return skipBlocked(BLOCKED_BY_REJECTED_STUCK);
      if (secondYield !== "continue") return secondYield;
    } else if (firstYield !== "continue") {
      return firstYield;
    }

    const gate = await gateShipAfterOpenCode({
      api: opts.api,
      owner,
      repo,
      issueNumber,
      botUsername: opts.botUsername,
      snapshot: snapshotFromJob(opts.job),
      continueOpenCode: async (issue) => {
        await writeFile(join(worktree, "JUMI_TASK.md"), buildTaskMarkdown(jobWithIssue(opts.job, issue)));
        await runEngine(`Re-running OpenCode after issue change for ${owner}/${repo}#${issueNumber}`, "follow-up");
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
    const liveJob = jobWithIssue(opts.job, gate.issue);

    throwIfAborted(opts.abortSignal);
    const prFileContents = await readPullRequestDescription(worktree);
    await rm(join(worktree, PR_DESCRIPTION_FILE), { recursive: true, force: true }).catch(() => undefined);
    await rm(join(worktree, "JUMI_TASK.md"), { force: true });
    await rm(join(worktree, QUEUE_FILE), { force: true }).catch(() => undefined);
    await rm(join(worktree, BLOCKED_BY_FILE), { force: true }).catch(() => undefined);
    await rm(join(worktree, ".jumi-tmp"), { recursive: true, force: true });
    const porcelain = (await runConfiguredGit(["status", "--porcelain"], { cwd: worktree, env })).trim();
    if (!porcelain) {
      const aheadText = (
        await runConfiguredGit(["rev-list", "--count", `origin/${opts.job.defaultBranch}..HEAD`], {
          cwd: worktree,
          env,
        })
      ).trim();
      const ahead = Number(aheadText);
      if (!Number.isFinite(ahead) || ahead <= 0) {
        await stopHeartbeat();
        await upsertWorkerComment(opts.api, owner, repo, issueNumber, opts.botUsername, "no changes");
        await stampTerminalClaim();
        await detachWorktree();
        return { status: "no-changes" };
      }
    }

    if (branch === opts.job.defaultBranch) {
      throw new Error("refusing to commit on the default branch");
    }

    if (porcelain) {
      const commitEnv = {
        ...env,
        GIT_AUTHOR_NAME: env.GIT_AUTHOR_NAME,
        GIT_AUTHOR_EMAIL: env.GIT_AUTHOR_EMAIL,
        GIT_COMMITTER_NAME: env.GIT_COMMITTER_NAME,
        GIT_COMMITTER_EMAIL: env.GIT_COMMITTER_EMAIL,
      };
      await runConfiguredGit(["add", "-A"], { cwd: worktree, env: commitEnv });
      await runConfiguredGit(["commit", "-m", `Implement #${issueNumber}: ${liveJob.title}`], {
        cwd: worktree,
        env: commitEnv,
      });
    }
    throwIfAborted(opts.abortSignal);
    await refreshGitAuth();
    await runConfiguredGit(["push", "-u", "origin", branch], { cwd: worktree, env });
    throwIfAborted(opts.abortSignal);

    const pr = await opts.api.createPullRequest(owner, repo, {
      title: liveJob.title,
      body: buildPullRequestBody(issueNumber, prFileContents),
      head: branch,
      base: opts.job.defaultBranch,
    });
    await upsertWorkerComment(opts.api, owner, repo, issueNumber, opts.botUsername, `Opened ${pr.html_url}`);
    await stopHeartbeat();
    await serializeClaim(async () => {
      await forgetClaim();
    });
    await detachWorktree();
    return { status: "pr", htmlUrl: pr.html_url, prNumber: pr.number };
  } catch (err) {
    if (isAbortError(err) || opts.abortSignal?.aborted) {
      await stopHeartbeat();
      await detachWorktree();
      return { status: "cancelled" };
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
      await appendStuckFingerprint(stuckPath, { kind: "error", hash: errorHash }, now).catch(() => undefined);
    }
    await stopHeartbeat();
    await stampTerminalClaim().catch(() => undefined);
    await detachWorktree();
    throw err;
  } finally {
    await stopHeartbeat();
  }
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
  await deleteClaim(followUpStatePath(opts.home, opts.owner, opts.repo, opts.issueNumber));
  await deleteClaim(conflictStatePath(opts.home, opts.owner, opts.repo, opts.issueNumber));
  await deleteClaim(ciStatePath(opts.home, opts.owner, opts.repo, opts.issueNumber));
  await deleteStuckState(opts.home, opts.owner, opts.repo, opts.issueNumber);
}
