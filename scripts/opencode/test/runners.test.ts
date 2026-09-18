import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendRunnerStamp,
  formatRunnerStamp,
  parseRunnersCatalog,
  parseRunnersFile,
  RUNNERS_FILE_ENV,
  runnerStamp,
  synthesizeRunners,
} from "../src/runners.ts";

describe("parseRunnersCatalog", () => {
  test("unknown type fails closed", () => {
    expect(() =>
      parseRunnersCatalog({
        runners: { x: { type: "hermes", model: "claude-opus" } },
        chain: ["x"],
      })
    ).toThrow("Unknown runner type: hermes");
  });

  test("registers type claude with model and optional effort", () => {
    expect(
      parseRunnersCatalog({
        runners: {
          spark: { type: "claude", model: "opus", effort: "high" },
          grok: { type: "opencode", model: "opencode/grok-4.6" },
        },
        chain: ["spark", "grok"],
      })
    ).toEqual({
      runners: {
        spark: { type: "claude", model: "opus", effort: "high" },
        grok: { type: "opencode", model: "opencode/grok-4.6" },
      },
      chain: ["spark", "grok"],
    });
  });

  test("empty chain, missing runner, and duplicate chain fail closed", () => {
    expect(() => parseRunnersCatalog({ runners: { a: { type: "opencode", model: "a/b" } }, chain: [] })).toThrow(
      "chain must not be empty"
    );
    expect(() =>
      parseRunnersCatalog({ runners: { a: { type: "opencode", model: "a/b" } }, chain: ["missing"] })
    ).toThrow("unknown runner missing");
    expect(() =>
      parseRunnersCatalog({
        runners: { a: { type: "opencode", model: "a/b" } },
        chain: ["a", "a"],
      })
    ).toThrow("duplicate runner in chain");
  });

  test("missing model fails closed", () => {
    expect(() => parseRunnersCatalog({ runners: { a: { type: "opencode" } }, chain: ["a"] })).toThrow("missing model");
  });
});

describe("parseRunnersFile", () => {
  test("invalid JSON fails closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "jumi-runners-parse-"));
    const file = join(dir, "runners.json");
    writeFileSync(file, "{");
    expect(() => parseRunnersFile(file)).toThrow(RUNNERS_FILE_ENV);
  });
});

describe("synthesizeRunners", () => {
  test("omits fallback when unset", () => {
    expect(synthesizeRunners({ model: "openai/gpt-5.5" })).toEqual({
      runners: { primary: { type: "opencode", model: "openai/gpt-5.5" } },
      chain: ["primary"],
    });
  });
});

describe("runner stamp", () => {
  test("formats harness, model, and variant or effort", () => {
    expect(formatRunnerStamp(runnerStamp({ type: "opencode", model: "xai/grok-4.6", variant: "high" }))).toBe(
      "_Jumi · opencode · xai/grok-4.6 (high)_"
    );
    expect(formatRunnerStamp(runnerStamp({ type: "claude", model: "claude-opus-5", effort: "high" }))).toBe(
      "_Jumi · claude · claude-opus-5 (high)_"
    );
  });

  test("defaults to opencode and omits an empty level", () => {
    expect(formatRunnerStamp(runnerStamp({ model: "openai/gpt-5.5" }))).toBe("_Jumi · opencode · openai/gpt-5.5_");
    expect(runnerStamp({ type: "claude", model: "opus", variant: "xhigh" })).toEqual({ type: "claude", model: "opus" });
  });

  test("appends one visible line and leaves the body alone without a runner", () => {
    const runner = runnerStamp({ type: "opencode", model: "m", variant: "v" });
    expect(appendRunnerStamp("Opened x\n", runner)).toBe("Opened x\n\n_Jumi · opencode · m (v)_");
    expect(appendRunnerStamp("", runner)).toBe("_Jumi · opencode · m (v)_");
    expect(appendRunnerStamp("no changes", undefined)).toBe("no changes");
    expect(appendRunnerStamp("body", "_Jumi · claude · opus_")).toBe("body\n\n_Jumi · claude · opus_");
  });
});
