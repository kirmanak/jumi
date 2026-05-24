import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutPullRequestWorkspace, createReviewWorkspace, type GitRunner } from "../src/workspace.ts";
import { makeBranch, makeJob, makePR, makeRepo } from "./fixtures.ts";

function makeCheckoutFixture() {
  const repo = makeRepo({
    full_name: "personal/housing_app",
    clone_url: "https://gitea.kirmanak.stream/personal/housing_app.git",
  });
  const pr = makePR({
    number: 48,
    head: makeBranch({ ref: "feature/release", sha: "a".repeat(40), repo }),
    base: makeBranch({ ref: "main", sha: "b".repeat(40), repo }),
  });
  return { repo, pr };
}

describe("review workspace", () => {
  test("creates a unique empty workspace under the configured root", async () => {
    const root = await mkdtemp(join(tmpdir(), "jumi-workspace-test-"));
    try {
      const workspace = await createReviewWorkspace(
        root,
        makeJob({ owner: "personal", repo: "housing_app", prNumber: 48 })
      );
      expect(workspace.startsWith(join(root, "jumi-personal-housing_app-48-"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("clones the base repository, fetches target and PR refs, and checks out PR head", async () => {
    const { repo, pr } = makeCheckoutFixture();
    const calls: Array<{ args: string[]; cwd: string; env: Record<string, string | undefined> }> = [];
    const gitRunner: GitRunner = async (args, opts) => {
      calls.push({ args, cwd: opts.cwd, env: opts.env });
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "a".repeat(40);
      if (args[0] === "rev-parse" && args[1] === "jumi/target") return "b".repeat(40);
      return "";
    };

    await checkoutPullRequestWorkspace({
      workdir: "/work/review-48",
      repo,
      pr,
      giteaUrl: "https://gitea.kirmanak.stream",
      username: "jumi",
      token: "bot-token",
      gitRunner,
    });

    expect(calls.map((call) => call.args)).toEqual([
      ["clone", "https://gitea.kirmanak.stream/personal/housing_app.git", "/work/review-48"],
      ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"],
      ["branch", "--force", "jumi/target", "b".repeat(40)],
      ["fetch", "origin", "+refs/pull/48/head:refs/remotes/origin/pr/48/head"],
      ["checkout", "--force", "-B", "jumi/pr-48", "a".repeat(40)],
      ["rev-parse", "HEAD"],
      ["rev-parse", "jumi/target"],
    ]);
    expect(calls[0].cwd).toBe("/work");
    expect(calls[0].env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(calls[0].env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(calls[0].env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(calls[0].env.GIT_LFS_SKIP_SMUDGE).toBe("1");
    expect(calls[0].env.GIT_CONFIG_KEY_0).toBe("http.https://gitea.kirmanak.stream/.extraheader");
    expect(calls[0].env.GIT_CONFIG_VALUE_0?.startsWith("Authorization: Basic ")).toBe(true);
    expect(JSON.stringify(calls.map((call) => call.args))).not.toContain("bot-token");
  });

  test("falls back to the source repository when the base repository lacks the PR ref", async () => {
    const { repo, pr } = makeCheckoutFixture();
    const calls: string[][] = [];
    const gitRunner: GitRunner = async (args) => {
      calls.push(args);
      if (args[0] === "fetch" && args[1] === "origin" && args[2].startsWith("+refs/pull/")) {
        throw new Error("missing pull ref");
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "a".repeat(40);
      if (args[0] === "rev-parse" && args[1] === "jumi/target") return "b".repeat(40);
      return "";
    };

    await checkoutPullRequestWorkspace({
      workdir: "/work/review-48",
      repo,
      pr,
      giteaUrl: "https://gitea.kirmanak.stream",
      username: "jumi",
      token: "bot-token",
      gitRunner,
    });

    expect(calls).toContainEqual([
      "remote",
      "add",
      "pr-head",
      "https://gitea.kirmanak.stream/personal/housing_app.git",
    ]);
    expect(calls).toContainEqual([
      "fetch",
      "pr-head",
      "+refs/heads/feature/release:refs/remotes/pr-head/feature/release",
    ]);
    expect(calls).toContainEqual(["checkout", "--force", "-B", "jumi/pr-48", "a".repeat(40)]);
    expect(calls.at(-2)).toEqual(["rev-parse", "HEAD"]);
    expect(calls.at(-1)).toEqual(["rev-parse", "jumi/target"]);
  });
});
