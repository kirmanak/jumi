import { describe, expect, test } from "bun:test";
import {
  blockedOnComment,
  checkIssueBlockers,
  DEPENDENCY_CYCLE_REASON,
  DEPENDENCY_GRAPH_CAP,
  formatIssueRef,
  isBlockerUnresolved,
} from "../src/dependencies.ts";
import type { LinkedIssue } from "../src/ports.ts";
import { makeLinkedIssue, makePR } from "./fixtures.ts";

describe("formatIssueRef / blockedOnComment", () => {
  test("uses #n in the home repo and owner/repo#n across repos", () => {
    expect(formatIssueRef({ owner: "kirmanak", repo: "demo", number: 196 }, "kirmanak", "demo")).toBe("#196");
    expect(formatIssueRef({ owner: "kirmanak", repo: "other", number: 10 }, "kirmanak", "demo")).toBe(
      "kirmanak/other#10"
    );
    expect(blockedOnComment([makeLinkedIssue({ number: 196 })], "kirmanak", "demo")).toBe("blocked on #196");
    expect(
      blockedOnComment(
        [makeLinkedIssue({ number: 197 }), makeLinkedIssue({ owner: "kirmanak", repo: "other", number: 10 })],
        "kirmanak",
        "demo"
      )
    ).toBe("blocked on #197, kirmanak/other#10");
  });
});

describe("isBlockerUnresolved", () => {
  test("open is unresolved; closed with no closer is done; closed with open closer is unresolved", async () => {
    const open = makeLinkedIssue({ state: "open" });
    const closed = makeLinkedIssue({ number: 196, state: "closed" });
    expect(await isBlockerUnresolved(open, { listOpenPulls: async () => [] })).toBe(true);
    expect(await isBlockerUnresolved(closed, { listOpenPulls: async () => [] })).toBe(false);
    expect(
      await isBlockerUnresolved(closed, {
        listOpenPulls: async () => [makePR({ title: "Fix", body: "Fixes #196" })],
      })
    ).toBe(true);
    expect(
      await isBlockerUnresolved(closed, {
        listOpenPulls: async () => [makePR({ title: "Fix", body: "Fixes #196", state: "closed" })],
      })
    ).toBe(false);
  });
});

describe("checkIssueBlockers", () => {
  test("ready when there are no dependencies", async () => {
    const result = await checkIssueBlockers(
      { listIssueDependencies: async () => [], listOpenPulls: async () => [] },
      "kirmanak",
      "demo",
      12
    );
    expect(result).toEqual({ status: "ready" });
  });

  test("blocked on a direct open blocker", async () => {
    const blocker = makeLinkedIssue({ number: 196 });
    const result = await checkIssueBlockers(
      {
        listIssueDependencies: async (_owner, _repo, index) => (index === 12 ? [blocker] : []),
        listOpenPulls: async () => [],
      },
      "kirmanak",
      "demo",
      12
    );
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") expect(result.blockers.map((row) => row.number)).toEqual([196]);
  });

  test("ready when the blocker is closed with no closer", async () => {
    const blocker = makeLinkedIssue({ number: 196, state: "closed" });
    const result = await checkIssueBlockers(
      {
        listIssueDependencies: async (_owner, _repo, index) => (index === 12 ? [blocker] : []),
        listOpenPulls: async () => [],
      },
      "kirmanak",
      "demo",
      12
    );
    expect(result).toEqual({ status: "ready" });
  });

  test("blocked when the blocker is closed but its closer is still open", async () => {
    const blocker = makeLinkedIssue({ number: 196, state: "closed" });
    const result = await checkIssueBlockers(
      {
        listIssueDependencies: async (_owner, _repo, index) => (index === 12 ? [blocker] : []),
        listOpenPulls: async () => [makePR({ title: "Fix", body: "Fixes #196" })],
      },
      "kirmanak",
      "demo",
      12
    );
    expect(result.status).toBe("blocked");
  });

  test("walks transitive blockers through a done parent", async () => {
    const mid = makeLinkedIssue({ number: 196, state: "closed" });
    const leaf = makeLinkedIssue({ number: 180, state: "open" });
    const result = await checkIssueBlockers(
      {
        listIssueDependencies: async (_owner, _repo, index) => {
          if (index === 12) return [mid];
          if (index === 196) return [leaf];
          return [];
        },
        listOpenPulls: async () => [],
      },
      "kirmanak",
      "demo",
      12
    );
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") expect(result.blockers.map((row) => row.number)).toEqual([180]);
  });

  test("fail-closes a cycle without looping", async () => {
    const a = makeLinkedIssue({ number: 12 });
    const b = makeLinkedIssue({ number: 196 });
    const result = await checkIssueBlockers(
      {
        listIssueDependencies: async (_owner, _repo, index) => {
          if (index === 12) return [b];
          if (index === 196) return [a];
          return [];
        },
        listOpenPulls: async () => [],
      },
      "kirmanak",
      "demo",
      12
    );
    expect(result).toEqual({ status: "stuck", reason: DEPENDENCY_CYCLE_REASON });
  });

  test("fail-closes when the graph exceeds the cap", async () => {
    const deps = new Map<number, LinkedIssue[]>();
    for (let i = 0; i < DEPENDENCY_GRAPH_CAP + 2; i++) {
      deps.set(i === 0 ? 12 : 1000 + i, i < DEPENDENCY_GRAPH_CAP + 1 ? [makeLinkedIssue({ number: 1001 + i })] : []);
    }
    const result = await checkIssueBlockers(
      {
        listIssueDependencies: async (_owner, _repo, index) => deps.get(index) ?? [],
        listOpenPulls: async () => [],
      },
      "kirmanak",
      "demo",
      12
    );
    expect(result).toEqual({ status: "stuck", reason: DEPENDENCY_CYCLE_REASON });
  });
});
