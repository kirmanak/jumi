import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkoutPullRequestWorkspace,
  createReviewWorkspace,
  GITHUB_GIT_USERNAME,
  type GitRunner,
  redactGitSecrets,
  validateCloneUrl,
  workerOpenCodeChildEnv,
} from "../src/workspace.ts";
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

function stripGitConfigArgs(args: string[]): string[] {
  const result = [...args];
  while (result[0] === "-c") result.splice(0, 2);
  return result;
}

function gitConfigValues(args: string[], key: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] !== "-c") continue;
    const config = args[index + 1];
    const prefix = `${key}=`;
    if (config.startsWith(prefix)) values.push(config.slice(prefix.length));
    index += 1;
  }
  return values;
}

describe("clone URL origin allowlist", () => {
  test("accepts github.com when forge URL is github.com and rejects a Gitea clone URL", () => {
    expect(validateCloneUrl("https://github.com/kirmanak/jumi.git", "https://github.com")).toBe(
      "https://github.com/kirmanak/jumi.git"
    );
    expect(() => validateCloneUrl("https://gitea.kirmanak.stream/kirmanak/jumi.git", "https://github.com")).toThrow(
      "Clone URL origin does not match configured forge URL"
    );
  });

  test("accepts Gitea when forge URL is Gitea and rejects github.com", () => {
    expect(validateCloneUrl("https://gitea.kirmanak.stream/kirmanak/jumi.git", "https://gitea.kirmanak.stream")).toBe(
      "https://gitea.kirmanak.stream/kirmanak/jumi.git"
    );
    expect(() => validateCloneUrl("https://github.com/kirmanak/jumi.git", "https://gitea.kirmanak.stream")).toThrow(
      "Clone URL origin does not match configured forge URL"
    );
  });
});

describe("redactGitSecrets", () => {
  test("redacts URL passwords and explicit tokens", () => {
    expect(redactGitSecrets("https://x-access-token:ghs_secret@github.com/kirmanak/jumi.git", ["ghs_secret"])).toBe(
      "https://x-access-token:***@github.com/kirmanak/jumi.git"
    );
    expect(redactGitSecrets("token=ghs_secret in stderr", ["ghs_secret"])).toBe("token=*** in stderr");
  });
});

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
      const gitArgs = stripGitConfigArgs(args);
      calls.push({ args, cwd: opts.cwd, env: opts.env });
      if (gitArgs[0] === "rev-parse" && gitArgs[1] === "HEAD") return "a".repeat(40);
      if (gitArgs[0] === "rev-parse" && gitArgs[1] === "jumi/target") return "b".repeat(40);
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

    expect(calls.map((call) => stripGitConfigArgs(call.args))).toEqual([
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
    expect(calls[0].env.GIT_AUTHOR_NAME).toBe("jumi");
    expect(calls[0].env.GIT_AUTHOR_EMAIL).toBe("jumi@kirmanak.stream");
    expect(calls[0].env.GIT_COMMITTER_NAME).toBe("jumi");
    expect(calls[0].env.GIT_COMMITTER_EMAIL).toBe("jumi@kirmanak.stream");
    expect(calls[0].env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(calls[0].env.GIT_AUTH_USERNAME).toBe("jumi");
    expect(calls[0].env.GIT_AUTH_TOKEN).toBe("bot-token");
    expect(calls[0].env.GIT_AUTH_HOST).toBe("gitea.kirmanak.stream");
    expect(gitConfigValues(calls[0].args, "core.hooksPath")).toEqual(["/dev/null"]);
    expect(gitConfigValues(calls[0].args, "core.symlinks")).toEqual(["false"]);
    expect(gitConfigValues(calls[0].args, "credential.helper")).toContain("");
    expect(
      gitConfigValues(calls[0].args, "credential.helper").some((helper) => helper.includes("GIT_AUTH_TOKEN"))
    ).toBe(true);
    expect(gitConfigValues(calls[0].args, "credential.helper").join("\n")).not.toContain("bot-token");
    expect(JSON.stringify(calls.map((call) => call.args))).not.toContain("bot-token");
  });

  test("falls back to the source repository when the base repository lacks the PR ref", async () => {
    const { repo, pr } = makeCheckoutFixture();
    const calls: string[][] = [];
    const gitRunner: GitRunner = async (args) => {
      const gitArgs = stripGitConfigArgs(args);
      calls.push(args);
      if (gitArgs[0] === "fetch" && gitArgs[1] === "origin" && gitArgs[2].startsWith("+refs/pull/")) {
        throw new Error("missing pull ref");
      }
      if (gitArgs[0] === "rev-parse" && gitArgs[1] === "HEAD") return "a".repeat(40);
      if (gitArgs[0] === "rev-parse" && gitArgs[1] === "jumi/target") return "b".repeat(40);
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

    expect(calls.map(stripGitConfigArgs)).toContainEqual([
      "remote",
      "add",
      "pr-head",
      "https://gitea.kirmanak.stream/personal/housing_app.git",
    ]);
    expect(calls.map(stripGitConfigArgs)).toContainEqual([
      "fetch",
      "pr-head",
      "+refs/heads/feature/release:refs/remotes/pr-head/feature/release",
    ]);
    expect(calls.map(stripGitConfigArgs)).toContainEqual(["checkout", "--force", "-B", "jumi/pr-48", "a".repeat(40)]);
    expect(stripGitConfigArgs(calls.at(-2) ?? [])).toEqual(["rev-parse", "HEAD"]);
    expect(stripGitConfigArgs(calls.at(-1) ?? [])).toEqual(["rev-parse", "jumi/target"]);
  });

  test("clones GitHub with x-access-token URL and does not log the token", async () => {
    const repo = makeRepo({
      full_name: "kirmanak/jumi",
      clone_url: "https://github.com/kirmanak/jumi.git",
    });
    const pr = makePR({
      number: 48,
      head: makeBranch({ ref: "feature/release", sha: "a".repeat(40), repo }),
      base: makeBranch({ ref: "main", sha: "b".repeat(40), repo }),
    });
    const logs: string[] = [];
    const calls: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
    const gitRunner: GitRunner = async (args, opts) => {
      const gitArgs = stripGitConfigArgs(args);
      calls.push({ args, env: opts.env });
      if (gitArgs[0] === "rev-parse" && gitArgs[1] === "HEAD") return "a".repeat(40);
      if (gitArgs[0] === "rev-parse" && gitArgs[1] === "jumi/target") return "b".repeat(40);
      return "";
    };

    await checkoutPullRequestWorkspace({
      workdir: "/work/review-48",
      repo,
      pr,
      giteaUrl: "https://github.com",
      username: GITHUB_GIT_USERNAME,
      token: "ghs_install",
      embedTokenInUrl: true,
      authorName: "kirmanak-jumi[bot]",
      authorEmail: "123+kirmanak-jumi[bot]@users.noreply.github.com",
      gitRunner,
      logger: (message) => logs.push(message),
    });

    expect(stripGitConfigArgs(calls[0].args)).toEqual([
      "clone",
      "https://x-access-token:ghs_install@github.com/kirmanak/jumi.git",
      "/work/review-48",
    ]);
    expect(stripGitConfigArgs(calls[1].args)).toEqual([
      "remote",
      "set-url",
      "origin",
      "https://github.com/kirmanak/jumi.git",
    ]);
    expect(calls[0].env.GIT_AUTH_USERNAME).toBe("x-access-token");
    expect(calls[0].env.GIT_AUTH_TOKEN).toBe("ghs_install");
    expect(calls[0].env.GIT_AUTHOR_NAME).toBe("kirmanak-jumi[bot]");
    expect(calls[0].env.GIT_AUTHOR_EMAIL).toBe("123+kirmanak-jumi[bot]@users.noreply.github.com");
    expect(calls[0].env.GIT_COMMITTER_NAME).toBe("kirmanak-jumi[bot]");
    expect(calls[0].env.GIT_COMMITTER_EMAIL).toBe("123+kirmanak-jumi[bot]@users.noreply.github.com");
    expect(logs.join("\n")).not.toContain("ghs_install");
  });
});

describe("workerOpenCodeChildEnv", () => {
  const auth = {
    giteaUrl: "https://gitea.kirmanak.stream",
    username: "jumi",
    token: "bot-token",
  };

  test("passes git auth plus JDK/Gradle env under /work, not HOME", () => {
    const originalJavaHome = process.env.JAVA_HOME;
    const originalWorkdir = process.env.WORKDIR;
    delete process.env.JAVA_HOME;
    delete process.env.WORKDIR;
    try {
      const env = workerOpenCodeChildEnv(auth, "/work/kirmanak/demo/12");
      expect(env.GIT_AUTH_TOKEN).toBe("bot-token");
      expect(env.JAVA_HOME).toBe("/opt/java/openjdk");
      expect(env.PATH.startsWith("/opt/java/openjdk/bin:")).toBe(true);
      expect(env.JAVA_TOOL_OPTIONS).toBe("-Djava.io.tmpdir=/work/kirmanak/demo/12/.jumi-tmp");
      expect(env.GRADLE_USER_HOME).toBe("/work/.gradle");
      expect(env.GRADLE_OPTS).toBe("-Dorg.gradle.daemon=false");
      expect(env.HOME).toBeUndefined();
    } finally {
      if (originalJavaHome === undefined) delete process.env.JAVA_HOME;
      else process.env.JAVA_HOME = originalJavaHome;
      if (originalWorkdir === undefined) delete process.env.WORKDIR;
      else process.env.WORKDIR = originalWorkdir;
    }
  });

  test("forwards image JAVA_HOME and WORKDIR", () => {
    const originalJavaHome = process.env.JAVA_HOME;
    const originalWorkdir = process.env.WORKDIR;
    process.env.JAVA_HOME = "/opt/custom-jdk";
    process.env.WORKDIR = "/work";
    try {
      const env = workerOpenCodeChildEnv(auth, "/work/owner/repo/1");
      expect(env.JAVA_HOME).toBe("/opt/custom-jdk");
      expect(env.PATH.startsWith("/opt/custom-jdk/bin:")).toBe(true);
      expect(env.GRADLE_USER_HOME).toBe("/work/.gradle");
    } finally {
      if (originalJavaHome === undefined) delete process.env.JAVA_HOME;
      else process.env.JAVA_HOME = originalJavaHome;
      if (originalWorkdir === undefined) delete process.env.WORKDIR;
      else process.env.WORKDIR = originalWorkdir;
    }
  });
});
