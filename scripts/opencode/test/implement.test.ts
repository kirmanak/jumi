import { afterEach, describe, expect, test } from "bun:test";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimFilePath, readClaim } from "../src/claim.ts";
import { BLOCKED_BY_FILE, BLOCKED_BY_REJECTED_STUCK, QUEUE_FILE } from "../src/dependencies.ts";
import type { OpenCodeRunOptions } from "../src/git.ts";
import { BLOCKED_BY_REJECTED_PROMPT, IMPLEMENT_YIELD_PROMPT } from "../src/git.ts";
import type { IssueApi } from "../src/gitea_issues.ts";
import { workerMarker } from "../src/gitea_issues.ts";
import { buildPullRequestBody, cancelIssueWork, implementIssue } from "../src/implement.ts";
import type { GitRunner } from "../src/workspace.ts";
import {
  emptyCiMethods,
  makeComment,
  makeIssue,
  makeIssueJob,
  makeLinkedIssue,
  makePR,
  makeRepo,
  makeUser,
} from "./fixtures.ts";

const originalPath = process.env.PATH;
const originalSecret = process.env.GITEA_BOT_TOKEN;

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalSecret === undefined) delete process.env.GITEA_BOT_TOKEN;
  else process.env.GITEA_BOT_TOKEN = originalSecret;
});

function stripGitConfigArgs(args: string[]): string[] {
  const result = [...args];
  while (result[0] === "-c") result.splice(0, 2);
  return result;
}

function makeApi(overrides: Partial<IssueApi> = {}): IssueApi & { comments: string[]; pulls: unknown[] } {
  const comments: string[] = [];
  const pulls: unknown[] = [];
  const defaults: IssueApi = {
    getRepo: async () => makeRepo(),
    getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
    getIssue: async () => makeIssue(),
    getPR: async (_owner, _repo, index) => makePR({ number: index }),
    listOpenPulls: async () => [],
    createPullRequest: async (_owner, _repo, pull) => {
      pulls.push(pull);
      return makePR({
        number: 3,
        title: pull.title,
        body: pull.body,
        html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/3",
      });
    },
    closePullRequest: async (_owner, _repo, index) => makePR({ number: index, state: "closed" }),
    findStickyIssueComment: async () => undefined,
    createIssueComment: async (_owner, _repo, _index, body) => {
      comments.push(body);
      return makeComment({ body });
    },
    updateIssueComment: async (_owner, _repo, _id, body) => {
      comments.push(body);
      return makeComment({ body });
    },
    listIssueComments: async () => [],
    listPullReviewComments: async () => [],
    listPullReviews: async () => [],
    ...emptyCiMethods(),
  };
  return { ...defaults, ...overrides, comments, pulls };
}

async function withDirs(run: (home: string, workdir: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "jumi-impl-home-"));
  const workdir = await mkdtemp(join(tmpdir(), "jumi-impl-work-"));
  try {
    await run(home, workdir);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
  }
}

describe("buildPullRequestBody", () => {
  test("falls back for null, empty, and whitespace-only contents", () => {
    expect(buildPullRequestBody(12, null)).toBe("Fixes #12");
    expect(buildPullRequestBody(12, undefined)).toBe("Fixes #12");
    expect(buildPullRequestBody(12, "")).toBe("Fixes #12");
    expect(buildPullRequestBody(12, "  \n")).toBe("Fixes #12");
  });

  test("appends Fixes #n when the text has no close keyword", () => {
    expect(buildPullRequestBody(12, "Caches categories.")).toBe("Caches categories.\n\nFixes #12");
  });

  test("does not duplicate an existing close keyword for this issue", () => {
    expect(buildPullRequestBody(12, "Caches categories.\n\nFixes #12")).toBe("Caches categories.\n\nFixes #12");
    expect(buildPullRequestBody(12, "Closes #12")).toBe("Closes #12");
    expect(buildPullRequestBody(12, "Fixed #12")).toBe("Fixed #12");
  });

  test("still appends Fixes #n when a different issue is mentioned", () => {
    expect(buildPullRequestBody(12, "Fixes #13")).toBe("Fixes #13\n\nFixes #12");
  });

  test("truncates to 8000 characters and still includes the close keyword", () => {
    const body = buildPullRequestBody(12, "x".repeat(9000));
    expect(body.length).toBeLessThanOrEqual(8000 + "\n\nFixes #12".length);
    expect(body.endsWith("\n\nFixes #12")).toBe(true);
    expect(body.startsWith("x".repeat(8000))).toBe(true);
  });

  test("strips NUL bytes", () => {
    expect(buildPullRequestBody(12, "Caches\0 categories.")).toBe("Caches categories.\n\nFixes #12");
  });
});

describe("implementIssue", () => {
  test("skips when an open PR already closes the issue", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi({
        listOpenPulls: async () => [makePR({ title: "Fix", body: "Fixes #12" })],
      });
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
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
      expect(result).toEqual({ status: "skipped", reason: "open PR already closes #12" });
      const claim = await readClaim(claimFilePath(home, "kirmanak", "demo", 12));
      expect(claim).toBeUndefined();
    });
  });

  test("jumi closer with human comments becomes follow-up work rather than a dead skip", async () => {
    await withDirs(async (home, workdir) => {
      let commentsListed = 0;
      const repo = makeRepo();
      const api = makeApi({
        listOpenPulls: async () => [
          makePR({
            number: 127,
            user: makeUser({ login: "jumi" }),
            body: "Fixes #12",
            head: {
              label: "kirmanak:jumi/issue-12-fix-the-thing",
              ref: "jumi/issue-12-fix-the-thing",
              sha: "headsha",
              repo,
              repo_id: repo.id,
            },
          }),
        ],
        listIssueComments: async () => {
          commentsListed++;
          return [makeComment({ id: 55, body: "please fix the tests", user: makeUser({ login: "alice" }) })];
        },
      });
      await expect(
        implementIssue({
          api,
          job: makeIssueJob(),
          giteaUrl: "https://gitea.kirmanak.stream",
          giteaToken: "bot-token",
          botUsername: "jumi",
          model: "openai/gpt-5.5",
          home,
          workdir,
          heartbeatIntervalMs: 0,
          gitRunner: async () => {
            throw new Error("follow-up git");
          },
          openCodeRunner: async () => {
            throw new Error("opencode should not run before git");
          },
          logger: () => undefined,
        })
      ).rejects.toThrow("follow-up git");
      expect(commentsListed).toBeGreaterThan(0);
    });
  });

  test("selects the jumi closer when a human Fixes #n is listed first", async () => {
    await withDirs(async (home, workdir) => {
      let commentsListed = 0;
      const repo = makeRepo();
      const api = makeApi({
        listOpenPulls: async () => [
          makePR({ title: "Fix", body: "Fixes #12", user: makeUser({ login: "alice" }) }),
          makePR({
            number: 127,
            user: makeUser({ login: "jumi" }),
            body: "Fixes #12",
            head: {
              label: "kirmanak:jumi/issue-12-fix-the-thing",
              ref: "jumi/issue-12-fix-the-thing",
              sha: "headsha",
              repo,
              repo_id: repo.id,
            },
          }),
        ],
        listIssueComments: async () => {
          commentsListed++;
          return [makeComment({ id: 55, body: "please fix the tests", user: makeUser({ login: "alice" }) })];
        },
      });
      await expect(
        implementIssue({
          api,
          job: makeIssueJob(),
          giteaUrl: "https://gitea.kirmanak.stream",
          giteaToken: "bot-token",
          botUsername: "jumi",
          model: "openai/gpt-5.5",
          home,
          workdir,
          heartbeatIntervalMs: 0,
          gitRunner: async () => {
            throw new Error("follow-up git");
          },
          openCodeRunner: async () => {
            throw new Error("opencode should not run before git");
          },
          logger: () => undefined,
        })
      ).rejects.toThrow("follow-up git");
      expect(commentsListed).toBeGreaterThan(0);
    });
  });

  test("first-run implement proceeds when an assigned foreign PR exists in the repo", async () => {
    await withDirs(async (home, workdir) => {
      const repo = makeRepo();
      const api = makeApi({
        listOpenPulls: async () => [
          makePR({
            user: makeUser({ login: "renovate" }),
            assignee: makeUser({ login: "jumi" }),
            assignees: [makeUser({ login: "jumi" })],
            head: { label: "kirmanak:renovate/x", ref: "renovate/x", sha: "abc", repo, repo_id: repo.id },
          }),
        ],
      });
      await expect(
        implementIssue({
          api,
          job: makeIssueJob(),
          giteaUrl: "https://gitea.kirmanak.stream",
          giteaToken: "bot-token",
          botUsername: "jumi",
          model: "openai/gpt-5.5",
          home,
          workdir,
          heartbeatIntervalMs: 0,
          gitRunner: async () => {
            throw new Error("first-run git");
          },
          openCodeRunner: async () => {
            throw new Error("opencode should not run before git");
          },
          logger: () => undefined,
        })
      ).rejects.toThrow("first-run git");
    });
  });

  test("skips first-run before clone when a Gitea blocker is still open", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi({
        listIssueDependencies: async (_owner, _repo, index) => (index === 12 ? [makeLinkedIssue({ number: 196 })] : []),
      });
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
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
      expect(result).toEqual({ status: "skipped", reason: "blocked on #196" });
      expect(api.comments.some((body) => body.includes("blocked on #196"))).toBe(true);
      expect(api.comments.filter((body) => body.includes("blocked on #196"))).toHaveLength(1);
      const claim = await readClaim(claimFilePath(home, "kirmanak", "demo", 12));
      expect(claim).toBeUndefined();
    });
  });

  test("keeps today's skip when an open PR already closes the blocked issue", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi({
        listOpenPulls: async () => [makePR({ title: "Fix", body: "Fixes #12" })],
        listIssueDependencies: async () => [makeLinkedIssue({ number: 196 })],
      });
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
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
      expect(result).toEqual({ status: "skipped", reason: "open PR already closes #12" });
      expect(api.comments.some((body) => body.includes("blocked on"))).toBe(false);
    });
  });

  test("fail-closes a dependency cycle without running the engine", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi({
        listIssueDependencies: async (_owner, _repo, index) =>
          index === 12 ? [makeLinkedIssue({ number: 196 })] : [makeLinkedIssue({ number: 12 })],
      });
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
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
      expect(result).toEqual({ status: "skipped", reason: "stuck: dependency cycle" });
      expect(api.comments.some((body) => body.includes("stuck: dependency cycle"))).toBe(true);
      const claim = await readClaim(claimFilePath(home, "kirmanak", "demo", 12));
      expect(claim).toBeUndefined();
    });
  });

  test("first-run yield of a queue id sets a Gitea dependency and does not open a PR", async () => {
    await withDirs(async (home, workdir) => {
      const deps: Array<{ owner: string; repo: string; number: number }> = [];
      const events: string[] = [];
      const api = makeApi({
        listRepoIssues: async () => [makeLinkedIssue({ number: 196, title: "Sibling" })],
        createIssueDependency: async (_owner, _repo, _index, dependency) => {
          events.push("createIssueDependency");
          deps.push(dependency);
        },
      });
      const gitCalls: string[][] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "push" && gitArgs.includes("--delete")) events.push("deleteIssueBranch");
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        if (gitArgs[0] === "show-ref") {
          const ref = gitArgs.at(-1) ?? "";
          if (ref === "refs/remotes/origin/jumi/issue-12-fix-the-thing") throw new Error("missing");
          return "";
        }
        return "";
      };
      let prompt: string | undefined;
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async (opts) => {
          prompt = opts.prompt;
          const queue = await readFile(join(workdir, "kirmanak/demo/12", QUEUE_FILE), "utf8");
          expect(queue).toContain("#196");
          await writeFile(join(workdir, "kirmanak/demo/12", BLOCKED_BY_FILE), "<!-- jumi-blocked-by: #196 -->\n");
          await writeFile(join(workdir, "kirmanak/demo/12/src.ts"), "guess");
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(prompt).toBe(IMPLEMENT_YIELD_PROMPT);
      expect(result).toEqual({ status: "skipped", reason: "blocked on #196" });
      expect(deps).toEqual([{ owner: "kirmanak", repo: "demo", number: 196 }]);
      expect(events).toEqual(["createIssueDependency", "deleteIssueBranch"]);
      expect(api.pulls).toHaveLength(0);
      expect(api.comments.some((body) => body.includes("blocked on #196"))).toBe(true);
      expect(gitCalls.some((args) => args[0] === "commit")).toBe(false);
      expect(gitCalls.some((args) => args[0] === "push" && args.includes("--delete"))).toBe(true);
      expect(gitCalls.some((args) => args[0] === "push" && args.includes("-u"))).toBe(false);
      const removeAt = gitCalls.findIndex((args) => args[0] === "worktree" && args[1] === "remove");
      const deleteHeadAt = gitCalls.findIndex(
        (args) => args[0] === "update-ref" && args[1] === "-d" && args[2] === "refs/heads/jumi/issue-12-fix-the-thing"
      );
      const deletePushAt = gitCalls.findIndex((args) => args[0] === "push" && args.includes("--delete"));
      expect(removeAt).toBeGreaterThanOrEqual(0);
      expect(deleteHeadAt).toBeGreaterThan(removeAt);
      expect(deletePushAt).toBeGreaterThan(removeAt);
      const claim = await readClaim(claimFilePath(home, "kirmanak", "demo", 12));
      expect(claim).toBeUndefined();
    });
  });

  test("invalid blocked-by retries once in the same lease then ships if the retry implements", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi({
        listRepoIssues: async () => [makeLinkedIssue({ number: 196, title: "Sibling" })],
      });
      const gitCalls: string[][] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        if (gitArgs[0] === "show-ref") {
          const ref = gitArgs.at(-1) ?? "";
          if (ref === "refs/remotes/origin/jumi/issue-12-fix-the-thing") throw new Error("missing");
          return "";
        }
        return "";
      };
      const prompts: Array<string | undefined> = [];
      let round = 0;
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async (opts) => {
          round++;
          prompts.push(opts.prompt);
          if (round === 1) {
            await writeFile(join(workdir, "kirmanak/demo/12", BLOCKED_BY_FILE), "<!-- jumi-blocked-by: #404 -->\n");
            await writeFile(join(workdir, "kirmanak/demo/12/junk.ts"), "guess");
            return { status: "ok" };
          }
          expect(await readFile(join(workdir, "kirmanak/demo/12", BLOCKED_BY_FILE), "utf8").catch(() => "")).toBe("");
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(round).toBe(2);
      expect(prompts[0]).toBe(IMPLEMENT_YIELD_PROMPT);
      expect(prompts[1]).toBe(BLOCKED_BY_REJECTED_PROMPT);
      expect(result.status).toBe("pr");
      expect(api.pulls).toHaveLength(1);
      const removeAt = gitCalls.findIndex((args) => args[0] === "worktree" && args[1] === "remove");
      const readdAt = gitCalls.findIndex(
        (args) => args[0] === "worktree" && args[1] === "add" && args.includes("origin/main") && args.includes("-B")
      );
      expect(removeAt).toBeGreaterThanOrEqual(0);
      expect(readdAt).toBeGreaterThan(removeAt);
    });
  });

  test("second garbage blocked-by is stuck and does not open a PR", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi({
        listRepoIssues: async () => [makeLinkedIssue({ number: 196, title: "Sibling" })],
      });
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        if (gitArgs[0] === "show-ref") {
          const ref = gitArgs.at(-1) ?? "";
          if (ref === "refs/remotes/origin/jumi/issue-12-fix-the-thing") throw new Error("missing");
          return "";
        }
        return "";
      };
      let round = 0;
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => {
          round++;
          await writeFile(
            join(workdir, "kirmanak/demo/12", BLOCKED_BY_FILE),
            `<!-- jumi-blocked-by: #${round === 1 ? 12 : 999} -->\n`
          );
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(round).toBe(2);
      expect(result).toEqual({ status: "skipped", reason: BLOCKED_BY_REJECTED_STUCK });
      expect(api.pulls).toHaveLength(0);
      expect(api.comments.some((body) => body.includes(BLOCKED_BY_REJECTED_STUCK))).toBe(true);
    });
  });

  test("empty queue does not mention yield and does not extra-spawn", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        return "";
      };
      let runs = 0;
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async (opts) => {
          runs++;
          expect("prompt" in opts).toBe(false);
          await expect(access(join(workdir, "kirmanak/demo/12", QUEUE_FILE))).rejects.toThrow();
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(runs).toBe(1);
      expect(result.status).toBe("pr");
    });
  });

  test("clears leftover JUMI_BLOCKED.md before the engine so a prior marker is not this run's yield", async () => {
    await withDirs(async (home, workdir) => {
      const worktree = join(workdir, "kirmanak/demo/12");
      await mkdir(join(worktree, ".git"), { recursive: true });
      await writeFile(join(worktree, BLOCKED_BY_FILE), "<!-- jumi-blocked-by: #196 -->\n");
      const deps: Array<{ owner: string; repo: string; number: number }> = [];
      const api = makeApi({
        listRepoIssues: async () => [makeLinkedIssue({ number: 196, title: "Sibling" })],
        createIssueDependency: async (_owner, _repo, _index, dependency) => {
          deps.push(dependency);
        },
      });
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        if (gitArgs[0] === "show-ref") {
          const ref = gitArgs.at(-1) ?? "";
          if (ref === "refs/remotes/origin/jumi/issue-12-fix-the-thing") throw new Error("missing");
          return "";
        }
        return "";
      };
      let leftoverPresent = true;
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => {
          leftoverPresent = await access(join(worktree, BLOCKED_BY_FILE)).then(
            () => true,
            () => false
          );
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(leftoverPresent).toBe(false);
      expect(result.status).toBe("pr");
      expect(deps).toEqual([]);
      expect(api.pulls).toHaveLength(1);
    });
  });

  test("empty queue does not treat an engine-written JUMI_BLOCKED.md as a yield", async () => {
    await withDirs(async (home, workdir) => {
      const deps: Array<{ owner: string; repo: string; number: number }> = [];
      const api = makeApi({
        createIssueDependency: async (_owner, _repo, _index, dependency) => {
          deps.push(dependency);
        },
      });
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        return "";
      };
      let runs = 0;
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => {
          runs++;
          await writeFile(join(workdir, "kirmanak/demo/12", BLOCKED_BY_FILE), "<!-- jumi-blocked-by: #196 -->\n");
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(runs).toBe(1);
      expect(result.status).toBe("pr");
      expect(deps).toEqual([]);
    });
  });

  test("valid yield still deletes issue-branch when createIssueDependency throws", async () => {
    await withDirs(async (home, workdir) => {
      const events: string[] = [];
      const api = makeApi({
        listRepoIssues: async () => [makeLinkedIssue({ number: 196, title: "Sibling" })],
        createIssueDependency: async () => {
          events.push("createIssueDependency");
          throw new Error("dependency already exists");
        },
      });
      const gitCalls: string[][] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "push" && gitArgs.includes("--delete")) events.push("deleteIssueBranch");
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        if (gitArgs[0] === "show-ref") {
          const ref = gitArgs.at(-1) ?? "";
          if (ref === "refs/remotes/origin/jumi/issue-12-fix-the-thing") throw new Error("missing");
          return "";
        }
        return "";
      };
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => {
          await writeFile(join(workdir, "kirmanak/demo/12", BLOCKED_BY_FILE), "<!-- jumi-blocked-by: #196 -->\n");
          await writeFile(join(workdir, "kirmanak/demo/12/src.ts"), "guess");
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "skipped", reason: "failed to set dependency: dependency already exists" });
      expect(events).toEqual(["createIssueDependency", "deleteIssueBranch"]);
      expect(api.pulls).toHaveLength(0);
      expect(api.comments.some((body) => body.includes("failed to set dependency: dependency already exists"))).toBe(
        true
      );
      const removeAt = gitCalls.findIndex((args) => args[0] === "worktree" && args[1] === "remove");
      const deleteHeadAt = gitCalls.findIndex(
        (args) => args[0] === "update-ref" && args[1] === "-d" && args[2] === "refs/heads/jumi/issue-12-fix-the-thing"
      );
      const deletePushAt = gitCalls.findIndex((args) => args[0] === "push" && args.includes("--delete"));
      expect(removeAt).toBeGreaterThanOrEqual(0);
      expect(deleteHeadAt).toBeGreaterThan(removeAt);
      expect(deletePushAt).toBeGreaterThan(removeAt);
      const claim = await readClaim(claimFilePath(home, "kirmanak", "demo", 12));
      expect(claim).toBeUndefined();
    });
  });

  test("valid yield POSTs the dependency even if issue-branch push --delete fails", async () => {
    await withDirs(async (home, workdir) => {
      const deps: Array<{ owner: string; repo: string; number: number }> = [];
      const api = makeApi({
        listRepoIssues: async () => [makeLinkedIssue({ number: 196, title: "Sibling" })],
        createIssueDependency: async (_owner, _repo, _index, dependency) => {
          deps.push(dependency);
        },
      });
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        if (gitArgs[0] === "push" && gitArgs.includes("--delete")) throw new Error("permission denied");
        return "";
      };
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => {
          await writeFile(join(workdir, "kirmanak/demo/12", BLOCKED_BY_FILE), "<!-- jumi-blocked-by: #196 -->\n");
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "skipped", reason: "blocked on #196" });
      expect(deps).toEqual([{ owner: "kirmanak", repo: "demo", number: 196 }]);
      expect(api.pulls).toHaveLength(0);
      expect(api.comments.some((body) => body.includes("blocked on #196"))).toBe(true);
    });
  });

  test("valid yield still skip-blocks when origin/issue-branch remains after delete", async () => {
    await withDirs(async (home, workdir) => {
      const deps: Array<{ owner: string; repo: string; number: number }> = [];
      const api = makeApi({
        listRepoIssues: async () => [makeLinkedIssue({ number: 196, title: "Sibling" })],
        createIssueDependency: async (_owner, _repo, _index, dependency) => {
          deps.push(dependency);
        },
      });
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        if (gitArgs[0] === "show-ref") return "abc123";
        return "";
      };
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => {
          await writeFile(join(workdir, "kirmanak/demo/12", BLOCKED_BY_FILE), "<!-- jumi-blocked-by: #196 -->\n");
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "skipped", reason: "blocked on #196" });
      expect(deps).toEqual([{ owner: "kirmanak", repo: "demo", number: 196 }]);
      expect(api.pulls).toHaveLength(0);
    });
  });

  test("skips when getIssue fails", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi({
        getIssue: async () => {
          throw new Error("gitea 502");
        },
      });
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
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
      expect(result.status).toBe("skipped");
      if (result.status === "skipped") expect(result.reason).toContain("failed to load issue");
    });
  });

  test("comments no changes and does not open a PR when the tree is clean", async () => {
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
      let openCodeOpts: OpenCodeRunOptions | undefined;
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async (opts) => {
          openCodeOpts = opts;
          const task = await readFile(join(workdir, "kirmanak/demo/12/JUMI_TASK.md"), "utf8");
          expect(task).toContain("Fix the thing");
          expect(task).toContain("Please implement this.");
          return { status: "ok" };
        },
        logger: () => undefined,
      });

      expect(result).toEqual({ status: "no-changes" });
      expect(api.pulls).toHaveLength(0);
      expect(api.comments.at(-1)).toContain("no changes");
      expect(api.comments.at(-1)).toContain(workerMarker("kirmanak", "demo", 12));
      expect(openCodeOpts?.sanitizeEnv).toBe(true);
      expect(openCodeOpts?.extraEnv?.GIT_AUTH_TOKEN).toBe("bot-token");
      expect(openCodeOpts?.extraEnv?.GITEA_BOT_TOKEN).toBeUndefined();
      expect(openCodeOpts?.extraEnv?.GIT_AUTHOR_NAME).toBe("jumi");
      expect(openCodeOpts?.extraEnv?.JAVA_HOME).toBe(process.env.JAVA_HOME || "/opt/java/openjdk");
      expect(openCodeOpts?.extraEnv?.GRADLE_USER_HOME).toBe(join(process.env.WORKDIR || "/work", ".gradle"));
      expect(openCodeOpts?.extraEnv?.GRADLE_OPTS).toBe("-Dorg.gradle.daemon=false");
      expect(openCodeOpts?.extraEnv?.JAVA_TOOL_OPTIONS).toBe(
        `-Djava.io.tmpdir=${join(workdir, "kirmanak/demo/12/.jumi-tmp")}`
      );
      expect(openCodeOpts?.extraEnv?.PATH?.startsWith(`${openCodeOpts?.extraEnv?.JAVA_HOME}/bin:`)).toBe(true);
      expect(gitCalls.some((args) => args[0] === "push")).toBe(false);
      expect(gitCalls.some((args) => args[0] === "commit")).toBe(false);
      expect(gitCalls.some((args) => args[0] === "rev-list" && args.includes("origin/main..HEAD"))).toBe(true);
    });
  });

  test("commits, pushes, and opens a PR when OpenCode leaves a dirty tree", async () => {
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
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => ({ status: "ok" }),
        logger: () => undefined,
      });

      expect(result).toEqual({
        status: "pr",
        htmlUrl: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/3",
        prNumber: 3,
      });
      expect(api.pulls).toEqual([
        {
          title: "Fix the thing",
          body: "Fixes #12",
          head: "jumi/issue-12-fix-the-thing",
          base: "main",
        },
      ]);
      const push = gitCalls.find((args) => args[0] === "push");
      expect(push).toEqual(["push", "-u", "origin", "jumi/issue-12-fix-the-thing"]);
      expect(gitCalls.some((args) => args[0] === "push" && args.includes("--force"))).toBe(false);
      expect(gitCalls.some((args) => args[0] === "commit")).toBe(true);
      expect(gitCalls.some((args) => args[0] === "add")).toBe(true);
      expect(gitCalls.some((args) => args.includes("+refs/heads/*:refs/remotes/origin/*"))).toBe(true);
      expect(gitCalls.some((args) => args.includes("+refs/heads/*:refs/heads/*"))).toBe(false);
      expect(gitCalls.some((args) => args[0] === "worktree" && args[1] === "remove")).toBe(true);
    });
  });

  test("does not open a PR when aborted after push", async () => {
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
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        abortSignal: abort.signal,
        gitRunner,
        openCodeRunner: async () => ({ status: "ok" }),
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "cancelled" });
      expect(api.pulls).toHaveLength(0);
    });
  });

  test("pushes and opens a PR when HEAD is ahead with a clean tree", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const gitCalls: string[][] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "";
        if (gitArgs[0] === "rev-list") return "1";
        return "";
      };
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => ({ status: "ok" }),
        logger: () => undefined,
      });
      expect(result.status).toBe("pr");
      expect(api.pulls).toHaveLength(1);
      expect(gitCalls.some((args) => args[0] === "commit")).toBe(false);
      expect(gitCalls.some((args) => args[0] === "push")).toBe(true);
    });
  });

  test("does not treat .jumi-tmp leftovers as a dirty tree", async () => {
    await withDirs(async (home, workdir) => {
      const worktree = join(workdir, "kirmanak/demo/12");
      const api = makeApi();
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") {
          try {
            await access(join(worktree, ".jumi-tmp"));
            return "?? .jumi-tmp/";
          } catch {
            return "";
          }
        }
        if (gitArgs[0] === "rev-list") return "0";
        return "";
      };
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => {
          await mkdir(join(worktree, ".jumi-tmp"), { recursive: true });
          await writeFile(join(worktree, ".jumi-tmp", "opencode-session.db"), "db");
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "no-changes" });
      expect(api.pulls).toHaveLength(0);
    });
  });

  test("heartbeat does not resurrect a terminal claim after no-changes", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "";
        if (gitArgs[0] === "rev-list") return "0";
        return "";
      };
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 20,
        gitRunner,
        openCodeRunner: async () => {
          await new Promise((resolve) => setTimeout(resolve, 45));
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "no-changes" });
      await new Promise((resolve) => setTimeout(resolve, 80));
      const claim = await readClaim(claimFilePath(home, "kirmanak", "demo", 12));
      expect(claim?.terminal).toBe(true);
      expect(claim?.pid).toBe(0);
    });
  });

  test("stamps terminal claims with issue updated_at after commenting", async () => {
    await withDirs(async (home, workdir) => {
      let commented = false;
      const api = makeApi({
        getIssue: async () => makeIssue({ updated_at: commented ? "2026-05-23T01:00:00Z" : "2026-05-23T00:00:00Z" }),
        createIssueComment: async (_owner, _repo, _index, body) => {
          commented = true;
          api.comments.push(body);
          return makeComment({ body });
        },
      });
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "";
        if (gitArgs[0] === "rev-list") return "0";
        return "";
      };
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => ({ status: "ok" }),
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "no-changes" });
      const claim = await readClaim(claimFilePath(home, "kirmanak", "demo", 12));
      expect(claim?.terminal).toBe(true);
      expect(claim?.issueUpdatedAt).toBe("2026-05-23T01:00:00Z");
    });
  });

  test("resumes an origin-only issue branch instead of defaultBranch", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const gitCalls: string[][] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "show-ref") {
          const ref = gitArgs.at(-1);
          if (ref === "refs/remotes/origin/jumi/issue-12-fix-the-thing") return "abc123";
          throw new Error("missing");
        }
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        return "";
      };
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => ({ status: "ok" }),
        logger: () => undefined,
      });
      expect(result.status).toBe("pr");
      expect(
        gitCalls.some(
          (args) =>
            args[0] === "worktree" &&
            args[1] === "add" &&
            args.includes("-B") &&
            args.includes("origin/jumi/issue-12-fix-the-thing")
        )
      ).toBe(true);
      expect(
        gitCalls.some(
          (args) => args[0] === "worktree" && args[1] === "add" && args.includes("origin/main") && args.includes("-B")
        )
      ).toBe(false);
    });
  });

  test("records a terminal claim when OpenCode fails", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi();
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        return "";
      };
      await expect(
        implementIssue({
          api,
          job: makeIssueJob(),
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
      const claim = await readClaim(claimFilePath(home, "kirmanak", "demo", 12));
      expect(claim?.pid).toBe(0);
      expect(claim?.terminal).toBe(true);
      expect(api.comments.at(-1)).toContain("Jumi failed");
    });
  });

  test("cancelIssueWork does not kill the parent pid", async () => {
    await withDirs(async (home) => {
      const killed: number[] = [];
      await cancelIssueWork({
        api: makeApi(),
        owner: "kirmanak",
        repo: "demo",
        issueNumber: 12,
        botUsername: "jumi",
        home,
        pidAlive: () => true,
        killPid: (pid) => {
          killed.push(pid);
        },
      });
      expect(killed).toEqual([]);
    });
  });

  test("uses JUMI_PR.md as the PR body and removes it before porcelain", async () => {
    await withDirs(async (home, workdir) => {
      const worktree = join(workdir, "kirmanak/demo/12");
      const api = makeApi();
      let statusSawPrFile = false;
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") {
          try {
            await access(join(worktree, "JUMI_PR.md"));
            statusSawPrFile = true;
            return "?? JUMI_PR.md";
          } catch {
            return " M src/demo.ts";
          }
        }
        return "";
      };
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => {
          await mkdir(worktree, { recursive: true });
          await writeFile(join(worktree, "JUMI_PR.md"), "Caches categories.");
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result.status).toBe("pr");
      expect(api.pulls[0]).toMatchObject({ body: "Caches categories.\n\nFixes #12" });
      expect(statusSawPrFile).toBe(false);
      await expect(access(join(worktree, "JUMI_PR.md"))).rejects.toThrow();
    });
  });

  test("does not duplicate Fixes #n when JUMI_PR.md already closes the issue", async () => {
    await withDirs(async (home, workdir) => {
      const worktree = join(workdir, "kirmanak/demo/12");
      const api = makeApi();
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        return "";
      };
      await implementIssue({
        api,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => {
          await mkdir(worktree, { recursive: true });
          await writeFile(join(worktree, "JUMI_PR.md"), "Caches categories.\n\nFixes #12");
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(api.pulls[0]).toMatchObject({ body: "Caches categories.\n\nFixes #12" });
    });
  });

  test("falls back to Fixes #n when JUMI_PR.md is empty", async () => {
    await withDirs(async (home, workdir) => {
      const worktree = join(workdir, "kirmanak/demo/12");
      const api = makeApi();
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        return "";
      };
      await implementIssue({
        api,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => {
          await mkdir(worktree, { recursive: true });
          await writeFile(join(worktree, "JUMI_PR.md"), "");
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(api.pulls[0]).toMatchObject({ body: "Fixes #12" });
    });
  });

  test("does not open a PR when only JUMI_PR.md was written", async () => {
    await withDirs(async (home, workdir) => {
      const worktree = join(workdir, "kirmanak/demo/12");
      const api = makeApi();
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") {
          try {
            await access(join(worktree, "JUMI_PR.md"));
            return "?? JUMI_PR.md";
          } catch {
            return "";
          }
        }
        if (gitArgs[0] === "rev-list") return "0";
        return "";
      };
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => {
          await mkdir(worktree, { recursive: true });
          await writeFile(join(worktree, "JUMI_PR.md"), "Caches categories.");
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "no-changes" });
      expect(api.pulls).toHaveLength(0);
    });
  });

  test("opens a PR from JUMI_PR.md when HEAD is already ahead with a clean tree", async () => {
    await withDirs(async (home, workdir) => {
      const worktree = join(workdir, "kirmanak/demo/12");
      const api = makeApi();
      const gitCalls: string[][] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return "";
        if (gitArgs[0] === "rev-list") return "1";
        return "";
      };
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => {
          await mkdir(worktree, { recursive: true });
          await writeFile(join(worktree, "JUMI_PR.md"), "Caches categories.");
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result.status).toBe("pr");
      expect(api.pulls[0]).toMatchObject({ body: "Caches categories.\n\nFixes #12" });
      expect(gitCalls.some((args) => args[0] === "commit")).toBe(false);
      expect(gitCalls.some((args) => args[0] === "push")).toBe(true);
    });
  });

  test("treats a JUMI_PR.md symlink as missing and does not follow it", async () => {
    await withDirs(async (home, workdir) => {
      const worktree = join(workdir, "kirmanak/demo/12");
      const api = makeApi();
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        return "";
      };
      await implementIssue({
        api,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => {
          await mkdir(worktree, { recursive: true });
          await writeFile(join(worktree, "secret.md"), "Should not appear.");
          await symlink(join(worktree, "secret.md"), join(worktree, "JUMI_PR.md"));
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(api.pulls[0]).toMatchObject({ body: "Fixes #12" });
    });
  });

  test("treats a JUMI_PR.md directory as missing without throwing", async () => {
    await withDirs(async (home, workdir) => {
      const worktree = join(workdir, "kirmanak/demo/12");
      const api = makeApi();
      let statusSawPrDir = false;
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") {
          try {
            await access(join(worktree, "JUMI_PR.md"));
            statusSawPrDir = true;
            return "?? JUMI_PR.md/";
          } catch {
            return " M src/demo.ts";
          }
        }
        return "";
      };
      await implementIssue({
        api,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => {
          await mkdir(join(worktree, "JUMI_PR.md"), { recursive: true });
          await writeFile(join(worktree, "JUMI_PR.md", "nested.md"), "Should not appear.");
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(api.pulls[0]).toMatchObject({ body: "Fixes #12" });
      expect(statusSawPrDir).toBe(false);
      await expect(access(join(worktree, "JUMI_PR.md"))).rejects.toThrow();
    });
  });

  test("does not open a PR when the issue is closed after OpenCode", async () => {
    await withDirs(async (home, workdir) => {
      let gets = 0;
      const api = makeApi({
        getIssue: async () => {
          gets++;
          return gets === 1 ? makeIssue() : makeIssue({ state: "closed" });
        },
      });
      const gitCalls: string[][] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        return "";
      };
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => ({ status: "ok" }),
        logger: () => undefined,
      });
      expect(result).toEqual({ status: "skipped", reason: "issue is closed" });
      expect(api.pulls).toHaveLength(0);
      expect(gitCalls.some((args) => args[0] === "push")).toBe(false);
      expect(gitCalls.some((args) => args[0] === "worktree" && args[1] === "remove")).toBe(false);
      expect(api.comments.at(-1)).toContain("Not opening a PR because the issue was closed.");
    });
  });

  test("re-runs OpenCode once when title or body changed after the first run", async () => {
    await withDirs(async (home, workdir) => {
      let gets = 0;
      const api = makeApi({
        getIssue: async () => {
          gets++;
          if (gets === 1) return makeIssue();
          return makeIssue({ title: "Rewritten title", body: "Do this instead." });
        },
      });
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        return "";
      };
      const tasks: string[] = [];
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => {
          tasks.push(await readFile(join(workdir, "kirmanak/demo/12/JUMI_TASK.md"), "utf8"));
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result.status).toBe("pr");
      expect(tasks).toHaveLength(2);
      expect(tasks[0]).toContain("Fix the thing");
      expect(tasks[1]).toContain("Rewritten title");
      expect(tasks[1]).toContain("Do this instead.");
      expect(api.pulls[0]).toMatchObject({ title: "Rewritten title" });
    });
  });

  test("continue OpenCode uses a no-push follow-up prompt instead of implement", async () => {
    await withDirs(async (home, workdir) => {
      let gets = 0;
      const kinds: string[] = [];
      const api = makeApi({
        getIssue: async () => {
          gets++;
          if (gets === 1) return makeIssue();
          return makeIssue({ title: "Rewritten title", body: "Do this instead." });
        },
      });
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        return "";
      };
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async (opts) => {
          kinds.push(opts.trace?.kind ?? "");
          expect("prompt" in opts).toBe(false);
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result.status).toBe("pr");
      expect(kinds).toEqual(["implement", "follow-up"]);
    });
  });

  test("does not treat updated_at churn as a rewrite", async () => {
    await withDirs(async (home, workdir) => {
      const api = makeApi({
        getIssue: async () => makeIssue({ updated_at: "2026-06-01T00:00:00Z" }),
      });
      let openCode = 0;
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        return "";
      };
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
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
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result.status).toBe("pr");
      expect(openCode).toBe(1);
      expect(api.pulls).toHaveLength(1);
    });
  });

  test("skips shipping when re-GET fails after OpenCode", async () => {
    await withDirs(async (home, workdir) => {
      let gets = 0;
      const api = makeApi({
        getIssue: async () => {
          gets++;
          if (gets === 1) return makeIssue();
          throw new Error("gitea 502");
        },
      });
      const gitCalls: string[][] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        return "";
      };
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        openCodeRunner: async () => ({ status: "ok" }),
        logger: () => undefined,
      });
      expect(result.status).toBe("skipped");
      if (result.status === "skipped") expect(result.reason).toContain("failed to re-check issue");
      expect(api.pulls).toHaveLength(0);
      expect(gitCalls.some((args) => args[0] === "push")).toBe(false);
      expect(api.comments.at(-1)).toContain("failed to re-check issue");
    });
  });

  test("does not open a PR on the old text when continue OpenCode fails", async () => {
    await withDirs(async (home, workdir) => {
      let gets = 0;
      const api = makeApi({
        getIssue: async () => {
          gets++;
          if (gets === 1) return makeIssue();
          return makeIssue({ title: "Rewritten title" });
        },
      });
      let openCode = 0;
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        return "";
      };
      await expect(
        implementIssue({
          api,
          job: makeIssueJob(),
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
            if (openCode === 2) return { status: "exit", exitCode: 1, message: "opencode exited with code 1" };
            return { status: "ok" };
          },
          logger: () => undefined,
        })
      ).rejects.toThrow("opencode exited with code 1");
      expect(openCode).toBe(2);
      expect(api.pulls).toHaveLength(0);
      expect(api.comments.at(-1)).toContain("Jumi failed:");
    });
  });

  test("does not loop OpenCode when the issue keeps changing", async () => {
    await withDirs(async (home, workdir) => {
      let gets = 0;
      const api = makeApi({
        getIssue: async () => {
          gets++;
          if (gets === 1) return makeIssue();
          return makeIssue({ title: `Edit ${gets}` });
        },
      });
      let openCode = 0;
      const gitCalls: string[][] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        return "";
      };
      const result = await implementIssue({
        api,
        job: makeIssueJob(),
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
          return { status: "ok" };
        },
        logger: () => undefined,
      });
      expect(result).toEqual({
        status: "skipped",
        reason: "issue title or body changed again after a continue round",
      });
      expect(openCode).toBe(2);
      expect(api.pulls).toHaveLength(0);
      expect(gitCalls.some((args) => args[0] === "push")).toBe(false);
    });
  });

  test("runs OpenCode without GITEA_BOT_TOKEN in the child environment", async () => {
    process.env.GITEA_BOT_TOKEN = "secret-token";
    await withDirs(async (home, workdir) => {
      const dir = await mkdtemp(join(tmpdir(), "fake-opencode-"));
      const secretFile = join(dir, "secret.txt");
      try {
        await writeFile(
          join(dir, "opencode"),
          `#!/bin/sh
printf '%s' "$GITEA_BOT_TOKEN" > '${secretFile}'
`
        );
        await chmod(join(dir, "opencode"), 0o755);
        process.env.PATH = `${dir}:${originalPath ?? ""}`;
        const api = makeApi();
        const gitRunner: GitRunner = async (args) => {
          const gitArgs = stripGitConfigArgs(args);
          if (gitArgs[0] === "rev-parse") return "abc123";
          if (gitArgs[0] === "status") return "";
          return "";
        };
        await implementIssue({
          api,
          job: makeIssueJob(),
          giteaUrl: "https://gitea.kirmanak.stream",
          giteaToken: "secret-token",
          botUsername: "jumi",
          model: "openai/gpt-5.5",
          home,
          workdir,
          heartbeatIntervalMs: 0,
          gitRunner,
          logger: () => undefined,
        });
        expect(await readFile(secretFile, "utf8")).toBe("");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
