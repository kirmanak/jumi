import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimFilePath, readClaim, writeClaim } from "../src/claim.ts";
import type { IssueApi } from "../src/gitea_issues.ts";
import { MemoryReviewJobStore, WORKER_JOB_KINDS } from "../src/review_jobs.ts";
import { handleIssueCancel, processWorkerTick, reclaimExpiredWorkerJobs } from "../src/worker.ts";
import { makeComment, makeIssue, makeIssueJob, makePR, makeRepo, makeWorkerConfig } from "./fixtures.ts";

function makeApi(overrides: Partial<IssueApi> = {}): IssueApi & { comments: string[] } {
  const comments: string[] = [];
  const defaults: IssueApi = {
    getRepo: async () => makeRepo(),
    getIssue: async () => makeIssue(),
    listOpenPulls: async () => [],
    createPullRequest: async (_owner, _repo, pull) => makePR({ title: pull.title, body: pull.body }),
    searchAssignedIssues: async () => [],
    findStickyIssueComment: async () => ({ id: 9 }),
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
  };
  return { ...defaults, ...overrides, comments };
}

describe("handleIssueCancel", () => {
  test("does not overwrite a leftover sticky after finished work", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-cancel-"));
    try {
      const api = makeApi();
      const result = await handleIssueCancel(makeWorkerConfig({ home }), api, "kirmanak", "demo", 12);
      expect(result).toEqual({ key: "kirmanak/demo#12", cancelled: true });
      expect(api.comments).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("deletes a terminal claim without posting stopped", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-cancel-"));
    try {
      const path = claimFilePath(home, "kirmanak", "demo", 12);
      await writeClaim(path, {
        pid: 0,
        startedAt: "2026-05-23T00:00:00Z",
        heartbeatAt: "2026-05-23T00:00:00Z",
        worktree: "/work/12",
        branch: "jumi/issue-12-fix-the-thing",
        issueUpdatedAt: "2026-05-23T00:00:00Z",
        headShaAtStart: "abc",
        terminal: true,
      });
      const api = makeApi();
      await handleIssueCancel(makeWorkerConfig({ home }), api, "kirmanak", "demo", 12);
      expect(await readClaim(path)).toBeUndefined();
      expect(api.comments).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("posts stopped when a non-terminal claim exists", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-cancel-"));
    try {
      await writeClaim(claimFilePath(home, "kirmanak", "demo", 12), {
        pid: 0,
        startedAt: "2026-05-23T00:00:00Z",
        heartbeatAt: "2026-05-23T00:00:00Z",
        worktree: "/work/12",
        branch: "jumi/issue-12-fix-the-thing",
        issueUpdatedAt: "2026-05-23T00:00:00Z",
        headShaAtStart: "",
        terminal: false,
      });
      const api = makeApi();
      await handleIssueCancel(makeWorkerConfig({ home }), api, "kirmanak", "demo", 12);
      expect(api.comments.at(-1)).toContain("stopped");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("kills recorded pid and cancels leased rows", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-cancel-"));
    try {
      const child = Bun.spawn(["sleep", "30"]);
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob());
      await store.lease("worker-1", 60_000, undefined, WORKER_JOB_KINDS);
      const key = "kirmanak/demo#12";
      const aborts = new Map<string, AbortController>([[key, new AbortController()]]);
      const pids = new Map<string, number>([[key, child.pid]]);
      const api = makeApi();
      await handleIssueCancel(makeWorkerConfig({ home }), api, "kirmanak", "demo", 12, undefined, store, aborts, pids);
      expect(aborts.get(key)?.signal.aborted).toBe(true);
      expect(store.rows[0]?.state).toBe("cancelled");
      expect(store.rows[0]?.leasedBy).toBeNull();
      await child.exited;
      expect(child.exitCode === 0).toBe(false);
      expect(api.comments.at(-1)).toContain("stopped");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("reclaimExpiredWorkerJobs", () => {
  test("marks max-attempt implement failed so the key can be re-enqueued", async () => {
    const store = new MemoryReviewJobStore();
    const job = makeIssueJob();
    await store.enqueueIssue(job);
    const past = new Date(Date.now() - 10_000);
    await store.lease("worker-1", 1, past, WORKER_JOB_KINDS);
    expect(await reclaimExpiredWorkerJobs(store, 2, () => undefined)).toEqual({ requeued: 1, published: 0 });
    await store.lease("worker-1", 1, past, WORKER_JOB_KINDS);
    expect(await reclaimExpiredWorkerJobs(store, 2, () => undefined)).toEqual({ requeued: 0, published: 1 });
    expect(store.rows[0]?.state).toBe("failed");
    expect(store.rows[0]?.leasedBy).toBeNull();
    expect(await store.enqueueIssue(job)).toEqual({ key: "implement:kirmanak/demo#12", queued: true });
  });
});

describe("processWorkerTick", () => {
  test("follow-up and conflict use configured timeouts, not OPENCODE_TIMEOUT_MS", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob({ mode: "follow-up", prNumber: 127, headSha: "headsha" }));
    let followUp: { timeoutMs?: number; maxFollowupRounds?: number; conflictTimeoutMs?: number } = {};
    await processWorkerTick(
      store,
      makeWorkerConfig({
        opencodeTimeoutMs: 14_400_000,
        followupTimeoutMs: 1_800_000,
        conflictTimeoutMs: 900_000,
        maxFollowupRounds: 5,
        maxConflictRounds: 7,
      }),
      makeApi(),
      "worker-1",
      {
        followUp: async (opts) => {
          followUp = {
            timeoutMs: opts.timeoutMs,
            maxFollowupRounds: opts.maxFollowupRounds,
            conflictTimeoutMs: opts.conflictTimeoutMs,
          };
          return { status: "no-changes" };
        },
      }
    );
    expect(followUp).toEqual({ timeoutMs: 1_800_000, maxFollowupRounds: 5, conflictTimeoutMs: 900_000 });

    await store.enqueueIssue(makeIssueJob({ mode: "conflict", prNumber: 127, headSha: "headsha" }));
    let conflict: { timeoutMs?: number; maxConflictRounds?: number } = {};
    await processWorkerTick(
      store,
      makeWorkerConfig({
        opencodeTimeoutMs: 14_400_000,
        conflictTimeoutMs: 900_000,
        maxConflictRounds: 7,
      }),
      makeApi(),
      "worker-1",
      {
        conflict: async (opts) => {
          conflict = { timeoutMs: opts.timeoutMs, maxConflictRounds: opts.maxConflictRounds };
          return { status: "up-to-date" };
        },
      }
    );
    expect(conflict).toEqual({ timeoutMs: 900_000, maxConflictRounds: 7 });
  });

  test("maps implement no-changes to skipped so an issue edit can re-enqueue", async () => {
    const store = new MemoryReviewJobStore();
    const job = makeIssueJob();
    await store.enqueueIssue(job);
    await processWorkerTick(store, makeWorkerConfig(), makeApi(), "worker-1", {
      implement: async () => ({ status: "no-changes" }),
    });
    expect(store.rows[0]?.state).toBe("skipped");
    expect(store.rows[0]?.resultReason).toBe("no-changes");
    expect(await store.enqueueIssue(job)).toEqual({ key: "implement:kirmanak/demo#12", queued: false });
    expect(await store.enqueueIssue(makeIssueJob({ issueUpdatedAt: "2026-05-23T01:00:00Z" }))).toEqual({
      key: "implement:kirmanak/demo#12",
      queued: true,
    });
  });
});
