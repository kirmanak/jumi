import { join } from "node:path";
import { isIssuePickedUp, type PickupPolicy } from "./assignee.ts";
import type { ClaimRecord } from "./claim.ts";
import { acquireClaim, claimFilePath, deleteClaim, isPidAlive, readClaim } from "./claim.ts";
import { type Engine, resolveEngine } from "./engine.ts";
import type { IssueApi } from "./ports.ts";
import { type GitRunner, runGit } from "./workspace.ts";

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
  branch?: string;
  forgetTerminal?: boolean;
}

export function isClaimedEarlyResult(value: ClaimedWorktree | ClaimedEarlyResult): value is ClaimedEarlyResult {
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
  const engine = resolveEngine(opts, opts.fallbackEngine);
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
