import { rm } from "node:fs/promises";
import { join } from "node:path";
import { logDiagnostic } from "./diagnostics.ts";
import { type Engine, EngineFailedError, type EngineResult, type EngineRunOptions } from "./engine.ts";
import { isQuotaError, isQuotaText } from "./quota.ts";

export const OPENCODE_SESSION_DB = "opencode-session.db";

const PROVIDER_UNAVAILABLE_RE =
  /rate[\s_-]*limit|too many requests|\b429\b|insufficient[_\s-]*quota|quota[_\s-]*(?:exceeded|exhausted)|usage[_\s-]*limit|hit your (?:usage|free) limit|overloaded|\b(?:502|503|504)\b|bad gateway|gateway timeout|service unavailable|provider(?: returned)?(?: error| (?:is )?unavailable)|model (?:not found|does not exist|unavailable|is not available|gone|not available)|unknown model|no such model|not a valid model/i;

export interface ModelHopOptions {
  fallbackModel?: string;
  fallbackVariant?: string;
  remainingLeaseMs?: () => number | Promise<number>;
  extendLease?: () => Promise<boolean>;
  logger?: (message: string) => void;
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
  if (!primary || !fallback) return false;
  return primary !== fallback;
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

export async function clearOpenCodeSession(workdir: string): Promise<void> {
  await rm(openCodeSessionDbPath(workdir), { force: true });
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

function shouldHopFromResult(result: EngineResult, opts: EngineRunOptions, fallbackModel: string): boolean {
  if (opts.continueSession || opts.abortSignal?.aborted) return false;
  if (result.auth === true) return false;
  if (isProviderUnavailableResult(result)) return true;
  return isQuotaStuckResult(result) && shouldHopInsteadOfQuotaStuck(opts.model, fallbackModel);
}

function shouldHopFromError(err: unknown, opts: EngineRunOptions, fallbackModel: string): boolean {
  if (opts.continueSession || opts.abortSignal?.aborted || isAbortError(err)) return false;
  if (!(err instanceof EngineFailedError) || err.infra || err.auth) return false;
  if (isQuotaError(err)) return shouldHopInsteadOfQuotaStuck(opts.model, fallbackModel);
  return looksLikeProviderUnavailable(err.message);
}

export function withModelHop(engine: Engine, hop: ModelHopOptions): Engine {
  const fallbackModel = hop.fallbackModel;
  if (!fallbackModel) return engine;

  let hopped = false;

  const spawnFallback = async (opts: EngineRunOptions): Promise<EngineResult> => {
    const log = hop.logger ?? opts.logger;
    if (log) {
      logDiagnostic(log, "opencode_hop", {
        review: opts.reviewLabel ?? null,
        from_model: opts.model,
        to_model: fallbackModel,
        hop: true,
      });
    }
    await clearOpenCodeSession(opts.workdir);
    hopped = true;
    return engine({
      ...opts,
      model: fallbackModel,
      variant: hop.fallbackVariant,
      continueSession: false,
      hop: true,
    });
  };

  return async (opts: EngineRunOptions): Promise<EngineResult> => {
    if (hopped) {
      return engine({
        ...opts,
        model: fallbackModel,
        variant: hop.fallbackVariant,
      });
    }

    let result: EngineResult;
    try {
      result = await engine(opts);
    } catch (err) {
      if (!shouldHopFromError(err, opts, fallbackModel)) throw err;
      if (!(await leaseAllowsHop(hop, opts.timeoutMs))) throw err;
      return spawnFallback(opts);
    }

    if (!shouldHopFromResult(result, opts, fallbackModel)) return result;
    if (!(await leaseAllowsHop(hop, opts.timeoutMs))) return result;
    return spawnFallback(opts);
  };
}
