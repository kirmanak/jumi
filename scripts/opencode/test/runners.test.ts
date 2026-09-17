import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRunnersCatalog, parseRunnersFile, RUNNERS_FILE_ENV, synthesizeRunners } from "../src/runners.ts";

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
