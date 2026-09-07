import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimFilePath, isPidAlive, readClaim, writeClaim } from "../src/claim.ts";
import type { IssueApi } from "../src/gitea_issues.ts";
import { MemoryReviewJobStore, WORKER_JOB_KINDS } from "../src/review_jobs.ts";
import { handleIssueCancel, processWorkerTick, reclaimExpiredWorkerJobs } from "../src/worker.ts";
import {
  emptyCiMethods,
  makeComment,
  makeIssue,
  makeIssueJob,
  makePR,
  makeRepo,
  makeWorkerConfig,
} from "./fixtures.ts";

function waitUntilAborted(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (!signal || signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

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
    ...emptyCiMethods(),
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

  test("ledger cancel does not kill an unrelated claim pid", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-cancel-"));
    try {
      const child = Bun.spawn(["sleep", "30"]);
      await writeClaim(claimFilePath(home, "kirmanak", "demo", 12), {
        pid: child.pid,
        startedAt: "2026-05-23T00:00:00Z",
        heartbeatAt: "2026-05-23T00:00:00Z",
        worktree: "/work/12",
        branch: "jumi/issue-12-fix-the-thing",
        issueUpdatedAt: "2026-05-23T00:00:00Z",
        headShaAtStart: "abc",
        terminal: false,
      });
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob());
      await store.lease("worker-other", 60_000, undefined, WORKER_JOB_KINDS);
      const api = makeApi();
      await handleIssueCancel(
        makeWorkerConfig({ home }),
        api,
        "kirmanak",
        "demo",
        12,
        undefined,
        store,
        new Map(),
        new Map()
      );
      expect(store.rows[0]?.state).toBe("cancelled");
      expect(isPidAlive(child.pid)).toBe(true);
      expect(api.comments.at(-1)).toContain("stopped");
      child.kill();
      await child.exited;
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

  test("two workers cannot double-lease the same job", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob());
    let running = 0;
    let maxRunning = 0;
    const implement = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await Bun.sleep(20);
      running--;
      return { status: "pr" as const, prNumber: 1, htmlUrl: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/1" };
    };
    const results = await Promise.all([
      processWorkerTick(store, makeWorkerConfig(), makeApi(), "worker-a", { implement }),
      processWorkerTick(store, makeWorkerConfig(), makeApi(), "worker-b", { implement }),
    ]);
    expect(maxRunning).toBe(1);
    expect(results.sort()).toEqual(["idle", "processed"]);
    expect(store.rows.filter((row) => row.kind === "implement")).toHaveLength(1);
    expect(store.rows[0]?.state).toBe("succeeded");
  });

  test("two workers lease different jobs", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob({ issueNumber: 12 }));
    await store.enqueueIssue(
      makeIssueJob({ issueNumber: 13, htmlUrl: "https://gitea.kirmanak.stream/kirmanak/demo/issues/13" })
    );
    const seen: number[] = [];
    const implement = async (opts: { job: { issueNumber: number } }) => {
      seen.push(opts.job.issueNumber);
      return { status: "pr" as const, prNumber: opts.job.issueNumber, htmlUrl: "https://example" };
    };
    const results = await Promise.all([
      processWorkerTick(store, makeWorkerConfig(), makeApi(), "worker-a", { implement }),
      processWorkerTick(store, makeWorkerConfig(), makeApi(), "worker-b", { implement }),
    ]);
    expect(results).toEqual(["processed", "processed"]);
    expect(seen.sort((a, b) => a - b)).toEqual([12, 13]);
    expect(store.rows.every((row) => row.state === "succeeded")).toBe(true);
  });

  test("same-replica unassign aborts the holder without waiting for heartbeat", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-cancel-"));
    try {
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob());
      const aborts = new Map<string, AbortController>();
      const started = Promise.withResolvers<void>();
      const tick = processWorkerTick(
        store,
        makeWorkerConfig({ home }),
        makeApi(),
        "worker-1",
        {
          heartbeatMs: 60_000,
          implement: async (opts) => {
            started.resolve();
            await waitUntilAborted(opts.abortSignal);
            return { status: "cancelled" };
          },
        },
        () => undefined,
        aborts
      );
      await started.promise;
      await handleIssueCancel(makeWorkerConfig({ home }), makeApi(), "kirmanak", "demo", 12, undefined, store, aborts);
      expect(await tick).toBe("processed");
      expect(store.rows[0]?.state).toBe("cancelled");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("unassign on another replica aborts the holder via failed heartbeat", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-cancel-"));
    try {
      const child = Bun.spawn(["sleep", "30"]);
      const store = new MemoryReviewJobStore();
      await store.enqueueIssue(makeIssueJob());
      const holderAborts = new Map<string, AbortController>();
      const holderPids = new Map<string, number>();
      const started = Promise.withResolvers<void>();
      const tick = processWorkerTick(
        store,
        makeWorkerConfig({ home }),
        makeApi(),
        "worker-holder",
        {
          heartbeatMs: 15,
          implement: async (opts) => {
            await opts.onPid?.(child.pid);
            started.resolve();
            await waitUntilAborted(opts.abortSignal);
            return { status: "cancelled" };
          },
        },
        () => undefined,
        holderAborts,
        holderPids
      );
      await started.promise;
      await handleIssueCancel(
        makeWorkerConfig({ home }),
        makeApi(),
        "kirmanak",
        "demo",
        12,
        undefined,
        store,
        new Map(),
        new Map()
      );
      expect(store.rows[0]?.state).toBe("cancelled");
      expect(await tick).toBe("processed");
      await child.exited;
      expect(child.exitCode === 0).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
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
