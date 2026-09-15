import { describe, expect, test } from "bun:test";
import { EngineFailedError } from "../src/engine.ts";
import { QUOTA_MESSAGE, QuotaWaitError } from "../src/quota.ts";
import { isResettingQuotaError, isResettingQuotaResult, throwIfQuotaWait } from "../src/quota_wait.ts";

describe("throwIfQuotaWait", () => {
  test("throws wait for resetting quota when fallback is unset", () => {
    expect(() =>
      throwIfQuotaWait({
        result: { status: "stuck", message: QUOTA_MESSAGE, quota: "resetting" },
        model: "opencode/big-pickle",
        random: () => 0,
      })
    ).toThrow(QuotaWaitError);
  });

  test("does not wait when fallback is a different provider", () => {
    expect(() =>
      throwIfQuotaWait({
        result: { status: "stuck", message: QUOTA_MESSAGE, quota: "resetting" },
        model: "opencode/big-pickle",
        fallbackModel: "anthropic/claude-sonnet-4-6",
        random: () => 0,
      })
    ).not.toThrow();
  });

  test("does not wait for hard quota", () => {
    expect(() =>
      throwIfQuotaWait({
        result: { status: "stuck", message: QUOTA_MESSAGE, quota: "hard" },
        model: "opencode/big-pickle",
        random: () => 0,
      })
    ).not.toThrow();
    expect(isResettingQuotaResult({ status: "stuck", message: QUOTA_MESSAGE, quota: "hard" })).toBe(false);
    expect(isResettingQuotaError(new EngineFailedError(QUOTA_MESSAGE, false, { quota: "hard" }))).toBe(false);
  });

  test("same-provider fallback is treated as no hop", () => {
    expect(() =>
      throwIfQuotaWait({
        result: { status: "stuck", message: QUOTA_MESSAGE, quota: "resetting" },
        model: "opencode/big-pickle",
        fallbackModel: "opencode/gpt-5.5",
        random: () => 0,
      })
    ).toThrow(QuotaWaitError);
  });
});
