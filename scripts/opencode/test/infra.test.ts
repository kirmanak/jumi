import { describe, expect, test } from "bun:test";
import { EngineFailedError } from "../src/engine.ts";
import {
  classifyOpenCodeInfra,
  decideInfraRetry,
  encodeInfraMarker,
  INFRA_BACKOFF_MS,
  INFRA_BUDGET_MS,
  INFRA_MAX_RETRIES,
  INFRA_SPAWN_REASON,
  InfraCircuitBreaker,
  isInfraFailure,
  looksLikeInfraStderr,
} from "../src/infra.ts";

describe("classifyOpenCodeInfra", () => {
  test("short run with unchanged session db is infra", () => {
    expect(
      classifyOpenCodeInfra({
        durationMs: 800,
        stderr: "EACCES: mkdir '/data/.local/state'",
        dbBefore: null,
        dbAfter: null,
      })
    ).toBe(true);
  });

  test("duration over 2s is a model attempt", () => {
    expect(classifyOpenCodeInfra({ durationMs: 2_000, dbBefore: null, dbAfter: null })).toBe(false);
  });

  test("session db growth is a model attempt even when short", () => {
    expect(classifyOpenCodeInfra({ durationMs: 400, dbBefore: null, dbAfter: 4096 })).toBe(false);
  });

  test("short EACCES with a created session db is still infra", () => {
    expect(
      classifyOpenCodeInfra({
        durationMs: 400,
        stderr: "EACCES: mkdir '/data/.local/state'",
        dbBefore: null,
        dbAfter: 4096,
      })
    ).toBe(true);
  });

  test("tokens exist is a model attempt even when short", () => {
    expect(classifyOpenCodeInfra({ durationMs: 400, dbBefore: null, dbAfter: null, tokensExist: true })).toBe(false);
  });

  test("provider-unavailable is not infra even when short", () => {
    expect(
      classifyOpenCodeInfra({
        durationMs: 400,
        stderr: "Error: 429 rate limit exceeded",
        dbBefore: null,
        dbAfter: null,
      })
    ).toBe(false);
    expect(
      classifyOpenCodeInfra({
        durationMs: 400,
        stderr: "model not found",
        dbBefore: null,
        dbAfter: null,
      })
    ).toBe(false);
  });

  test("auth death is not infra even when short or slow", () => {
    expect(
      classifyOpenCodeInfra({
        durationMs: 400,
        stderr: "missing API key",
        dbBefore: null,
        dbAfter: null,
      })
    ).toBe(false);
    expect(
      classifyOpenCodeInfra({
        durationMs: 8_000,
        stderr: 'oauth token refresh failed: {"error":"invalid_grant"}',
        dbBefore: null,
        dbAfter: null,
      })
    ).toBe(false);
  });
});

describe("isInfraFailure", () => {
  test("uses EngineFailedError.infra and stderr heuristics", () => {
    expect(isInfraFailure(new EngineFailedError("opencode exited", true))).toBe(true);
    expect(isInfraFailure(new EngineFailedError("opencode exited", false))).toBe(false);
    expect(isInfraFailure(new EngineFailedError("EACCES: mkdir '/data/.local/state'", false))).toBe(false);
    expect(isInfraFailure(new Error("EACCES: mkdir '/data/.local/state'"))).toBe(true);
    expect(isInfraFailure(new Error("cannot save result for job 1"))).toBe(false);
  });

  test("looksLikeInfraStderr matches spawn and not auth", () => {
    expect(looksLikeInfraStderr("spawn opencode ENOENT")).toBe(true);
    expect(looksLikeInfraStderr('Executable not found in $PATH: "opencode"')).toBe(true);
    expect(looksLikeInfraStderr("missing API key")).toBe(false);
    expect(looksLikeInfraStderr("invalid_grant")).toBe(false);
    expect(looksLikeInfraStderr("opencode exited with code 1:\nbad things")).toBe(false);
  });

  test("raw missing-key errors are not infra", () => {
    expect(isInfraFailure(new Error("missing API key"))).toBe(false);
    expect(isInfraFailure(new EngineFailedError("missing API key", false, { auth: true }))).toBe(false);
  });
});

describe("decideInfraRetry", () => {
  test("backs off 2s then 5s without exhausting", () => {
    const first = decideInfraRetry(null, 1_000);
    expect(first).toEqual({
      action: "requeue",
      count: 1,
      firstFailAt: 1_000,
      backoffMs: INFRA_BACKOFF_MS[0],
      marker: encodeInfraMarker(1, 1_000),
    });
    const second = decideInfraRetry(first.action === "requeue" ? first.marker : null, 4_000);
    expect(second.action).toBe("requeue");
    if (second.action === "requeue") expect(second.backoffMs).toBe(INFRA_BACKOFF_MS[1]);
  });

  test("exhausts after 8 infra retries", () => {
    const marker = encodeInfraMarker(INFRA_MAX_RETRIES - 1, 1_000);
    expect(decideInfraRetry(marker, 2_000)).toEqual({ action: "exhaust", reason: INFRA_SPAWN_REASON });
  });

  test("exhausts after 20 minute wall budget", () => {
    const marker = encodeInfraMarker(1, 1_000);
    expect(decideInfraRetry(marker, 1_000 + INFRA_BUDGET_MS)).toEqual({
      action: "exhaust",
      reason: INFRA_SPAWN_REASON,
    });
  });
});

describe("InfraCircuitBreaker", () => {
  test("opens after N consecutive infra fails and skips lease until cooldown", () => {
    const breaker = new InfraCircuitBreaker(3, 60_000);
    expect(breaker.canLease(0)).toBe(true);
    breaker.recordInfra(0);
    breaker.recordInfra(1);
    expect(breaker.canLease(2)).toBe(true);
    breaker.recordInfra(2);
    expect(breaker.canLease(3)).toBe(false);
    expect(breaker.canLease(2 + 60_000 - 1)).toBe(false);
    expect(breaker.canLease(2 + 60_000)).toBe(true);
  });

  test("model success closes; another infra fail opens again", () => {
    const breaker = new InfraCircuitBreaker(3, 60_000);
    breaker.recordInfra(0);
    breaker.recordInfra(1);
    breaker.recordInfra(2);
    expect(breaker.canLease(3)).toBe(false);
    expect(breaker.canLease(2 + 60_000)).toBe(true);
    breaker.recordModelReached();
    expect(breaker.canLease(2 + 60_000 + 1)).toBe(true);
    breaker.recordInfra(2 + 60_000 + 2);
    breaker.recordInfra(2 + 60_000 + 3);
    expect(breaker.canLease(2 + 60_000 + 4)).toBe(true);
    breaker.recordInfra(2 + 60_000 + 5);
    expect(breaker.canLease(2 + 60_000 + 6)).toBe(false);
  });

  test("half-open infra fail opens again", () => {
    const breaker = new InfraCircuitBreaker(3, 10);
    breaker.recordInfra(0);
    breaker.recordInfra(1);
    breaker.recordInfra(2);
    expect(breaker.canLease(12)).toBe(true);
    breaker.recordInfra(13);
    expect(breaker.canLease(14)).toBe(false);
    expect(breaker.canLease(13 + 10)).toBe(true);
  });
});
