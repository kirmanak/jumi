import { access, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isIssuePickedUp, type PickupPolicy } from "./assignee.ts";
import type { ClaimRecord } from "./claim.ts";
import { acquireClaim, claimFilePath, deleteClaim, isPidAlive, readClaim, writeClaim } from "./claim.ts";
import { type Engine, resolveEngine } from "./engine.ts";
import { withEngineChain } from "./fallback.ts";
import { isInfraFailure } from "./infra.ts";
import type { IssueApi } from "./ports.ts";
import { isQuotaWaitError } from "./quota.ts";
import type { NamedRunner } from "./runners.ts";
import {
  type GitAuth,
  type GitAuthResolver,
  type GitRunner,
  gitConfigArgs,
  gitEnv,
  gitRemoteUrl,
  resolveGitAuth,
  runGit,
  validateCloneUrl,
} from "./workspace.ts";

export const HEARTBEAT_INTERVAL_MS = 30_000;

export type ClaimedEarlyResult = { status: "skipped"; reason: string } | { status: "cancelled" };

export interface ClaimedWorktree {
  owner: string;
  repo: string;
  issueNumber: number;
  worktree: string;
  barePath: string;
  claimPath: string;
  claim: ClaimRecord;
  useClaim: boolean;
  sanitizeEnv: boolean;
  engine: Engine;
  git: GitRunner;
  now: () => Date;
  forgetClaim: () => Promise<void>;
}

export interface BeginClaimedWorktreeOpts {
  job: {
    owner: string;
    repo: string;
    issueNumber: number;
    issueUpdatedAt: string;
  };
  home: string;
  workdir: string;
  engine?: Engine;
  openCodeRunner?: Engine;
  gitRunner?: GitRunner;
  abortSignal?: AbortSignal;
  now?: () => Date;
  pidAlive?: (pid: number) => boolean;
  useClaim?: boolean;
  sanitizeOpenCodeEnv?: boolean;
  fallbackEngine: Engine;
  fallbackModel?: string;
  fallbackVariant?: string;
  chain?: NamedRunner[];
  remainingLeaseMs?: () => number | Promise<number>;
  extendLease?: () => Promise<boolean>;
  logger?: (message: string) => void;
  branch?: string;
  forgetTerminal?: boolean;
}

export function isClaimedEarlyResult(value: object): value is ClaimedEarlyResult {
  return "status" in value;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const err = new Error("cancelled");
  err.name = "AbortError";
  throw err;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message === "cancelled");
}

function assertSafeSegment(value: string, label: string): string {
  if (!value || value === "." || value === ".." || /[\\/\0]/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

export async function beginClaimedWorktree(
  opts: BeginClaimedWorktreeOpts
): Promise<ClaimedWorktree | ClaimedEarlyResult> {
  const now = () => opts.now?.() ?? new Date();
  const pidAlive = opts.pidAlive ?? isPidAlive;
  const git = opts.gitRunner ?? runGit;
  const engine = withEngineChain(resolveEngine(opts, opts.fallbackEngine), {
    chain: opts.chain,
    fallbackModel: opts.fallbackModel,
    fallbackVariant: opts.fallbackVariant,
    remainingLeaseMs: opts.remainingLeaseMs,
    extendLease: opts.extendLease,
    logger: opts.logger,
  });
  const owner = assertSafeSegment(opts.job.owner, "owner");
  const repo = assertSafeSegment(opts.job.repo, "repo");
  const issueNumber = opts.job.issueNumber;
  const worktree = join(opts.workdir, owner, repo, String(issueNumber));
  const barePath = join(opts.workdir, "_cache", owner, `${repo}.git`);
  const claimPath = claimFilePath(opts.home, owner, repo, issueNumber);
  const sanitizeEnv = opts.sanitizeOpenCodeEnv ?? true;
  const useClaim = opts.useClaim !== false;
  const forgetClaim = async () => {
    if (useClaim) await deleteClaim(claimPath);
  };

  throwIfAborted(opts.abortSignal);

  const startedAt = now().toISOString();
  if (opts.forgetTerminal && useClaim) {
    const existingClaim = await readClaim(claimPath);
    if (existingClaim?.terminal) await forgetClaim();
  }

  const claim: ClaimRecord = {
    pid: 0,
    startedAt,
    heartbeatAt: startedAt,
    worktree,
    branch: opts.branch ?? "",
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

  return {
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
  };
}

export async function recheckAssignedAndOpen(
  claimed: ClaimedWorktree,
  opts: { api: Pick<IssueApi, "getIssue"> } & PickupPolicy
): Promise<ClaimedEarlyResult | undefined> {
  try {
    const currentIssue = await opts.api.getIssue(claimed.owner, claimed.repo, claimed.issueNumber);
    if (!isIssuePickedUp(currentIssue, opts) || currentIssue.state !== "open") {
      await claimed.forgetClaim();
      return { status: "cancelled" };
    }
  } catch (err) {
    await claimed.forgetClaim();
    return { status: "skipped", reason: `failed to load issue: ${err instanceof Error ? err.message : String(err)}` };
  }
  return undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export interface OpenClaimedLoopOpts {
  giteaUrl: string;
  giteaToken: string;
  botUsername: string;
  gitAuthResolver?: GitAuthResolver;
  heartbeatIntervalMs?: number;
}

export interface ClaimedLoop extends ClaimedWorktree {
  auth: GitAuth;
  env: Record<string, string | undefined>;
  serializeClaim: <T>(fn: () => Promise<T>) => Promise<T>;
  stopHeartbeat: () => Promise<void>;
  stampHeadSha: (headSha: string) => Promise<void>;
  stampEnginePid: (pid: number) => Promise<void>;
  stampTerminalClaim: (api: Pick<IssueApi, "getIssue">) => Promise<void>;
  forgetSerialized: () => Promise<void>;
  refreshGitAuth: () => Promise<void>;
  runConfiguredGit: GitRunner;
  detachWorktree: () => Promise<void>;
  refExists: (ref: string) => Promise<boolean>;
  engineOnPid: (onPid?: (pid: number) => void | Promise<void>) => (pid: number) => Promise<void>;
}

export function openClaimedLoop(claimed: ClaimedWorktree, opts: OpenClaimedLoopOpts): ClaimedLoop {
  const configArgs = gitConfigArgs();
  let auth: GitAuth = { giteaUrl: opts.giteaUrl, username: opts.botUsername, token: opts.giteaToken };
  let env = gitEnv(auth);
  const runConfiguredGit: GitRunner = (args, runOpts) => claimed.git([...configArgs, ...args], runOpts);
  const refreshGitAuth = async () => {
    auth = await resolveGitAuth(opts);
    env = gitEnv(auth);
  };
  const detachWorktree = async () => {
    try {
      await runConfiguredGit(["worktree", "remove", "--force", claimed.worktree], {
        cwd: claimed.barePath,
        env,
      });
    } catch {
      // Already gone or never added.
    }
    await rm(claimed.worktree, { recursive: true, force: true }).catch(() => undefined);
  };
  const refExists = async (ref: string) => {
    try {
      await runConfiguredGit(["show-ref", "--verify", "--quiet", ref], { cwd: claimed.barePath, env });
      return true;
    } catch {
      return false;
    }
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
  const stampHeadSha = async (headSha: string) => {
    await serializeClaim(async () => {
      if (heartbeatStopped || !claimed.useClaim) return;
      claimed.claim.headShaAtStart = headSha;
      claimed.claim.heartbeatAt = claimed.now().toISOString();
      await writeClaim(claimed.claimPath, claimed.claim);
    });
  };
  const stampEnginePid = async (pid: number) => {
    await serializeClaim(async () => {
      if (heartbeatStopped || !claimed.useClaim) return;
      const current = await readClaim(claimed.claimPath);
      if (heartbeatStopped || !current || current.terminal) return;
      current.pid = pid;
      current.heartbeatAt = claimed.now().toISOString();
      await writeClaim(claimed.claimPath, current);
    });
  };
  const stampTerminalClaim = async (api: Pick<IssueApi, "getIssue">) => {
    if (!claimed.useClaim) return;
    let updatedAt = claimed.claim.issueUpdatedAt;
    try {
      const current = await api.getIssue(claimed.owner, claimed.repo, claimed.issueNumber);
      if (current.updated_at) updatedAt = current.updated_at;
    } catch {
      // Keep the timestamp we already have.
    }
    await serializeClaim(async () => {
      claimed.claim.pid = 0;
      claimed.claim.terminal = true;
      claimed.claim.issueUpdatedAt = updatedAt;
      claimed.claim.heartbeatAt = claimed.now().toISOString();
      await writeClaim(claimed.claimPath, claimed.claim);
    });
  };
  const forgetSerialized = async () => {
    await serializeClaim(async () => {
      await claimed.forgetClaim();
    });
  };
  const engineOnPid = (onPid?: (pid: number) => void | Promise<void>) => async (pid: number) => {
    await onPid?.(pid);
    await stampEnginePid(pid);
  };
  heartbeat =
    heartbeatMs > 0 && claimed.useClaim
      ? setInterval(() => {
          void serializeClaim(async () => {
            if (heartbeatStopped) return;
            const current = await readClaim(claimed.claimPath);
            if (heartbeatStopped || !current || current.terminal || current.startedAt !== claimed.claim.startedAt)
              return;
            current.heartbeatAt = claimed.now().toISOString();
            await writeClaim(claimed.claimPath, current);
          }).catch(() => undefined);
        }, heartbeatMs)
      : undefined;

  return {
    ...claimed,
    get auth() {
      return auth;
    },
    set auth(value) {
      auth = value;
    },
    get env() {
      return env;
    },
    set env(value) {
      env = value;
    },
    serializeClaim,
    stopHeartbeat,
    stampHeadSha,
    stampEnginePid,
    stampTerminalClaim,
    forgetSerialized,
    refreshGitAuth,
    runConfiguredGit,
    detachWorktree,
    refExists,
    engineOnPid,
  };
}

export async function ensureBareCache(
  loop: ClaimedLoop,
  opts: { cloneUrl: string; giteaUrl: string; abortSignal?: AbortSignal; log: (message: string) => void }
): Promise<void> {
  throwIfAborted(opts.abortSignal);
  await loop.refreshGitAuth();
  const cloneUrl = validateCloneUrl(opts.cloneUrl, opts.giteaUrl);
  await mkdir(dirname(loop.barePath), { recursive: true });
  if (await pathExists(loop.barePath)) {
    opts.log(`Fetching ${loop.owner}/${loop.repo} cache`);
    await loop.runConfiguredGit(["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*"], {
      cwd: loop.barePath,
      env: loop.env,
    });
  } else {
    opts.log(`Cloning ${loop.owner}/${loop.repo} into bare cache`);
    await loop.runConfiguredGit(["clone", "--bare", gitRemoteUrl(cloneUrl, loop.auth), loop.barePath], {
      cwd: dirname(loop.barePath),
      env: loop.env,
    });
    if (loop.auth.embedTokenInUrl) {
      await loop.runConfiguredGit(["remote", "set-url", "origin", cloneUrl], { cwd: loop.barePath, env: loop.env });
    }
    await loop.runConfiguredGit(["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*"], {
      cwd: loop.barePath,
      env: loop.env,
    });
  }
  throwIfAborted(opts.abortSignal);
}

export async function attachIssueWorktree(
  loop: ClaimedLoop,
  opts: { branch: string; defaultBranch: string; abortSignal?: AbortSignal; log: (message: string) => void }
): Promise<string> {
  if (!(await pathExists(join(loop.worktree, ".git")))) {
    await mkdir(dirname(loop.worktree), { recursive: true });
    if (await loop.refExists(`refs/heads/${opts.branch}`)) {
      opts.log(`Adding worktree ${loop.worktree} from existing ${opts.branch}`);
      await loop.runConfiguredGit(["worktree", "add", loop.worktree, opts.branch], {
        cwd: loop.barePath,
        env: loop.env,
      });
    } else if (await loop.refExists(`refs/remotes/origin/${opts.branch}`)) {
      opts.log(`Adding worktree ${loop.worktree} from origin/${opts.branch}`);
      await loop.runConfiguredGit(["worktree", "add", "-B", opts.branch, loop.worktree, `origin/${opts.branch}`], {
        cwd: loop.barePath,
        env: loop.env,
      });
    } else {
      opts.log(`Adding worktree ${loop.worktree} on ${opts.branch}`);
      await loop.runConfiguredGit(
        ["worktree", "add", "-B", opts.branch, loop.worktree, `origin/${opts.defaultBranch}`],
        {
          cwd: loop.barePath,
          env: loop.env,
        }
      );
    }
  }
  await mkdir(loop.worktree, { recursive: true });
  await loop.runConfiguredGit(["checkout", "-B", opts.branch], { cwd: loop.worktree, env: loop.env });
  throwIfAborted(opts.abortSignal);
  return (await loop.runConfiguredGit(["rev-parse", "HEAD"], { cwd: loop.worktree, env: loop.env })).trim();
}

export async function attachPrWorktree(
  loop: ClaimedLoop,
  opts: { branch: string; defaultBranch: string; abortSignal?: AbortSignal; log: (message: string) => void }
): Promise<{ headSha: string; baseSha: string } | ClaimedEarlyResult> {
  const originRef = `refs/remotes/origin/${opts.branch}`;
  const originExists = await loop
    .runConfiguredGit(["show-ref", "--verify", "--quiet", originRef], {
      cwd: loop.barePath,
      env: loop.env,
    })
    .then(() => true)
    .catch(() => false);
  if (!originExists) {
    return skipClaimedWork(loop, `missing branch ${opts.branch}`);
  }
  if (!(await pathExists(join(loop.worktree, ".git")))) {
    await mkdir(dirname(loop.worktree), { recursive: true });
    opts.log(`Adding worktree ${loop.worktree} from origin/${opts.branch}`);
    await loop.runConfiguredGit(["worktree", "add", "-B", opts.branch, loop.worktree, `origin/${opts.branch}`], {
      cwd: loop.barePath,
      env: loop.env,
    });
  } else {
    await loop.runConfiguredGit(["checkout", opts.branch], { cwd: loop.worktree, env: loop.env });
    await loop.runConfiguredGit(["reset", "--hard", `origin/${opts.branch}`], { cwd: loop.worktree, env: loop.env });
  }
  await mkdir(loop.worktree, { recursive: true });
  throwIfAborted(opts.abortSignal);
  const headSha = (await loop.runConfiguredGit(["rev-parse", "HEAD"], { cwd: loop.worktree, env: loop.env })).trim();
  const baseSha = (
    await loop.runConfiguredGit(["rev-parse", `origin/${opts.defaultBranch}`], { cwd: loop.worktree, env: loop.env })
  ).trim();
  return { headSha, baseSha };
}

export async function stripSentinels(worktree: string, files: readonly string[]): Promise<void> {
  for (const file of files) {
    await rm(join(worktree, file), { recursive: true, force: true }).catch(() => undefined);
  }
  await rm(join(worktree, ".jumi-tmp"), { recursive: true, force: true });
}

export async function worktreePorcelain(loop: ClaimedLoop): Promise<string> {
  return (await loop.runConfiguredGit(["status", "--porcelain"], { cwd: loop.worktree, env: loop.env })).trim();
}

export async function commitsAheadOf(loop: ClaimedLoop, ref: string): Promise<number> {
  const aheadText = (
    await loop.runConfiguredGit(["rev-list", "--count", `${ref}..HEAD`], {
      cwd: loop.worktree,
      env: loop.env,
    })
  ).trim();
  const ahead = Number(aheadText);
  return Number.isFinite(ahead) ? ahead : 0;
}

export async function commitIfDirty(loop: ClaimedLoop, porcelain: string, message: string): Promise<void> {
  if (!porcelain) return;
  const commitEnv = {
    ...loop.env,
    GIT_AUTHOR_NAME: loop.env.GIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: loop.env.GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: loop.env.GIT_COMMITTER_NAME,
    GIT_COMMITTER_EMAIL: loop.env.GIT_COMMITTER_EMAIL,
  };
  await loop.runConfiguredGit(["add", "-A"], { cwd: loop.worktree, env: commitEnv });
  await loop.runConfiguredGit(["commit", "-m", message], {
    cwd: loop.worktree,
    env: commitEnv,
  });
}

export async function pushClaimedBranch(loop: ClaimedLoop, branch: string): Promise<void> {
  await loop.refreshGitAuth();
  await loop.runConfiguredGit(["push", "-u", "origin", branch], { cwd: loop.worktree, env: loop.env });
}

async function fetchOriginBranchAfterPushFailure(loop: ClaimedLoop, branch: string): Promise<void> {
  await loop
    .runConfiguredGit(["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
      cwd: loop.worktree,
      env: loop.env,
    })
    .catch(() => undefined);
}

export async function inspectMovedPrHead(
  loop: ClaimedLoop,
  branch: string,
  attemptedHeadSha: string
): Promise<string | undefined> {
  await fetchOriginBranchAfterPushFailure(loop, branch);
  const remoteSha = (
    await loop
      .runConfiguredGit(["rev-parse", `origin/${branch}`], { cwd: loop.worktree, env: loop.env })
      .catch(() => "")
  ).trim();
  if (remoteSha && remoteSha !== attemptedHeadSha) return remoteSha;
  return undefined;
}

export async function inspectRemoteContainsDefault(
  loop: ClaimedLoop,
  branch: string,
  defaultBranch: string
): Promise<boolean> {
  await fetchOriginBranchAfterPushFailure(loop, branch);
  const remoteContainsDefault = await loop
    .runConfiguredGit(["merge-base", "--is-ancestor", `origin/${defaultBranch}`, `origin/${branch}`], {
      cwd: loop.worktree,
      env: loop.env,
    })
    .then(() => true)
    .catch(() => false);
  if (remoteContainsDefault) {
    await loop.runConfiguredGit(["reset", "--hard", `origin/${branch}`], { cwd: loop.worktree, env: loop.env });
  }
  return remoteContainsDefault;
}

export async function skipClaimedWork(
  loop: ClaimedLoop,
  reason: string,
  opts?: { detach?: boolean }
): Promise<{ status: "skipped"; reason: string }> {
  await loop.stopHeartbeat();
  await loop.forgetSerialized();
  if (opts?.detach !== false) await loop.detachWorktree();
  return { status: "skipped", reason };
}

export async function runClaimedLoop<T>(
  loop: ClaimedLoop,
  abortSignal: AbortSignal | undefined,
  body: () => Promise<T>,
  onFailure?: (err: unknown) => Promise<void>
): Promise<T | { status: "cancelled" }> {
  try {
    return await body();
  } catch (err) {
    if (isAbortError(err) || abortSignal?.aborted) {
      await loop.stopHeartbeat();
      await loop.detachWorktree();
      return { status: "cancelled" };
    }
    if (isInfraFailure(err) || isQuotaWaitError(err)) {
      await loop.stopHeartbeat();
      await loop.detachWorktree();
      throw err;
    }
    try {
      if (onFailure) await onFailure(err);
    } catch (next) {
      if (isInfraFailure(next) || isQuotaWaitError(next)) {
        await loop.stopHeartbeat();
        await loop.detachWorktree();
        throw next;
      }
      throw next;
    }
    throw err;
  } finally {
    await loop.stopHeartbeat();
  }
}
