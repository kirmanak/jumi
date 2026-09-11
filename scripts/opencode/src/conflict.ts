import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isAssignedToBot } from "./assignee.ts";
import { buildCiMarkdown, CI_LOG_FILE, inspectCi } from "./ci.ts";
import type { ClaimRecord } from "./claim.ts";
import {
  acquireClaim,
  claimFilePath,
  conflictStatePath,
  deleteClaim,
  isPidAlive,
  readClaim,
  stuckStatePath,
  writeClaim,
} from "./claim.ts";
import { resolveEngine, throwIfEngineFailed } from "./engine.ts";
import { FORGE_COMMITTER_EMAIL, FORGE_COMMITTER_NAME } from "./forge.ts";
import { openCodeEngine } from "./git.ts";
import { isEligibleWorkerPR, resolveWorkerPullRequest, upsertWorkerComment } from "./gitea_issues.ts";
import {
  buildTaskMarkdown,
  HEARTBEAT_INTERVAL_MS,
  type HelmRunner,
  type ImplementOptions,
  type OpenCodeRunner,
} from "./implement.ts";
import { gateShipAfterOpenCode, jobWithIssue, snapshotFromJob } from "./issue_recheck.ts";
import type { Pull } from "./ports.ts";
import { appendStuckFingerprint, evaluateStuck, fingerprintError, readStuckState, stuckComment } from "./stuck.ts";
import type { IssueJob } from "./types.ts";
import {
  type GitRunner,
  gitConfigArgs,
  gitEnv,
  runGit,
  validateCloneUrl,
  workerOpenCodeChildEnv,
} from "./workspace.ts";

export { CONFLICT_PROMPT } from "./git.ts";

export const CONFLICT_TIMEOUT_MS = 60 * 60 * 1000;
export const MAX_CONFLICT_ROUNDS = 3;

const GENERATED_LOCKS = new Set(["Chart.lock", "requirements.lock"]);

export type ConflictResult =
  | { status: "pushed"; prNumber: number; htmlUrl: string }
  | { status: "up-to-date" }
  | { status: "stuck" }
  | { status: "skipped"; reason: string }
  | { status: "cancelled" };

export interface ConflictState {
  prNumber: number;
  round: number;
  lastHeadSha: string;
  lastBaseSha: string;
  updatedAt: string;
}

export type MergeDefaultStatus = "up-to-date" | "merged" | "stuck";

export interface MergeDefaultResult {
  status: MergeDefaultStatus;
  headSha: string;
  baseSha: string;
  openCodeRan: boolean;
  conflicted: boolean;
}

export interface MergeDefaultIntoWorktreeOpts {
  git: GitRunner;
  env: Record<string, string | undefined>;
  worktree: string;
  defaultBranch: string;
  headRef: string;
  job: IssueJob;
  pr: Pull;
  model: string;
  home: string;
  sanitizeOpenCodeEnv?: boolean;
  extraEnv: Record<string, string>;
  maxOutputBytes?: number;
  timeoutMs?: number;
  openCodeRunner: OpenCodeRunner;
  helmRunner?: HelmRunner;
  logger?: (message: string) => void;
  abortSignal?: AbortSignal;
  onPid?: (pid: number) => void | Promise<void>;
  ciMarkdown?: string;
  jobId?: string;
  skipCleanMerge?: boolean;
}

function logDefault(message: string) {
  console.log(`[conflict] ${message}`);
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

function emptyConflictState(): ConflictState {
  return { prNumber: 0, round: 0, lastHeadSha: "", lastBaseSha: "", updatedAt: "" };
}

export { conflictStatePath };

export async function readConflictState(path: string): Promise<ConflictState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return emptyConflictState();
    const state = parsed as ConflictState;
    return {
      prNumber: typeof state.prNumber === "number" ? state.prNumber : 0,
      round: typeof state.round === "number" ? state.round : 0,
      lastHeadSha: typeof state.lastHeadSha === "string" ? state.lastHeadSha : "",
      lastBaseSha: typeof state.lastBaseSha === "string" ? state.lastBaseSha : "",
      updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : "",
    };
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return emptyConflictState();
    return emptyConflictState();
  }
}

export async function writeConflictState(path: string, state: ConflictState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

export async function deleteConflictState(
  home: string,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<void> {
  await deleteClaim(conflictStatePath(home, owner, repo, issueNumber));
}

export async function needsConflict(opts: {
  pr: Pull;
  owner: string;
  repo: string;
  issueNumber: number;
  botUsername: string;
  home: string;
  maxConflictRounds?: number;
}): Promise<boolean> {
  if (!isEligibleWorkerPR(opts.pr, opts.owner, opts.repo)) return false;
  if (opts.pr.mergeable !== false) return false;
  const state = await readConflictState(conflictStatePath(opts.home, opts.owner, opts.repo, opts.issueNumber));
  if (state.round >= (opts.maxConflictRounds ?? MAX_CONFLICT_ROUNDS)) return false;
  if (
    state.lastHeadSha &&
    state.lastBaseSha &&
    state.lastHeadSha === opts.pr.head.sha &&
    state.lastBaseSha === opts.pr.base.sha
  ) {
    return false;
  }
  return true;
}

function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function gitLines(
  git: GitRunner,
  args: string[],
  opts: { cwd: string; env: Record<string, string | undefined> }
): Promise<string[]> {
  try {
    return splitLines(await git(args, opts));
  } catch {
    return [];
  }
}

async function unmergedPaths(
  git: GitRunner,
  worktree: string,
  env: Record<string, string | undefined>
): Promise<string[]> {
  return gitLines(git, ["diff", "--name-only", "--diff-filter=U"], { cwd: worktree, env });
}

async function markerPaths(
  git: GitRunner,
  worktree: string,
  env: Record<string, string | undefined>
): Promise<string[]> {
  return gitLines(git, ["grep", "-l", "^<<<<<<<"], { cwd: worktree, env });
}

function isGeneratedLock(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return GENERATED_LOCKS.has(base);
}

async function runHelm(args: string[], opts: { cwd: string }): Promise<string> {
  const proc = Bun.spawn(["helm", ...args], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    const details = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    throw new Error(`helm ${args.join(" ")} failed with exit code ${exitCode}${details ? `:\n${details}` : ""}`);
  }
  return stdout.trim();
}

function helmAvailable(injected?: HelmRunner): boolean {
  if (injected) return true;
  return typeof Bun.which === "function" && Boolean(Bun.which("helm"));
}

async function regenerateLock(
  git: GitRunner,
  env: Record<string, string | undefined>,
  worktree: string,
  lockPath: string,
  helm: HelmRunner | undefined
): Promise<void> {
  const absLock = join(worktree, lockPath);
  await rm(absLock, { force: true });
  const chartDirRel = dirname(lockPath);
  const chartDir = join(worktree, chartDirRel);
  if (!(await pathExists(join(chartDir, "Chart.yaml"))) || !helmAvailable(helm)) return;
  const runner = helm ?? runHelm;
  await runner(["dependency", "update"], { cwd: chartDir });
  if (await pathExists(absLock)) {
    await git(["add", "--", lockPath], { cwd: worktree, env }).catch(() => undefined);
  }
  const vendorRel = join(chartDirRel, "charts");
  await git(["add", "-u", "--", vendorRel], { cwd: worktree, env }).catch(() => undefined);
}

async function buildConflictMarkdown(opts: {
  git: GitRunner;
  env: Record<string, string | undefined>;
  worktree: string;
  pr: Pull;
  headSha: string;
  headRef: string;
  defaultBranch: string;
  baseSha: string;
  conflicted: string[];
}): Promise<string> {
  let diff = "";
  try {
    diff = await opts.git(["diff"], { cwd: opts.worktree, env: opts.env });
  } catch {
    diff = "";
  }
  return [
    `# Merge conflict`,
    ``,
    `PR: ${opts.pr.html_url}`,
    `Number: ${opts.pr.number}`,
    `Head SHA: ${opts.headSha}`,
    `Head ref: ${opts.headRef}`,
    `Default branch: ${opts.defaultBranch}`,
    `Default SHA: ${opts.baseSha}`,
    ``,
    `## Conflicted paths`,
    ``,
    ...opts.conflicted.map((path) => `- ${path}`),
    ``,
    `## Diff`,
    ``,
    "```",
    diff,
    "```",
    ``,
  ].join("\n");
}

async function gitOk(
  git: GitRunner,
  args: string[],
  opts: { cwd: string; env: Record<string, string | undefined> }
): Promise<boolean> {
  try {
    await git(args, opts);
    return true;
  } catch {
    return false;
  }
}

async function commitMerge(
  git: GitRunner,
  env: Record<string, string | undefined>,
  worktree: string,
  defaultBranch: string,
  headRef: string
): Promise<void> {
  const commitEnv = {
    ...env,
    GIT_AUTHOR_NAME: FORGE_COMMITTER_NAME,
    GIT_AUTHOR_EMAIL: FORGE_COMMITTER_EMAIL,
    GIT_COMMITTER_NAME: FORGE_COMMITTER_NAME,
    GIT_COMMITTER_EMAIL: FORGE_COMMITTER_EMAIL,
  };
  await git(["commit", "-m", `Merge ${defaultBranch} into ${headRef}`], { cwd: worktree, env: commitEnv });
}

async function commitMergeIfNeeded(
  git: GitRunner,
  env: Record<string, string | undefined>,
  worktree: string,
  defaultBranch: string,
  headRef: string
): Promise<void> {
  const originDefault = `origin/${defaultBranch}`;
  const mergeInProgress = await gitOk(git, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: worktree, env });
  const dirty = Boolean((await git(["status", "--porcelain"], { cwd: worktree, env })).trim());
  if (mergeInProgress || dirty) {
    try {
      await commitMerge(git, env, worktree, defaultBranch, headRef);
    } catch (err) {
      if (await gitOk(git, ["merge-base", "--is-ancestor", originDefault, "HEAD"], { cwd: worktree, env })) {
        return;
      }
      throw err;
    }
    return;
  }
  if (await gitOk(git, ["merge-base", "--is-ancestor", originDefault, "HEAD"], { cwd: worktree, env })) {
    return;
  }
  throw new Error(`merge of ${defaultBranch} into ${headRef} did not complete`);
}

export async function mergeDefaultIntoWorktree(opts: MergeDefaultIntoWorktreeOpts): Promise<MergeDefaultResult> {
  const log = opts.logger ?? logDefault;
  const git = opts.git;
  const { worktree, env, defaultBranch, headRef } = opts;
  const originDefault = `origin/${defaultBranch}`;

  throwIfAborted(opts.abortSignal);
  await git(["fetch", "origin", `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`], {
    cwd: worktree,
    env,
  });
  await git(["fetch", "origin", `+refs/heads/${headRef}:refs/remotes/origin/${headRef}`], {
    cwd: worktree,
    env,
  }).catch(() => undefined);

  const headSha = (await git(["rev-parse", "HEAD"], { cwd: worktree, env })).trim();
  const baseSha = (await git(["rev-parse", originDefault], { cwd: worktree, env })).trim();

  try {
    await git(["merge-base", "--is-ancestor", originDefault, "HEAD"], { cwd: worktree, env });
    return { status: "up-to-date", headSha, baseSha, openCodeRan: false, conflicted: false };
  } catch {
    // Default is not an ancestor; merge.
  }

  throwIfAborted(opts.abortSignal);
  let conflicted = false;
  try {
    await git(["merge", "--no-ff", "--no-commit", originDefault], { cwd: worktree, env });
  } catch (err) {
    const unmerged = await unmergedPaths(git, worktree, env);
    if (unmerged.length === 0) throw err;
    conflicted = true;
    try {
      for (const path of unmerged) {
        if (!isGeneratedLock(path)) continue;
        await regenerateLock(git, env, worktree, path, opts.helmRunner);
      }
    } catch (regenErr) {
      log(`Failed to regenerate generated lock: ${regenErr instanceof Error ? regenErr.message : String(regenErr)}`);
      return { status: "stuck", headSha, baseSha, openCodeRan: false, conflicted: true };
    }
  }

  let remaining = [
    ...new Set([...(await unmergedPaths(git, worktree, env)), ...(await markerPaths(git, worktree, env))]),
  ];
  const leftoverLocks = remaining.filter(isGeneratedLock);
  remaining = remaining.filter((path) => !isGeneratedLock(path));
  let openCodeRan = false;
  if (leftoverLocks.length > 0) {
    return { status: "stuck", headSha, baseSha, openCodeRan: false, conflicted: true };
  }
  if (opts.skipCleanMerge && remaining.length === 0 && !conflicted) {
    if (await gitOk(git, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: worktree, env })) {
      await git(["merge", "--abort"], { cwd: worktree, env }).catch(() => undefined);
    }
    return { status: "up-to-date", headSha, baseSha, openCodeRan: false, conflicted: false };
  }
  if (remaining.length > 0) {
    throwIfAborted(opts.abortSignal);
    await writeFile(join(worktree, "JUMI_TASK.md"), buildTaskMarkdown(opts.job));
    await writeFile(
      join(worktree, "JUMI_CONFLICT.md"),
      await buildConflictMarkdown({
        git,
        env,
        worktree,
        pr: opts.pr,
        headSha,
        headRef,
        defaultBranch,
        baseSha,
        conflicted: remaining,
      })
    );
    if (opts.ciMarkdown) await writeFile(join(worktree, CI_LOG_FILE), opts.ciMarkdown);
    log(`Running OpenCode conflict resolution for ${opts.job.owner}/${opts.job.repo}#${opts.job.issueNumber}`);
    openCodeRan = true;
    throwIfEngineFailed(
      await opts.openCodeRunner({
        model: opts.model,
        workdir: worktree,
        home: opts.home,
        sanitizeEnv: opts.sanitizeOpenCodeEnv ?? true,
        extraEnv: opts.extraEnv,
        timeoutMs: opts.timeoutMs ?? CONFLICT_TIMEOUT_MS,
        maxOutputBytes: opts.maxOutputBytes,
        reviewLabel: `${opts.job.owner}/${opts.job.repo}#${opts.job.issueNumber}`,
        trace: {
          kind: "conflict",
          owner: opts.job.owner,
          repo: opts.job.repo,
          sha: headSha,
          jobId: opts.jobId ?? opts.job.delivery,
        },
        logger: log,
        abortSignal: opts.abortSignal,
        onPid: opts.onPid,
      })
    );
    await rm(join(worktree, "JUMI_TASK.md"), { force: true });
    await rm(join(worktree, "JUMI_CONFLICT.md"), { force: true });
    await rm(join(worktree, CI_LOG_FILE), { force: true });
    await rm(join(worktree, ".jumi-tmp"), { recursive: true, force: true });
    await git(["add", "-A"], { cwd: worktree, env }).catch(() => undefined);
    remaining = await markerPaths(git, worktree, env);
    if (remaining.length > 0) {
      return { status: "stuck", headSha, baseSha, openCodeRan, conflicted: true };
    }
  }

  throwIfAborted(opts.abortSignal);
  if (conflicted || openCodeRan) {
    await git(["add", "-A"], { cwd: worktree, env }).catch(() => undefined);
  }
  await commitMergeIfNeeded(git, env, worktree, defaultBranch, headRef);
  return { status: "merged", headSha, baseSha, openCodeRan, conflicted };
}

export function shouldIncrementRound(result: MergeDefaultResult): boolean {
  return result.openCodeRan || result.conflicted || result.status === "stuck";
}

export async function implementConflict(opts: ImplementOptions): Promise<ConflictResult> {
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
  const statePath = conflictStatePath(opts.home, owner, repo, issueNumber);
  const sanitizeEnv = opts.sanitizeOpenCodeEnv ?? true;
  const useClaim = opts.useClaim !== false;
  const maxConflictRounds = opts.maxConflictRounds ?? MAX_CONFLICT_ROUNDS;
  const timeoutMs = opts.timeoutMs ?? CONFLICT_TIMEOUT_MS;
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

  const branch = pr.head.ref;
  claim.branch = branch;
  if (!branch || branch === opts.job.defaultBranch) {
    await forgetClaim();
    return { status: "skipped", reason: "refusing to merge on the default branch" };
  }

  const state = await readConflictState(statePath);
  if (state.round >= maxConflictRounds) {
    await sticky("stuck: cannot resolve conflicts", pr.number);
    await forgetClaim();
    return { status: "stuck" };
  }
  const stuckPath = stuckStatePath(opts.home, owner, repo, issueNumber);
  const stuckReason = evaluateStuck((await readStuckState(stuckPath)).fingerprints);
  if (stuckReason) {
    await sticky(stuckComment(stuckReason), pr.number);
    await forgetClaim();
    return { status: "stuck" };
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

  const recordAttempt = async (headSha: string, baseSha: string, increment: boolean) => {
    await writeConflictState(statePath, {
      prNumber: pr.number,
      round: increment ? state.round + 1 : state.round,
      lastHeadSha: headSha,
      lastBaseSha: baseSha,
      updatedAt: now().toISOString(),
    });
  };

  let attemptedHeadSha = "";
  let attemptedBaseSha = "";
  let mergeDefaultThrew = false;

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

    if (state.lastHeadSha && state.lastBaseSha && state.lastHeadSha === headSha && state.lastBaseSha === baseSha) {
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
    let ciMarkdown: string | undefined;
    try {
      const ci = await inspectCi({
        api: opts.api,
        owner,
        repo,
        sha: pr.head.sha,
        home: opts.home,
        issueNumber,
      });
      if (ci.failed.length) ciMarkdown = buildCiMarkdown({ sha: pr.head.sha, checks: ci.failed });
    } catch (err) {
      log(`CI inspect failed for ${owner}/${repo}#${issueNumber}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const mergeResult = await mergeDefaultIntoWorktree({
      git: runConfiguredGit,
      env,
      worktree,
      defaultBranch: opts.job.defaultBranch,
      headRef: branch,
      skipCleanMerge: true,
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
      timeoutMs,
      openCodeRunner: engine,
      helmRunner: opts.helmRunner,
      logger: log,
      abortSignal: opts.abortSignal,
      ciMarkdown,
      jobId: opts.jobId ?? opts.job.delivery,
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
      mergeDefaultThrew = true;
      throw err;
    });

    if (mergeResult.status === "up-to-date") {
      await stopHeartbeat();
      await serializeClaim(async () => {
        await forgetClaim();
      });
      await detachWorktree();
      return { status: "up-to-date" };
    }

    if (mergeResult.status === "stuck") {
      await sticky("stuck: cannot resolve conflicts", pr.number);
      await recordAttempt(mergeResult.headSha, mergeResult.baseSha, shouldIncrementRound(mergeResult));
      await stopHeartbeat();
      await serializeClaim(async () => {
        await forgetClaim();
      });
      await detachWorktree();
      return { status: "stuck" };
    }

    const gate = await gateShipAfterOpenCode({
      api: opts.api,
      owner,
      repo,
      issueNumber,
      botUsername: opts.botUsername,
      snapshot: snapshotFromJob(taskJob),
      closerPrNumber: pr.number,
      continueOpenCode: async (issue) => {
        throwIfAborted(opts.abortSignal);
        await writeFile(join(worktree, "JUMI_TASK.md"), buildTaskMarkdown(jobWithIssue(taskJob, issue)));
        log(`Re-running OpenCode after issue change for ${owner}/${repo}#${issueNumber}`);
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
              sha: mergeResult.headSha,
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
        await rm(join(worktree, "JUMI_PR.md"), { recursive: true, force: true }).catch(() => undefined);
        await rm(join(worktree, "JUMI_TASK.md"), { force: true });
        await rm(join(worktree, ".jumi-tmp"), { recursive: true, force: true });
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
    if (gate.continued) {
      await rm(join(worktree, "JUMI_PR.md"), { recursive: true, force: true }).catch(() => undefined);
      await rm(join(worktree, "JUMI_TASK.md"), { force: true });
      await rm(join(worktree, ".jumi-tmp"), { recursive: true, force: true });
      const porcelain = (await runConfiguredGit(["status", "--porcelain"], { cwd: worktree, env })).trim();
      if (porcelain) {
        const commitEnv = {
          ...env,
          GIT_AUTHOR_NAME: FORGE_COMMITTER_NAME,
          GIT_AUTHOR_EMAIL: FORGE_COMMITTER_EMAIL,
          GIT_COMMITTER_NAME: FORGE_COMMITTER_NAME,
          GIT_COMMITTER_EMAIL: FORGE_COMMITTER_EMAIL,
        };
        await runConfiguredGit(["add", "-A"], { cwd: worktree, env: commitEnv });
        await runConfiguredGit(["commit", "-m", `Implement #${issueNumber}: ${gate.snapshot.title}`], {
          cwd: worktree,
          env: commitEnv,
        });
      }
    }

    try {
      await runConfiguredGit(["push", "-u", "origin", branch], { cwd: worktree, env });
    } catch (err) {
      await runConfiguredGit(["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
        cwd: worktree,
        env,
      }).catch(() => undefined);
      const remoteContainsDefault = await runConfiguredGit(
        ["merge-base", "--is-ancestor", `origin/${opts.job.defaultBranch}`, `origin/${branch}`],
        { cwd: worktree, env }
      )
        .then(() => true)
        .catch(() => false);
      if (remoteContainsDefault) {
        await runConfiguredGit(["reset", "--hard", `origin/${branch}`], { cwd: worktree, env });
        await stopHeartbeat();
        await serializeClaim(async () => {
          await forgetClaim();
        });
        await detachWorktree();
        return { status: "skipped", reason: "remote already contains default" };
      }
      throw err;
    }
    throwIfAborted(opts.abortSignal);

    await sticky(`Pushed merge of ${opts.job.defaultBranch}.`, pr.number);
    await recordAttempt(mergeResult.headSha, mergeResult.baseSha, shouldIncrementRound(mergeResult));
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
    if (mergeDefaultThrew && attemptedHeadSha && attemptedBaseSha) {
      await recordAttempt(attemptedHeadSha, attemptedBaseSha, true).catch(() => undefined);
    }
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
