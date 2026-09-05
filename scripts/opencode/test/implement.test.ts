import { afterEach, describe, expect, test } from "bun:test";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimFilePath, readClaim } from "../src/claim.ts";
import type { OpenCodeRunOptions } from "../src/git.ts";
import type { IssueApi } from "../src/gitea_issues.ts";
import { workerMarker } from "../src/gitea_issues.ts";
import { cancelIssueWork, implementIssue } from "../src/implement.ts";
import type { GitRunner } from "../src/workspace.ts";
import { makeComment, makeIssue, makeIssueJob, makePR, makeRepo } from "./fixtures.ts";

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
    getIssue: async () => makeIssue(),
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
    searchAssignedIssues: async () => [],
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
        openCodeRunner: async (_prompt, opts) => {
          openCodeOpts = opts;
          const task = await readFile(join(workdir, "kirmanak/demo/12/JUMI_TASK.md"), "utf8");
          expect(task).toContain("Fix the thing");
          expect(task).toContain("Please implement this.");
          return "done";
        },
        logger: () => undefined,
      });

      expect(result).toEqual({ status: "no-changes" });
      expect(api.pulls).toHaveLength(0);
      expect(api.comments.at(-1)).toContain("no changes");
      expect(api.comments.at(-1)).toContain(workerMarker("kirmanak", "demo", 12));
      expect(openCodeOpts?.sanitizeEnv).toBe(true);
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
        openCodeRunner: async () => "done",
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
        openCodeRunner: async () => "done",
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
        openCodeRunner: async () => "done",
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
          return "done";
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
          return "done";
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
        openCodeRunner: async () => "done",
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
        openCodeRunner: async () => "done",
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
