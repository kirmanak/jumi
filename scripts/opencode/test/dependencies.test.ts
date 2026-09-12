import { describe, expect, test } from "bun:test";
import {
  blockedOnComment,
  checkIssueBlockers,
  collectCandidateQueue,
  DEPENDENCY_CYCLE_REASON,
  DEPENDENCY_GRAPH_CAP,
  formatIssueRef,
  formatQueueMarkdown,
  isBlockerUnresolved,
  parseBlockedByArtifact,
  parseIssueCitations,
  validateYield,
} from "../src/dependencies.ts";
import type { LinkedIssue } from "../src/ports.ts";
import { makeIssue, makeLinkedIssue, makePR, makeUser } from "./fixtures.ts";

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

describe("parseIssueCitations", () => {
  test("reads #n, owner/repo#n, and issue URLs; closed/self are the caller's problem", () => {
    expect(
      parseIssueCitations(
        "Depends on #196 and kirmanak/other#10. See https://gitea.kirmanak.stream/kirmanak/demo/issues/180",
        "kirmanak",
        "demo"
      )
    ).toEqual([
      { owner: "kirmanak", repo: "other", number: 10 },
      { owner: "kirmanak", repo: "demo", number: 196 },
      { owner: "kirmanak", repo: "demo", number: 180 },
    ]);
  });
});

describe("parseBlockedByArtifact / validateYield", () => {
  test("parses the structured marker", () => {
    expect(parseBlockedByArtifact(null, "kirmanak", "demo")).toEqual({ present: false });
    expect(parseBlockedByArtifact("<!-- jumi-blocked-by: #196 -->\n", "kirmanak", "demo")).toEqual({
      present: true,
      parsed: { owner: "kirmanak", repo: "demo", number: 196 },
    });
    expect(parseBlockedByArtifact("<!-- jumi-blocked-by: kirmanak/other#10 -->", "kirmanak", "demo")).toEqual({
      present: true,
      parsed: { owner: "kirmanak", repo: "other", number: 10 },
    });
    expect(parseBlockedByArtifact("please wait on 196", "kirmanak", "demo")).toEqual({
      present: true,
      parsed: undefined,
    });
  });

  test("rejects invalid, unknown, and self; maps a closer to the issue it closes", () => {
    const candidates = [
      { owner: "kirmanak", repo: "demo", number: 196, title: "Blocker", kind: "issue" as const },
      {
        owner: "kirmanak",
        repo: "demo",
        number: 225,
        title: "Closer",
        kind: "closer" as const,
        closes: { owner: "kirmanak", repo: "demo", number: 196 },
      },
    ];
    expect(validateYield(undefined, candidates, "kirmanak", "demo", 12)).toEqual({ ok: false, reason: "invalid" });
    expect(validateYield({ owner: "kirmanak", repo: "demo", number: 12 }, candidates, "kirmanak", "demo", 12)).toEqual({
      ok: false,
      reason: "self",
    });
    expect(validateYield({ owner: "kirmanak", repo: "demo", number: 999 }, candidates, "kirmanak", "demo", 12)).toEqual(
      { ok: false, reason: "unknown" }
    );
    expect(validateYield({ owner: "kirmanak", repo: "demo", number: 196 }, candidates, "kirmanak", "demo", 12)).toEqual(
      { ok: true, blocker: { owner: "kirmanak", repo: "demo", number: 196 } }
    );
    expect(validateYield({ owner: "kirmanak", repo: "demo", number: 225 }, candidates, "kirmanak", "demo", 12)).toEqual(
      { ok: true, blocker: { owner: "kirmanak", repo: "demo", number: 196 } }
    );
  });
});

describe("collectCandidateQueue", () => {
  test("includes assigned bot issues, their open closers, open citations, and existing deps", async () => {
    const assigned = makeLinkedIssue({ number: 196, title: "Sibling" });
    const cited = makeIssue({ number: 180, title: "Cited" });
    const dep = makeLinkedIssue({ number: 170, title: "Dep" });
    const closedCited = makeIssue({ number: 9, title: "Done", state: "closed" });
    const queue = await collectCandidateQueue({
      api: {
        listRepoIssues: async () => [assigned, makeLinkedIssue({ number: 12, title: "Self" })],
        listIssueDependencies: async () => [dep],
        getIssue: async (_owner, _repo, index) => {
          if (index === 180) return cited;
          if (index === 9) return closedCited;
          throw new Error("missing");
        },
      },
      owner: "kirmanak",
      repo: "demo",
      issueNumber: 12,
      botUsername: "jumi",
      body: "Wait for #180. Closed #9 is noise. Invented #404 stays out.",
      pulls: [makePR({ number: 225, title: "Fix sibling", body: "Fixes #196", user: makeUser({ login: "jumi" }) })],
    });
    expect(queue.map((row) => ({ number: row.number, kind: row.kind }))).toEqual([
      { number: 196, kind: "issue" },
      { number: 225, kind: "closer" },
      { number: 180, kind: "cited" },
      { number: 170, kind: "dependency" },
    ]);
    expect(formatQueueMarkdown(queue, "kirmanak", "demo")).toContain("#196 Sibling");
    expect(formatQueueMarkdown(queue, "kirmanak", "demo")).toContain("#225 open closer of #196");
  });
});
