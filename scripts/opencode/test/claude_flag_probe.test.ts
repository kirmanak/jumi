import { describe, expect, test } from "bun:test";
import { claudeArgv } from "../src/claude.ts";
import {
  CLAUDE_REJECTABLE_FLAGS,
  droppedFlagWarning,
  flagObjection,
  nonsenseValue,
  pinnedFlagValues,
  withFlagValue,
} from "../src/claude_flag_probe.ts";

const argv = claudeArgv({ model: "probe-model", effort: "high", workdir: "/work" });

describe("pinnedFlagValues", () => {
  test("pins the production values the claude binary is able to reject", () => {
    // These are the literals the image probe re-runs against the installed
    // binary. Argv shape is asserted in claude.test.ts; what is pinned here is
    // the *values*, because those are what a Claude release can refuse.
    expect(pinnedFlagValues(argv)).toEqual([
      { flag: "--permission-mode", value: "dontAsk" },
      { flag: "--setting-sources", value: "user" },
      { flag: "--output-format", value: "stream-json" },
      { flag: "--effort", value: "high" },
    ]);
  });

  test("covers every rejectable flag, so the probe table cannot silently shrink", () => {
    expect(pinnedFlagValues(argv).map(({ flag }) => flag)).toEqual(CLAUDE_REJECTABLE_FLAGS);
  });

  test("omits a flag production did not pass", () => {
    // `--effort` is operator config, not a constant: a runner without one
    // spawns without the flag and there is nothing to probe.
    const withoutEffort = claudeArgv({ model: "probe-model", workdir: "/work" });
    expect(withoutEffort).not.toContain("--effort");
    expect(pinnedFlagValues(withoutEffort).map(({ flag }) => flag)).toEqual([
      "--permission-mode",
      "--setting-sources",
      "--output-format",
    ]);
  });
});

describe("withFlagValue", () => {
  test("swaps one value and leaves the rest of the argv alone", () => {
    const swapped = withFlagValue(argv, "--permission-mode", "nope");
    expect(swapped[swapped.indexOf("--permission-mode") + 1]).toBe("nope");
    expect(swapped.filter((arg) => arg !== "nope")).toEqual(argv.filter((arg) => arg !== "dontAsk"));
  });

  test("throws rather than probing an argv that lost the flag", () => {
    expect(() => withFlagValue(["claude", "-p"], "--permission-mode", "nope")).toThrow("--permission-mode");
  });
});

describe("nonsenseValue", () => {
  test("is a value no release can accept for the flag", () => {
    expect(nonsenseValue("--permission-mode")).toBe("jumi-not-a-valid-permission-mode");
    for (const flag of CLAUDE_REJECTABLE_FLAGS) {
      expect(pinnedFlagValues(argv).map(({ value }) => value)).not.toContain(nonsenseValue(flag));
    }
  });
});

describe("droppedFlagWarning", () => {
  test("catches a flag the binary took and then ignored", () => {
    const stderr = "Warning: Unknown --effort value 'high' — ignoring it and using the default effort.";
    expect(droppedFlagWarning(argv, stderr)).toBe(stderr);
  });

  test("ignores runtime noise that names no flag of ours", () => {
    // The probe runs inside the image, where unrelated warnings (container,
    // locale, root) are not a statement about the production argv.
    expect(droppedFlagWarning(argv, "Warning: running as root in a container")).toBeUndefined();
    expect(droppedFlagWarning(argv, "")).toBeUndefined();
  });
});

describe("flagObjection", () => {
  test("reads commander's rejection of a bad value", () => {
    const stderr = "error: option '--permission-mode <mode>' argument 'bad' is invalid. Allowed choices are dontAsk.";
    expect(flagObjection("--permission-mode", "bad", { code: 1, stderr })).toBe(stderr);
  });

  test("counts a warning that drops the flag, which exits zero", () => {
    // `--effort` does not fail the process; it warns and falls back to the
    // default effort. In production that is a silent downgrade, so the probe
    // has to treat it as a rejection too.
    const stderr = "Warning: Unknown --effort value 'bad' — ignoring it and using the default effort.";
    expect(flagObjection("--effort", "bad", { code: 0, stderr })).toBe(stderr.trim());
  });

  test("falls back to a non-zero exit when nothing on stderr names the flag", () => {
    expect(flagObjection("--output-format", "bad", { code: 1, stderr: "" })).toBe("exit 1");
  });

  test("reports no objection when the binary took the nonsense value", () => {
    // This is the case that fails the image probe: a binary that shrugs at a
    // nonsense value would also shrug at a typo in the production constant,
    // which would make the positive case prove nothing.
    expect(flagObjection("--permission-mode", "bad", { code: 0, stderr: "" })).toBeUndefined();
  });
});
