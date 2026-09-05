import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimFilePath, writeClaim } from "../src/claim.ts";
import type { IssueApi } from "../src/gitea_issues.ts";
import { scanAssignedIssues } from "../src/scan.ts";
import { makeComment, makeIssue, makePR, makeRepo, makeUser } from "./fixtures.ts";

function makeApi(overrides: Partial<IssueApi> = {}): IssueApi {
  const defaults: IssueApi = {
    getRepo: async () => repo,
    getIssue: async () => makeIssue(),
    listOpenPulls: async () => [],
    createPullRequest: async (_owner, _repo, pull) => makePR({ title: pull.title, body: pull.body }),
    searchAssignedIssues: async () => [],
    findStickyIssueComment: async () => undefined,
    createIssueComment: async (_owner, _repo, _index, body) => makeComment({ body }),
    updateIssueComment: async (_owner, _repo, _id, body) => makeComment({ body }),
  };
  return { ...defaults, ...overrides };
}

const policy = {
  giteaUrl: "https://gitea.kirmanak.stream",
  allowedOrgs: ["kirmanak"],
  allowedRepos: [],
};

const repo = makeRepo();

describe("scanAssignedIssues", () => {
  test("enqueues assigned issues without a live claim", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-scan-"));
    try {
      const jobs = await scanAssignedIssues({
        api: makeApi({
          searchAssignedIssues: async () => [makeIssue({ repository: repo })],
        }),
        home,
        botUsername: "jumi",
        policy,
        logger: () => undefined,
      });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.issueNumber).toBe(12);
      expect(jobs[0]?.action).toBe("scan");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("reclaims when the claim pid is dead", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-scan-"));
    try {
      await writeClaim(claimFilePath(home, "kirmanak", "demo", 12), {
        pid: 999999,
        startedAt: "2026-05-23T00:00:00Z",
        heartbeatAt: new Date().toISOString(),
        worktree: "/work/kirmanak/demo/12",
        branch: "jumi/issue-12-fix-the-thing",
        issueUpdatedAt: "2026-05-23T00:00:00Z",
        headShaAtStart: "abc",
      });
      const jobs = await scanAssignedIssues({
        api: makeApi({
          searchAssignedIssues: async () => [makeIssue({ repository: repo })],
        }),
        home,
        botUsername: "jumi",
        policy,
        pidAlive: () => false,
        logger: () => undefined,
      });
      expect(jobs).toHaveLength(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("reclaims when heartbeat is stale", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-scan-"));
    try {
      await writeClaim(claimFilePath(home, "kirmanak", "demo", 12), {
        pid: 42,
        startedAt: "2026-05-23T00:00:00Z",
        heartbeatAt: "2026-05-23T00:00:00Z",
        worktree: "/work/kirmanak/demo/12",
        branch: "jumi/issue-12-fix-the-thing",
        issueUpdatedAt: "2026-05-23T00:00:00Z",
        headShaAtStart: "abc",
      });
      const jobs = await scanAssignedIssues({
        api: makeApi({
          searchAssignedIssues: async () => [makeIssue({ repository: repo })],
        }),
        home,
        botUsername: "jumi",
        policy,
        nowMs: Date.parse("2026-05-23T00:05:00Z"),
        pidAlive: () => true,
        logger: () => undefined,
      });
      expect(jobs).toHaveLength(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("skips live claims", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-scan-"));
    try {
      await writeClaim(claimFilePath(home, "kirmanak", "demo", 12), {
        pid: 42,
        startedAt: "2026-05-23T00:00:00Z",
        heartbeatAt: new Date().toISOString(),
        worktree: "/work/kirmanak/demo/12",
        branch: "jumi/issue-12-fix-the-thing",
        issueUpdatedAt: "2026-05-23T00:00:00Z",
        headShaAtStart: "abc",
      });
      const jobs = await scanAssignedIssues({
        api: makeApi({
          searchAssignedIssues: async () => [makeIssue({ repository: repo })],
        }),
        home,
        botUsername: "jumi",
        policy,
        pidAlive: () => true,
        logger: () => undefined,
      });
      expect(jobs).toHaveLength(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("skips when an open PR already closes the issue", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-scan-"));
    try {
      const jobs = await scanAssignedIssues({
        api: makeApi({
          searchAssignedIssues: async () => [makeIssue({ repository: repo })],
          listOpenPulls: async () => [makePR({ title: "Fix", body: "Closes #12", user: makeUser({ login: "alice" }) })],
        }),
        home,
        botUsername: "jumi",
        policy,
        logger: () => undefined,
      });
      expect(jobs).toHaveLength(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("resolves Gitea issue-search RepositoryMeta via getRepo", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-scan-"));
    try {
      let fetched: string | undefined;
      const jobs = await scanAssignedIssues({
        api: makeApi({
          searchAssignedIssues: async () => [
            makeIssue({
              repository: { id: 10, name: "demo", owner: "kirmanak", full_name: "kirmanak/demo" },
            }),
          ],
          getRepo: async (owner, name) => {
            fetched = `${owner}/${name}`;
            return repo;
          },
        }),
        home,
        botUsername: "jumi",
        policy,
        logger: () => undefined,
      });
      expect(fetched).toBe("kirmanak/demo");
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.cloneUrl).toBe(repo.clone_url);
      expect(jobs[0]?.defaultBranch).toBe("main");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("skips terminal claims but resumes pid 0 setup crashes", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-scan-"));
    try {
      const base = {
        pid: 0,
        startedAt: "2026-05-23T00:00:00Z",
        heartbeatAt: "2026-05-23T00:00:00Z",
        worktree: "/work/kirmanak/demo/12",
        branch: "jumi/issue-12-fix-the-thing",
        issueUpdatedAt: "2026-05-23T00:00:00Z",
        headShaAtStart: "abc",
      };
      await writeClaim(claimFilePath(home, "kirmanak", "demo", 12), { ...base, terminal: true });
      const skipped = await scanAssignedIssues({
        api: makeApi({ searchAssignedIssues: async () => [makeIssue({ repository: repo })] }),
        home,
        botUsername: "jumi",
        policy,
        logger: () => undefined,
      });
      expect(skipped).toHaveLength(0);

      await writeClaim(claimFilePath(home, "kirmanak", "demo", 12), { ...base, terminal: false });
      const resumed = await scanAssignedIssues({
        api: makeApi({ searchAssignedIssues: async () => [makeIssue({ repository: repo })] }),
        home,
        botUsername: "jumi",
        policy,
        pidAlive: () => false,
        logger: () => undefined,
      });
      expect(resumed).toHaveLength(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("skips pull request issues", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-scan-"));
    try {
      const jobs = await scanAssignedIssues({
        api: makeApi({
          searchAssignedIssues: async () => [makeIssue({ repository: repo, pull_request: { merged_at: null } })],
        }),
        home,
        botUsername: "jumi",
        policy,
        logger: () => undefined,
      });
      expect(jobs).toHaveLength(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
