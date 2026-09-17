import { describe, expect, test } from "bun:test";
import { hostname } from "node:os";
import { AUTH_DEATH_REASON, isAuthFailure, looksLikeProviderAuthDeath, providerAuthDeathMessage } from "../src/auth.ts";
import { EngineFailedError } from "../src/engine.ts";

describe("looksLikeProviderAuthDeath", () => {
  test("matches refresh-grant rejection and missing provider key", () => {
    expect(looksLikeProviderAuthDeath('oauth: {"error":"invalid_grant"}')).toBe(true);
    expect(looksLikeProviderAuthDeath("missing API key")).toBe(true);
    expect(looksLikeProviderAuthDeath("API key not found for provider xai")).toBe(true);
    expect(looksLikeProviderAuthDeath(providerAuthDeathMessage())).toBe(true);
  });

  test("does not match quota, unavailable, or spawn", () => {
    expect(looksLikeProviderAuthDeath("429 rate limit exceeded")).toBe(false);
    expect(looksLikeProviderAuthDeath("model not found")).toBe(false);
    expect(looksLikeProviderAuthDeath("EACCES: mkdir '/data/.local/state'")).toBe(false);
    expect(looksLikeProviderAuthDeath("spawn opencode ENOENT")).toBe(false);
  });
});

describe("providerAuthDeathMessage", () => {
  test("is a short hostname line", () => {
    const message = providerAuthDeathMessage();
    expect(message).toBe(`${hostname()}: ${AUTH_DEATH_REASON}`);
    expect(message).toContain("auth");
    expect(new TextEncoder().encode(message).byteLength).toBeLessThan(140);
  });
});

describe("isAuthFailure", () => {
  test("uses EngineFailedError.auth and stderr heuristics", () => {
    expect(isAuthFailure(new EngineFailedError(providerAuthDeathMessage(), false, { auth: true }))).toBe(true);
    expect(isAuthFailure(new EngineFailedError("missing API key", true))).toBe(false);
    expect(isAuthFailure(new EngineFailedError("EACCES: mkdir", true))).toBe(false);
    expect(isAuthFailure(new Error("invalid_grant"))).toBe(true);
    expect(isAuthFailure(new Error("cannot save result for job 1"))).toBe(false);
  });
});
