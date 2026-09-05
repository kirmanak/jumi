import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimFilePath, followUpStatePath, readClaim } from "../src/claim.ts";
import {
  buildFeedbackMarkdown,
  collectFollowUpItems,
  FEEDBACK_MAX_BYTES,
  FOLLOWUP_PROMPT,
  FOLLOWUP_TIMEOUT_MS,
  implementFollowUp,
  needsFollowUp,
  writeFollowUpState,
} from "../src/followup.ts";
import type { IssueApi } from "../src/gitea_issues.ts";
import type { GiteaPullReview } from "../src/types.ts";
import type { GitRunner } from "../src/workspace.ts";
import { makeComment, makeIssue, makeIssueJob, makePR, makeRepo, makeUser } from "./fixtures.ts";

function stripGitConfigArgs(args: string[]): string[] {
  const result = [...args];
  while (result[0] === "-c") result.splice(0, 2);
  return result;
}

function jumiPr() {
  const repo = makeRepo();
  return makePR({
    number: 127,
    title: "Fix the thing",
    body: "Fixes #12",
    user: makeUser({ login: "jumi" }),
    html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/127",
    head: {
      label: "kirmanak:jumi/issue-12-fix-the-thing",
      ref: "jumi/issue-12-fix-the-thing",
      sha: "headsha",
      repo,
      repo_id: repo.id,
    },
  });
}

function makeApi(
  overrides: Partial<IssueApi> = {}
): IssueApi & { comments: string[]; pulls: unknown[]; commentIndexes: number[] } {
  const comments: string[] = [];
  const pulls: unknown[] = [];
  const commentIndexes: number[] = [];
  const defaults: IssueApi = {
    getRepo: async () => makeRepo(),
    getIssue: async () => makeIssue(),
    listOpenPulls: async () => [jumiPr()],
    createPullRequest: async (_owner, _repo, pull) => {
      pulls.push(pull);
      return makePR({ number: 3, title: pull.title, body: pull.body });
    },
    searchAssignedIssues: async () => [],
    findStickyIssueComment: async () => undefined,
    createIssueComment: async (_owner, _repo, index, body) => {
      commentIndexes.push(index);
      comments.push(body);
      return makeComment({ body });
    },
    updateIssueComment: async (_owner, _repo, _id, body) => {
      comments.push(body);
      return makeComment({ body });
    },
    listIssueComments: async () => [
      makeComment({ id: 55, body: "please fix the tests", user: makeUser({ login: "alice" }) }),
    ],
    listPullReviewComments: async () => [],
    listPullReviews: async () => [],
  };
  return { ...defaults, ...overrides, comments, pulls, commentIndexes };
}

async function withDirs(run: (home: string, workdir: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "jumi-fu-home-"));
  const workdir = await mkdtemp(join(tmpdir(), "jumi-fu-work-"));
  try {
    await run(home, workdir);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
  }
}

function followUpJob(overrides: Parameters<typeof makeIssueJob>[0] = {}) {
  return makeIssueJob({
    mode: "follow-up",
    prNumber: 127,
    trigger: { event: "issue_comment", commentId: 55, sender: "alice" },
    ...overrides,
  });
}

function makeReview(overrides: Partial<GiteaPullReview> = {}): GiteaPullReview {
  return {
    id: 9,
    body: "please change this",
    user: makeUser({ login: "alice" }),
    state: "REQUEST_CHANGES",
    ...overrides,
  };
}

describe("implementFollowUp", () => {
  test("skips when no open jumi closing PR", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi({
        listOpenPulls: async () => [makePR({ title: "Fix", body: "Fixes #12", user: makeUser({ login: "alice" }) })],
      });
      const result = await implementFollowUp({
        api,
        job: followUpJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: async () => {
          throw new Error("git should not run");
        },
        openCodeRunner: async () => {
          throw new Error("opencode should not run");
        },
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "skipped", reason: "no open jumi closing PR" });
      expect(api.pulls).toHaveLength(0);
    });
  });

  test("checks out pr.head.ref, not a freshly slugged branch from a retitled issue", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const gitCalls: string[][] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        return "";
      };
      await implementFollowUp({
        api,
        job: followUpJob({ title: "Completely Retitled Issue" }),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => "done",
        logger: () => undefined,
      });
      const slugged = "jumi/issue-12-completely-retitled-issue";
      expect(gitCalls.some((args) => args.includes(slugged))).toBe(false);
      expect(gitCalls.some((args) => args.includes("jumi/issue-12-fix-the-thing"))).toBe(true);
      expect(gitCalls.some((args) => args[0] === "worktree" && args[1] === "add" && args.includes("origin/main"))).toBe(
        false
      );
      expect(
        gitCalls.some(
          (args) =>
            args[0] === "worktree" &&
            args[1] === "add" &&
            args.includes("-B") &&
            args.includes("jumi/issue-12-fix-the-thing") &&
            args.includes("origin/jumi/issue-12-fix-the-thing")
        )
      ).toBe(true);
      expect(
        gitCalls.some(
          (args) =>
            args[0] === "worktree" &&
            args[1] === "add" &&
            !args.includes("-B") &&
            args.includes("jumi/issue-12-fix-the-thing")
        )
      ).toBe(false);
    });
  });

  test("checks out origin PR branch even when a stale local ref exists", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const gitCalls: string[][] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "show-ref") return "";
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        return "";
      };
      await implementFollowUp({
        api,
        job: followUpJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => "done",
        logger: () => undefined,
      });
      expect(
        gitCalls.some(
          (args) =>
            args[0] === "worktree" &&
            args[1] === "add" &&
            args.includes("-B") &&
            args.includes("jumi/issue-12-fix-the-thing") &&
            args.includes("origin/jumi/issue-12-fix-the-thing")
        )
      ).toBe(true);
      expect(
        gitCalls.some(
          (args) =>
            args[0] === "worktree" &&
            args[1] === "add" &&
            !args.includes("-B") &&
            args.includes("jumi/issue-12-fix-the-thing")
        )
      ).toBe(false);
    });
  });

  test("existing worktree resets hard to origin PR branch", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      await mkdir(join(workdir, "kirmanak", "demo", "12", ".git"), { recursive: true });
      const gitCalls: string[][] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "show-ref") return "";
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        return "";
      };
      await implementFollowUp({
        api,
        job: followUpJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => "done",
        logger: () => undefined,
      });
      expect(gitCalls.some((args) => args[0] === "worktree" && args[1] === "add")).toBe(false);
      expect(gitCalls.some((args) => args[0] === "checkout" && args.includes("jumi/issue-12-fix-the-thing"))).toBe(
        true
      );
      expect(
        gitCalls.some(
          (args) =>
            args[0] === "reset" && args.includes("--hard") && args.includes("origin/jumi/issue-12-fix-the-thing")
        )
      ).toBe(true);
    });
  });

  test("writes JUMI_FEEDBACK.md and uses FOLLOWUP_PROMPT", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      let prompt = "";
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "";
        if (gitArgs[0] === "rev-list") return "0";
        return "";
      };
      await implementFollowUp({
        api,
        job: followUpJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async (usedPrompt) => {
          prompt = usedPrompt;
          const feedback = await readFile(join(workdir, "kirmanak/demo/12/JUMI_FEEDBACK.md"), "utf8");
          expect(feedback).toContain("please fix the tests");
          expect(feedback).toContain("pulls/127");
          expect(feedback).toContain("jumi/issue-12-fix-the-thing");
          return "done";
        },
        logger: () => undefined,
      });
      expect(prompt).toBe(FOLLOWUP_PROMPT);
    });
  });

  test("writes webhook review content into JUMI_FEEDBACK.md without a review id", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi({
        listIssueComments: async () => [],
        listPullReviews: async () => [],
      });
      await implementFollowUp({
        api,
        job: followUpJob({
          trigger: {
            event: "pull_request_comment",
            sender: "alice",
            body: "please rename",
          },
        }),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: async (args) => {
          const gitArgs = stripGitConfigArgs(args);
          if (gitArgs[0] === "rev-parse") return "abc123";
          if (gitArgs[0] === "status") return "";
          if (gitArgs[0] === "rev-list") return "0";
          return "";
        },
        openCodeRunner: async () => {
          const feedback = await readFile(join(workdir, "kirmanak/demo/12/JUMI_FEEDBACK.md"), "utf8");
          expect(feedback).toContain("please rename");
          return "done";
        },
        logger: () => undefined,
      });
    });
  });

  test("pushes to existing branch and does not call createPullRequest", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const gitCalls: string[][] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        return "";
      };
      const result = await implementFollowUp({
        api,
        job: followUpJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => "done",
        logger: () => undefined,
      });
      expect(result).toEqual({
        status: "pushed",
        prNumber: 127,
        htmlUrl: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/127",
      });
      expect(api.pulls).toHaveLength(0);
      expect(gitCalls.find((args) => args[0] === "push")).toEqual([
        "push",
        "-u",
        "origin",
        "jumi/issue-12-fix-the-thing",
      ]);
      expect(gitCalls.some((args) => args[0] === "push" && args.includes("--force"))).toBe(false);
      expect(api.comments.at(-1)).toContain("Pushed follow-up to");
      expect(api.commentIndexes.at(-1)).toBe(127);
    });
  });

  test("clean tree → no-changes, no PR", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const gitCalls: string[][] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "";
        if (gitArgs[0] === "rev-list") return "0";
        return "";
      };
      const result = await implementFollowUp({
        api,
        job: followUpJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => "done",
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "no-changes" });
      expect(api.pulls).toHaveLength(0);
      expect(api.comments.at(-1)).toContain("no follow-up changes");
      expect(gitCalls.some((args) => args[0] === "push")).toBe(false);
      expect(
        gitCalls.some((args) => args[0] === "rev-list" && args.includes("origin/jumi/issue-12-fix-the-thing..HEAD"))
      ).toBe(true);
    });
  });

  test("child extraEnv has GIT_AUTH_TOKEN and not GITEA_BOT_TOKEN", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "";
        if (gitArgs[0] === "rev-list") return "0";
        return "";
      };
      let extraEnv: Record<string, string> | undefined;
      await implementFollowUp({
        api,
        job: followUpJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async (_prompt, opts) => {
          extraEnv = opts.extraEnv;
          return "done";
        },
        logger: () => undefined,
      });
      expect(extraEnv?.GIT_AUTH_TOKEN).toBe("bot-token");
      expect(extraEnv?.GITEA_BOT_TOKEN).toBeUndefined();
    });
  });

  test("abort after push does not open a PR", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const abort = new AbortController();
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        if (gitArgs[0] === "push") abort.abort();
        return "";
      };
      const result = await implementFollowUp({
        api,
        job: followUpJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        abortSignal: abort.signal,
        gitRunner,
        openCodeRunner: async () => "done",
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "cancelled" });
      expect(api.pulls).toHaveLength(0);
    });
  });

  test("max 3 rounds → stuck, no OpenCode", async () => {
    await withDirs(async (home, workdir) => {
      await writeFollowUpState(followUpStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 127,
        round: 3,
        lastHeadSha: "abc",
        handledCommentIds: [],
        handledReviewIds: [],
        updatedAt: "2026-05-23T00:00:00Z",
      });
      const api = makeApi();
      let openCode = 0;
      const result = await implementFollowUp({
        api,
        job: followUpJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: async () => {
          throw new Error("git should not run");
        },
        openCodeRunner: async () => {
          openCode++;
          return "done";
        },
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "skipped", reason: "stuck: too many follow-up rounds" });
      expect(openCode).toBe(0);
      expect(api.comments.at(-1)).toContain("stuck: too many follow-up rounds");
    });
  });

  test("already-handled comment id → skip OpenCode", async () => {
    await withDirs(async (home, workdir) => {
      await writeFollowUpState(followUpStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 127,
        round: 1,
        lastHeadSha: "abc",
        handledCommentIds: [55],
        handledReviewIds: [],
        updatedAt: "2026-05-23T00:00:00Z",
      });
      let openCode = 0;
      const result = await implementFollowUp({
        api: makeApi(),
        job: followUpJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner: async () => {
          throw new Error("git should not run");
        },
        openCodeRunner: async () => {
          openCode++;
          return "done";
        },
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "skipped", reason: "comment already handled" });
      expect(openCode).toBe(0);
    });
  });

  test("review webhook without id skips OpenCode after no-changes", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "";
        if (gitArgs[0] === "rev-list") return "0";
        return "";
      };
      const shared = {
        api,
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        logger: () => undefined,
      };
      expect(
        await implementFollowUp({
          ...shared,
          job: followUpJob(),
          gitRunner,
          openCodeRunner: async () => "done",
        })
      ).toEqual({ status: "no-changes" });

      let openCode = 0;
      const result = await implementFollowUp({
        ...shared,
        job: followUpJob({
          trigger: { event: "pull_request_comment", sender: "alice", body: "please change this" },
        }),
        gitRunner: async () => {
          throw new Error("git should not run");
        },
        openCodeRunner: async () => {
          openCode++;
          return "done";
        },
      });
      expect(result).toEqual({ status: "skipped", reason: "no unhandled feedback" });
      expect(openCode).toBe(0);
    });
  });

  test("first-time review webhook with unhandled COMMENT review runs OpenCode", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi({
        listIssueComments: async () => [],
        listPullReviews: async () => [
          makeReview({
            id: 42,
            body: "please rename",
            state: "COMMENT",
            type: "pull_request_review_comment",
          }),
        ],
      });
      let openCode = 0;
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "";
        if (gitArgs[0] === "rev-list") return "0";
        return "";
      };
      const result = await implementFollowUp({
        api,
        job: followUpJob({
          trigger: { event: "pull_request_comment", sender: "alice", body: "please rename" },
        }),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => {
          openCode++;
          return "done";
        },
        logger: () => undefined,
      });
      expect(openCode).toBe(1);
      expect(result.status).not.toBe("skipped");
    });
  });

  test("timeout passed to OpenCode is 3600000", async () => {
    await withDirs(async (home, workdir) => {
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "";
        if (gitArgs[0] === "rev-list") return "0";
        return "";
      };
      let timeoutMs: number | undefined;
      await implementFollowUp({
        api: makeApi(),
        job: followUpJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        timeoutMs: 14_400_000,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async (_prompt, opts) => {
          timeoutMs = opts.timeoutMs;
          return "done";
        },
        logger: () => undefined,
      });
      expect(timeoutMs).toBe(FOLLOWUP_TIMEOUT_MS);
      expect(timeoutMs).toBe(3_600_000);
    });
  });

  test("does not persist a terminal claim after OpenCode failure", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        return "";
      };
      await expect(
        implementFollowUp({
          api,
          job: followUpJob(),
          giteaUrl: "https://gitea.kirmanak.stream",
          giteaToken: "bot-token",
          botUsername: "jumi",
          model: "openai/gpt-5.5",
          home,
          workdir,
          heartbeatIntervalMs: 0,
          gitRunner,
          openCodeRunner: async () => {
            throw new Error("opencode exploded");
          },
          logger: () => undefined,
        })
      ).rejects.toThrow("opencode exploded");
      expect(await readClaim(claimFilePath(home, "kirmanak", "demo", 12))).toBeUndefined();
      expect(api.comments.at(-1)).toContain("Jumi failed");
      const state = JSON.parse(await readFile(followUpStatePath(home, "kirmanak", "demo", 12), "utf8"));
      expect(state.round).toBe(1);
      expect(state.handledCommentIds).not.toContain(55);
    });
  });

  test("retries the same commentId after OpenCode failure", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "";
        if (gitArgs[0] === "rev-list") return "0";
        return "";
      };
      const shared = {
        api,
        job: followUpJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        logger: () => undefined,
      };
      await expect(
        implementFollowUp({
          ...shared,
          openCodeRunner: async () => {
            throw new Error("opencode exploded");
          },
        })
      ).rejects.toThrow("opencode exploded");
      let openCode = 0;
      const result = await implementFollowUp({
        ...shared,
        openCodeRunner: async () => {
          openCode++;
          return "done";
        },
      });
      expect(result.status).not.toBe("skipped");
      expect(openCode).toBe(1);
    });
  });
});

describe("buildFeedbackMarkdown", () => {
  test("omits trimmed extra comment ids that are not in markdown", () => {
    const huge = "x".repeat(FEEDBACK_MAX_BYTES);
    const result = buildFeedbackMarkdown({
      pr: jumiPr(),
      trigger: { event: "issue_comment", commentId: 55, sender: "alice" },
      triggerBody: "please fix the tests",
      comments: [
        makeComment({
          id: 1,
          body: huge,
          created_at: "2026-01-01T00:00:00Z",
          user: makeUser({ login: "bob" }),
        }),
        makeComment({
          id: 55,
          body: "please fix the tests",
          created_at: "2026-01-02T00:00:00Z",
          user: makeUser({ login: "alice" }),
        }),
      ],
      inlines: [],
      reviews: [],
    });
    expect(result.markdown).not.toContain("### Comment 1");
    expect(result.markdown).toContain("Comment id: 55");
    expect(result.commentIds).toContain(55);
    expect(result.commentIds).not.toContain(1);
  });
});

describe("collectFollowUpItems", () => {
  test("includes request-changes and human COMMENT reviews with a body", async () => {
    const api = makeApi({
      listIssueComments: async () => [],
      listPullReviews: async () => [
        makeReview({ id: 1, body: "please change this", state: "REQUEST_CHANGES" }),
        makeReview({
          id: 2,
          body: "please rename",
          state: "COMMENT",
          type: "pull_request_review_comment",
        }),
      ],
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi");
    expect(items.reviews.map((review) => review.id)).toEqual([1, 2]);
  });

  test("skips empty, approve-without-body, approve-with-body, and bot reviews", async () => {
    const api = makeApi({
      listIssueComments: async () => [],
      listPullReviews: async () => [
        makeReview({ id: 1, body: "", state: "COMMENT", type: "pull_request_review_comment" }),
        makeReview({ id: 2, body: "", state: "APPROVED" }),
        makeReview({ id: 3, body: "looks good", state: "APPROVED" }),
        makeReview({
          id: 4,
          body: "please rename",
          state: "COMMENT",
          type: "pull_request_review_comment",
          user: makeUser({ login: "jumi" }),
        }),
      ],
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi");
    expect(items.reviews).toEqual([]);
  });
});

describe("needsFollowUp", () => {
  test("returns true for a human COMMENT review with a summary body", async () => {
    await withDirs(async (home) => {
      const api = makeApi({
        listIssueComments: async () => [],
        listPullReviews: async () => [
          makeReview({
            id: 42,
            body: "please rename",
            state: "COMMENT",
            type: "pull_request_review_comment",
          }),
        ],
      });
      expect(
        await needsFollowUp({
          api,
          owner: "kirmanak",
          repo: "demo",
          pr: jumiPr(),
          issueNumber: 12,
          botUsername: "jumi",
          home,
        })
      ).toBe(true);
    });
  });

  test("returns false for empty, approve, and bot reviews", async () => {
    await withDirs(async (home) => {
      const api = makeApi({
        listIssueComments: async () => [],
        listPullReviews: async () => [
          makeReview({ id: 1, body: "", state: "APPROVED" }),
          makeReview({ id: 2, body: "looks good", state: "APPROVED" }),
          makeReview({
            id: 3,
            body: "please rename",
            state: "COMMENT",
            user: makeUser({ login: "jumi" }),
          }),
        ],
      });
      expect(
        await needsFollowUp({
          api,
          owner: "kirmanak",
          repo: "demo",
          pr: jumiPr(),
          issueNumber: 12,
          botUsername: "jumi",
          home,
        })
      ).toBe(false);
    });
  });
});
