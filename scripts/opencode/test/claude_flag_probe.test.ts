import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeArgv } from "../src/claude.ts";
import {
  CLAUDE_EFFORT_LEVELS,
  CLAUDE_REJECTABLE_FLAGS,
  droppedFlagWarning,
  flagObjection,
  judgeEffortLevel,
  judgeNegativeRun,
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

describe("judgeNegativeRun", () => {
  const bad = nonsenseValue("--effort");
  const effort = { flag: "--effort", value: "high" };
  const swapped = withFlagValue(argv, "--effort", bad);

  test("accepts commander's exit for a flag the binary can refuse", () => {
    const mode = { flag: "--permission-mode", value: "dontAsk" };
    const badMode = nonsenseValue("--permission-mode");
    const stderr = `error: option '--permission-mode <mode>' argument '${badMode}' is invalid.`;
    const result = judgeNegativeRun(withFlagValue(argv, "--permission-mode", badMode), mode, badMode, {
      code: 1,
      stdout: "",
      stderr,
      timedOut: false,
    });
    expect(result.ok).toBe(true);
  });

  test("accepts the --effort warning when the positive run's own detector also sees it", () => {
    const stderr = `Warning: Unknown --effort value '${bad}' — ignoring it and using the default effort.`;
    const result = judgeNegativeRun(swapped, effort, bad, { code: 0, stdout: "", stderr, timedOut: false });
    expect(result.ok).toBe(true);
    expect(result.observed).toBe(stderr);
  });

  test("fails when the --effort warning is invisible to droppedFlagWarning", () => {
    // `flagObjection` only needs the flag and the value somewhere on the line,
    // but the positive run's "no production flag was warned about and dropped"
    // row uses the anchored `droppedFlagWarning`. A release that prefixes the
    // line would disarm that row while this control stayed green, so the
    // control has to exercise the anchored matcher too.
    const stderr = `⚠ Warning: Unknown --effort value '${bad}' — ignoring it and using the default effort.`;
    const result = judgeNegativeRun(swapped, effort, bad, { code: 0, stdout: "", stderr, timedOut: false });
    expect(result.ok).toBe(false);
    expect(result.observed).toContain("droppedFlagWarning");
  });

  test("fails when the binary took the nonsense value without a word", () => {
    const result = judgeNegativeRun(swapped, effort, bad, {
      code: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    });
    expect(result.ok).toBe(false);
  });
});

describe("judgeEffortLevel", () => {
  test("covers every level the binary documents, not just the one Jumi's runners use", () => {
    // `effort` is free-form operator config (`JUMI_RUNNERS_FILE`), so a runner
    // on `xhigh` or `max` gets no protection from probing `high` alone — and a
    // level the binary forgot downgrades the run silently instead of failing.
    expect(CLAUDE_EFFORT_LEVELS).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("passes a clean run", () => {
    const levelArgv = withFlagValue(argv, "--effort", "max");
    expect(judgeEffortLevel("max", levelArgv, { code: 0, stdout: "", stderr: "", timedOut: false }).ok).toBe(true);
  });

  test("fails a level the binary warned about and dropped", () => {
    const levelArgv = withFlagValue(argv, "--effort", "xhigh");
    const stderr = "Warning: Unknown --effort value 'xhigh' — ignoring it and using the default effort.";
    const result = judgeEffortLevel("xhigh", levelArgv, { code: 0, stdout: "", stderr, timedOut: false });
    expect(result.ok).toBe(false);
    expect(result.observed).toBe(stderr);
  });

  test("fails a level the binary exited on", () => {
    const levelArgv = withFlagValue(argv, "--effort", "low");
    expect(judgeEffortLevel("low", levelArgv, { code: 1, stdout: "", stderr: "boom", timedOut: false }).ok).toBe(false);
  });
});

describe("image verification paths", () => {
  const repoRoot = join(process.cwd(), "../..");

  test("runs the claude flag probe in every image verification path", () => {
    // The probe is the only thing standing between a CLAUDE_VERSION bump and a
    // production flag the binary no longer accepts, so no verification path may
    // lose it. `opencode-checks.yml` matters most: it is the one that runs on
    // pull_request, so it is what gates the bump before the image is published.
    const paths = [
      ".gitea/scripts/build-reviewer-image.sh",
      ".gitea/scripts/build-worker-image.sh",
      ".github/workflows/jumi-reviewer-image.yml",
      ".github/workflows/jumi-worker-image.yml",
      ".github/workflows/opencode-checks.yml",
    ];
    expect(existsSync(join(repoRoot, "scripts/opencode/src/claude_flag_probe.ts"))).toBe(true);
    for (const path of paths) {
      expect(readFileSync(join(repoRoot, path), "utf8")).toContain("bun src/claude_flag_probe.ts");
    }
    // Both pull_request image builds in that one file — reviewer and worker —
    // ship `claude`, so both have to prove the flags, not just the first.
    const checks = readFileSync(join(repoRoot, ".github/workflows/opencode-checks.yml"), "utf8");
    expect(checks.split("bun src/claude_flag_probe.ts").length - 1).toBe(2);
  });
});
