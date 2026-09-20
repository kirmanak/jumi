import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createBunSqlClient,
  isUniqueViolation,
  MAX_ATTEMPTS_REASON,
  PgReviewJobStore,
  RECLAIM_LEASED_BY,
  WORKER_JOB_KINDS,
} from "../src/review_jobs.ts";
import type { SqlClient } from "../src/sql_client.ts";
import { makeIssueJob, makeJob } from "./fixtures.ts";

// The ledger invariants below live in Postgres, not in TypeScript: partial unique
// indexes, `FOR UPDATE SKIP LOCKED`, `ON CONFLICT ... WHERE`, and the migration that
// requeues duplicate worker leases before the index that forbids them. A fake `unsafe()`
// that matches substrings cannot fail when one of those clauses is deleted, so this file
// runs the real `PgReviewJobStore` against a real database. It is skipped when
// JUMI_TEST_DATABASE_URL is unset so `bun test` stays green without Docker.
const databaseUrl = process.env.JUMI_TEST_DATABASE_URL ?? "";
const pgRequired = process.env.JUMI_TEST_PG_REQUIRED === "1";

// A misspelled URL in CI would turn the whole suite below into a silent no-op, so the CI
// job that owns the service container also sets JUMI_TEST_PG_REQUIRED=1.
test("postgres queue suite is not silently skipped where CI requires it", () => {
  expect(pgRequired && databaseUrl === "").toBe(false);
});

const describePg = databaseUrl ? describe : describe.skip;

describePg("PgReviewJobStore against real postgres", () => {
  let sql!: SqlClient;
  let store!: PgReviewJobStore;

  function asRows<T>(result: unknown): T[] {
    return Array.isArray(result) ? (result as T[]) : [];
  }

  async function countJobs(where: string, params: unknown[] = []): Promise<number> {
    const rows = asRows<{ n: unknown }>(
      await sql.unsafe(`SELECT COUNT(*)::int AS n FROM review_jobs WHERE ${where}`, params)
    );
    return Number(rows[0]?.n ?? 0);
  }

  async function indexExists(name: string): Promise<boolean> {
    const rows = asRows<{ n: unknown }>(
      await sql.unsafe(`SELECT COUNT(*)::int AS n FROM pg_indexes WHERE indexname = $1`, [name])
    );
    return Number(rows[0]?.n ?? 0) > 0;
  }

  beforeAll(async () => {
    if (!databaseUrl) return;
    sql = createBunSqlClient(databaseUrl);
    store = new PgReviewJobStore(sql);
    // Start from an empty database so `migrate()` is exercised from scratch, not against
    // whatever a previous run left behind.
    await sql.unsafe(`DROP TABLE IF EXISTS review_jobs, issue_skip_latches`);
    await store.migrate();
  });

  beforeEach(async () => {
    if (!databaseUrl) return;
    await sql.unsafe(`TRUNCATE review_jobs, issue_skip_latches RESTART IDENTITY`);
    // Re-assert the schema: the migrate test drops an index on purpose.
    await store.migrate();
  });

  test("two workers racing for one issue end with exactly one lease", async () => {
    await store.enqueueIssue(makeIssueJob());
    await store.enqueueIssue(makeIssueJob({ mode: "follow-up", prNumber: 7, headSha: "sha1", delivery: "d2" }));
    expect(await countJobs(`state = 'queued'`)).toBe(2);

    const leased = (
      await Promise.all([
        store.lease("worker-a", 60_000, new Date(), WORKER_JOB_KINDS),
        store.lease("worker-b", 60_000, new Date(), WORKER_JOB_KINDS),
      ])
    ).filter((row) => row != null);

    expect(leased).toHaveLength(1);
    expect(leased[0]?.issueNumber).toBe(12);
    expect(await countJobs(`state = 'leased'`)).toBe(1);
    expect(await countJobs(`state = 'queued'`)).toBe(1);
  });

  test("partial unique index rejects a second leased worker row for the same issue", async () => {
    await store.enqueueIssue(makeIssueJob());
    await store.enqueueIssue(makeIssueJob({ mode: "follow-up", prNumber: 7, headSha: "sha1", delivery: "d2" }));
    const first = await store.lease("worker-a", 60_000, new Date(), WORKER_JOB_KINDS);
    expect(first?.kind).toBe("implement");

    const queued = asRows<{ id: unknown }>(await sql.unsafe(`SELECT id FROM review_jobs WHERE state = 'queued'`));
    expect(queued).toHaveLength(1);

    let err: unknown;
    try {
      await sql.unsafe(
        `UPDATE review_jobs
         SET state = 'leased', leased_by = 'worker-b', leased_until = NOW() + interval '1 minute'
         WHERE id = $1`,
        [Number(queued[0]?.id)]
      );
    } catch (caught) {
      err = caught;
    }
    // The index name is in the server message, so this assertion fails if the partial
    // unique index is dropped from the schema rather than merely renamed around it.
    expect(String(err)).toContain("review_jobs_leased_worker_issue");
    // `lease()` swallows exactly this error class to retry; a real driver error, not a fake.
    expect(isUniqueViolation(err)).toBe(true);
    expect(await countJobs(`state = 'leased'`)).toBe(1);
  });

  test("a lease that loses the index race retries and comes back empty", async () => {
    await store.enqueueIssue(makeIssueJob());
    await store.enqueueIssue(makeIssueJob({ mode: "follow-up", prNumber: 7, headSha: "sha1", delivery: "d2" }));
    const ids = asRows<{ id: unknown }>(await sql.unsafe(`SELECT id FROM review_jobs ORDER BY id`));
    expect(ids).toHaveLength(2);

    // Hold an uncommitted lease on the first row. The second lease cannot see it yet, so it
    // runs the whole NOT EXISTS / SKIP LOCKED path and only collides at the unique index.
    let commit!: () => void;
    const gate = new Promise<void>((resolve) => {
      commit = resolve;
    });
    const holder = sql.begin(async (tx) => {
      await tx.unsafe(
        `UPDATE review_jobs
         SET state = 'leased', leased_by = 'worker-holder', leased_until = NOW() + interval '1 hour'
         WHERE id = $1`,
        [Number(ids[0]?.id)]
      );
      await gate;
    });

    await Bun.sleep(100);
    const blocked = store.lease("worker-b", 60_000, new Date(), WORKER_JOB_KINDS);
    await Bun.sleep(100);
    commit();
    await holder;

    // Not an error: 23505 here means "someone else got the issue", and the retry finds the
    // now-visible lease. A lease() that rethrew would read as a dead queue to the worker.
    expect(await blocked).toBeUndefined();
    expect(await countJobs(`state = 'leased'`)).toBe(1);
    expect(await countJobs(`state = 'queued'`)).toBe(1);
  });

  test("a blocked issue does not starve another issue, and unblocks when the lease ends", async () => {
    await store.enqueueIssue(makeIssueJob());
    await store.enqueueIssue(makeIssueJob({ mode: "follow-up", prNumber: 7, headSha: "sha1", delivery: "d2" }));
    await store.enqueueIssue(
      makeIssueJob({
        issueNumber: 13,
        htmlUrl: "https://gitea.kirmanak.stream/kirmanak/demo/issues/13",
        delivery: "d3",
      })
    );

    const first = await store.lease("worker-a", 60_000, new Date(), WORKER_JOB_KINDS);
    expect(first?.issueNumber).toBe(12);
    expect(first?.kind).toBe("implement");

    // Without the NOT EXISTS guard the oldest runnable row is issue 12's follow-up, whose
    // UPDATE trips the unique index; the lease would come back empty and issue 13 would
    // wait behind a job it has nothing to do with.
    const second = await store.lease("worker-b", 60_000, new Date(), WORKER_JOB_KINDS);
    expect(second?.issueNumber).toBe(13);

    await store.markPublished(first!.id, "worker-a", { state: "succeeded" });
    const third = await store.lease("worker-c", 60_000, new Date(), WORKER_JOB_KINDS);
    expect(third?.issueNumber).toBe(12);
    expect(third?.kind).toBe("follow-up");
  });

  test("reclaim requeues an expired lease and publishes failure at the attempt cap", async () => {
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000);
    expect(leased?.attempt).toBe(0);

    const live = await store.reclaimExpired(2);
    expect(live.requeued).toHaveLength(0);
    expect(live.publish).toHaveLength(0);

    expect(await store.expireLease(leased!.id, "engine-1")).toBe(true);
    const first = await store.reclaimExpired(2);
    expect(first.publish).toHaveLength(0);
    expect(first.requeued).toHaveLength(1);
    expect(first.requeued[0]?.attempt).toBe(1);
    expect(first.requeued[0]?.state).toBe("queued");

    const retried = await store.lease("engine-2", 60_000);
    expect(retried?.id).toBe(leased!.id);
    expect(retried?.attempt).toBe(1);
    expect(await store.expireLease(retried!.id, "engine-2")).toBe(true);

    const second = await store.reclaimExpired(2);
    expect(second.requeued).toHaveLength(0);
    expect(second.publish).toHaveLength(1);
    expect(second.publish[0]?.attempt).toBe(2);
    expect(second.publish[0]?.state).toBe("leased");
    expect(second.publish[0]?.leasedBy).toBe(RECLAIM_LEASED_BY);
    expect(second.publish[0]?.error).toBe(MAX_ATTEMPTS_REASON);
    expect(second.publish[0]?.resultReason).toBe(MAX_ATTEMPTS_REASON);

    const stored = await store.get(leased!.id);
    expect(stored?.state).toBe("leased");
    expect(stored?.leasedBy).toBe(RECLAIM_LEASED_BY);
    expect(stored?.leasedUntil ?? 0).toBeGreaterThan(Date.now());
  });

  test("concurrent enqueue of one job_key inserts exactly one in-flight row", async () => {
    const job = makeJob();
    const key = "kirmanak/demo#7:headsha";
    const results = await Promise.all([store.enqueue(job), store.enqueue(job)]);

    expect(results.map((result) => result.key)).toEqual([key, key]);
    expect(results.filter((result) => result.queued)).toHaveLength(1);
    expect(await countJobs(`job_key = $1`, [key])).toBe(1);
  });

  test("in-flight dedupe index is partial: a terminal row does not block the next attempt", async () => {
    const job = makeJob();
    const key = "kirmanak/demo#7:headsha";
    expect(await store.enqueue(job)).toEqual({ key, queued: true });
    const leased = await store.lease("engine-1", 60_000);
    await store.markPublished(leased!.id, "engine-1", { state: "failed", reason: "boom" });

    expect(await store.enqueue(job)).toEqual({ key, queued: true });
    expect(await countJobs(`job_key = $1`, [key])).toBe(2);
    expect(await countJobs(`job_key = $1 AND state IN ('queued', 'leased')`, [key])).toBe(1);
  });

  test("migrate is idempotent and requeues extra leased worker rows before the unique index", async () => {
    expect(await indexExists("review_jobs_leased_worker_issue")).toBe(true);

    // Reproduce a pre-index ledger: two leased worker rows on one issue.
    await sql.unsafe(`DROP INDEX review_jobs_leased_worker_issue`);
    await sql.unsafe(
      `INSERT INTO review_jobs (
         job_key, kind, owner, repo, pr_number, head_sha, issue_number, delivery, state, attempt, leased_by, leased_until
       ) VALUES
         ($1, 'implement', 'kirmanak', 'demo', 0, '', 12, 'd1', 'leased', 0, 'worker-a', NOW() + interval '1 hour'),
         ($2, 'follow-up', 'kirmanak', 'demo', 7, 'sha1', 12, 'd2', 'leased', 0, 'worker-b', NOW() + interval '1 hour')`,
      ["implement:kirmanak/demo#12", "follow-up:kirmanak/demo#7:sha1"]
    );

    await store.migrate();
    const after = asRows<{ kind: unknown; state: unknown; leased_by: unknown }>(
      await sql.unsafe(`SELECT kind, state, leased_by FROM review_jobs ORDER BY id`)
    );
    expect(after.map((row) => String(row.state))).toEqual(["leased", "queued"]);
    expect(String(after[0]?.leased_by)).toBe("worker-a");
    expect(after[1]?.leased_by).toBeNull();
    expect(await indexExists("review_jobs_leased_worker_issue")).toBe(true);

    // Migrate again: every statement in the schema must survive a second run.
    await store.migrate();
    expect(await countJobs(`state = 'leased'`)).toBe(1);
    expect(await indexExists("review_jobs_leased_worker_issue")).toBe(true);
    expect(await indexExists("review_jobs_inflight_job_key")).toBe(true);
  });
});
