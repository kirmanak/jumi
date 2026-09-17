import { hostname } from "node:os";
import { EngineFailedError } from "./engine.ts";

export const AUTH_DEATH_REASON = "provider auth death";

const AUTH_STDERR_RE = /invalid_grant|missing API key|API key not/i;

export function looksLikeProviderAuthDeath(text: string): boolean {
  return AUTH_STDERR_RE.test(text) || text.includes(AUTH_DEATH_REASON);
}

export function providerAuthDeathMessage(host = hostname()): string {
  return `${host}: ${AUTH_DEATH_REASON}`;
}

export function isAuthFailure(err: unknown): boolean {
  if (err instanceof EngineFailedError) return err.auth === true;
  const text = err instanceof Error ? err.message : String(err);
  return looksLikeProviderAuthDeath(text);
}
