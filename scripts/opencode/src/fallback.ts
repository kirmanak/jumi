import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { recordOpenCodeRun, shouldDeferQuotaExit } from "./control_metrics.ts";
import { logDiagnostic } from "./diagnostics.ts";
import { attachRunner, type Engine, EngineFailedError, type EngineResult, type EngineRunOptions } from "./engine.ts";
import { isQuotaError, isQuotaText } from "./quota.ts";
import { type NamedRunner, OPENCODE_RUNNER_TYPE, runnerStamp, usesEffort } from "./runners.ts";

export const OPENCODE_SESSION_DB = "opencode-session.db";
/** Conversation id of the last `agy` child in this worktree; resumed only by the same runner. */
export const AGY_CONVERSATION_FILE = "agy-conversation-id";

const PROVIDER_UNAVAILABLE_RE =
  /rate[\s_-]*limit|too many requests|resource[_\s-]*exhausted|out of quota|\b429\b|insufficient[_\s-]*quota|quota[_\s-]*(?:exceeded|exhausted)|usage[_\s-]*limit|hit your (?:usage|free|session) limit|overloaded|\b(?:502|503|504)\b|bad gateway|gateway timeout|service unavailable|provider(?: returned)?(?: error| (?:is )?unavailable)|model (?:not found|does not exist|unavailable|is not available|gone|not available)|unknown model|no such model|not a valid model/i;

export interface ModelHopOptions {
  fallbackModel?: string;
  fallbackVariant?: string;
  remainingLeaseMs?: () => number | Promise<number>;
  extendLease?: () => Promise<boolean>;
  logger?: (message: string) => void;
}

export interface EngineChainOptions extends ModelHopOptions {
  chain?: NamedRunner[];
}

export function looksLikeProviderUnavailable(text: string): boolean {
  return PROVIDER_UNAVAILABLE_RE.test(text);
}

export function modelProviderPrefix(model: string): string {
  const slash = model.indexOf("/");
  if (slash <= 0) return "";
  return model.slice(0, slash).toLowerCase();
}

export function shouldHopInsteadOfQuotaStuck(primaryModel: string, fallbackModel: string | undefined): boolean {
  if (!fallbackModel) return false;
  const primary = modelProviderPrefix(primaryModel);
  const fallback = modelProviderPrefix(fallbackModel);
  if (primary && fallback) return primary !== fallback;
  return primaryModel !== fallbackModel;
}

export function isProviderUnavailableResult(result: EngineResult): boolean {
  if (result.status !== "exit") return false;
  if (result.infra === true) return false;
  if (result.auth === true) return false;
  if (result.exitCode === 143) return false;
  return looksLikeProviderUnavailable(result.message ?? "");
}

export function openCodeSessionDbPath(workdir: string): string {
  return join(workdir, ".jumi-tmp", OPENCODE_SESSION_DB);
}

export function openCodeLogDirPath(workdir: string): string {
  return join(workdir, ".jumi-tmp", "xdg-data", "opencode", "log");
}

export function agyConversationPath(workdir: string): string {
  return join(workdir, ".jumi-tmp", AGY_CONVERSATION_FILE);
}

async function pathIsFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

export async function hasResumableSession(workdir: string): Promise<boolean> {
  return (await pathIsFile(openCodeSessionDbPath(workdir))) || (await pathIsFile(agyConversationPath(workdir)));
}

export async function clearOpenCodeSession(workdir: string): Promise<void> {
  await rm(openCodeSessionDbPath(workdir), { force: true });
  await rm(agyConversationPath(workdir), { force: true });
  await rm(openCodeLogDirPath(workdir), { recursive: true, force: true });
}

async function remainingCoversTimeout(hop: ModelHopOptions, timeoutMs: number | undefined): Promise<boolean> {
  if (!timeoutMs || timeoutMs <= 0) return true;
  if (!hop.remainingLeaseMs) return true;
  return (await hop.remainingLeaseMs()) >= timeoutMs;
}

async function leaseAllowsHop(hop: ModelHopOptions, timeoutMs: number | undefined): Promise<boolean> {
  if (hop.extendLease && !(await hop.extendLease())) return false;
  return remainingCoversTimeout(hop, timeoutMs);
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message === "cancelled");
}

function isQuotaStuckResult(result: EngineResult): boolean {
  return result.status === "stuck" && isQuotaText(result.message);
}

function shouldHopFromResult(
  result: EngineResult,
  opts: EngineRunOptions,
  currentModel: string,
  nextModel: string
): boolean {
  if (opts.continueSession || opts.abortSignal?.aborted) return false;
  if (result.auth === true) return true;
  if (isProviderUnavailableResult(result)) return true;
  return isQuotaStuckResult(result) && shouldHopInsteadOfQuotaStuck(currentModel, nextModel);
}

function shouldHopFromError(err: unknown, opts: EngineRunOptions, currentModel: string, nextModel: string): boolean {
  if (opts.continueSession || opts.abortSignal?.aborted || isAbortError(err)) return false;
  if (!(err instanceof EngineFailedError) || err.infra) return false;
  if (err.auth) return true;
  if (isQuotaError(err)) return shouldHopInsteadOfQuotaStuck(currentModel, nextModel);
  return looksLikeProviderUnavailable(err.message);
}

function settleQuotaSigterm(opts: EngineRunOptions, result: EngineResult, hopped: boolean): void {
  if (!shouldDeferQuotaExit(result)) return;
  recordOpenCodeRun(opts.trace?.kind ?? "review", { ...result, hopped });
}

async function beginHop(
  hop: EngineChainOptions,
  opts: EngineRunOptions,
  from: NamedRunner,
  to: NamedRunner
): Promise<void> {
  const log = hop.logger ?? opts.logger;
  if (log) {
    logDiagnostic(log, "opencode_hop", {
      review: opts.reviewLabel ?? null,
      from_model: from.model,
      to_model: to.model,
      hop: true,
    });
  }
  await clearOpenCodeSession(opts.workdir);
}

function engineOptsForRunner(
  opts: EngineRunOptions,
  runner: NamedRunner,
  extra?: Partial<EngineRunOptions>
): EngineRunOptions {
  const fields: Pick<EngineRunOptions, "type" | "model" | "variant" | "effort"> = usesEffort(runner.type)
    ? {
        type: runner.type,
        model: runner.model,
        effort: "effort" in runner ? runner.effort : undefined,
        variant: undefined,
      }
    : {
        type: runner.type,
        model: runner.model,
        variant: "variant" in runner ? runner.variant : undefined,
        effort: undefined,
      };
  return { ...opts, ...fields, ...extra };
}

function lazyChain(opts: EngineRunOptions, hop: EngineChainOptions): NamedRunner[] {
  return [
    { name: "primary", type: OPENCODE_RUNNER_TYPE, model: opts.model, variant: opts.variant },
    { name: "fallback", type: OPENCODE_RUNNER_TYPE, model: hop.fallbackModel!, variant: hop.fallbackVariant },
  ];
}

function stampRunner(result: EngineResult, runner: NamedRunner): EngineResult {
  return { ...result, runner: runnerStamp(runner) };
}

export function withEngineChain(engine: Engine, hop: EngineChainOptions): Engine {
  // Without a chain the bare engine runs and stamps fall back to the spawn
  // options, which workers never type, so they read `opencode`. A Claude
  // primary must therefore arrive through `chain` (a 1-entry one is fine).
  if (!hop.chain?.length && !hop.fallbackModel) return engine;

  let chain: NamedRunner[] | undefined;
  if (hop.chain && hop.chain.length >= 2) chain = hop.chain;
  else if (hop.chain?.length === 1 && !hop.fallbackModel) chain = hop.chain;
  let index = 0;

  const runnersFor = (opts: EngineRunOptions): NamedRunner[] => {
    if (chain) return chain;
    chain = lazyChain(opts, hop);
    return chain;
  };

  return async (opts: EngineRunOptions): Promise<EngineResult> => {
    const runners = runnersFor(opts);

    if (opts.hopFromIncomplete === true && !opts.continueSession && !opts.abortSignal?.aborted) {
      const next = runners[index + 1];
      if (next && (await leaseAllowsHop(hop, opts.timeoutMs))) {
        await beginHop(hop, opts, runners[index]!, next);
        index++;
      } else {
        return { status: "ok" };
      }
    }

    if (index > 0 && opts.hopFromIncomplete !== true) {
      const current = runners[index]!;
      try {
        return stampRunner(await engine(engineOptsForRunner(opts, current)), current);
      } catch (err) {
        attachRunner(err, runnerStamp(current));
        throw err;
      }
    }

    while (true) {
      const runner = runners[index]!;
      const hopSpawn = index > 0;
      const runOpts: EngineRunOptions = engineOptsForRunner(opts, runner, {
        deferQuotaExit: true,
        ...(hopSpawn ? { continueSession: false, hop: true } : {}),
      });

      let result: EngineResult;
      try {
        result = stampRunner(await engine(runOpts), runner);
      } catch (err) {
        attachRunner(err, runnerStamp(runner));
        const next = runners[index + 1];
        if (!next || !shouldHopFromError(err, opts, runner.model, next.model)) throw err;
        if (!(await leaseAllowsHop(hop, opts.timeoutMs))) throw err;
        await beginHop(hop, opts, runner, next);
        index++;
        continue;
      }

      const next = runners[index + 1];
      if (!next || !shouldHopFromResult(result, opts, runner.model, next.model)) {
        settleQuotaSigterm(opts, result, false);
        return result;
      }
      if (!(await leaseAllowsHop(hop, opts.timeoutMs))) {
        settleQuotaSigterm(opts, result, false);
        return result;
      }
      try {
        await beginHop(hop, opts, runner, next);
      } catch (err) {
        settleQuotaSigterm(opts, result, false);
        throw err;
      }
      settleQuotaSigterm(opts, result, true);
      index++;
    }
  };
}

export function withModelHop(engine: Engine, hop: ModelHopOptions): Engine {
  return withEngineChain(engine, hop);
}
