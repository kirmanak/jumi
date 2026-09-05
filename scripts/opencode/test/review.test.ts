import { describe, expect, test } from "bun:test";
import type { ReviewApi } from "../src/review.ts";
import { reviewPullRequest } from "../src/review.ts";
import { makeBranch, makeComment, makeFile, makeIssue, makePR, makeRepo, makeUser } from "./fixtures.ts";

function makeApi(overrides: Partial<ReviewApi> = {}): ReviewApi {
  const defaults: ReviewApi = {
    getRepo: async () => makeRepo(),
    getPR: async () => makePR(),
    getPRFiles: async () => [makeFile()],
    getIssue: async () => makeIssue(),
    listIssueComments: async () => [],
    findStickyIssueComment: async () => undefined,
    createIssueComment: async (_owner, _repo, _index, body) => makeComment({ id: 1, body }),
    updateIssueComment: async (_owner, _repo, commentId, body) => makeComment({ id: commentId, body }),
    createCommitStatus: async (_owner, _repo, _sha, status) => status,
  };
  return { ...defaults, ...overrides };
}

const baseOptions = {
  owner: "kirmanak",
  repo: "demo",
  prNumber: 7,
  model: "openai/gpt-5.5",
  workspace: "/work",
  giteaUrl: "https://gitea.kirmanak.stream",
  giteaToken: "bot-token",
  botUsername: "jumi",
  workspacePreparer: async () => undefined,
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

  test("creates a sticky review comment and updates commit status", async () => {
    let createdBody = "";
    const statuses: Array<{ sha: string; state: string; context?: string; description?: string; target_url?: string }> =
      [];
    const result = await reviewPullRequest({
      ...baseOptions,
      api: makeApi({
        createIssueComment: async (_owner, _repo, _index, body) => {
          createdBody = body;
          return makeComment({ id: 123, body });
        },
        createCommitStatus: async (_owner, _repo, sha, status) => {
          statuses.push({ sha, ...status });
          return status;
        },
      }),
      openCodeRunner: async () => "Looks good\n<!-- jumi-check: success -->",
    });

    expect(result).toEqual({ status: "posted", commentId: 123 });
    expect(createdBody).toContain("<!-- jumi-review:kirmanak/demo#7 -->");
    expect(createdBody).toContain("Reviewed commit: `headsha`");
    expect(createdBody).toContain("Looks good");
    expect(createdBody).not.toContain("jumi-check");
    expect(statuses).toEqual([
      {
        sha: "headsha",
        state: "pending",
        context: "jumi/opencode-review",
        description: "Jumi review is running",
        target_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/7",
      },
      {
        sha: "headsha",
        state: "success",
        context: "jumi/opencode-review",
        description: "No blocking issues",
        target_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/7",
      },
    ]);
  });

  test("updates an existing sticky review comment", async () => {
    let updatedBody = "";
    const result = await reviewPullRequest({
      ...baseOptions,
      api: makeApi({
        findStickyIssueComment: async () => ({ id: 99 }),
        updateIssueComment: async (_owner, _repo, commentId, body) => {
          updatedBody = body;
          return makeComment({ id: commentId, body });
        },
      }),
      openCodeRunner: async () => "Updated review\n<!-- jumi-check: success -->",
    });

    expect(result).toEqual({ status: "updated", commentId: 99 });
    expect(updatedBody).toContain("Updated review");
  });

  test("skips empty OpenCode output and fails the commit status", async () => {
    const statuses: Array<{ state: string; description?: string }> = [];
    await expect(
      reviewPullRequest({
        ...baseOptions,
        api: makeApi({
          createCommitStatus: async (_owner, _repo, _sha, status) => {
            statuses.push(status);
            return status;
          },
        }),
        openCodeRunner: async () => "   ",
      })
    ).resolves.toEqual({ status: "skipped", reason: "OpenCode produced no output" });
    expect(statuses.map((status) => status.state)).toEqual(["pending", "failure"]);
    expect(statuses[1].description).toBe("Incomplete review: no output");
  });

  test("fails the commit status when OpenCode reports failure", async () => {
    const statuses: Array<{ state: string; description?: string }> = [];
    const result = await reviewPullRequest({
      ...baseOptions,
      api: makeApi({
        createCommitStatus: async (_owner, _repo, _sha, status) => {
          statuses.push(status);
          return status;
        },
      }),
      openCodeRunner: async () =>
        "L12: 🔴 bug: null deref. Guard it.\nL40: 🟡 risk: swallowed error. Fail closed.\n<!-- jumi-check: failure; 1 blocking, 1 risk -->",
    });

    expect(result.status).toBe("posted");
    expect(statuses.map((status) => status.state)).toEqual(["pending", "failure"]);
    expect(statuses[1].description).toBe("1 blocking, 1 risk");
  });

  test("fails closed when the review omits the check trailer", async () => {
    let createdBody = "";
    const statuses: Array<{ state: string; description?: string }> = [];
    const result = await reviewPullRequest({
      ...baseOptions,
      api: makeApi({
        createIssueComment: async (_owner, _repo, _index, body) => {
          createdBody = body;
          return makeComment({ id: 44, body });
        },
        createCommitStatus: async (_owner, _repo, _sha, status) => {
          statuses.push(status);
          return status;
        },
      }),
      openCodeRunner: async () => "I'll inspect the PR and check for correctness issues.",
    });

    expect(result).toEqual({ status: "posted", commentId: 44 });
    expect(createdBody).toContain("I'll inspect the PR");
    expect(statuses.map((status) => status.state)).toEqual(["pending", "failure"]);
    expect(statuses[1].description).toBe("Incomplete review: no check verdict");
  });

  test("keeps a questions-only review green when OpenCode reports success", async () => {
    const statuses: Array<{ state: string; description?: string }> = [];
    await reviewPullRequest({
      ...baseOptions,
      api: makeApi({
        createCommitStatus: async (_owner, _repo, _sha, status) => {
          statuses.push(status);
          return status;
        },
      }),
      openCodeRunner: async () =>
        "No correctness bugs.\n❓ q: is the timeout intentional?\n<!-- jumi-check: success -->",
    });
    expect(statuses.at(-1)).toMatchObject({ state: "success", description: "No blocking issues" });
  });

  test("marks the commit status failed when the review crashes", async () => {
    const statuses: Array<{ state: string; description?: string }> = [];
    await expect(
      reviewPullRequest({
        ...baseOptions,
        api: makeApi({
          createCommitStatus: async (_owner, _repo, _sha, status) => {
            statuses.push(status);
            return status;
          },
        }),
        openCodeRunner: async () => {
          throw new Error("model unavailable");
        },
      })
    ).rejects.toThrow("model unavailable");

    expect(statuses.map((status) => status.state)).toEqual(["pending", "failure"]);
    expect(statuses[1].description).toBe("Jumi review failed: model unavailable");
  });

  test("truncates long status descriptions without splitting UTF-8 characters", async () => {
    const statuses: Array<{ state: string; description?: string }> = [];
    const message = "€".repeat(200);
    await expect(
      reviewPullRequest({
        ...baseOptions,
        api: makeApi({
          createCommitStatus: async (_owner, _repo, _sha, status) => {
            statuses.push(status);
            return status;
          },
        }),
        openCodeRunner: async () => {
          throw new Error(message);
        },
      })
    ).rejects.toThrow(message);

    expect(statuses.map((status) => status.state)).toEqual(["pending", "failure"]);
    expect(statuses[1].description?.endsWith("…")).toBe(true);
    expect(new TextEncoder().encode(statuses[1].description ?? "").byteLength).toBeLessThanOrEqual(255);
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
    let stickyLookup = false;
    let created = false;
    const result = await reviewPullRequest({
      ...baseOptions,
      api: makeApi({
        getPR: async () => {
          getPRCalls++;
          return makePR({ head: makeBranch({ sha: getPRCalls === 1 ? "oldsha" : "newsha" }) });
        },
        findStickyIssueComment: async () => {
          stickyLookup = true;
          return undefined;
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
    expect(stickyLookup).toBe(false);
    expect(created).toBe(false);
  });

  test("checks out the repository before running OpenCode and tells it the target branch", async () => {
    let checkout: unknown;
    let prompt = "";
    let runnerWorkdir = "";

    await reviewPullRequest({
      ...baseOptions,
      api: makeApi({ getPR: async () => makePR({ base: makeBranch({ ref: "main", sha: "basesha" }) }) }),
      workspacePreparer: async (opts) => {
        checkout = {
          workdir: opts.workdir,
          repo: opts.repo.full_name,
          pr: opts.pr.number,
          targetBranch: opts.pr.base.ref,
          headSha: opts.pr.head.sha,
          giteaUrl: opts.giteaUrl,
          username: opts.username,
          token: opts.token,
        };
      },
      openCodeRunner: async (value, opts) => {
        prompt = value;
        runnerWorkdir = opts.workdir;
        return "Review";
      },
    });

    expect(checkout).toEqual({
      workdir: "/work",
      repo: "kirmanak/demo",
      pr: 7,
      targetBranch: "main",
      headSha: "headsha",
      giteaUrl: "https://gitea.kirmanak.stream",
      username: "jumi",
      token: "bot-token",
    });
    expect(runnerWorkdir).toBe("/work");
    expect(prompt).toContain('target_branch="main"');
    expect(prompt).toContain('target_ref="jumi/target"');
    expect(prompt).toContain('target_remote_ref="origin/main"');
    expect(prompt).toContain("stable refs like jumi/target and HEAD");
    expect(prompt).toContain("git log --oneline jumi/target..HEAD");
    expect(prompt).toContain("web search/fetch");
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

  test("loads linked issue 12 and PR comments for Fixes #12", async () => {
    const calls: Array<{ method: string; index: number }> = [];
    await reviewPullRequest({
      ...baseOptions,
      api: makeApi({
        getPR: async () => makePR({ body: "Fixes #12" }),
        getIssue: async (_owner, _repo, index) => {
          calls.push({ method: "getIssue", index });
          return makeIssue({ number: index });
        },
        listIssueComments: async (_owner, _repo, index) => {
          calls.push({ method: "listIssueComments", index });
          return [];
        },
      }),
      openCodeRunner: async () => "Review",
    });

    expect(calls).toContainEqual({ method: "getIssue", index: 12 });
    expect(calls).toContainEqual({ method: "listIssueComments", index: 7 });
    expect(calls).toContainEqual({ method: "listIssueComments", index: 12 });
  });

  test("still posts a review when a linked issue 404s", async () => {
    let prompt = "";
    const result = await reviewPullRequest({
      ...baseOptions,
      api: makeApi({
        getPR: async () => makePR({ body: "Fixes #12" }),
        getIssue: async () => {
          throw new Error("Gitea API GET https://gitea.example/issues/12 → 404: not found");
        },
      }),
      openCodeRunner: async (value) => {
        prompt = value;
        return "Review\n<!-- jumi-check: success -->";
      },
    });

    expect(result.status).toBe("posted");
    expect(prompt).toContain("Failed to load linked issue #12");
    expect(prompt).toContain("404");
  });

  test("injects Jumi sticky and human comments into the OpenCode prompt", async () => {
    let prompt = "";
    await reviewPullRequest({
      ...baseOptions,
      api: makeApi({
        listIssueComments: async () => [
          makeComment({
            id: 10,
            body: "<!-- jumi-review:kirmanak/demo#7 -->\nPrevious findings",
            user: makeUser({ login: "jumi" }),
          }),
          makeComment({
            id: 11,
            body: "please also handle timeouts",
            user: makeUser({ login: "alice" }),
          }),
        ],
      }),
      openCodeRunner: async (value) => {
        prompt = value;
        return "Review";
      },
    });

    expect(prompt).toContain("Previous findings");
    expect(prompt).toContain("please also handle timeouts");
    expect(prompt).toContain('author="jumi"');
    expect(prompt).toContain('author="alice"');
  });
});
