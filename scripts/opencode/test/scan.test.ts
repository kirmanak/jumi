import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimFilePath, followUpStatePath, writeClaim } from "../src/claim.ts";
import { writeFollowUpState } from "../src/followup.ts";
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
    listIssueComments: async () => [],
    listPullReviewComments: async () => [],
    listPullReviews: async () => [],
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

  test("closing jumi PR + new human PR comment enqueues follow-up", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-scan-"));
    try {
      const jobs = await scanAssignedIssues({
        api: makeApi({
          searchAssignedIssues: async () => [makeIssue({ repository: repo })],
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
          listIssueComments: async () => [
            makeComment({ id: 55, body: "please fix the tests", user: makeUser({ login: "alice" }) }),
          ],
        }),
        home,
        botUsername: "jumi",
        policy,
        logger: () => undefined,
      });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.mode).toBe("follow-up");
      expect(jobs[0]?.prNumber).toBe(127);
      expect(jobs[0]?.action).toBe("scan");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("closing jumi PR + no new comments still skips", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-scan-"));
    try {
      const jobs = await scanAssignedIssues({
        api: makeApi({
          searchAssignedIssues: async () => [makeIssue({ repository: repo })],
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

  test("closing non-jumi PR does not follow-up; first-run remains skipped", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-scan-"));
    try {
      const jobs = await scanAssignedIssues({
        api: makeApi({
          searchAssignedIssues: async () => [makeIssue({ repository: repo })],
          listOpenPulls: async () => [makePR({ title: "Fix", body: "Closes #12", user: makeUser({ login: "alice" }) })],
          listIssueComments: async () => [
            makeComment({ id: 55, body: "please fix", user: makeUser({ login: "alice" }) }),
          ],
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

  test("terminal first-run claim + jumi PR + new comment still enqueues follow-up", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-scan-"));
    try {
      await writeClaim(claimFilePath(home, "kirmanak", "demo", 12), {
        pid: 0,
        startedAt: "2026-05-23T00:00:00Z",
        heartbeatAt: "2026-05-23T00:00:00Z",
        worktree: "/work/kirmanak/demo/12",
        branch: "jumi/issue-12-fix-the-thing",
        issueUpdatedAt: "2026-05-23T00:00:00Z",
        headShaAtStart: "abc",
        terminal: true,
      });
      const jobs = await scanAssignedIssues({
        api: makeApi({
          searchAssignedIssues: async () => [makeIssue({ repository: repo })],
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
          listIssueComments: async () => [makeComment({ id: 88, body: "nits", user: makeUser({ login: "alice" }) })],
        }),
        home,
        botUsername: "jumi",
        policy,
        logger: () => undefined,
      });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.mode).toBe("follow-up");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("closing jumi PR + human issue comment + inline list 404 still enqueues follow-up", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-scan-"));
    try {
      const jobs = await scanAssignedIssues({
        api: makeApi({
          searchAssignedIssues: async () => [makeIssue({ repository: repo })],
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
          listIssueComments: async () => [
            makeComment({ id: 55, body: "please fix the tests", user: makeUser({ login: "alice" }) }),
          ],
          listPullReviewComments: async () => {
            throw new Error("404: not found");
          },
        }),
        home,
        botUsername: "jumi",
        policy,
        logger: () => undefined,
      });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.mode).toBe("follow-up");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("closing jumi PR + only bot sticky + inlines 404 still skips", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-scan-"));
    try {
      const jobs = await scanAssignedIssues({
        api: makeApi({
          searchAssignedIssues: async () => [makeIssue({ repository: repo })],
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
          listIssueComments: async () => [
            makeComment({
              id: 1,
              body: "<!-- jumi-worker:kirmanak/demo#12 -->\nworking",
              user: makeUser({ login: "jumi" }),
            }),
          ],
          listPullReviewComments: async () => {
            throw new Error("404: not found");
          },
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

  const HEAD_SHA = "a62c750c0ffee000000000000000000000000000";
  const STALE_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  function jumiClosingPr(sha = HEAD_SHA) {
    return makePR({
      number: 127,
      user: makeUser({ login: "jumi" }),
      body: "Fixes #12",
      head: {
        label: "kirmanak:jumi/issue-12-fix-the-thing",
        ref: "jumi/issue-12-fix-the-thing",
        sha,
        repo,
        repo_id: repo.id,
      },
    });
  }

  function failureSticky(sha = HEAD_SHA) {
    return [
      "<!-- jumi-review:kirmanak/demo#127 -->",
      "### Jumi OpenCode review",
      "",
      `Reviewed commit: \`${sha}\``,
      "",
      "1 blocking",
      "<!-- jumi-check: failure -->",
    ].join("\n");
  }

  test("closing jumi PR + current-head failure sticky enqueues follow-up", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-scan-"));
    try {
      const jobs = await scanAssignedIssues({
        api: makeApi({
          searchAssignedIssues: async () => [makeIssue({ repository: repo })],
          listOpenPulls: async () => [jumiClosingPr()],
          listIssueComments: async () => [
            makeComment({
              id: 38022,
              body: failureSticky(),
              user: makeUser({ login: "jumi" }),
            }),
          ],
        }),
        home,
        botUsername: "jumi",
        policy,
        logger: () => undefined,
      });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.mode).toBe("follow-up");
      expect(jobs[0]?.prNumber).toBe(127);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("closing jumi PR + only stale-SHA failure sticky skips", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-scan-"));
    try {
      const jobs = await scanAssignedIssues({
        api: makeApi({
          searchAssignedIssues: async () => [makeIssue({ repository: repo })],
          listOpenPulls: async () => [jumiClosingPr()],
          listIssueComments: async () => [
            makeComment({
              id: 38022,
              body: failureSticky(STALE_SHA),
              user: makeUser({ login: "jumi" }),
            }),
          ],
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

  test("closing jumi PR + handled failure sticky id+sha skips", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-scan-"));
    try {
      await writeFollowUpState(followUpStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 127,
        round: 1,
        lastHeadSha: HEAD_SHA,
        handledCommentIds: [],
        handledReviewIds: [],
        handledReviewFindings: [{ id: 38022, sha: HEAD_SHA }],
        updatedAt: "2026-05-23T00:00:00Z",
      });
      const jobs = await scanAssignedIssues({
        api: makeApi({
          searchAssignedIssues: async () => [makeIssue({ repository: repo })],
          listOpenPulls: async () => [jumiClosingPr()],
          listIssueComments: async () => [
            makeComment({
              id: 38022,
              body: failureSticky(),
              user: makeUser({ login: "jumi" }),
            }),
          ],
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

  test("closing jumi PR + same sticky id with new current-head SHA enqueues follow-up", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-scan-"));
    const nextSha = "cccccccccccccccccccccccccccccccccccccccc";
    try {
      await writeFollowUpState(followUpStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 127,
        round: 1,
        lastHeadSha: HEAD_SHA,
        handledCommentIds: [38022],
        handledReviewIds: [],
        handledReviewFindings: [{ id: 38022, sha: HEAD_SHA }],
        updatedAt: "2026-05-23T00:00:00Z",
      });
      const jobs = await scanAssignedIssues({
        api: makeApi({
          searchAssignedIssues: async () => [makeIssue({ repository: repo })],
          listOpenPulls: async () => [jumiClosingPr(nextSha)],
          listIssueComments: async () => [
            makeComment({
              id: 38022,
              body: failureSticky(nextSha),
              user: makeUser({ login: "jumi" }),
            }),
          ],
        }),
        home,
        botUsername: "jumi",
        policy,
        logger: () => undefined,
      });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.mode).toBe("follow-up");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("closing jumi PR + current-head failure sticky with reason suffix enqueues follow-up", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-scan-"));
    try {
      const jobs = await scanAssignedIssues({
        api: makeApi({
          searchAssignedIssues: async () => [makeIssue({ repository: repo })],
          listOpenPulls: async () => [jumiClosingPr()],
          listIssueComments: async () => [
            makeComment({
              id: 38022,
              body: failureSticky().replace(
                "<!-- jumi-check: failure -->",
                "<!-- jumi-check: failure; 1 blocking, 1 risk -->"
              ),
              user: makeUser({ login: "jumi" }),
            }),
          ],
        }),
        home,
        botUsername: "jumi",
        policy,
        logger: () => undefined,
      });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.mode).toBe("follow-up");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("closing jumi PR + current-head failure sticky at round 3 skips", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-scan-"));
    try {
      await writeFollowUpState(followUpStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 127,
        round: 3,
        lastHeadSha: HEAD_SHA,
        handledCommentIds: [],
        handledReviewIds: [],
        handledReviewFindings: [],
        updatedAt: "2026-05-23T00:00:00Z",
      });
      const jobs = await scanAssignedIssues({
        api: makeApi({
          searchAssignedIssues: async () => [makeIssue({ repository: repo })],
          listOpenPulls: async () => [jumiClosingPr()],
          listIssueComments: async () => [
            makeComment({
              id: 38022,
              body: failureSticky(),
              user: makeUser({ login: "jumi" }),
            }),
          ],
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
