import { describe, expect, test } from "bun:test";
import {
  gateShipAfterOpenCode,
  ISSUE_CHANGED_AGAIN_COMMENT,
  ISSUE_CLOSED_CLOSER_COMMENT,
  ISSUE_CLOSED_NO_PR_COMMENT,
  issueTextChanged,
  type RecheckApi,
  skipRecheckComment,
  snapshotFromIssue,
  snapshotFromJob,
} from "../src/issue_recheck.ts";
import { makeComment, makeIssue, makeIssueJob, makePR } from "./fixtures.ts";

function makeRecheckApi(overrides: Partial<RecheckApi> = {}): RecheckApi & { comments: string[]; closed: number[] } {
  const comments: string[] = [];
  const closed: number[] = [];
  const defaults: RecheckApi = {
    getIssue: async () => makeIssue(),
    closePullRequest: async (_owner, _repo, index) => {
      closed.push(index);
      return makePR({ number: index, state: "closed" });
    },
    findStickyIssueComment: async () => undefined,
    createIssueComment: async (_owner, _repo, _index, body) => {
      comments.push(body);
      return makeComment({ body });
    },
    updateIssueComment: async (_owner, _repo, _id, body) => {
      comments.push(body);
      return makeComment({ body });
    },
  };
  return { ...defaults, ...overrides, comments, closed };
}

describe("issueTextChanged", () => {
  test("ignores updated_at and compares title and body only", () => {
    const snapshot = snapshotFromIssue(makeIssue());
    expect(issueTextChanged(snapshot, makeIssue({ updated_at: "2026-06-01T00:00:00Z" }))).toBe(false);
    expect(issueTextChanged(snapshot, makeIssue({ title: "Other" }))).toBe(true);
    expect(issueTextChanged(snapshot, makeIssue({ body: "Other body" }))).toBe(true);
    expect(issueTextChanged(snapshot, makeIssue({ body: null }))).toBe(true);
  });

  test("treats null live body as empty", () => {
    expect(issueTextChanged({ title: "Fix the thing", body: "" }, makeIssue({ body: null }))).toBe(false);
  });
});

describe("gateShipAfterOpenCode", () => {
  test("ships when title and body match even if updated_at churned", async () => {
    const api = makeRecheckApi({
      getIssue: async () => makeIssue({ updated_at: "2026-06-01T00:00:00Z" }),
    });
    let continued = 0;
    const result = await gateShipAfterOpenCode({
      api,
      owner: "kirmanak",
      repo: "demo",
      issueNumber: 12,
      botUsername: "jumi",
      snapshot: snapshotFromJob(makeIssueJob()),
      continueOpenCode: async () => {
        continued++;
      },
    });
    expect(result).toMatchObject({ action: "ship", continued: false });
    expect(continued).toBe(0);
    expect(api.closed).toEqual([]);
  });

  test("re-GETs the closing issue, not the PR-as-issue", async () => {
    const indexes: number[] = [];
    const api = makeRecheckApi({
      getIssue: async (_owner, _repo, index) => {
        indexes.push(index);
        return makeIssue();
      },
    });
    await gateShipAfterOpenCode({
      api,
      owner: "kirmanak",
      repo: "demo",
      issueNumber: 12,
      botUsername: "jumi",
      snapshot: snapshotFromJob(makeIssueJob()),
      closerPrNumber: 127,
      continueOpenCode: async () => {
        throw new Error("should not continue");
      },
    });
    expect(indexes).toEqual([12]);
  });

  test("closed with no PR comments on the issue and keeps local work", async () => {
    const api = makeRecheckApi({
      getIssue: async () => makeIssue({ state: "closed" }),
    });
    const result = await gateShipAfterOpenCode({
      api,
      owner: "kirmanak",
      repo: "demo",
      issueNumber: 12,
      botUsername: "jumi",
      snapshot: snapshotFromJob(makeIssueJob()),
      continueOpenCode: async () => {
        throw new Error("should not continue");
      },
    });
    expect(result).toEqual({ action: "skip", reason: "issue is closed", keepLocalWork: true });
    expect(api.closed).toEqual([]);
    expect(api.comments.at(-1)).toContain(ISSUE_CLOSED_NO_PR_COMMENT);
  });

  test("closed with a closer closes that PR, comments why, and does not keep local work", async () => {
    const api = makeRecheckApi({
      getIssue: async () => makeIssue({ state: "closed" }),
    });
    const result = await gateShipAfterOpenCode({
      api,
      owner: "kirmanak",
      repo: "demo",
      issueNumber: 12,
      botUsername: "jumi",
      snapshot: snapshotFromJob(makeIssueJob()),
      closerPrNumber: 127,
      continueOpenCode: async () => {
        throw new Error("should not continue");
      },
    });
    expect(result).toEqual({ action: "skip", reason: "issue is closed", keepLocalWork: false });
    expect(api.closed).toEqual([127]);
    expect(api.comments.at(-1)).toContain(ISSUE_CLOSED_CLOSER_COMMENT);
  });

  test("GET failure skips shipping and does not continue", async () => {
    const api = makeRecheckApi({
      getIssue: async () => {
        throw new Error("gitea 502");
      },
    });
    let continued = 0;
    const result = await gateShipAfterOpenCode({
      api,
      owner: "kirmanak",
      repo: "demo",
      issueNumber: 12,
      botUsername: "jumi",
      snapshot: snapshotFromJob(makeIssueJob()),
      continueOpenCode: async () => {
        continued++;
      },
    });
    expect(result).toEqual({
      action: "skip",
      reason: "failed to re-check issue: gitea 502",
      keepLocalWork: true,
    });
    expect(continued).toBe(0);
    expect(api.comments.at(-1)).toContain(skipRecheckComment("gitea 502"));
  });

  test("title or body change continues once on the live issue then ships", async () => {
    let gets = 0;
    const api = makeRecheckApi({
      getIssue: async () => {
        gets++;
        return makeIssue({ title: "Rewritten", body: "Do this instead." });
      },
    });
    const seen: string[] = [];
    const result = await gateShipAfterOpenCode({
      api,
      owner: "kirmanak",
      repo: "demo",
      issueNumber: 12,
      botUsername: "jumi",
      snapshot: snapshotFromJob(makeIssueJob()),
      continueOpenCode: async (issue) => {
        seen.push(`${issue.title}\n${issue.body ?? ""}`);
      },
    });
    expect(result.action).toBe("ship");
    if (result.action === "ship") {
      expect(result.continued).toBe(true);
      expect(result.snapshot).toEqual({ title: "Rewritten", body: "Do this instead." });
    }
    expect(seen).toEqual(["Rewritten\nDo this instead."]);
    expect(gets).toBe(2);
  });

  test("caps at one continue and skips if the issue changes again", async () => {
    let gets = 0;
    const api = makeRecheckApi({
      getIssue: async () => {
        gets++;
        return makeIssue({ title: `Edit ${gets}` });
      },
    });
    let continued = 0;
    const result = await gateShipAfterOpenCode({
      api,
      owner: "kirmanak",
      repo: "demo",
      issueNumber: 12,
      botUsername: "jumi",
      snapshot: snapshotFromJob(makeIssueJob()),
      continueOpenCode: async () => {
        continued++;
      },
    });
    expect(result).toEqual({
      action: "skip",
      reason: "issue title or body changed again after a continue round",
      keepLocalWork: true,
    });
    expect(continued).toBe(1);
    expect(gets).toBe(2);
    expect(api.comments.at(-1)).toContain(ISSUE_CHANGED_AGAIN_COMMENT);
  });

  test("continue OpenCode failure propagates and does not ship", async () => {
    const api = makeRecheckApi({
      getIssue: async () => makeIssue({ title: "Rewritten" }),
    });
    await expect(
      gateShipAfterOpenCode({
        api,
        owner: "kirmanak",
        repo: "demo",
        issueNumber: 12,
        botUsername: "jumi",
        snapshot: snapshotFromJob(makeIssueJob()),
        continueOpenCode: async () => {
          throw new Error("opencode exploded");
        },
      })
    ).rejects.toThrow("opencode exploded");
    expect(api.closed).toEqual([]);
  });
});
