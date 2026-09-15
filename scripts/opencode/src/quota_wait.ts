import type { EngineResult } from "./engine.ts";
import { EngineFailedError } from "./engine.ts";
import { shouldHopInsteadOfQuotaStuck } from "./fallback.ts";
import {
  decideQuotaRetry,
  isQuotaError,
  isQuotaText,
  isResettingQuotaText,
  type QuotaClass,
  QuotaWaitError,
} from "./quota.ts";

export { isQuotaWaitError, QuotaWaitError } from "./quota.ts";

function quotaClassOf(input: { quota?: QuotaClass; message?: string | null }): QuotaClass | undefined {
  if (input.quota === "resetting" || input.quota === "hard") return input.quota;
  if (isResettingQuotaText(input.message)) return "resetting";
  if (isQuotaText(input.message)) return "hard";
  return undefined;
}

export function isResettingQuotaResult(result: EngineResult): boolean {
  return quotaClassOf({ quota: result.quota, message: result.message }) === "resetting";
}

export function isResettingQuotaError(err: unknown): boolean {
  if (err instanceof QuotaWaitError) return true;
  if (err instanceof EngineFailedError) {
    return quotaClassOf({ quota: err.quota, message: err.message }) === "resetting";
  }
  if (!isQuotaError(err)) return false;
  const text = err instanceof Error ? err.message : String(err);
  return isResettingQuotaText(text);
}

export function throwIfQuotaWait(input: {
  result?: EngineResult;
  err?: unknown;
  model: string;
  fallbackModel?: string;
  previousError?: string | null;
  nowMs?: number;
  random?: () => number;
}): void {
  if (shouldHopInsteadOfQuotaStuck(input.model, input.fallbackModel)) return;
  let kind: QuotaClass | undefined;
  let retryAfterMs: number | undefined;
  if (input.result) {
    if (input.result.status !== "stuck" || !isQuotaText(input.result.message)) return;
    kind = quotaClassOf({ quota: input.result.quota, message: input.result.message });
    retryAfterMs = input.result.retryAfterMs;
  } else if (input.err) {
    if (input.err instanceof QuotaWaitError) throw input.err;
    if (!isQuotaError(input.err) && !isResettingQuotaError(input.err)) return;
    if (input.err instanceof EngineFailedError) {
      kind = quotaClassOf({ quota: input.err.quota, message: input.err.message });
      retryAfterMs = input.err.retryAfterMs;
    } else {
      const text = input.err instanceof Error ? input.err.message : String(input.err);
      kind = quotaClassOf({ message: text });
    }
  } else {
    return;
  }
  if (kind !== "resetting") return;
  const decision = decideQuotaRetry(input.previousError, input.nowMs ?? Date.now(), retryAfterMs, input.random);
  if (decision.action === "exhaust") return;
  throw new QuotaWaitError(decision);
}
