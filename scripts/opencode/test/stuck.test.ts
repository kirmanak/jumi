import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendStuckFingerprint,
  detectStuck,
  evaluateStuck,
  fingerprintCiChecks,
  fingerprintError,
  fingerprintFollowUpText,
  fingerprintReviewArtifact,
  isSkipLatchReason,
  readStuckState,
  stuckComment,
  writeStuckState,
} from "../src/stuck.ts";

const findingA = "please fix the tests\n<!-- jumi-check: failure -->";
const findingB = "rename the helper\n<!-- jumi-check: failure -->";

describe("fingerprintReviewArtifact", () => {
  test("hashes a complete failure finding and ignores commit SHA", () => {
    const a = fingerprintReviewArtifact(
      "### Jumi OpenCode review\n\nReviewed commit: `abc1234`\n\nplease fix the tests\n<!-- jumi-check: failure -->"
    );
    const b = fingerprintReviewArtifact(
      "### Jumi OpenCode review\n\nReviewed commit: `def5678`\n\nplease fix the tests\n<!-- jumi-check: failure -->"
    );
    expect(a).toBeTruthy();
    expect(a).toBe(b);
  });

  test("does not count empty, incomplete, stub, or success artifacts", () => {
    expect(fingerprintReviewArtifact("")).toBeUndefined();
    expect(fingerprintReviewArtifact(undefined)).toBeUndefined();
    expect(fingerprintReviewArtifact("please fix the tests")).toBeUndefined();
    expect(fingerprintReviewArtifact("I'll inspect the PR and check for correctness issues.")).toBeUndefined();
    expect(fingerprintReviewArtifact("Looks good\n<!-- jumi-check: success -->")).toBeUndefined();
    expect(fingerprintReviewArtifact("<!-- jumi-check: failure -->")).toBeUndefined();
  });
});

describe("fingerprintFollowUpText", () => {
  test("strips SHAs, ids, and headers so the same finding matches", () => {
    const a = fingerprintFollowUpText(`# Review feedback

PR: https://gitea.kirmanak.stream/kirmanak/demo/pulls/127
Number: 127
Head SHA: abcdef1
Head ref: jumi/issue-12-fix

## Trigger

Event: issue_comment
Sender: alice
Comment id: 55

please fix the tests
`);
    const b = fingerprintFollowUpText(`# Review feedback

PR: https://gitea.kirmanak.stream/kirmanak/demo/pulls/127
Number: 127
Head SHA: 9999999
Head ref: jumi/issue-12-fix

## Trigger

Event: issue_comment
Sender: alice
Comment id: 55

please fix the tests
`);
    expect(a).toBeTruthy();
    expect(a).toBe(b);
  });

  test("does not count empty or boilerplate feedback", () => {
    expect(fingerprintFollowUpText("")).toBeUndefined();
    expect(fingerprintFollowUpText("# Review feedback\n\n(no trigger body)\n")).toBeUndefined();
    expect(
      fingerprintFollowUpText("# Review feedback\n\nNo review comments this round. Address JUMI_CI.md.\n")
    ).toBeUndefined();
  });
});

describe("fingerprintError", () => {
  test("hashes a job error and skips cancel/empty", () => {
    expect(fingerprintError("opencode exploded")).toBeTruthy();
    expect(fingerprintError("opencode exploded")).toBe(fingerprintError("  opencode exploded  "));
    expect(fingerprintError("")).toBeUndefined();
    expect(fingerprintError("cancelled")).toBeUndefined();
    expect(fingerprintError("AbortError")).toBeUndefined();
  });
});

describe("fingerprintCiChecks", () => {
  test("requires a log hash", () => {
    expect(fingerprintCiChecks([{ name: "build", logHash: "" }])).toBeUndefined();
    expect(fingerprintCiChecks([{ name: "build", logHash: "abc" }])).toBeTruthy();
  });
});

describe("detectStuck", () => {
  const A = { kind: "action" as const, hash: "aaa" };
  const B = { kind: "action" as const, hash: "bbb" };
  const C = { kind: "ci" as const, hash: "ccc" };
  const D = { kind: "ci" as const, hash: "ddd" };
  const E = { kind: "error" as const, hash: "eee" };
  const F = { kind: "error" as const, hash: "fff" };

  test("same action 4×", () => {
    expect(detectStuck([A, A, A])).toBeUndefined();
    expect(detectStuck([A, A, A, A])).toBe("repeated-action");
  });

  test("same CI 4×", () => {
    expect(detectStuck([C, C, C])).toBeUndefined();
    expect(detectStuck([C, C, C, C])).toBe("repeated-action");
  });

  test("same error 3×", () => {
    expect(detectStuck([E, E])).toBeUndefined();
    expect(detectStuck([E, E, E])).toBe("repeated-error");
  });

  test("A→B→A ping-pong of distinct fingerprints", () => {
    expect(detectStuck([A, B])).toBeUndefined();
    expect(detectStuck([A, B, A])).toBe("ping-pong");
    expect(detectStuck([C, D, C])).toBe("ping-pong");
    expect(detectStuck([E, F, E])).toBe("ping-pong");
  });

  test("two different reviews without alternating are not ping-pong", () => {
    expect(detectStuck([A, B, B])).toBeUndefined();
    expect(detectStuck([A, A, B])).toBeUndefined();
  });

  test("mixed kinds last-three is not ping-pong", () => {
    expect(detectStuck([A, E, A])).toBeUndefined();
    expect(evaluateStuck([A, E], A)).toBeUndefined();
    expect(detectStuck([A, C, A])).toBeUndefined();
    expect(evaluateStuck([A, C], A)).toBeUndefined();
  });

  test("evaluateStuck uses current fingerprint", () => {
    expect(evaluateStuck([A, A, A], A)).toBe("repeated-action");
    expect(evaluateStuck([A, B], A)).toBe("ping-pong");
    expect(evaluateStuck([C, C, C], C)).toBe("repeated-action");
    expect(evaluateStuck([C, D], C)).toBe("ping-pong");
    expect(evaluateStuck([E, E], E)).toBe("repeated-error");
    expect(evaluateStuck([A, A], B)).toBeUndefined();
  });

  test("stays stuck once the history already matches", () => {
    expect(evaluateStuck([A, B, A], B)).toBe("ping-pong");
  });
});

describe("stuckComment", () => {
  test("uses stuck: prefix", () => {
    expect(stuckComment("repeated-action")).toBe("stuck: repeated action");
    expect(stuckComment("repeated-error")).toBe("stuck: repeated error");
    expect(stuckComment("ping-pong")).toBe("stuck: ping-pong");
  });
});

describe("isSkipLatchReason", () => {
  test("matches stuck: skip latches and ignores per-job skips", () => {
    expect(isSkipLatchReason("stuck: cannot resolve conflicts")).toBe(true);
    expect(isSkipLatchReason("stuck: repeated error")).toBe(true);
    expect(isSkipLatchReason("stuck: usage limit exceeded")).toBe(true);
    expect(isSkipLatchReason("same head and base already attempted")).toBe(false);
    expect(isSkipLatchReason("no unhandled feedback")).toBe(false);
    expect(isSkipLatchReason(undefined)).toBe(false);
  });
});

describe("stuck state file", () => {
  test("round-trips fingerprints", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-stuck-"));
    try {
      const path = join(dir, "12.stuck.json");
      await writeStuckState(path, {
        fingerprints: [{ kind: "action", hash: fingerprintReviewArtifact(findingA)! }],
        updatedAt: "2026-05-23T00:00:00Z",
      });
      await appendStuckFingerprint(path, { kind: "action", hash: fingerprintReviewArtifact(findingB)! });
      await appendStuckFingerprint(path, {
        kind: "ci",
        hash: fingerprintCiChecks([{ name: "build", logHash: "abc" }])!,
      });
      const state = await readStuckState(path);
      expect(state.fingerprints).toHaveLength(3);
      expect(state.fingerprints[0]?.kind).toBe("action");
      expect(state.fingerprints[2]?.kind).toBe("ci");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
