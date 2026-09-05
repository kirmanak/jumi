import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimFilePath, conflictStatePath, followUpStatePath, readClaim } from "../src/claim.ts";
import { CONFLICT_PROMPT, readConflictState, writeConflictState } from "../src/conflict.ts";
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
        handledReviewFindings: [],
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
        handledReviewFindings: [],
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

  test("calls merge-default before feedback OpenCode", async () => {
    await withDirs(async (home, workdir) => {
      const events: string[] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "merge-base") events.push("merge-base");
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "";
        if (gitArgs[0] === "rev-list") return "0";
        return "";
      };
      await implementFollowUp({
        api: makeApi(),
        job: followUpJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async (prompt) => {
          events.push(prompt === FOLLOWUP_PROMPT ? "feedback" : "other");
          return "done";
        },
        logger: () => undefined,
      });
      expect(events.indexOf("merge-base")).toBeGreaterThanOrEqual(0);
      expect(events.indexOf("feedback")).toBeGreaterThan(events.indexOf("merge-base"));
    });
  });

  test("merge stuck → no feedback OpenCode", async () => {
    await withDirs(async (home, workdir) => {
      const prompts: string[] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "merge-base" && gitArgs.includes("HEAD")) {
          throw new Error("git merge-base --is-ancestor failed with exit code 1");
        }
        if (gitArgs[0] === "merge") throw new Error("git merge failed with exit code 1");
        if (gitArgs[0] === "diff" && gitArgs.includes("--diff-filter=U")) return "src/demo.ts";
        if (gitArgs[0] === "grep") return "src/demo.ts";
        if (gitArgs[0] === "rev-parse") return "abc123";
        return "";
      };
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
        gitRunner,
        openCodeRunner: async (prompt) => {
          prompts.push(prompt);
          return "done";
        },
        logger: () => undefined,
      });
      expect(prompts).toEqual([CONFLICT_PROMPT]);
      expect(result).toEqual({ status: "skipped", reason: "stuck: cannot resolve conflicts" });
      const conflict = await readConflictState(conflictStatePath(home, "kirmanak", "demo", 12));
      expect(conflict.round).toBe(1);
      expect(conflict.lastHeadSha).toBe("abc123");
      expect(conflict.lastBaseSha).toBe("abc123");
    });
  });

  test("follow-up same-SHA after stuck skips merge/OpenCode", async () => {
    await withDirs(async (home, workdir) => {
      await writeConflictState(conflictStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 127,
        round: 1,
        lastHeadSha: "headsha",
        lastBaseSha: "basesha",
        updatedAt: "2026-05-23T00:00:00Z",
      });
      let openCode = 0;
      let mergeCalled = false;
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
        gitRunner: async (args) => {
          const gitArgs = stripGitConfigArgs(args);
          if (gitArgs[0] === "merge") mergeCalled = true;
          if (gitArgs[0] === "rev-parse" && gitArgs.includes("origin/main")) return "basesha";
          if (gitArgs[0] === "rev-parse") return "headsha";
          return "";
        },
        openCodeRunner: async () => {
          openCode++;
          return "done";
        },
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "skipped", reason: "same head and base already attempted" });
      expect(openCode).toBe(0);
      expect(mergeCalled).toBe(false);
    });
  });

  test("follow-up prefix OpenCode throw persists conflict state", async () => {
    await withDirs(async (home, workdir) => {
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "merge-base" && gitArgs.includes("HEAD")) {
          throw new Error("git merge-base --is-ancestor failed with exit code 1");
        }
        if (gitArgs[0] === "merge") throw new Error("git merge failed with exit code 1");
        if (gitArgs[0] === "diff" && gitArgs.includes("--diff-filter=U")) return "src/demo.ts";
        if (gitArgs[0] === "grep") return "src/demo.ts";
        if (gitArgs[0] === "rev-parse" && gitArgs.includes("origin/main")) return "basesha";
        if (gitArgs[0] === "rev-parse") return "headsha";
        return "";
      };
      await expect(
        implementFollowUp({
          api: makeApi(),
          job: followUpJob(),
          giteaUrl: "https://gitea.kirmanak.stream",
          giteaToken: "bot-token",
          botUsername: "jumi",
          model: "openai/gpt-5.5",
          home,
          workdir,
          heartbeatIntervalMs: 0,
          gitRunner,
          openCodeRunner: async (prompt) => {
            if (prompt === CONFLICT_PROMPT) throw new Error("opencode crashed");
            throw new Error("feedback should not run");
          },
          logger: () => undefined,
        })
      ).rejects.toThrow("opencode crashed");
      const conflict = await readConflictState(conflictStatePath(home, "kirmanak", "demo", 12));
      expect(conflict.round).toBe(1);
      expect(conflict.lastHeadSha).toBe("headsha");
      expect(conflict.lastBaseSha).toBe("basesha");
      const followup = JSON.parse(await readFile(followUpStatePath(home, "kirmanak", "demo", 12), "utf8"));
      expect(followup.round).toBe(1);
    });
  });

  test("follow-up honors MAX_CONFLICT_ROUNDS / shared conflict state", async () => {
    await withDirs(async (home, workdir) => {
      await writeConflictState(conflictStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 127,
        round: 3,
        lastHeadSha: "abc",
        lastBaseSha: "def",
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
      expect(result).toEqual({ status: "skipped", reason: "stuck: cannot resolve conflicts" });
      expect(openCode).toBe(0);
      expect(api.comments.at(-1)).toContain("stuck: cannot resolve conflicts");
    });
  });

  test("follow-up records conflict SHAs after push on merged, immediately on stuck", async () => {
    await withDirs(async (home, workdir) => {
      let conflictDone = false;
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "merge-base" && gitArgs.includes("HEAD")) {
          throw new Error("git merge-base --is-ancestor failed with exit code 1");
        }
        if (gitArgs[0] === "merge") throw new Error("git merge failed with exit code 1");
        if (gitArgs[0] === "diff" && gitArgs.includes("--diff-filter=U")) return "src/demo.ts";
        if (gitArgs[0] === "grep") return conflictDone ? "" : "src/demo.ts";
        if (gitArgs[0] === "rev-parse" && gitArgs.includes("MERGE_HEAD")) return "mergehead";
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "M src/demo.ts";
        if (gitArgs[0] === "rev-list") return "1";
        return "";
      };
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
        gitRunner,
        openCodeRunner: async (prompt) => {
          if (prompt === CONFLICT_PROMPT) conflictDone = true;
          return "done";
        },
        logger: () => undefined,
      });
      expect(result.status).toBe("pushed");
      const conflict = await readConflictState(conflictStatePath(home, "kirmanak", "demo", 12));
      expect(conflict.round).toBe(1);
      expect(conflict.lastHeadSha).toBe("abc123");
      expect(conflict.lastBaseSha).toBe("abc123");
    });
  });

  test("follow-up does not record merged conflict SHAs if later step throws", async () => {
    await withDirs(async (home, workdir) => {
      let conflictDone = false;
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "merge-base" && gitArgs.includes("HEAD")) {
          throw new Error("git merge-base --is-ancestor failed with exit code 1");
        }
        if (gitArgs[0] === "merge") throw new Error("git merge failed with exit code 1");
        if (gitArgs[0] === "diff" && gitArgs.includes("--diff-filter=U")) return "src/demo.ts";
        if (gitArgs[0] === "grep") return conflictDone ? "" : "src/demo.ts";
        if (gitArgs[0] === "rev-parse" && gitArgs.includes("MERGE_HEAD")) return "mergehead";
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "M src/demo.ts";
        return "";
      };
      await expect(
        implementFollowUp({
          api: makeApi(),
          job: followUpJob(),
          giteaUrl: "https://gitea.kirmanak.stream",
          giteaToken: "bot-token",
          botUsername: "jumi",
          model: "openai/gpt-5.5",
          home,
          workdir,
          heartbeatIntervalMs: 0,
          gitRunner,
          openCodeRunner: async (prompt) => {
            if (prompt === CONFLICT_PROMPT) {
              conflictDone = true;
              return "done";
            }
            throw new Error("feedback exploded");
          },
          logger: () => undefined,
        })
      ).rejects.toThrow("feedback exploded");
      const conflict = await readConflictState(conflictStatePath(home, "kirmanak", "demo", 12));
      expect(conflict.round).toBe(0);
      expect(conflict.lastHeadSha).toBe("");
      expect(conflict.lastBaseSha).toBe("");
    });
  });

  test("follow-up up-to-date merge does not increment conflict round", async () => {
    await withDirs(async (home, workdir) => {
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "";
        if (gitArgs[0] === "rev-list") return "0";
        return "";
      };
      await implementFollowUp({
        api: makeApi(),
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
      const conflict = await readConflictState(conflictStatePath(home, "kirmanak", "demo", 12));
      expect(conflict.round).toBe(0);
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

  test("no-changes persists jumi-review finding as id+sha, not comment id", async () => {
    await withDirs(async (home, workdir) => {
      const sha = "a62c750c0ffee000000000000000000000000000";
      const pr = jumiPr();
      pr.head.sha = sha;
      const api = makeApi({
        listOpenPulls: async () => [pr],
        listIssueComments: async () => [
          makeComment({
            id: 38022,
            body: [
              "<!-- jumi-review:kirmanak/demo#127 -->",
              "### Jumi OpenCode review",
              "",
              `Reviewed commit: \`${sha}\``,
              "",
              "1 blocking",
              "<!-- jumi-check: failure; 1 blocking, 1 risk -->",
            ].join("\n"),
            user: makeUser({ login: "jumi" }),
          }),
        ],
      });
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return sha;
        if (gitArgs[0] === "status") return "";
        if (gitArgs[0] === "rev-list") return "0";
        return "";
      };
      const result = await implementFollowUp({
        api,
        job: followUpJob({ trigger: undefined }),
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
      const state = JSON.parse(await readFile(followUpStatePath(home, "kirmanak", "demo", 12), "utf8"));
      expect(state.handledCommentIds).not.toContain(38022);
      expect(state.handledReviewFindings).toEqual([{ id: 38022, sha }]);
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
  test("keeps human issue comments when inline listing 404s", async () => {
    const api = makeApi({
      listIssueComments: async () => [
        makeComment({ id: 55, body: "please fix the tests", user: makeUser({ login: "alice" }) }),
      ],
      listPullReviewComments: async () => {
        throw new Error("404: not found");
      },
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", jumiPr().head.sha);
    expect(items.comments.map((comment) => comment.id)).toEqual([55]);
    expect(items.inlines).toEqual([]);
    await withDirs(async (home) => {
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

  test("needsFollowUp is false when inlines 404 and there is no human feedback", async () => {
    const api = makeApi({
      listIssueComments: async () => [],
      listPullReviewComments: async () => {
        throw new Error("404: not found");
      },
      listPullReviews: async () => [],
    });
    await withDirs(async (home) => {
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
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", jumiPr().head.sha);
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
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", jumiPr().head.sha);
    expect(items.reviews).toEqual([]);
  });

  const HEAD_SHA = "a62c750c0ffee000000000000000000000000000";
  const STALE_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  function reviewSticky(opts: { sha?: string; trailer?: string | null; worker?: boolean; review?: boolean } = {}) {
    const lines: string[] = [];
    if (opts.worker) lines.push("<!-- jumi-worker:kirmanak/demo#12 -->");
    if (opts.review !== false) lines.push("<!-- jumi-review:kirmanak/demo#127 -->");
    lines.push("### Jumi OpenCode review", "", `Reviewed commit: \`${opts.sha ?? HEAD_SHA}\``, "", "1 blocking");
    if (opts.trailer !== null) lines.push(opts.trailer ?? "<!-- jumi-check: failure -->");
    return lines.join("\n");
  }

  function prWithHead(sha = HEAD_SHA) {
    const pr = jumiPr();
    return { ...pr, head: { ...pr.head, sha } };
  }

  test("keeps current-head jumi failure sticky with reason suffix and needsFollowUp", async () => {
    const api = makeApi({
      listIssueComments: async () => [
        makeComment({
          id: 38022,
          body: reviewSticky({ trailer: "<!-- jumi-check: failure; 1 blocking, 1 risk -->" }),
          user: makeUser({ login: "jumi" }),
        }),
      ],
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", HEAD_SHA);
    expect(items.comments.map((comment) => comment.id)).toEqual([38022]);
    await withDirs(async (home) => {
      expect(
        await needsFollowUp({
          api,
          owner: "kirmanak",
          repo: "demo",
          pr: prWithHead(),
          issueNumber: 12,
          botUsername: "jumi",
          home,
        })
      ).toBe(true);
    });
  });

  test("keeps current-head jumi failure sticky and needsFollowUp", async () => {
    const api = makeApi({
      listIssueComments: async () => [
        makeComment({
          id: 38022,
          body: reviewSticky(),
          user: makeUser({ login: "jumi" }),
        }),
      ],
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", HEAD_SHA);
    expect(items.comments.map((comment) => comment.id)).toEqual([38022]);
    await withDirs(async (home) => {
      expect(
        await needsFollowUp({
          api,
          owner: "kirmanak",
          repo: "demo",
          pr: prWithHead(),
          issueNumber: 12,
          botUsername: "jumi",
          home,
        })
      ).toBe(true);
    });
  });

  test("excludes jumi review sticky when trailer is missing", async () => {
    const api = makeApi({
      listIssueComments: async () => [
        makeComment({
          id: 38022,
          body: reviewSticky({ trailer: null }),
          user: makeUser({ login: "jumi" }),
        }),
      ],
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", HEAD_SHA);
    expect(items.comments).toEqual([]);
    await withDirs(async (home) => {
      expect(
        await needsFollowUp({
          api,
          owner: "kirmanak",
          repo: "demo",
          pr: prWithHead(),
          issueNumber: 12,
          botUsername: "jumi",
          home,
        })
      ).toBe(false);
    });
  });

  test("excludes jumi failure sticky for a SHA that is not pr.head.sha", async () => {
    const api = makeApi({
      listIssueComments: async () => [
        makeComment({
          id: 38022,
          body: reviewSticky({ sha: STALE_SHA }),
          user: makeUser({ login: "jumi" }),
        }),
      ],
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", HEAD_SHA);
    expect(items.comments).toEqual([]);
  });

  test("excludes jumi review sticky with success trailer", async () => {
    const api = makeApi({
      listIssueComments: async () => [
        makeComment({
          id: 38022,
          body: reviewSticky({ trailer: "<!-- jumi-check: success -->" }),
          user: makeUser({ login: "jumi" }),
        }),
      ],
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", HEAD_SHA);
    expect(items.comments).toEqual([]);
  });

  test("excludes jumi review sticky with success trailer and reason suffix", async () => {
    const api = makeApi({
      listIssueComments: async () => [
        makeComment({
          id: 38022,
          body: reviewSticky({ trailer: "<!-- jumi-check: success; no blocking issues -->" }),
          user: makeUser({ login: "jumi" }),
        }),
      ],
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", HEAD_SHA);
    expect(items.comments).toEqual([]);
  });

  test("excludes jumi-worker sticky", async () => {
    const api = makeApi({
      listIssueComments: async () => [
        makeComment({
          id: 1,
          body: reviewSticky({ worker: true }),
          user: makeUser({ login: "jumi" }),
        }),
      ],
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", HEAD_SHA);
    expect(items.comments).toEqual([]);
  });

  test("keeps a human alice root comment in scope", async () => {
    const api = makeApi({
      listIssueComments: async () => [
        makeComment({ id: 55, body: "please fix the tests", user: makeUser({ login: "alice" }) }),
        makeComment({
          id: 1,
          body: "<!-- jumi-worker:kirmanak/demo#12 -->\nworking",
          user: makeUser({ login: "jumi" }),
        }),
      ],
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", HEAD_SHA);
    expect(items.comments.map((comment) => comment.id)).toEqual([55]);
  });

  test("excludes human jumi-check failure without jumi-review", async () => {
    const api = makeApi({
      listIssueComments: async () => [
        makeComment({
          id: 77,
          body: "please fix\n<!-- jumi-check: failure -->",
          user: makeUser({ login: "alice" }),
        }),
      ],
    });
    const items = await collectFollowUpItems(api, "kirmanak", "demo", 127, "jumi", HEAD_SHA);
    expect(items.comments).toEqual([]);
  });

  test("needsFollowUp is false when the same jumi-review id and reviewed SHA are already handled", async () => {
    const api = makeApi({
      listIssueComments: async () => [
        makeComment({
          id: 38022,
          body: reviewSticky(),
          user: makeUser({ login: "jumi" }),
        }),
      ],
    });
    await withDirs(async (home) => {
      await writeFollowUpState(followUpStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 127,
        round: 1,
        lastHeadSha: HEAD_SHA,
        handledCommentIds: [],
        handledReviewIds: [],
        handledReviewFindings: [{ id: 38022, sha: HEAD_SHA }],
        updatedAt: "2026-05-23T00:00:00Z",
      });
      expect(
        await needsFollowUp({
          api,
          owner: "kirmanak",
          repo: "demo",
          pr: prWithHead(),
          issueNumber: 12,
          botUsername: "jumi",
          home,
        })
      ).toBe(false);
    });
  });

  test("needsFollowUp is true when the same jumi-review id has a new current-head SHA", async () => {
    const nextSha = "cccccccccccccccccccccccccccccccccccccccc";
    const api = makeApi({
      listIssueComments: async () => [
        makeComment({
          id: 38022,
          body: reviewSticky({ sha: nextSha }),
          user: makeUser({ login: "jumi" }),
        }),
      ],
    });
    await withDirs(async (home) => {
      await writeFollowUpState(followUpStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 127,
        round: 1,
        lastHeadSha: HEAD_SHA,
        handledCommentIds: [38022],
        handledReviewIds: [],
        handledReviewFindings: [{ id: 38022, sha: HEAD_SHA }],
        updatedAt: "2026-05-23T00:00:00Z",
      });
      expect(
        await needsFollowUp({
          api,
          owner: "kirmanak",
          repo: "demo",
          pr: prWithHead(nextSha),
          issueNumber: 12,
          botUsername: "jumi",
          home,
        })
      ).toBe(true);
    });
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
