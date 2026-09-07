import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewApi } from "../src/review.ts";
import { HEARTBEAT_MS, MemoryReviewJobStore, RECLAIM_LEASED_BY } from "../src/review_jobs.ts";
import { processEngineTick, reclaimExpiredJobs, startReviewer } from "../src/server.ts";
import type { GitRunner } from "../src/workspace.ts";
import { makeComment, makeConfig, makeFile, makeIssue, makeJob, makePR, makeRepo } from "./fixtures.ts";

function makeApi(overrides: Partial<ReviewApi> = {}): ReviewApi & {
  comments: string[];
  statuses: Array<{ sha: string; state: string; description?: string }>;
} {
  const comments: string[] = [];
  const statuses: Array<{ sha: string; state: string; description?: string }> = [];
  const defaults: ReviewApi = {
    getRepo: async () => makeRepo(),
    getPR: async () => makePR(),
    getPRFiles: async () => [makeFile()],
    getIssue: async () => makeIssue(),
    listIssueComments: async () => [],
    findStickyIssueComment: async () => undefined,
    createIssueComment: async (_owner, _repo, _index, body) => {
      comments.push(body);
      return makeComment({ id: comments.length, body });
    },
    updateIssueComment: async (_owner, _repo, commentId, body) => {
      comments.push(body);
      return makeComment({ id: commentId, body });
    },
    createCommitStatus: async (_owner, _repo, sha, status) => {
      statuses.push({ sha, state: status.state, description: status.description });
      return status;
    },
  };
  return { ...defaults, ...overrides, comments, statuses };
}

function frozenGit(): GitRunner {
  return async (args) => {
    if (args[0] === "rev-parse") return "headsha";
    if (args[0] === "status") return "?? JUMI_REVIEW.md";
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

function hangUntilAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => {
      const err = new Error("cancelled");
      err.name = "AbortError";
      reject(err);
    };
    if (signal?.aborted) fail();
    else signal?.addEventListener("abort", fail, { once: true });
  });
}

async function withWorkspace<T>(run: (workspace: string) => Promise<T>): Promise<T> {
  const workspace = await mkdtemp(join(tmpdir(), "jumi-engine-"));
  try {
    return await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

describe("processEngineTick", () => {
  test("leases a job, persists JUMI_REVIEW.md, and posts sticky via fake API", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const api = makeApi();
      let ran = 0;
      await processEngineTick(store, makeConfig({ workdir: workspace }), api, "engine-1", {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        openCodeRunner: async (opts) => {
          ran++;
          await writeFile(join(opts.workdir, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });

      expect(ran).toBe(1);
      const row = store.rows[0];
      expect(row?.state).toBe("succeeded");
      expect(row?.resultMarkdown).toContain("Looks good");
      expect(row?.resultMarkdown).not.toContain("I'll inspect");
      expect(api.comments[0]).toContain("Looks good");
      expect(api.comments[0]).not.toContain("I'll inspect");
      expect(api.statuses.map((status) => status.state)).toEqual(["pending", "success"]);
    });
  });

  test("incomplete review skip persists; reclaim publishes failure and does not rerun OpenCode", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const api = makeApi();
      let ran = 0;
      await processEngineTick(store, makeConfig({ workdir: workspace }), api, "engine-1", {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        openCodeRunner: async () => {
          ran++;
          return { status: "ok" };
        },
      });

      expect(ran).toBe(1);
      const row = store.rows[0];
      expect(row?.state).toBe("skipped");
      expect(row?.resultReason).toBe("Incomplete review: no output");
      expect(api.statuses.at(-1)).toMatchObject({ state: "failure", description: "Incomplete review: no output" });

      row!.state = "leased";
      row!.leasedBy = "dead-engine";
      row!.leasedUntil = 1;
      row!.publishedAt = null;
      api.statuses.length = 0;
      await reclaimExpiredJobs(store, api, makeConfig(), () => undefined);
      expect(ran).toBe(1);
      expect(store.rows[0]?.state).toBe("skipped");
      expect(api.statuses.at(-1)).toMatchObject({ state: "failure", description: "Incomplete review: no output" });
    });
  });

  test("reclaim after result_markdown publishes without OpenCode", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("dead-engine", 1, new Date(1_000));
    await store.saveResult(leased!.id, "dead-engine", {
      kind: "markdown",
      markdown: "Persisted review\n<!-- jumi-check: success -->",
    });
    const api = makeApi();
    const ran = 0;
    await reclaimExpiredJobs(store, api, makeConfig(), () => undefined);
    expect(ran).toBe(0);
    expect(store.rows[0]?.state).toBe("succeeded");
    expect(api.comments[0]).toContain("Persisted review");
    expect(api.comments[0]).not.toContain("I'll inspect");
  });

  test("overlapping reclaimExpiredJobs does not double-post a persist-ready sticky", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("dead-engine", 1, new Date(1_000));
    await store.saveResult(leased!.id, "dead-engine", {
      kind: "markdown",
      markdown: "Persisted review\n<!-- jumi-check: success -->",
    });
    let releaseComment!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseComment = resolve;
    });
    let enteredPublish!: () => void;
    const inPublish = new Promise<void>((resolve) => {
      enteredPublish = resolve;
    });
    let commentCalls = 0;
    const api = makeApi({
      findStickyIssueComment: async () => {
        enteredPublish();
        await gate;
        return undefined;
      },
      createIssueComment: async (_owner, _repo, _index, body) => {
        commentCalls++;
        api.comments.push(body);
        return makeComment({ id: commentCalls, body });
      },
    });
    const first = reclaimExpiredJobs(store, api, makeConfig(), () => undefined);
    await inPublish;
    const second = reclaimExpiredJobs(store, api, makeConfig(), () => undefined);
    releaseComment();
    await Promise.all([first, second]);
    expect(commentCalls).toBe(1);
    expect(api.comments).toHaveLength(1);
    expect(store.rows[0]?.state).toBe("succeeded");
  });

  test("persist-ready reclaim claims HEARTBEAT_MS not leaseMs", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("dead-engine", 1, new Date(1_000));
    await store.saveResult(leased!.id, "dead-engine", {
      kind: "markdown",
      markdown: "Persisted review\n<!-- jumi-check: success -->",
    });
    let releaseComment!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseComment = resolve;
    });
    let enteredPublish!: () => void;
    const inPublish = new Promise<void>((resolve) => {
      enteredPublish = resolve;
    });
    const api = makeApi({
      findStickyIssueComment: async () => {
        enteredPublish();
        await gate;
        throw new Error("gitea down");
      },
    });
    const first = reclaimExpiredJobs(store, api, makeConfig(), () => undefined);
    await inPublish;

    const claimedUntil = store.rows[0]!.leasedUntil!;
    const now = Date.now();
    expect(claimedUntil).toBeGreaterThan(now);
    expect(claimedUntil).toBeLessThanOrEqual(now + HEARTBEAT_MS + 1_000);
    expect(claimedUntil).toBeLessThan(now + makeConfig().leaseMs / 2);

    const twoSecondsLater = await store.reclaimExpired(2, new Date(now + 2_000));
    expect(twoSecondsLater.publish).toHaveLength(0);
    expect(twoSecondsLater.requeued).toHaveLength(0);

    const afterHeartbeat = await store.reclaimExpired(2, new Date(now + HEARTBEAT_MS + 1));
    expect(afterHeartbeat.publish).toHaveLength(1);

    releaseComment();
    await first;
    expect(store.rows[0]?.leasedUntil).toBeLessThan(Date.now());
    expect(store.rows[0]?.leasedBy).toBeNull();
    expect(store.rows[0]?.publishedAt).toBeNull();
  });

  test("reclaimExpiredJobs expires lease on Gitea failure so the next tick retries publish", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("dead-engine", 1, new Date(1_000));
    await store.saveResult(leased!.id, "dead-engine", {
      kind: "markdown",
      markdown: "Persisted review\n<!-- jumi-check: success -->",
    });
    let commentCalls = 0;
    const api = makeApi({
      createIssueComment: async (_owner, _repo, _index, body) => {
        commentCalls++;
        if (commentCalls === 1) throw new Error("gitea 502");
        api.comments.push(body);
        return makeComment({ id: commentCalls, body });
      },
    });
    await reclaimExpiredJobs(store, api, makeConfig(), () => undefined);
    expect(commentCalls).toBe(1);
    expect(store.rows[0]?.state).toBe("leased");
    expect(store.rows[0]?.publishedAt).toBeNull();
    expect(store.rows[0]?.leasedBy).toBeNull();
    expect(store.rows[0]?.leasedUntil).toBeLessThan(Date.now());

    await reclaimExpiredJobs(store, api, makeConfig(), () => undefined);
    expect(commentCalls).toBe(2);
    expect(store.rows[0]?.state).toBe("succeeded");
    expect(api.comments).toHaveLength(1);
    expect(api.comments[0]).toContain("Persisted review");
  });

  test("expired lease without a result is retried", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      await store.lease("dead-engine", 1, new Date(1_000));
      const reclaimed = await store.reclaimExpired(2, new Date(5_000));
      expect(reclaimed.requeued[0]?.attempt).toBe(1);

      const api = makeApi();
      let ran = 0;
      await processEngineTick(store, makeConfig({ workdir: workspace }), api, "engine-2", {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        openCodeRunner: async (opts) => {
          ran++;
          await writeFile(join(opts.workdir, "JUMI_REVIEW.md"), "Retry\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(ran).toBe(1);
      expect(store.rows[0]?.state).toBe("succeeded");
    });
  });

  test("publish throw after persist retries publish and marks published", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      let commentCalls = 0;
      const api = makeApi({
        createIssueComment: async (_owner, _repo, _index, body) => {
          commentCalls++;
          if (commentCalls === 1) throw new Error("gitea down");
          api.comments.push(body);
          return makeComment({ id: commentCalls, body });
        },
      });
      await processEngineTick(store, makeConfig({ workdir: workspace }), api, "engine-1", {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        openCodeRunner: async (opts) => {
          await writeFile(join(opts.workdir, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(commentCalls).toBe(2);
      expect(store.rows[0]?.state).toBe("succeeded");
      expect(store.rows[0]?.leasedUntil).toBeNull();
      expect(api.comments[0]).toContain("Looks good");
    });
  });

  test("persistResult throw on markdown does not persist error; expireLease so reclaim can retry", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const originalSave = store.saveResult.bind(store);
      store.saveResult = async (id, leasedBy, result) => {
        if (result.kind === "markdown") throw new Error("cannot save result");
        return originalSave(id, leasedBy, result);
      };
      const api = makeApi();
      await processEngineTick(store, makeConfig({ workdir: workspace }), api, "engine-1", {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        openCodeRunner: async (opts) => {
          await writeFile(join(opts.workdir, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(store.rows[0]?.error).toBeNull();
      expect(store.rows[0]?.resultMarkdown).toBeNull();
      expect(store.rows[0]?.resultReason).toBeNull();
      expect(store.rows[0]?.state).toBe("leased");
      expect(store.rows[0]?.leasedUntil).toBeLessThan(Date.now());
      expect(api.comments).toHaveLength(0);
      expect(api.statuses.some((status) => status.description?.includes("cannot save result"))).toBe(false);
      const reclaimed = await store.reclaimExpired(2);
      expect(reclaimed.requeued).toHaveLength(1);
      expect(reclaimed.publish).toHaveLength(0);

      store.saveResult = originalSave;
      await processEngineTick(store, makeConfig({ workdir: workspace }), api, "engine-2", {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        openCodeRunner: async (opts) => {
          await writeFile(join(opts.workdir, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(store.rows[0]?.state).toBe("succeeded");
      expect(api.comments[0]).toContain("Looks good");
      expect(api.comments[0]).not.toContain("cannot save result");
    });
  });

  test("persistResult throw on skip does not persist error; expireLease so reclaim can retry", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const originalSave = store.saveResult.bind(store);
      store.saveResult = async (id, leasedBy, result) => {
        if (result.kind === "skip") throw new Error("cannot save result");
        return originalSave(id, leasedBy, result);
      };
      const api = makeApi();
      await processEngineTick(store, makeConfig({ workdir: workspace }), api, "engine-1", {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        openCodeRunner: async () => ({ status: "ok" }),
      });
      expect(store.rows[0]?.error).toBeNull();
      expect(store.rows[0]?.resultReason).toBeNull();
      expect(store.rows[0]?.state).toBe("leased");
      expect(store.rows[0]?.leasedUntil).toBeLessThan(Date.now());
      expect(api.comments).toHaveLength(0);
      expect(api.statuses.some((status) => status.description?.includes("cannot save result"))).toBe(false);
      const reclaimed = await store.reclaimExpired(2);
      expect(reclaimed.requeued).toHaveLength(1);
      expect(reclaimed.publish).toHaveLength(0);
    });
  });

  test("engine catch after reclaim claimed does not publish or expire as the original engine", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const originalSave = store.saveResult.bind(store);
      const originalExpire = store.expireLease.bind(store);
      const expireCallers: string[] = [];
      store.saveResult = async (id, leasedBy, result) => {
        await originalSave(id, leasedBy, result);
        store.rows[0]!.leasedBy = RECLAIM_LEASED_BY;
      };
      store.expireLease = async (id, leasedBy, now) => {
        expireCallers.push(leasedBy);
        return originalExpire(id, leasedBy, now);
      };
      let commentCalls = 0;
      const api = makeApi({
        createIssueComment: async () => {
          commentCalls++;
          throw new Error("gitea down");
        },
      });
      await processEngineTick(store, makeConfig({ workdir: workspace }), api, "engine-1", {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        openCodeRunner: async (opts) => {
          await writeFile(join(opts.workdir, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(commentCalls).toBe(1);
      expect(expireCallers).toEqual([]);
      expect(store.rows[0]?.leasedBy).toBe(RECLAIM_LEASED_BY);
      expect(store.rows[0]?.state).toBe("leased");
      expect(store.rows[0]?.publishedAt).toBeNull();
    });
  });

  test("throw before persist expires the lease so reclaim can retry", async () => {
    await withWorkspace(async (workspace) => {
      const blocker = join(workspace, "not-a-dir");
      await writeFile(blocker, "x");
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const api = makeApi();
      await processEngineTick(store, makeConfig({ workdir: blocker }), api, "engine-1");
      expect(store.rows[0]?.state).toBe("leased");
      expect(store.rows[0]?.resultMarkdown).toBeNull();
      expect(store.rows[0]?.resultReason).toBeNull();
      expect(store.rows[0]?.error).toBeNull();
      expect(store.rows[0]?.leasedUntil).toBeLessThan(Date.now());
      const reclaimed = await store.reclaimExpired(2);
      expect(reclaimed.requeued).toHaveLength(1);
      expect(reclaimed.requeued[0]?.state).toBe("queued");
    });
  });

  test("already-aborted tick does not lease", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const abort = new AbortController();
    abort.abort();
    const result = await processEngineTick(store, makeConfig(), makeApi(), "engine-1", {
      abortSignal: abort.signal,
      openCodeRunner: async () => {
        throw new Error("should not run");
      },
    });
    expect(result).toBe("idle");
    expect(store.rows[0]?.state).toBe("queued");
    expect(store.rows[0]?.attempt).toBe(0);
  });

  test("engine stop aborts OpenCode and requeues the leased SHA", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const shutdown = new AbortController();
      let started!: () => void;
      const gate = new Promise<void>((resolve) => {
        started = resolve;
      });
      const reviewer = await startReviewer(makeConfig({ role: "engine", workdir: workspace, port: 0 }), {
        store,
        api: makeApi(),
        signal: shutdown.signal,
        ensureAuth: async () => undefined,
        extras: {
          gitRunner: frozenGit(),
          workspacePreparer: async () => undefined,
          openCodeRunner: async (opts) => {
            started();
            return hangUntilAbort(opts.abortSignal);
          },
        },
      });
      try {
        await gate;
        shutdown.abort();
        reviewer.stop();
        const deadline = Date.now() + 2_000;
        while (Date.now() < deadline && store.rows[0]?.state !== "queued") {
          await Bun.sleep(10);
        }
        expect(store.rows[0]?.state).toBe("queued");
        expect(store.rows[0]?.attempt).toBe(0);
        expect(store.rows[0]?.leasedBy).toBeNull();
      } finally {
        reviewer.stop();
        reviewer.server?.stop(true);
      }
    });
  });

  test("abort without a persisted result requeues the same SHA without consuming an attempt", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const api = makeApi();
      const abort = new AbortController();
      let started!: () => void;
      const gate = new Promise<void>((resolve) => {
        started = resolve;
      });
      const tick = processEngineTick(store, makeConfig({ workdir: workspace }), api, "engine-1", {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        abortSignal: abort.signal,
        openCodeRunner: async (opts) => {
          started();
          return hangUntilAbort(opts.abortSignal);
        },
      });
      await gate;
      abort.abort();
      await tick;

      expect(store.rows[0]?.state).toBe("queued");
      expect(store.rows[0]?.attempt).toBe(0);
      expect(store.rows[0]?.leasedBy).toBeNull();
      expect(store.rows[0]?.leasedUntil).toBeNull();
      expect(store.rows[0]?.error).toBeNull();
      expect(store.rows[0]?.resultMarkdown).toBeNull();
      expect(api.comments).toHaveLength(0);
      expect(api.statuses.map((status) => status.state)).toEqual(["pending"]);
      expect(api.statuses.some((status) => status.state === "failure")).toBe(false);

      const abort2 = new AbortController();
      let started2!: () => void;
      const gate2 = new Promise<void>((resolve) => {
        started2 = resolve;
      });
      const tick2 = processEngineTick(store, makeConfig({ workdir: workspace }), api, "engine-2", {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        abortSignal: abort2.signal,
        openCodeRunner: async (opts) => {
          started2();
          return hangUntilAbort(opts.abortSignal);
        },
      });
      await gate2;
      abort2.abort();
      await tick2;
      expect(store.rows[0]?.state).toBe("queued");
      expect(store.rows[0]?.attempt).toBe(0);

      await processEngineTick(store, makeConfig({ workdir: workspace }), api, "engine-3", {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        openCodeRunner: async (opts) => {
          await writeFile(join(opts.workdir, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
          return { status: "ok" };
        },
      });
      expect(store.rows[0]?.state).toBe("succeeded");
      expect(api.comments[0]).toContain("Looks good");
    });
  });

  test("abort does not release a different engine's lease", async () => {
    await withWorkspace(async (workspace) => {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const api = makeApi();
      const abort = new AbortController();
      let started!: () => void;
      const gate = new Promise<void>((resolve) => {
        started = resolve;
      });
      const originalRelease = store.releaseLease.bind(store);
      const callers: string[] = [];
      store.releaseLease = async (id, leasedBy) => {
        callers.push(leasedBy);
        store.rows[0]!.leasedBy = "engine-other";
        return originalRelease(id, leasedBy);
      };
      const tick = processEngineTick(store, makeConfig({ workdir: workspace }), api, "engine-1", {
        gitRunner: frozenGit(),
        workspacePreparer: async () => undefined,
        abortSignal: abort.signal,
        openCodeRunner: async (opts) => {
          started();
          return hangUntilAbort(opts.abortSignal);
        },
      });
      await gate;
      abort.abort();
      await tick;
      expect(callers).toEqual(["engine-1"]);
      expect(store.rows[0]?.state).toBe("leased");
      expect(store.rows[0]?.leasedBy).toBe("engine-other");
    });
  });

  test("in-flight heartbeat after throw cannot restore an expired lease", async () => {
    await withWorkspace(async (workspace) => {
      const blocker = join(workspace, "not-a-dir");
      await writeFile(blocker, "x");
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());

      let releaseHeartbeat!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseHeartbeat = resolve;
      });
      let heartbeatCalls = 0;
      const pendingHeartbeats: Promise<boolean>[] = [];
      const originalHeartbeat = store.heartbeat.bind(store);
      store.heartbeat = (id, leasedBy, leaseMs, now) => {
        heartbeatCalls++;
        const run = gate.then(() => originalHeartbeat(id, leasedBy, leaseMs, now));
        pendingHeartbeats.push(run);
        return run;
      };

      const intervalCallbacks: Array<() => void> = [];
      const realSetInterval = globalThis.setInterval.bind(globalThis);
      globalThis.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        if (typeof handler === "function") {
          const cb = () => {
            (handler as (...handlerArgs: unknown[]) => void)(...args);
          };
          intervalCallbacks.push(cb);
          cb();
        }
        return realSetInterval(handler, timeout, ...args);
      }) as typeof setInterval;

      try {
        const api = makeApi();
        await processEngineTick(store, makeConfig({ workdir: blocker }), api, "engine-1");
        intervalCallbacks[0]!();
        expect(heartbeatCalls).toBe(1);

        releaseHeartbeat();
        await Promise.all(pendingHeartbeats);

        expect(store.rows[0]?.state).toBe("leased");
        expect(store.rows[0]?.leasedBy).toBeNull();
        expect(store.rows[0]?.leasedUntil).toBeLessThan(Date.now());
        const reclaimed = await store.reclaimExpired(2);
        expect(reclaimed.requeued).toHaveLength(1);
        expect(reclaimed.requeued[0]?.state).toBe("queued");
      } finally {
        globalThis.setInterval = realSetInterval;
      }
    });
  });
});
