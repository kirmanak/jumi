import { describe, expect, test } from "bun:test";
import type { ReviewApi } from "../src/review.ts";
import { reviewPullRequest } from "../src/review.ts";
import { makeBranch, makeComment, makeFile, makePR, makeRepo } from "./fixtures.ts";

function makeApi(overrides: Partial<ReviewApi> = {}): ReviewApi {
  return {
    getRepo: async () => makeRepo(),
    getPR: async () => makePR(),
    getPRFiles: async () => [makeFile()],
    getIssueComments: async () => [],
    createIssueComment: async (_owner, _repo, _index, body) => makeComment({ id: 1, body }),
    updateIssueComment: async (_owner, _repo, commentId, body) => makeComment({ id: commentId, body }),
    ...overrides,
  };
}

const baseOptions = {
  owner: "kirmanak",
  repo: "demo",
  prNumber: 7,
  model: "openai/gpt-5.5",
  workspace: "/work",
  botUsername: "jumi",
  logger: () => undefined,
};

describe("reviewPullRequest", () => {
  test("skips closed, merged, WIP, and skip-review PRs", async () => {
    const runner = async () => {
      throw new Error("runner should not be called");
    };

    await expect(
      reviewPullRequest({
        ...baseOptions,
        api: makeApi({ getPR: async () => makePR({ state: "closed" }) }),
        openCodeRunner: runner,
      })
    ).resolves.toEqual({ status: "skipped", reason: "PR is closed" });
    await expect(
      reviewPullRequest({
        ...baseOptions,
        api: makeApi({ getPR: async () => makePR({ merged: true }) }),
        openCodeRunner: runner,
      })
    ).resolves.toEqual({ status: "skipped", reason: "PR is already merged" });
    await expect(
      reviewPullRequest({
        ...baseOptions,
        api: makeApi({ getPR: async () => makePR({ title: "WIP: no" }) }),
        openCodeRunner: runner,
      })
    ).resolves.toEqual({ status: "skipped", reason: "PR title disables review" });
    await expect(
      reviewPullRequest({
        ...baseOptions,
        api: makeApi({ getPR: async () => makePR({ title: "Add thing [skip review]" }) }),
        openCodeRunner: runner,
      })
    ).resolves.toEqual({ status: "skipped", reason: "PR title disables review" });
  });

  test("creates a sticky review comment", async () => {
    let createdBody = "";
    const result = await reviewPullRequest({
      ...baseOptions,
      api: makeApi({
        createIssueComment: async (_owner, _repo, _index, body) => {
          createdBody = body;
          return makeComment({ id: 123, body });
        },
      }),
      openCodeRunner: async () => "Looks good",
    });

    expect(result).toEqual({ status: "posted", commentId: 123 });
    expect(createdBody).toContain("<!-- jumi-review:kirmanak/demo#7 -->");
    expect(createdBody).toContain("Reviewed commit: `headsha`");
    expect(createdBody).toContain("Looks good");
  });

  test("updates an existing sticky review comment", async () => {
    let updatedBody = "";
    const result = await reviewPullRequest({
      ...baseOptions,
      api: makeApi({
        getIssueComments: async () => [makeComment({ id: 99, body: "<!-- jumi-review:kirmanak/demo#7 -->\nold" })],
        updateIssueComment: async (_owner, _repo, commentId, body) => {
          updatedBody = body;
          return makeComment({ id: commentId, body });
        },
      }),
      openCodeRunner: async () => "Updated review",
    });

    expect(result).toEqual({ status: "updated", commentId: 99 });
    expect(updatedBody).toContain("Updated review");
  });

  test("skips empty OpenCode output", async () => {
    await expect(
      reviewPullRequest({ ...baseOptions, api: makeApi(), openCodeRunner: async () => "   " })
    ).resolves.toEqual({ status: "skipped", reason: "OpenCode produced no output" });
  });

  test("skips stale jobs before OpenCode runs", async () => {
    const runner = async () => {
      throw new Error("runner should not be called");
    };

    await expect(
      reviewPullRequest({
        ...baseOptions,
        api: makeApi({ getPR: async () => makePR({ head: makeBranch({ sha: "newsha" }) }) }),
        expectedHeadSha: "oldsha",
        openCodeRunner: runner,
      })
    ).resolves.toEqual({ status: "skipped", reason: "PR head changed from oldsha to newsha" });
  });

  test("skips posting when the PR head changes during review", async () => {
    let getPRCalls = 0;
    let commentRead = false;
    let created = false;
    const result = await reviewPullRequest({
      ...baseOptions,
      api: makeApi({
        getPR: async () => {
          getPRCalls++;
          return makePR({ head: makeBranch({ sha: getPRCalls === 1 ? "oldsha" : "newsha" }) });
        },
        getIssueComments: async () => {
          commentRead = true;
          return [];
        },
        createIssueComment: async (_owner, _repo, _index, body) => {
          created = true;
          return makeComment({ body });
        },
      }),
      expectedHeadSha: "oldsha",
      openCodeRunner: async () => "stale review",
    });

    expect(result).toEqual({ status: "skipped", reason: "PR head changed from oldsha to newsha" });
    expect(getPRCalls).toBe(2);
    expect(commentRead).toBe(false);
    expect(created).toBe(false);
  });

  test("adds review notes when file and patch limits are hit", async () => {
    let prompt = "";
    await reviewPullRequest({
      ...baseOptions,
      api: makeApi({
        getPRFiles: async () => [
          makeFile({ filename: "first.ts", patch: "abcdef" }),
          makeFile({ filename: "second.ts", patch: "ghijkl" }),
        ],
      }),
      maxFiles: 1,
      maxPatchBytes: 3,
      openCodeRunner: async (value) => {
        prompt = value;
        return "Review";
      },
    });

    expect(prompt).toContain("Only the first 1 of 2 changed files are included.");
    expect(prompt).toContain("Patch for first.ts was truncated to fit the patch budget.");
    expect(prompt).toContain("abc\n[patch truncated]");
  });
});
