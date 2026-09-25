import { describe, expect, test } from "bun:test";
import { EngineFailedError, throwIfEngineFailed } from "../src/engine.ts";
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

  test("configured pair alone does not skip the wait", () => {
    expect(() =>
      throwIfQuotaWait({
        result: { status: "stuck", message: QUOTA_MESSAGE, quota: "resetting" },
        model: "opencode/big-pickle",
        fallbackModel: "anthropic/claude-sonnet-4-6",
        random: () => 0,
      })
    ).toThrow(QuotaWaitError);
  });

  test("waits when the producing runner is last in a mixed chain", () => {
    expect(() =>
      throwIfQuotaWait({
        result: {
          status: "stuck",
          message: QUOTA_MESSAGE,
          quota: "resetting",
          runner: { type: "opencode", model: "anthropic/claude-sonnet-4-6" },
        },
        model: "opencode/big-pickle",
        fallbackModel: "anthropic/claude-sonnet-4-6",
        chain: [{ model: "opencode/big-pickle" }, { model: "anthropic/claude-sonnet-4-6" }],
        random: () => 0,
      })
    ).toThrow(QuotaWaitError);
  });

  test("does not wait when a later runner can still take the quota", () => {
    expect(() =>
      throwIfQuotaWait({
        result: {
          status: "stuck",
          message: QUOTA_MESSAGE,
          quota: "resetting",
          runner: { type: "opencode", model: "opencode/big-pickle" },
        },
        model: "opencode/big-pickle",
        chain: [{ model: "opencode/big-pickle" }, { model: "anthropic/claude-sonnet-4-6" }],
        random: () => 0,
      })
    ).not.toThrow();
  });

  test("a refused hop survives throwIfEngineFailed so a later runner does not skip the wait", () => {
    let thrown: unknown;
    try {
      throwIfEngineFailed({
        status: "stuck",
        message: QUOTA_MESSAGE,
        quota: "resetting",
        runner: { type: "opencode", model: "opencode/big-pickle" },
        hopRefused: true,
      });
    } catch (err) {
      thrown = err;
    }
    expect(() =>
      throwIfQuotaWait({
        err: thrown,
        model: "opencode/big-pickle",
        chain: [{ model: "opencode/big-pickle" }, { model: "anthropic/claude-sonnet-4-6" }],
        random: () => 0,
      })
    ).toThrow(QuotaWaitError);
  });

  test("refused hop waits even when a later runner remains", () => {
    expect(() =>
      throwIfQuotaWait({
        result: {
          status: "stuck",
          message: QUOTA_MESSAGE,
          quota: "resetting",
          runner: { type: "opencode", model: "opencode/big-pickle" },
          hopRefused: true,
        },
        model: "opencode/big-pickle",
        fallbackModel: "anthropic/claude-sonnet-4-6",
        chain: [{ model: "opencode/big-pickle" }, { model: "anthropic/claude-sonnet-4-6" }],
        random: () => 0,
      })
    ).toThrow(QuotaWaitError);
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

  test("throws wait for Claude resetting usage-limit when fallback is unset", () => {
    expect(() =>
      throwIfQuotaWait({
        result: { status: "stuck", exitCode: 1, message: QUOTA_MESSAGE, quota: "resetting" },
        model: "claude-opus-5",
        random: () => 0,
      })
    ).toThrow(QuotaWaitError);
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
