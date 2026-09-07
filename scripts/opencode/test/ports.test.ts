import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GiteaAPI } from "../src/api.ts";
import type { Engine } from "../src/engine.ts";
import { resolveEngine } from "../src/engine.ts";
import type { Forge } from "../src/forge.ts";
import { createGiteaForge, FORGE_COMMITTER_EMAIL, FORGE_COMMITTER_NAME } from "../src/forge.ts";
import { openCodeEngine, runOpenCode } from "../src/git.ts";
import { workerMarker } from "../src/gitea_issues.ts";
import { implementIssue } from "../src/implement.ts";
import { reviewPullRequest } from "../src/review.ts";
import type { GitRunner } from "../src/workspace.ts";
import { makeBranch, makeComment, makeFile, makeIssue, makeIssueJob, makePR, makeRepo } from "./fixtures.ts";

function lastNonEmptyLine(text: string): string {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return "";
}

function stripGitConfigArgs(args: string[]): string[] {
  const result = [...args];
  while (result[0] === "-c") result.splice(0, 2);
  return result;
}

function makeFakeForge(overrides: Partial<Forge> = {}): Forge & {
  comments: string[];
  pulls: Array<{ title: string; body: string; head: string; base: string }>;
  statuses: Array<{ sha: string; state: string; context?: string; description?: string }>;
} {
  const comments: string[] = [];
  const pulls: Array<{ title: string; body: string; head: string; base: string }> = [];
  const statuses: Array<{ sha: string; state: string; context?: string; description?: string }> = [];
  const defaults: Forge = {
    getRepo: async () => makeRepo(),
    getPR: async () => makePR(),
    getPRFiles: async () => [makeFile()],
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
    listIssueComments: async () => [],
    listPullReviewComments: async () => [],
    listPullReviews: async () => [],
    createCommitStatus: async (_owner, _repo, sha, status) => {
      statuses.push({ sha, state: status.state, context: status.context, description: status.description });
      return status;
    },
  };
  return { ...defaults, ...overrides, comments, pulls, statuses };
}

async function withDirs(run: (home: string, workdir: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "jumi-ports-home-"));
  const workdir = await mkdtemp(join(tmpdir(), "jumi-ports-work-"));
  try {
    await run(home, workdir);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
  }
}

describe("Engine and Forge ports", () => {
  test("OpenCode is the Engine impl and Gitea is the Forge impl", () => {
    expect(openCodeEngine).toBe(runOpenCode);
    const forge = createGiteaForge("https://gitea.example.test", "token-1");
    expect(forge).toBeInstanceOf(GiteaAPI);
    expect(FORGE_COMMITTER_NAME).toBe("jumi");
    expect(FORGE_COMMITTER_EMAIL).toBe("jumi@kirmanak.stream");
  });

  test("resolveEngine prefers engine over openCodeRunner", async () => {
    const engine: Engine = async () => "engine";
    const openCodeRunner: Engine = async () => "opencode";
    const fallback: Engine = async () => "fallback";
    expect(await resolveEngine({ engine, openCodeRunner }, fallback)("p", { model: "m", workdir: "/" })).toBe("engine");
    expect(await resolveEngine({ openCodeRunner }, fallback)("p", { model: "m", workdir: "/" })).toBe("opencode");
    expect(await resolveEngine({}, fallback)("p", { model: "m", workdir: "/" })).toBe("fallback");
  });

  test("implement produces a PR via the parent with a fake engine and fake forge", async () => {
    await withDirs(async (home, workdir) => {
      const forge = makeFakeForge();
      const worktree = join(workdir, "kirmanak/demo/12");
      const gitCalls: string[][] = [];
      const gitRunner: GitRunner = async (args) => {
        const gitArgs = stripGitConfigArgs(args);
        gitCalls.push(gitArgs);
        if (gitArgs[0] === "rev-parse") return "abc123";
        if (gitArgs[0] === "status") return " M src/demo.ts";
        return "";
      };
      let engineOpts: Parameters<Engine>[1] | undefined;
      const engine: Engine = async (_prompt, opts) => {
        engineOpts = opts;
        const task = await readFile(join(worktree, "JUMI_TASK.md"), "utf8");
        expect(task).toContain("Fix the thing");
        await mkdir(worktree, { recursive: true });
        await writeFile(join(worktree, "JUMI_PR.md"), "Caches categories.");
        return "I'll inspect the issue and open a PR myself…";
      };

      const result = await implementIssue({
        api: forge,
        engine,
        job: makeIssueJob(),
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        model: "openai/gpt-5.5",
        home,
        workdir,
        heartbeatIntervalMs: 0,
        gitRunner,
        logger: () => undefined,
      });

      expect(result).toEqual({
        status: "pr",
        htmlUrl: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/3",
        prNumber: 3,
      });
      expect(forge.pulls).toEqual([
        {
          title: "Fix the thing",
          body: "Caches categories.\n\nFixes #12",
          head: "jumi/issue-12-fix-the-thing",
          base: "main",
        },
      ]);
      expect(forge.comments.at(-1)).toContain("Opened https://gitea.kirmanak.stream/kirmanak/demo/pulls/3");
      expect(forge.comments.at(-1)).toContain(workerMarker("kirmanak", "demo", 12));
      expect(gitCalls.some((args) => args[0] === "push" && args.includes("--force"))).toBe(false);
      expect(gitCalls.some((args) => args[0] === "push")).toBe(true);
      expect(gitCalls.some((args) => args[0] === "commit")).toBe(true);
      expect(engineOpts?.sanitizeEnv).toBe(true);
      expect(engineOpts?.extraEnv?.GITEA_BOT_TOKEN).toBeUndefined();
      expect(engineOpts?.extraEnv?.GIT_AUTH_TOKEN).toBe("bot-token");
      expect(engineOpts?.extraEnv?.GIT_COMMITTER_EMAIL).toBe(FORGE_COMMITTER_EMAIL);
    });
  });

  test("review publishes sticky+trailer+status from the artifact, not engine stdout", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "jumi-ports-review-"));
    try {
      const sha = "d90b7289701097dae3ffa3dc0ccdc348be552697";
      const forge = makeFakeForge({
        getPR: async () => makePR({ head: makeBranch({ sha }) }),
      });
      const gitRunner: GitRunner = async (args) => {
        if (args[0] === "rev-parse") return sha;
        if (args[0] === "status") return "?? JUMI_REVIEW.md";
        throw new Error(`unexpected git ${args.join(" ")}`);
      };
      const engine: Engine = async () => {
        await writeFile(join(workspace, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
        return "I'll inspect the Valkey bump…";
      };

      const result = await reviewPullRequest({
        api: forge,
        engine,
        owner: "kirmanak",
        repo: "demo",
        prNumber: 7,
        expectedHeadSha: sha,
        model: "openai/gpt-5.5",
        workspace,
        giteaUrl: "https://gitea.kirmanak.stream",
        giteaToken: "bot-token",
        botUsername: "jumi",
        workspacePreparer: async () => undefined,
        gitRunner,
        logger: () => undefined,
      });

      expect(result.status).toBe("posted");
      expect(forge.comments).toHaveLength(1);
      expect(forge.comments[0]).toContain("<!-- jumi-review:kirmanak/demo#7 -->");
      expect(forge.comments[0]).toContain("Looks good");
      expect(forge.comments[0]).not.toContain("I'll inspect");
      expect(lastNonEmptyLine(forge.comments[0])).toBe("<!-- jumi-check: success -->");
      expect(forge.statuses.map((status) => ({ state: status.state, context: status.context }))).toEqual([
        { state: "pending", context: "jumi/opencode-review" },
        { state: "success", context: "jumi/opencode-review" },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
