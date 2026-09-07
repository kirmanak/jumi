import { describe, expect, test } from "bun:test";
import {
  HEARTBEAT_MS,
  MemoryReviewJobStore,
  PgReviewJobStore,
  pgTextArrayLiteral,
  RECLAIM_LEASED_BY,
  WORKER_JOB_KINDS,
} from "../src/review_jobs.ts";
import { makeIssueJob, makeJob } from "./fixtures.ts";

describe("MemoryReviewJobStore", () => {
  test("dedupes in-flight job_key", async () => {
    const store = new MemoryReviewJobStore();
    const job = makeJob();
    expect(await store.enqueue(job)).toEqual({ key: "kirmanak/demo#7:headsha", queued: true });
    expect(await store.enqueue(job)).toEqual({ key: "kirmanak/demo#7:headsha", queued: false });
    const leased = await store.lease("engine-1", 60_000);
    expect(leased?.state).toBe("leased");
    expect(await store.enqueue(job)).toEqual({ key: "kirmanak/demo#7:headsha", queued: false });
  });

  test("redelivery of succeeded or skipped SHA does not insert", async () => {
    const store = new MemoryReviewJobStore();
    const job = makeJob();
    await store.enqueue(job);
    const leased = await store.lease("engine-1", 60_000);
    await store.markPublished(leased!.id, "engine-1", { state: "succeeded" });
    expect(await store.enqueue(job)).toEqual({ key: "kirmanak/demo#7:headsha", queued: false });
    expect(store.rows.filter((row) => row.jobKey === "kirmanak/demo#7:headsha")).toHaveLength(1);

    const skipped = makeJob({ headSha: "skippedsha" });
    await store.enqueue(skipped);
    const leasedSkip = await store.lease("engine-1", 60_000);
    await store.saveResult(leasedSkip!.id, "engine-1", { kind: "skip", reason: "Incomplete review: no output" });
    await store.markPublished(leasedSkip!.id, "engine-1", { state: "skipped", reason: "Incomplete review: no output" });
    expect(await store.enqueue(skipped)).toEqual({ key: "kirmanak/demo#7:skippedsha", queued: false });

    const headChange = makeJob({ headSha: "movedsha" });
    await store.enqueue(headChange);
    const leasedHead = await store.lease("engine-1", 60_000);
    await store.markPublished(leasedHead!.id, "engine-1", {
      state: "skipped",
      reason: "PR head changed from movedsha to newsha",
    });
    expect(await store.enqueue(headChange)).toEqual({ key: "kirmanak/demo#7:movedsha", queued: false });
  });

  test("closed or merged skip is not terminal; reopen can insert", async () => {
    const store = new MemoryReviewJobStore();
    const job = makeJob();
    await store.enqueue(job);
    const leased = await store.lease("engine-1", 60_000);
    await store.markPublished(leased!.id, "engine-1", { state: "skipped", reason: "PR is closed" });
    expect(await store.enqueue(job)).toEqual({ key: "kirmanak/demo#7:headsha", queued: true });
    expect(store.rows.filter((row) => row.jobKey === "kirmanak/demo#7:headsha" && row.state === "queued")).toHaveLength(
      1
    );

    const merged = makeJob({ headSha: "mergedsha" });
    await store.enqueue(merged);
    const leasedMerged = await store.lease("engine-1", 60_000);
    await store.markPublished(leasedMerged!.id, "engine-1", { state: "skipped", reason: "PR is already merged" });
    expect(await store.enqueue(merged)).toEqual({ key: "kirmanak/demo#7:mergedsha", queued: true });
  });

  test("failed SHA may be retried", async () => {
    const store = new MemoryReviewJobStore();
    const job = makeJob();
    await store.enqueue(job);
    const leased = await store.lease("engine-1", 60_000);
    await store.markPublished(leased!.id, "engine-1", { state: "failed", reason: "boom" });
    expect(await store.enqueue(job)).toEqual({ key: "kirmanak/demo#7:headsha", queued: true });
  });

  test("new SHA cancels queued predecessor for the same PR, not a leased one", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob({ headSha: "old" }));
    expect(await store.enqueue(makeJob({ headSha: "new" }))).toEqual({
      key: "kirmanak/demo#7:new",
      queued: true,
    });
    expect(store.rows.find((row) => row.headSha === "old")?.state).toBe("cancelled");
    expect(store.rows.find((row) => row.headSha === "new")?.state).toBe("queued");

    const store2 = new MemoryReviewJobStore();
    await store2.enqueue(makeJob({ headSha: "leased-old" }));
    const leased = await store2.lease("engine-1", 60_000);
    expect(leased?.headSha).toBe("leased-old");
    await store2.enqueue(makeJob({ headSha: "newer" }));
    expect(store2.rows.find((row) => row.headSha === "leased-old")?.state).toBe("leased");
    expect(store2.rows.find((row) => row.headSha === "newer")?.state).toBe("queued");
  });

  test("retry of an in-flight SHA does not cancel a newer queued SHA", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob({ headSha: "sha1" }));
    const leased = await store.lease("engine-1", 60_000);
    expect(leased?.headSha).toBe("sha1");
    await store.enqueue(makeJob({ headSha: "sha2" }));
    expect(await store.enqueue(makeJob({ headSha: "sha1" }))).toEqual({
      key: "kirmanak/demo#7:sha1",
      queued: false,
    });
    expect(store.rows.find((row) => row.headSha === "sha1")?.state).toBe("leased");
    expect(store.rows.find((row) => row.headSha === "sha2")?.state).toBe("queued");
  });

  test("stale SHA retry does not insert or cancel a newer queued SHA", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob({ headSha: "sha2", prUpdatedAt: "2026-05-23T00:00:02Z", delivery: "d2" }));
    expect(
      await store.enqueue(makeJob({ headSha: "sha1", prUpdatedAt: "2026-05-23T00:00:01Z", delivery: "d1" }))
    ).toEqual({
      key: "kirmanak/demo#7:sha1",
      queued: false,
    });
    expect(store.rows.find((row) => row.headSha === "sha2")?.state).toBe("queued");
    expect(store.rows.find((row) => row.headSha === "sha1")).toBeUndefined();
  });

  test("SKIP LOCKED does not double-lease", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const [a, b] = await Promise.all([store.lease("e1", 60_000), store.lease("e2", 60_000)]);
    const leased = [a, b].filter(Boolean);
    expect(leased).toHaveLength(1);
    expect(leased[0]?.leasedBy === "e1" || leased[0]?.leasedBy === "e2").toBe(true);
  });

  test("two workers cannot double-lease the same implement row", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob());
    const [a, b] = await Promise.all([
      store.lease("worker-a", 60_000, undefined, WORKER_JOB_KINDS),
      store.lease("worker-b", 60_000, undefined, WORKER_JOB_KINDS),
    ]);
    const leased = [a, b].filter(Boolean);
    expect(leased).toHaveLength(1);
    expect(leased[0]?.kind).toBe("implement");
    expect(leased[0]?.leasedBy === "worker-a" || leased[0]?.leasedBy === "worker-b").toBe(true);
  });

  test("lease expiry reclaim requeues with attempt++", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 1, new Date(1_000));
    expect(leased?.attempt).toBe(0);
    const result = await store.reclaimExpired(2, new Date(5_000));
    expect(result.requeued).toHaveLength(1);
    expect(result.requeued[0]?.attempt).toBe(1);
    expect(result.requeued[0]?.state).toBe("queued");
    expect(result.publish).toHaveLength(0);
  });

  test("reclaim after max attempts publishes failure without requeue", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    await store.lease("engine-1", 1, new Date(1_000));
    await store.reclaimExpired(2, new Date(5_000));
    await store.lease("engine-1", 1, new Date(6_000));
    const result = await store.reclaimExpired(2, new Date(10_000));
    expect(result.requeued).toHaveLength(0);
    expect(result.publish).toHaveLength(1);
    expect(result.publish[0]?.attempt).toBe(2);
    expect(result.publish[0]?.error).toContain("max attempts");
    expect(result.publish[0]?.state).toBe("leased");
  });

  test("persist-ready reclaim extends leasedUntil so a second reclaim does not republish", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("dead-engine", 1, new Date(1_000));
    await store.saveResult(leased!.id, "dead-engine", {
      kind: "markdown",
      markdown: "Persisted review\n<!-- jumi-check: success -->",
    });
    const first = await store.reclaimExpired(2, new Date(5_000));
    expect(first.publish).toHaveLength(1);
    expect(first.publish[0]?.state).toBe("leased");
    expect(first.publish[0]?.leasedBy).toBe(RECLAIM_LEASED_BY);
    expect(first.publish[0]?.leasedUntil).toBe(5_000 + HEARTBEAT_MS);
    expect(store.rows[0]?.leasedUntil).toBe(5_000 + HEARTBEAT_MS);
    const second = await store.reclaimExpired(2, new Date(5_000));
    expect(second.publish).toHaveLength(0);
    expect(second.requeued).toHaveLength(0);
    expect(store.rows[0]?.state).toBe("leased");
    expect(store.rows[0]?.publishedAt).toBeNull();
  });

  test("expireLease nulls leasedBy so a late heartbeat cannot restore leasedUntil", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000, new Date(1_000));
    expect(leased?.leasedBy).toBe("engine-1");
    expect(await store.expireLease(leased!.id, "engine-1", new Date(2_000))).toBe(true);
    const expired = await store.get(leased!.id);
    expect(expired?.state).toBe("leased");
    expect(expired?.leasedBy).toBeNull();
    expect(expired?.leasedUntil).toBe(1_999);
    expect(await store.heartbeat(leased!.id, "engine-1", 60_000, new Date(3_000))).toBe(false);
    const after = await store.get(leased!.id);
    expect(after?.leasedBy).toBeNull();
    expect(after?.leasedUntil).toBe(1_999);
  });

  test("reclaim claim blocks original engine saveResult, expireLease, and markPublished", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("dead-engine", 1, new Date(1_000));
    await store.saveResult(leased!.id, "dead-engine", {
      kind: "markdown",
      markdown: "Persisted review\n<!-- jumi-check: success -->",
    });
    const reclaimed = await store.reclaimExpired(2, new Date(5_000));
    expect(reclaimed.publish[0]?.leasedBy).toBe(RECLAIM_LEASED_BY);

    await expect(store.saveResult(leased!.id, "dead-engine", { kind: "skip", reason: "late" })).rejects.toThrow(
      "cannot save result"
    );
    expect(store.rows[0]?.resultMarkdown).toContain("Persisted review");
    expect(store.rows[0]?.leasedBy).toBe(RECLAIM_LEASED_BY);

    expect(await store.expireLease(leased!.id, "dead-engine")).toBe(false);
    expect(store.rows[0]?.leasedBy).toBe(RECLAIM_LEASED_BY);
    expect(store.rows[0]?.leasedUntil).toBe(5_000 + HEARTBEAT_MS);

    await expect(store.markPublished(leased!.id, "dead-engine", { state: "succeeded" })).rejects.toThrow(
      "cannot mark published"
    );
    expect(store.rows[0]?.state).toBe("leased");
    expect(store.rows[0]?.leasedBy).toBe(RECLAIM_LEASED_BY);
  });

  test("releaseLease requeues without attempt++ and rejects persist-ready or foreign leases", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000, new Date(1_000));
    expect(leased?.attempt).toBe(0);
    expect(await store.releaseLease(leased!.id, "engine-other")).toBe(false);
    expect(store.rows[0]?.state).toBe("leased");
    expect(await store.releaseLease(leased!.id, "engine-1")).toBe(true);
    expect(store.rows[0]?.state).toBe("queued");
    expect(store.rows[0]?.leasedBy).toBeNull();
    expect(store.rows[0]?.leasedUntil).toBeNull();
    expect(store.rows[0]?.attempt).toBe(0);
    expect(await store.heartbeat(leased!.id, "engine-1", 60_000, new Date(3_000))).toBe(false);

    const persistStore = new MemoryReviewJobStore();
    await persistStore.enqueue(makeJob());
    const persist = await persistStore.lease("engine-1", 60_000);
    await persistStore.saveResult(persist!.id, "engine-1", {
      kind: "markdown",
      markdown: "Persisted review\n<!-- jumi-check: success -->",
    });
    expect(await persistStore.releaseLease(persist!.id, "engine-1")).toBe(false);
    expect(persistStore.rows[0]?.state).toBe("leased");
  });

  test("matching owner can expireLease; reclaim owner expire still lets the next tick retry", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000, new Date(1_000));
    expect(await store.expireLease(leased!.id, "engine-1", new Date(2_000))).toBe(true);
    expect(store.rows[0]?.leasedBy).toBeNull();
    expect(store.rows[0]?.leasedUntil).toBe(1_999);

    const store2 = new MemoryReviewJobStore();
    await store2.enqueue(makeJob());
    const persist = await store2.lease("dead-engine", 1, new Date(1_000));
    await store2.saveResult(persist!.id, "dead-engine", {
      kind: "markdown",
      markdown: "Persisted review\n<!-- jumi-check: success -->",
    });
    const claimed = await store2.reclaimExpired(2, new Date(5_000));
    expect(claimed.publish[0]?.leasedBy).toBe(RECLAIM_LEASED_BY);
    expect(await store2.expireLease(persist!.id, RECLAIM_LEASED_BY, new Date(6_000))).toBe(true);
    expect(store2.rows[0]?.leasedBy).toBeNull();
    expect(store2.rows[0]?.leasedUntil).toBe(5_999);
    const retry = await store2.reclaimExpired(2, new Date(7_000));
    expect(retry.publish).toHaveLength(1);
    expect(retry.publish[0]?.leasedBy).toBe(RECLAIM_LEASED_BY);
  });
});

type FakeSql = {
  unsafe(query: string, params?: unknown[]): Promise<unknown>;
  begin<T>(fn: (tx: FakeSql) => Promise<T>): Promise<T>;
};

function recordingSql(opts: { insertRows?: unknown[]; inflightRows?: unknown[]; doneRows?: unknown[] } = {}): {
  sql: FakeSql;
  queries: string[];
} {
  const queries: string[] = [];
  const sql: FakeSql = {
    async unsafe(query: string) {
      queries.push(query);
      if (query.includes("INSERT")) return opts.insertRows ?? [];
      if (query.includes("FOR UPDATE") && !query.includes("SKIP LOCKED")) return opts.inflightRows ?? [];
      if (query.includes("succeeded")) return opts.doneRows ?? [];
      return [];
    },
    async begin<T>(fn: (tx: FakeSql) => Promise<T>) {
      return fn(sql);
    },
  };
  return { sql, queries };
}

describe("PgReviewJobStore.enqueue", () => {
  test("retry of an in-flight job_key does not cancel queued successors", async () => {
    const { sql, queries } = recordingSql();
    const store = new PgReviewJobStore(sql);
    expect(await store.enqueue(makeJob({ headSha: "sha1" }))).toEqual({
      key: "kirmanak/demo#7:sha1",
      queued: false,
    });
    expect(queries.some((query) => query.includes("cancelled"))).toBe(false);
  });

  test("cancels queued predecessors only after a successful insert", async () => {
    const { sql, queries } = recordingSql({ insertRows: [{ id: 1 }] });
    const store = new PgReviewJobStore(sql);
    expect(await store.enqueue(makeJob({ headSha: "new" }))).toEqual({
      key: "kirmanak/demo#7:new",
      queued: true,
    });
    const insertAt = queries.findIndex((query) => query.includes("INSERT"));
    const cancelAt = queries.findIndex((query) => query.includes("cancelled"));
    expect(insertAt).toBeGreaterThanOrEqual(0);
    expect(cancelAt).toBeGreaterThan(insertAt);
  });

  test("does not insert or cancel when a queued SHA has a newer pr_updated_at", async () => {
    const { sql, queries } = recordingSql({
      inflightRows: [{ job_key: "kirmanak/demo#7:sha2", pr_updated_at: "2026-05-23T00:00:02Z" }],
    });
    const store = new PgReviewJobStore(sql);
    expect(await store.enqueue(makeJob({ headSha: "sha1", prUpdatedAt: "2026-05-23T00:00:01Z" }))).toEqual({
      key: "kirmanak/demo#7:sha1",
      queued: false,
    });
    expect(queries.some((query) => query.includes("INSERT"))).toBe(false);
    expect(queries.some((query) => query.includes("cancelled"))).toBe(false);
  });

  test("inserts after a non-terminal closed skip", async () => {
    const { sql, queries } = recordingSql({
      doneRows: [{ state: "skipped", result_reason: "PR is closed" }],
      insertRows: [{ id: 1 }],
    });
    const store = new PgReviewJobStore(sql);
    expect(await store.enqueue(makeJob())).toEqual({
      key: "kirmanak/demo#7:headsha",
      queued: true,
    });
    expect(queries.some((query) => query.includes("INSERT"))).toBe(true);
  });

  test("locks inflight rows FOR UPDATE in id order", async () => {
    const { sql, queries } = recordingSql();
    const store = new PgReviewJobStore(sql);
    await store.enqueue(makeJob());
    const inflight = queries.find((query) => query.includes("FOR UPDATE") && !query.includes("SKIP LOCKED"));
    expect(inflight).toContain("ORDER BY id");
  });

  test("does not insert after an incomplete-review skip", async () => {
    const { sql, queries } = recordingSql({
      doneRows: [{ state: "skipped", result_reason: "Incomplete review: no output" }],
    });
    const store = new PgReviewJobStore(sql);
    expect(await store.enqueue(makeJob())).toEqual({
      key: "kirmanak/demo#7:headsha",
      queued: false,
    });
    expect(queries.some((query) => query.includes("INSERT"))).toBe(false);
  });
});

describe("PgReviewJobStore expireLease", () => {
  test("nulls leased_by so a late heartbeat cannot restore leasedUntil", async () => {
    let leasedBy: string | null = "engine-1";
    let leasedUntil = new Date(Date.now() + 60_000).toISOString();
    const queries: string[] = [];
    const sql: FakeSql = {
      async unsafe(query: string, params?: unknown[]) {
        queries.push(query);
        if (query.includes("leased_by = NULL")) {
          if (!query.includes("leased_by = $2") || !query.includes("state = 'leased'")) return [];
          if (leasedBy !== params?.[1]) return [];
          leasedUntil = String(params?.[2]);
          leasedBy = null;
          return [{ id: 1 }];
        }
        if (query.includes("leased_by = $2") && query.includes("state = 'leased'")) {
          if (leasedBy !== params?.[1]) return [];
          leasedUntil = String(params?.[2]);
          return [{ id: 1 }];
        }
        return [];
      },
      async begin<T>(fn: (tx: FakeSql) => Promise<T>) {
        return fn(sql);
      },
    };
    const store = new PgReviewJobStore(sql);
    expect(await store.expireLease(1, "engine-1", new Date(2_000))).toBe(true);
    expect(queries.some((query) => query.includes("leased_by = $2") && query.includes("leased_by = NULL"))).toBe(true);
    expect(leasedBy).toBeNull();
    expect(leasedUntil).toBe(new Date(1_999).toISOString());
    expect(await store.heartbeat(1, "engine-1", 60_000, new Date(3_000))).toBe(false);
    expect(leasedUntil).toBe(new Date(1_999).toISOString());
  });
});

describe("PgReviewJobStore releaseLease", () => {
  test("requeues without a persisted result and no-ops persist-ready rows", async () => {
    let state = "leased";
    let leasedBy: string | null = "engine-1";
    let leasedUntil: string | null = new Date(Date.now() + 60_000).toISOString();
    let resultMarkdown: string | null = null;
    const queries: string[] = [];
    const sql: FakeSql = {
      async unsafe(query: string, params?: unknown[]) {
        queries.push(query);
        if (query.includes("state = 'queued'") && query.includes("leased_by = NULL")) {
          if (leasedBy !== params?.[1] || resultMarkdown) return [];
          state = "queued";
          leasedBy = null;
          leasedUntil = null;
          return [{ id: 1 }];
        }
        return [];
      },
      async begin<T>(fn: (tx: FakeSql) => Promise<T>) {
        return fn(sql);
      },
    };
    const store = new PgReviewJobStore(sql);
    expect(await store.releaseLease(1, "engine-1")).toBe(true);
    expect(
      queries.some((query) => query.includes("state = 'queued'") && query.includes("result_markdown IS NULL"))
    ).toBe(true);
    expect(state).toBe("queued");
    expect(leasedBy).toBeNull();
    expect(leasedUntil).toBeNull();

    state = "leased";
    leasedBy = "engine-1";
    resultMarkdown = "Persisted review";
    expect(await store.releaseLease(1, "engine-1")).toBe(false);
    expect(state).toBe("leased");
  });
});

describe("PgReviewJobStore saveResult and markPublished", () => {
  test("throws when no row is affected and requires leased_by", async () => {
    const queries: string[] = [];
    const sql: FakeSql = {
      async unsafe(query: string) {
        queries.push(query);
        return [];
      },
      async begin<T>(fn: (tx: FakeSql) => Promise<T>) {
        return fn(sql);
      },
    };
    const store = new PgReviewJobStore(sql);
    await expect(store.saveResult(1, "engine-1", { kind: "skip", reason: "late" })).rejects.toThrow(
      "cannot save result"
    );
    expect(queries.some((query) => query.includes("leased_by = $2") && query.includes("state = 'leased'"))).toBe(true);
    await expect(store.markPublished(1, "engine-1", { state: "succeeded" })).rejects.toThrow("cannot mark published");
    expect(queries.some((query) => query.includes("leased_by = $2") && query.includes("state = 'leased'"))).toBe(true);
  });
});

describe("PgReviewJobStore.reclaimExpired", () => {
  test("persist-ready reclaim updates leased_until so a second select does not republish", async () => {
    const persistRow = {
      id: 1,
      job_key: "kirmanak/demo#7:headsha",
      owner: "kirmanak",
      repo: "demo",
      pr_number: 7,
      head_sha: "headsha",
      delivery: "delivery-1",
      state: "leased",
      attempt: 0,
      leased_by: "dead-engine",
      leased_until: new Date(1_000).toISOString(),
      result_markdown: "Persisted review",
      result_reason: null,
      error: null,
      pending_status_at: null,
      published_at: null,
      pr_updated_at: null,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(1_000).toISOString(),
    };
    let leasedUntil = persistRow.leased_until;
    let leasedBy: string | null = persistRow.leased_by;
    const queries: string[] = [];
    const sql: FakeSql = {
      async unsafe(query: string, params?: unknown[]) {
        queries.push(query);
        if (query.includes("FOR UPDATE SKIP LOCKED")) {
          if (Date.parse(String(leasedUntil)) < Date.parse(String(params?.[0]))) {
            return [{ ...persistRow, leased_by: leasedBy, leased_until: leasedUntil }];
          }
          return [];
        }
        if (query.includes("UPDATE") && query.includes("leased_until")) {
          leasedBy = String(params?.[1]);
          leasedUntil = String(params?.[2]);
          return [{ ...persistRow, leased_by: leasedBy, leased_until: leasedUntil }];
        }
        return [];
      },
      async begin<T>(fn: (tx: FakeSql) => Promise<T>) {
        return fn(sql);
      },
    };
    const store = new PgReviewJobStore(sql);
    const first = await store.reclaimExpired(2, new Date(5_000), 30_000);
    expect(first.publish).toHaveLength(1);
    expect(first.publish[0]?.leasedBy).toBe(RECLAIM_LEASED_BY);
    expect(first.publish[0]?.leasedUntil).toBe(35_000);
    expect(queries.some((query) => query.includes("UPDATE") && query.includes("leased_until"))).toBe(true);
    const second = await store.reclaimExpired(2, new Date(5_000), 30_000);
    expect(second.publish).toHaveLength(0);
    expect(second.requeued).toHaveLength(0);
  });
});

describe("pgTextArrayLiteral", () => {
  test("formats closed job kinds as a postgres array literal, not a comma-string", () => {
    expect(pgTextArrayLiteral(["review"])).toBe("{review}");
    expect(pgTextArrayLiteral(["implement", "follow-up", "conflict"])).toBe("{implement,follow-up,conflict}");
    expect(pgTextArrayLiteral([])).toBe("{}");
  });

  test("refuses elements that would break the literal", () => {
    expect(() => pgTextArrayLiteral(["review,queued"])).toThrow(/refusing to bind/);
  });
});

describe("PgReviewJobStore kind ANY() bind", () => {
  test("lease/reclaim/cancel bind text[] literals instead of JS arrays", async () => {
    const captured: { query: string; params?: unknown[] }[] = [];
    const sql: FakeSql = {
      async unsafe(query: string, params?: unknown[]) {
        captured.push({ query, params });
        return [];
      },
      async begin<T>(fn: (tx: FakeSql) => Promise<T>) {
        return fn(sql);
      },
    };
    const store = new PgReviewJobStore(sql);

    await store.lease("engine-1", 60_000, new Date(0));
    const leaseReview = captured.find((row) => row.query.includes("state = 'queued' AND kind = ANY($3::text[])"));
    expect(leaseReview?.params?.[2]).toBe("{review}");
    expect(Array.isArray(leaseReview?.params?.[2])).toBe(false);

    captured.length = 0;
    await store.lease("worker-1", 60_000, new Date(0), WORKER_JOB_KINDS);
    const leaseWorker = captured.find((row) => row.query.includes("kind = ANY($3::text[])"));
    expect(leaseWorker?.params?.[2]).toBe("{implement,follow-up,conflict}");

    captured.length = 0;
    await store.reclaimExpired(2, new Date(5_000), 30_000, WORKER_JOB_KINDS);
    const reclaim = captured.find((row) => row.query.includes("kind = ANY($2::text[])"));
    expect(reclaim?.params?.[1]).toBe("{implement,follow-up,conflict}");

    captured.length = 0;
    await store.cancelQueuedForIssue("personal", "jumi", 149);
    const cancel = captured.find((row) => row.query.includes("kind = ANY($4::text[])"));
    expect(cancel?.params?.[3]).toBe("{implement,follow-up,conflict}");
  });
});
