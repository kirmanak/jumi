import { isInfraRetryMarker } from "./infra.ts";
import type { EnqueueResult } from "./queue.ts";
import { isTerminalSkipReason, type PersistReviewResult, reviewJobKey } from "./review.ts";
import { createBunSqlClient, pgTextArrayLiteral, type SqlClient, wrapSqlError } from "./sql_client.ts";
import type { IssueJob, IssueJobTrigger, ReviewJob } from "./types.ts";

export {
  createBunSqlClient,
  isQueueUnavailable,
  pgTextArrayLiteral,
  QueueUnavailableError,
} from "./sql_client.ts";

export const REVIEW_JOB_STATES = ["queued", "leased", "succeeded", "skipped", "failed", "cancelled"] as const;
export type ReviewJobState = (typeof REVIEW_JOB_STATES)[number];

export const JOB_KINDS = ["review", "implement", "follow-up", "conflict"] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export const REVIEW_KIND: JobKind = "review";
export const WORKER_JOB_KINDS: readonly JobKind[] = ["implement", "follow-up", "conflict"];

export interface IssueJobPayload {
  issueNumber: number;
  title: string;
  body: string;
  htmlUrl: string;
  issueUpdatedAt: string;
  defaultBranch: string;
  cloneUrl: string;
  action: string;
  trigger?: IssueJobTrigger;
}

export const MAX_ATTEMPTS_REASON = "Jumi review failed: max attempts exceeded";
export const HEARTBEAT_MS = 30_000;
export const QUEUE_POLL_MS = 1_000;
export const RECLAIM_LEASED_BY = "reclaim";

export type { PersistReviewResult };

export interface ReviewJobRecord {
  id: number;
  jobKey: string;
  kind: JobKind;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  issueNumber: number | null;
  payload: IssueJobPayload | null;
  delivery: string;
  state: ReviewJobState;
  attempt: number;
  leasedBy: string | null;
  leasedUntil: number | null;
  resultMarkdown: string | null;
  resultReason: string | null;
  error: string | null;
  pendingStatusAt: number | null;
  publishedAt: number | null;
  prUpdatedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ReclaimResult {
  requeued: ReviewJobRecord[];
  publish: ReviewJobRecord[];
}

export interface ReviewJobStore {
  migrate(): Promise<void>;
  enqueue(job: ReviewJob): Promise<EnqueueResult>;
  enqueueIssue(job: IssueJob): Promise<EnqueueResult>;
  drop(key: string): Promise<boolean>;
  lease(
    leasedBy: string,
    leaseMs: number,
    now?: Date,
    kinds?: readonly JobKind[]
  ): Promise<ReviewJobRecord | undefined>;
  heartbeat(id: number, leasedBy: string, leaseMs: number, now?: Date): Promise<boolean>;
  expireLease(id: number, leasedBy: string, now?: Date): Promise<boolean>;
  requeueInfra(id: number, leasedBy: string, backoffMs: number, marker: string, now?: Date): Promise<boolean>;
  releaseLease(id: number, leasedBy: string): Promise<boolean>;
  saveResult(id: number, leasedBy: string, result: PersistReviewResult): Promise<void>;
  markPublished(
    id: number,
    leasedBy: string,
    outcome: { state: "succeeded" | "skipped" | "failed"; reason?: string }
  ): Promise<void>;
  reclaimExpired(maxAttempts: number, now?: Date, leaseMs?: number, kinds?: readonly JobKind[]): Promise<ReclaimResult>;
  cancelQueuedForIssue(owner: string, repo: string, issueNumber: number): Promise<number>;
  countSucceeded(kind: JobKind, owner: string, repo: string, issueNumber: number): Promise<number>;
  countByState(): Promise<Record<ReviewJobState, number>>;
  get(id: number): Promise<ReviewJobRecord | undefined>;
}

export const REVIEW_JOBS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS review_jobs (
  id BIGSERIAL PRIMARY KEY,
  job_key TEXT NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  delivery TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'succeeded', 'skipped', 'failed', 'cancelled')),
  attempt INTEGER NOT NULL DEFAULT 0,
  leased_by TEXT,
  leased_until TIMESTAMPTZ,
  result_markdown TEXT,
  result_reason TEXT,
  error TEXT,
  pending_status_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  pr_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS review_jobs_inflight_job_key
  ON review_jobs (job_key)
  WHERE state IN ('queued', 'leased');

CREATE INDEX IF NOT EXISTS review_jobs_queued_created
  ON review_jobs (created_at, id)
  WHERE state = 'queued';

CREATE INDEX IF NOT EXISTS review_jobs_leased_until
  ON review_jobs (leased_until)
  WHERE state = 'leased';

ALTER TABLE review_jobs ADD COLUMN IF NOT EXISTS pr_updated_at TIMESTAMPTZ;
ALTER TABLE review_jobs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'review';
ALTER TABLE review_jobs ADD COLUMN IF NOT EXISTS issue_number INTEGER;
ALTER TABLE review_jobs ADD COLUMN IF NOT EXISTS payload JSONB;

CREATE INDEX IF NOT EXISTS review_jobs_queued_kind_created
  ON review_jobs (kind, created_at, id)
  WHERE state = 'queued';

UPDATE review_jobs
SET state = 'queued', leased_by = NULL, leased_until = NULL, updated_at = NOW()
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY owner, repo, issue_number
      ORDER BY id ASC
    ) AS rn
    FROM review_jobs
    WHERE state = 'leased'
      AND kind IN ('implement', 'follow-up', 'conflict')
      AND issue_number IS NOT NULL
  ) ranked
  WHERE rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS review_jobs_leased_worker_issue
  ON review_jobs (owner, repo, issue_number)
  WHERE state = 'leased' AND kind IN ('implement', 'follow-up', 'conflict') AND issue_number IS NOT NULL;
`;

export function hasPersistedResult(row: ReviewJobRecord): boolean {
  if (row.resultMarkdown || row.resultReason) return true;
  return Boolean(row.error && !isInfraRetryMarker(row.error));
}

function isTerminalOutcome(state: ReviewJobState, reason: string | null | undefined): boolean {
  return state === "succeeded" || (state === "skipped" && isTerminalSkipReason(reason));
}

function jobPrUpdatedAtMs(job: ReviewJob): number | null {
  if (!job.prUpdatedAt) return null;
  const parsed = Date.parse(job.prUpdatedAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function isSamePullRequest(
  row: { owner: string; repo: string; prNumber: number },
  job: { owner: string; repo: string; prNumber: number }
): boolean {
  return row.owner === job.owner && row.repo === job.repo && row.prNumber === job.prNumber;
}

function rowKind(row: { kind?: JobKind | null }): JobKind {
  return row.kind || REVIEW_KIND;
}

function hasNewerInflight(rows: ReviewJobRecord[], job: ReviewJob, key: string): boolean {
  const incomingTs = jobPrUpdatedAtMs(job);
  if (incomingTs == null) return false;
  return rows.some(
    (row) =>
      rowKind(row) === REVIEW_KIND &&
      isSamePullRequest(row, job) &&
      (row.state === "queued" || row.state === "leased") &&
      row.jobKey !== key &&
      row.prUpdatedAt != null &&
      row.prUpdatedAt > incomingTs
  );
}

export function workerJobKind(job: IssueJob): JobKind {
  return job.mode ?? "implement";
}

export function workerJobKey(job: IssueJob): string {
  const kind = workerJobKind(job);
  if (kind === "implement") return `implement:${job.owner}/${job.repo}#${job.issueNumber}`;
  return `${kind}:${job.owner}/${job.repo}#${job.prNumber ?? 0}:${job.headSha ?? ""}`;
}

export function issueJobPayload(job: IssueJob): IssueJobPayload {
  return {
    issueNumber: job.issueNumber,
    title: job.title,
    body: job.body,
    htmlUrl: job.htmlUrl,
    issueUpdatedAt: job.issueUpdatedAt,
    defaultBranch: job.defaultBranch,
    cloneUrl: job.cloneUrl,
    action: job.action,
    trigger: job.trigger,
  };
}

export function issueJobFromRecord(row: ReviewJobRecord): IssueJob {
  const payload = row.payload;
  if (!payload) throw new Error(`job ${row.id} missing payload`);
  const kind = rowKind(row);
  return {
    delivery: row.delivery,
    owner: row.owner,
    repo: row.repo,
    issueNumber: payload.issueNumber,
    action: payload.action,
    title: payload.title,
    body: payload.body,
    htmlUrl: payload.htmlUrl,
    issueUpdatedAt: payload.issueUpdatedAt,
    defaultBranch: payload.defaultBranch,
    cloneUrl: payload.cloneUrl,
    receivedAt: new Date(row.createdAt).toISOString(),
    mode: kind === "review" ? undefined : kind,
    prNumber: row.prNumber || undefined,
    headSha: row.headSha || undefined,
    trigger: payload.trigger,
  };
}

function parsePayload(value: unknown): IssueJobPayload | null {
  if (value == null) return null;
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const rec = parsed as Partial<IssueJobPayload>;
  if (typeof rec.issueNumber !== "number" || typeof rec.title !== "string") return null;
  return {
    issueNumber: rec.issueNumber,
    title: rec.title,
    body: typeof rec.body === "string" ? rec.body : "",
    htmlUrl: typeof rec.htmlUrl === "string" ? rec.htmlUrl : "",
    issueUpdatedAt: typeof rec.issueUpdatedAt === "string" ? rec.issueUpdatedAt : "",
    defaultBranch: typeof rec.defaultBranch === "string" ? rec.defaultBranch : "",
    cloneUrl: typeof rec.cloneUrl === "string" ? rec.cloneUrl : "",
    action: typeof rec.action === "string" ? rec.action : "",
    trigger: rec.trigger,
  };
}

function kindsOrReview(kinds?: readonly JobKind[]): readonly JobKind[] {
  return kinds && kinds.length > 0 ? kinds : [REVIEW_KIND];
}

function isWorkerKind(kind: JobKind): boolean {
  return WORKER_JOB_KINDS.includes(kind);
}

function sameWorkerIssue(
  left: { owner: string; repo: string; issueNumber: number | null },
  right: { owner: string; repo: string; issueNumber: number | null }
): boolean {
  return left.owner === right.owner && left.repo === right.repo && left.issueNumber === right.issueNumber;
}

function workerIssueIsLeased(
  rows: readonly ReviewJobRecord[],
  candidate: { owner: string; repo: string; issueNumber: number | null }
): boolean {
  return rows.some(
    (held) => held.state === "leased" && isWorkerKind(rowKind(held)) && sameWorkerIssue(held, candidate)
  );
}

function leasesWorkerKinds(kinds: readonly JobKind[]): boolean {
  return kinds.some((kind) => isWorkerKind(kind));
}

function isImplementTerminal(
  row: Pick<ReviewJobRecord, "kind" | "state" | "resultReason" | "payload">,
  job: IssueJob
): boolean {
  if (rowKind(row) !== "implement") return false;
  if (row.state === "succeeded") return true;
  return (
    row.state === "skipped" && row.resultReason === "no-changes" && row.payload?.issueUpdatedAt === job.issueUpdatedAt
  );
}

function emptyCounts(): Record<ReviewJobState, number> {
  return { queued: 0, leased: 0, succeeded: 0, skipped: 0, failed: 0, cancelled: 0 };
}

export class MemoryReviewJobStore implements ReviewJobStore {
  readonly rows: ReviewJobRecord[] = [];
  private nextId = 1;
  private chain = Promise.resolve();

  private locked<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async migrate(): Promise<void> {}

  enqueue(job: ReviewJob): Promise<EnqueueResult> {
    return this.locked(() => {
      const key = reviewJobKey(job);
      const now = Date.now();
      const sameKey = this.rows.filter((row) => row.jobKey === key);
      if (sameKey.some((row) => isTerminalOutcome(row.state, row.resultReason))) {
        return { key, queued: false };
      }
      if (sameKey.some((row) => row.state === "queued" || row.state === "leased")) {
        return { key, queued: false };
      }
      if (hasNewerInflight(this.rows, job, key)) {
        return { key, queued: false };
      }
      const incomingTs = jobPrUpdatedAtMs(job);
      for (const row of this.rows) {
        if (
          rowKind(row) === REVIEW_KIND &&
          isSamePullRequest(row, job) &&
          row.state === "queued" &&
          row.jobKey !== key &&
          (incomingTs == null || row.prUpdatedAt == null || row.prUpdatedAt <= incomingTs)
        ) {
          row.state = "cancelled";
          row.updatedAt = now;
        }
      }
      this.rows.push({
        id: this.nextId++,
        jobKey: key,
        kind: REVIEW_KIND,
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        headSha: job.headSha,
        issueNumber: null,
        payload: null,
        delivery: job.delivery,
        state: "queued",
        attempt: 0,
        leasedBy: null,
        leasedUntil: null,
        resultMarkdown: null,
        resultReason: null,
        error: null,
        pendingStatusAt: null,
        publishedAt: null,
        prUpdatedAt: incomingTs,
        createdAt: now,
        updatedAt: now,
      });
      return { key, queued: true };
    });
  }

  enqueueIssue(job: IssueJob): Promise<EnqueueResult> {
    return this.locked(() => {
      const key = workerJobKey(job);
      const kind = workerJobKind(job);
      const now = Date.now();
      const sameKey = this.rows.filter((row) => row.jobKey === key);
      if (sameKey.some((row) => row.state === "queued" || row.state === "leased")) {
        return { key, queued: false };
      }
      if (kind === "implement" && sameKey.some((row) => isImplementTerminal(row, job))) {
        return { key, queued: false };
      }
      if (kind !== "implement" && job.prNumber) {
        for (const row of this.rows) {
          if (
            rowKind(row) === kind &&
            isSamePullRequest(row, { owner: job.owner, repo: job.repo, prNumber: job.prNumber }) &&
            row.state === "queued" &&
            row.jobKey !== key
          ) {
            row.state = "cancelled";
            row.updatedAt = now;
          }
        }
      }
      this.rows.push({
        id: this.nextId++,
        jobKey: key,
        kind,
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber ?? 0,
        headSha: job.headSha ?? "",
        issueNumber: job.issueNumber,
        payload: issueJobPayload(job),
        delivery: job.delivery,
        state: "queued",
        attempt: 0,
        leasedBy: null,
        leasedUntil: null,
        resultMarkdown: null,
        resultReason: null,
        error: null,
        pendingStatusAt: null,
        publishedAt: null,
        prUpdatedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      return { key, queued: true };
    });
  }

  drop(key: string): Promise<boolean> {
    return this.locked(() => {
      const row = this.rows.find((item) => item.jobKey === key && item.state === "queued");
      if (!row) return false;
      row.state = "cancelled";
      row.updatedAt = Date.now();
      return true;
    });
  }

  lease(
    leasedBy: string,
    leaseMs: number,
    now = new Date(),
    kinds?: readonly JobKind[]
  ): Promise<ReviewJobRecord | undefined> {
    return this.locked(() => {
      const allowed = kindsOrReview(kinds);
      const serializeWorkers = leasesWorkerKinds(allowed);
      const ts = now.getTime();
      const row = this.rows.find((item) => {
        if (item.state !== "queued" || !allowed.includes(rowKind(item))) return false;
        if (item.leasedUntil != null && item.leasedUntil > ts) return false;
        if (serializeWorkers && isWorkerKind(rowKind(item)) && workerIssueIsLeased(this.rows, item)) return false;
        return true;
      });
      if (!row) return undefined;
      row.state = "leased";
      row.leasedBy = leasedBy;
      row.leasedUntil = ts + leaseMs;
      row.updatedAt = ts;
      return { ...row };
    });
  }

  heartbeat(id: number, leasedBy: string, leaseMs: number, now = new Date()): Promise<boolean> {
    return this.locked(() => {
      const row = this.rows.find((item) => item.id === id);
      if (row?.state !== "leased" || row.leasedBy !== leasedBy) return false;
      const ts = now.getTime();
      row.leasedUntil = ts + leaseMs;
      row.updatedAt = ts;
      return true;
    });
  }

  expireLease(id: number, leasedBy: string, now = new Date()): Promise<boolean> {
    return this.locked(() => {
      const row = this.rows.find((item) => item.id === id);
      if (row?.state !== "leased" || row.leasedBy !== leasedBy) return false;
      const ts = now.getTime();
      row.leasedUntil = ts - 1;
      row.leasedBy = null;
      row.updatedAt = ts;
      return true;
    });
  }

  requeueInfra(id: number, leasedBy: string, backoffMs: number, marker: string, now = new Date()): Promise<boolean> {
    return this.locked(() => {
      const row = this.rows.find((item) => item.id === id);
      if (row?.state !== "leased" || row.leasedBy !== leasedBy) return false;
      if (hasPersistedResult(row)) return false;
      const ts = now.getTime();
      row.state = "queued";
      row.leasedBy = null;
      row.leasedUntil = ts + backoffMs;
      row.error = marker;
      row.updatedAt = ts;
      return true;
    });
  }

  releaseLease(id: number, leasedBy: string): Promise<boolean> {
    return this.locked(() => {
      const row = this.rows.find((item) => item.id === id);
      if (row?.state !== "leased" || row.leasedBy !== leasedBy) return false;
      if (hasPersistedResult(row)) return false;
      const ts = Date.now();
      row.state = "queued";
      row.leasedBy = null;
      row.leasedUntil = null;
      row.updatedAt = ts;
      return true;
    });
  }

  saveResult(id: number, leasedBy: string, result: PersistReviewResult): Promise<void> {
    return this.locked(() => {
      const row = this.rows.find((item) => item.id === id);
      if (row?.state !== "leased" || row.leasedBy !== leasedBy) throw new Error(`cannot save result for job ${id}`);
      if (result.kind === "markdown") {
        row.resultMarkdown = result.markdown;
        row.resultReason = null;
        row.error = null;
      } else if (result.kind === "skip") {
        row.resultReason = result.reason;
        row.resultMarkdown = null;
      } else {
        row.error = result.error;
        row.resultReason = result.error;
        row.resultMarkdown = null;
      }
      row.updatedAt = Date.now();
    });
  }

  markPublished(
    id: number,
    leasedBy: string,
    outcome: { state: "succeeded" | "skipped" | "failed"; reason?: string }
  ): Promise<void> {
    return this.locked(() => {
      const row = this.rows.find((item) => item.id === id);
      if (row?.state !== "leased" || row.leasedBy !== leasedBy) throw new Error(`cannot mark published for job ${id}`);
      const ts = Date.now();
      row.state = outcome.state;
      if (outcome.reason) row.resultReason = outcome.reason;
      row.publishedAt = ts;
      row.leasedBy = null;
      row.leasedUntil = null;
      row.updatedAt = ts;
    });
  }

  reclaimExpired(
    maxAttempts: number,
    now = new Date(),
    leaseMs = HEARTBEAT_MS,
    kinds?: readonly JobKind[]
  ): Promise<ReclaimResult> {
    return this.locked(() => {
      const allowed = kindsOrReview(kinds);
      const ts = now.getTime();
      const claimedUntil = ts + leaseMs;
      const requeued: ReviewJobRecord[] = [];
      const publish: ReviewJobRecord[] = [];
      for (const row of this.rows) {
        if (row.state !== "leased" || row.leasedUntil == null || row.leasedUntil >= ts) continue;
        if (!allowed.includes(rowKind(row))) continue;
        if (hasPersistedResult(row)) {
          row.leasedBy = RECLAIM_LEASED_BY;
          row.leasedUntil = claimedUntil;
          row.updatedAt = ts;
          publish.push({ ...row });
          continue;
        }
        row.attempt += 1;
        row.updatedAt = ts;
        if (isInfraRetryMarker(row.error)) row.error = null;
        if (row.attempt >= maxAttempts) {
          row.error = MAX_ATTEMPTS_REASON;
          row.resultReason = MAX_ATTEMPTS_REASON;
          row.leasedBy = RECLAIM_LEASED_BY;
          row.leasedUntil = claimedUntil;
          publish.push({ ...row });
          continue;
        }
        row.state = "queued";
        row.leasedBy = null;
        row.leasedUntil = null;
        requeued.push({ ...row });
      }
      return { requeued, publish };
    });
  }

  countByState(): Promise<Record<ReviewJobState, number>> {
    return this.locked(() => {
      const counts = emptyCounts();
      for (const row of this.rows) counts[row.state]++;
      return counts;
    });
  }

  get(id: number): Promise<ReviewJobRecord | undefined> {
    return this.locked(() => {
      const row = this.rows.find((item) => item.id === id);
      return row ? { ...row } : undefined;
    });
  }

  cancelQueuedForIssue(owner: string, repo: string, issueNumber: number): Promise<number> {
    return this.locked(() => {
      const now = Date.now();
      let n = 0;
      for (const row of this.rows) {
        if (row.owner !== owner || row.repo !== repo || row.issueNumber !== issueNumber) continue;
        if (!WORKER_JOB_KINDS.includes(rowKind(row))) continue;
        if (row.state !== "queued" && row.state !== "leased") continue;
        row.state = "cancelled";
        row.leasedBy = null;
        row.leasedUntil = null;
        row.updatedAt = now;
        n++;
      }
      return n;
    });
  }

  countSucceeded(kind: JobKind, owner: string, repo: string, issueNumber: number): Promise<number> {
    return this.locked(() => {
      return this.rows.filter(
        (row) =>
          rowKind(row) === kind &&
          row.owner === owner &&
          row.repo === repo &&
          row.issueNumber === issueNumber &&
          row.state === "succeeded"
      ).length;
    });
  }
}

type ReviewJobRow = {
  id: unknown;
  job_key: unknown;
  kind: unknown;
  owner: unknown;
  repo: unknown;
  pr_number: unknown;
  head_sha: unknown;
  issue_number: unknown;
  payload: unknown;
  delivery: unknown;
  state: unknown;
  attempt: unknown;
  leased_by: unknown;
  leased_until: unknown;
  result_markdown: unknown;
  result_reason: unknown;
  error: unknown;
  pending_status_at: unknown;
  published_at: unknown;
  pr_updated_at: unknown;
  created_at: unknown;
  updated_at: unknown;
};

export function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
    const rec = current as { code?: unknown; sqlState?: unknown; cause?: unknown };
    for (const value of [rec.code, rec.sqlState]) {
      if (value === "23505" || value === 23505) return true;
    }
    current = rec.cause;
  }
  return false;
}

function asRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function num(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  if (typeof value === "string" && value !== "") return Number(value);
  throw new Error(`expected number, got ${typeof value}`);
}

function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

function strOrNull(value: unknown): string | null {
  if (value == null) return null;
  return String(value);
}

function epoch(value: unknown): number | null {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function epochRequired(value: unknown): number {
  return epoch(value) ?? Date.now();
}

function mapRow(row: ReviewJobRow): ReviewJobRecord {
  return {
    id: num(row.id),
    jobKey: str(row.job_key),
    kind: (str(row.kind) || REVIEW_KIND) as JobKind,
    owner: str(row.owner),
    repo: str(row.repo),
    prNumber: num(row.pr_number),
    headSha: str(row.head_sha),
    issueNumber: row.issue_number == null || row.issue_number === "" ? null : num(row.issue_number),
    payload: parsePayload(row.payload),
    delivery: str(row.delivery),
    state: str(row.state) as ReviewJobState,
    attempt: num(row.attempt),
    leasedBy: strOrNull(row.leased_by),
    leasedUntil: epoch(row.leased_until),
    resultMarkdown: strOrNull(row.result_markdown),
    resultReason: strOrNull(row.result_reason),
    error: strOrNull(row.error),
    pendingStatusAt: epoch(row.pending_status_at),
    publishedAt: epoch(row.published_at),
    prUpdatedAt: epoch(row.pr_updated_at),
    createdAt: epochRequired(row.created_at),
    updatedAt: epochRequired(row.updated_at),
  };
}

export class PgReviewJobStore implements ReviewJobStore {
  constructor(private readonly sql: SqlClient) {}

  async migrate(): Promise<void> {
    try {
      await this.sql.unsafe(REVIEW_JOBS_SCHEMA_SQL);
    } catch (err) {
      wrapSqlError(err);
    }
  }

  async enqueue(job: ReviewJob): Promise<EnqueueResult> {
    const key = reviewJobKey(job);
    const prUpdatedAt = job.prUpdatedAt ?? null;
    return this.sql.begin(async (tx) => {
      const done = asRows<{ state: unknown; result_reason: unknown }>(
        await tx.unsafe(
          `SELECT state, result_reason FROM review_jobs WHERE job_key = $1 AND state IN ('succeeded', 'skipped')`,
          [key]
        )
      );
      if (done.some((row) => isTerminalOutcome(str(row.state) as ReviewJobState, strOrNull(row.result_reason)))) {
        return { key, queued: false };
      }

      const inflight = asRows<{ job_key: unknown; pr_updated_at: unknown }>(
        await tx.unsafe(
          `SELECT job_key, pr_updated_at FROM review_jobs
           WHERE owner = $1 AND repo = $2 AND pr_number = $3 AND kind = $4 AND state IN ('queued', 'leased')
           ORDER BY id
           FOR UPDATE`,
          [job.owner, job.repo, job.prNumber, REVIEW_KIND]
        )
      );
      if (inflight.some((row) => str(row.job_key) === key)) return { key, queued: false };
      const incomingTs = jobPrUpdatedAtMs(job);
      if (
        incomingTs != null &&
        inflight.some((row) => {
          const existing = epoch(row.pr_updated_at);
          return existing != null && existing > incomingTs;
        })
      ) {
        return { key, queued: false };
      }

      const inserted = asRows<{ id: unknown }>(
        await tx.unsafe(
          `INSERT INTO review_jobs (
             job_key, owner, repo, pr_number, head_sha, delivery, state, attempt, pr_updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, 'queued', 0, $7::timestamptz)
           ON CONFLICT (job_key) WHERE state IN ('queued', 'leased')
           DO NOTHING
           RETURNING id`,
          [key, job.owner, job.repo, job.prNumber, job.headSha, job.delivery, prUpdatedAt]
        )
      );
      if (inserted.length === 0) return { key, queued: false };

      await tx.unsafe(
        `UPDATE review_jobs
         SET state = 'cancelled', updated_at = NOW()
         WHERE owner = $1 AND repo = $2 AND pr_number = $3 AND kind = $6 AND state = 'queued' AND job_key <> $4
           AND ($5::timestamptz IS NULL OR pr_updated_at IS NULL OR pr_updated_at <= $5::timestamptz)`,
        [job.owner, job.repo, job.prNumber, key, prUpdatedAt, REVIEW_KIND]
      );
      return { key, queued: true };
    });
  }

  async enqueueIssue(job: IssueJob): Promise<EnqueueResult> {
    const key = workerJobKey(job);
    const kind = workerJobKind(job);
    const payload = issueJobPayload(job);
    return this.sql.begin(async (tx) => {
      if (kind === "implement") {
        const done = asRows<{ state: unknown; result_reason: unknown; payload: unknown }>(
          await tx.unsafe(
            `SELECT state, result_reason, payload FROM review_jobs WHERE job_key = $1 AND state IN ('succeeded', 'skipped')`,
            [key]
          )
        );
        if (
          done.some((row) =>
            isImplementTerminal(
              {
                kind,
                state: str(row.state) as ReviewJobState,
                resultReason: strOrNull(row.result_reason),
                payload: parsePayload(row.payload),
              },
              job
            )
          )
        ) {
          return { key, queued: false };
        }
      }

      const inflight = asRows<{ job_key: unknown }>(
        await tx.unsafe(
          `SELECT job_key FROM review_jobs
           WHERE job_key = $1 AND state IN ('queued', 'leased')
           ORDER BY id
           FOR UPDATE`,
          [key]
        )
      );
      if (inflight.length > 0) return { key, queued: false };

      const inserted = asRows<{ id: unknown }>(
        await tx.unsafe(
          `INSERT INTO review_jobs (
             job_key, kind, owner, repo, pr_number, head_sha, issue_number, payload, delivery, state, attempt
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, 'queued', 0)
           ON CONFLICT (job_key) WHERE state IN ('queued', 'leased')
           DO NOTHING
           RETURNING id`,
          [
            key,
            kind,
            job.owner,
            job.repo,
            job.prNumber ?? 0,
            job.headSha ?? "",
            job.issueNumber,
            JSON.stringify(payload),
            job.delivery,
          ]
        )
      );
      if (inserted.length === 0) return { key, queued: false };

      if (kind !== "implement" && job.prNumber) {
        await tx.unsafe(
          `UPDATE review_jobs
           SET state = 'cancelled', updated_at = NOW()
           WHERE owner = $1 AND repo = $2 AND pr_number = $3 AND kind = $4 AND state = 'queued' AND job_key <> $5`,
          [job.owner, job.repo, job.prNumber, kind, key]
        );
      }
      return { key, queued: true };
    });
  }

  async drop(key: string): Promise<boolean> {
    const rows = asRows<{ id: unknown }>(
      await this.sql.unsafe(
        `UPDATE review_jobs SET state = 'cancelled', updated_at = NOW()
         WHERE job_key = $1 AND state = 'queued'
         RETURNING id`,
        [key]
      )
    );
    return rows.length > 0;
  }

  async lease(
    leasedBy: string,
    leaseMs: number,
    now = new Date(),
    kinds?: readonly JobKind[]
  ): Promise<ReviewJobRecord | undefined> {
    const allowed = kindsOrReview(kinds);
    const until = new Date(now.getTime() + leaseMs).toISOString();
    const serializeWorkers = leasesWorkerKinds(allowed);
    const runnable = `(leased_until IS NULL OR leased_until <= $3::timestamptz)`;
    const query = serializeWorkers
      ? `UPDATE review_jobs
         SET state = 'leased', leased_by = $1, leased_until = $2::timestamptz, updated_at = NOW()
         WHERE id = (
           SELECT id FROM review_jobs
           WHERE state = 'queued' AND kind = ANY($4::text[]) AND ${runnable}
             AND NOT EXISTS (
               SELECT 1 FROM review_jobs held
               WHERE held.state = 'leased'
                 AND held.kind = ANY($5::text[])
                 AND held.owner = review_jobs.owner
                 AND held.repo = review_jobs.repo
                 AND held.issue_number IS NOT DISTINCT FROM review_jobs.issue_number
             )
           ORDER BY created_at ASC, id ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         RETURNING *`
      : `UPDATE review_jobs
         SET state = 'leased', leased_by = $1, leased_until = $2::timestamptz, updated_at = NOW()
         WHERE id = (
           SELECT id FROM review_jobs
           WHERE state = 'queued' AND kind = ANY($4::text[]) AND ${runnable}
           ORDER BY created_at ASC, id ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         RETURNING *`;
    const nowIso = now.toISOString();
    const params = serializeWorkers
      ? [leasedBy, until, nowIso, pgTextArrayLiteral(allowed), pgTextArrayLiteral([...WORKER_JOB_KINDS])]
      : [leasedBy, until, nowIso, pgTextArrayLiteral(allowed)];
    for (let attempt = 0; ; attempt++) {
      try {
        const rows = asRows<ReviewJobRow>(await this.sql.unsafe(query, params));
        return rows[0] ? mapRow(rows[0]) : undefined;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        if (attempt >= 1) return undefined;
      }
    }
  }

  async heartbeat(id: number, leasedBy: string, leaseMs: number, now = new Date()): Promise<boolean> {
    const rows = asRows<{ id: unknown }>(
      await this.sql.unsafe(
        `UPDATE review_jobs
         SET leased_until = $3::timestamptz, updated_at = NOW()
         WHERE id = $1 AND leased_by = $2 AND state = 'leased'
         RETURNING id`,
        [id, leasedBy, new Date(now.getTime() + leaseMs).toISOString()]
      )
    );
    return rows.length > 0;
  }

  async expireLease(id: number, leasedBy: string, now = new Date()): Promise<boolean> {
    const rows = asRows<{ id: unknown }>(
      await this.sql.unsafe(
        `UPDATE review_jobs
         SET leased_until = $3::timestamptz, leased_by = NULL, updated_at = NOW()
         WHERE id = $1 AND leased_by = $2 AND state = 'leased'
         RETURNING id`,
        [id, leasedBy, new Date(now.getTime() - 1).toISOString()]
      )
    );
    return rows.length > 0;
  }

  async requeueInfra(
    id: number,
    leasedBy: string,
    backoffMs: number,
    marker: string,
    now = new Date()
  ): Promise<boolean> {
    const rows = asRows<{ id: unknown }>(
      await this.sql.unsafe(
        `UPDATE review_jobs
         SET state = 'queued',
             leased_by = NULL,
             leased_until = $3::timestamptz,
             error = $4,
             updated_at = NOW()
         WHERE id = $1 AND leased_by = $2 AND state = 'leased'
           AND result_markdown IS NULL AND result_reason IS NULL
           AND (error IS NULL OR error LIKE 'infra-retry:%')
         RETURNING id`,
        [id, leasedBy, new Date(now.getTime() + backoffMs).toISOString(), marker]
      )
    );
    return rows.length > 0;
  }

  async releaseLease(id: number, leasedBy: string): Promise<boolean> {
    const rows = asRows<{ id: unknown }>(
      await this.sql.unsafe(
        `UPDATE review_jobs
         SET state = 'queued', leased_by = NULL, leased_until = NULL, updated_at = NOW()
         WHERE id = $1 AND leased_by = $2 AND state = 'leased'
           AND result_markdown IS NULL AND result_reason IS NULL
           AND (error IS NULL OR error LIKE 'infra-retry:%')
         RETURNING id`,
        [id, leasedBy]
      )
    );
    return rows.length > 0;
  }

  async saveResult(id: number, leasedBy: string, result: PersistReviewResult): Promise<void> {
    let rows: { id: unknown }[];
    if (result.kind === "markdown") {
      rows = asRows<{ id: unknown }>(
        await this.sql.unsafe(
          `UPDATE review_jobs
           SET result_markdown = $3, result_reason = NULL, error = NULL, updated_at = NOW()
           WHERE id = $1 AND leased_by = $2 AND state = 'leased'
           RETURNING id`,
          [id, leasedBy, result.markdown]
        )
      );
    } else if (result.kind === "skip") {
      rows = asRows<{ id: unknown }>(
        await this.sql.unsafe(
          `UPDATE review_jobs
           SET result_reason = $3, result_markdown = NULL, updated_at = NOW()
           WHERE id = $1 AND leased_by = $2 AND state = 'leased'
           RETURNING id`,
          [id, leasedBy, result.reason]
        )
      );
    } else {
      rows = asRows<{ id: unknown }>(
        await this.sql.unsafe(
          `UPDATE review_jobs
           SET error = $3, result_reason = $3, result_markdown = NULL, updated_at = NOW()
           WHERE id = $1 AND leased_by = $2 AND state = 'leased'
           RETURNING id`,
          [id, leasedBy, result.error]
        )
      );
    }
    if (rows.length === 0) throw new Error(`cannot save result for job ${id}`);
  }

  async markPublished(
    id: number,
    leasedBy: string,
    outcome: { state: "succeeded" | "skipped" | "failed"; reason?: string }
  ): Promise<void> {
    const rows = asRows<{ id: unknown }>(
      await this.sql.unsafe(
        `UPDATE review_jobs
         SET state = $3,
             result_reason = COALESCE($4, result_reason),
             published_at = NOW(),
             leased_by = NULL,
             leased_until = NULL,
             updated_at = NOW()
         WHERE id = $1 AND leased_by = $2 AND state = 'leased'
         RETURNING id`,
        [id, leasedBy, outcome.state, outcome.reason ?? null]
      )
    );
    if (rows.length === 0) throw new Error(`cannot mark published for job ${id}`);
  }

  async reclaimExpired(
    maxAttempts: number,
    now = new Date(),
    leaseMs = HEARTBEAT_MS,
    kinds?: readonly JobKind[]
  ): Promise<ReclaimResult> {
    return this.sql.begin(async (tx) => {
      const allowed = kindsOrReview(kinds);
      const ts = now.toISOString();
      const claimedUntil = new Date(now.getTime() + leaseMs).toISOString();
      const expired = asRows<ReviewJobRow>(
        await tx.unsafe(
          `SELECT * FROM review_jobs
           WHERE state = 'leased' AND leased_until < $1::timestamptz AND kind = ANY($2::text[])
           ORDER BY id
           FOR UPDATE SKIP LOCKED`,
          [ts, pgTextArrayLiteral(allowed)]
        )
      );

      const requeued: ReviewJobRecord[] = [];
      const publish: ReviewJobRecord[] = [];

      for (const raw of expired) {
        const row = mapRow(raw);
        if (hasPersistedResult(row)) {
          const updated = asRows<ReviewJobRow>(
            await tx.unsafe(
              `UPDATE review_jobs
               SET leased_by = $2,
                   leased_until = $3::timestamptz,
                   updated_at = NOW()
               WHERE id = $1 AND state = 'leased'
               RETURNING *`,
              [row.id, RECLAIM_LEASED_BY, claimedUntil]
            )
          );
          if (updated[0]) publish.push(mapRow(updated[0]));
          continue;
        }
        if (row.attempt + 1 >= maxAttempts) {
          const updated = asRows<ReviewJobRow>(
            await tx.unsafe(
              `UPDATE review_jobs
               SET attempt = attempt + 1,
                   error = $2,
                   result_reason = $2,
                   leased_by = $3,
                   leased_until = $4::timestamptz,
                   updated_at = NOW()
               WHERE id = $1
               RETURNING *`,
              [row.id, MAX_ATTEMPTS_REASON, RECLAIM_LEASED_BY, claimedUntil]
            )
          );
          if (updated[0]) publish.push(mapRow(updated[0]));
          continue;
        }
        const updated = asRows<ReviewJobRow>(
          await tx.unsafe(
            `UPDATE review_jobs
             SET attempt = attempt + 1,
                 state = 'queued',
                 leased_by = NULL,
                 leased_until = NULL,
                 error = CASE WHEN error LIKE 'infra-retry:%' THEN NULL ELSE error END,
                 updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [row.id]
          )
        );
        if (updated[0]) requeued.push(mapRow(updated[0]));
      }

      return { requeued, publish };
    });
  }

  async countByState(): Promise<Record<ReviewJobState, number>> {
    const rows = asRows<{ state: unknown; n: unknown }>(
      await this.sql.unsafe(`SELECT state, COUNT(*)::bigint AS n FROM review_jobs GROUP BY state`)
    );
    const counts = emptyCounts();
    for (const row of rows) {
      const state = str(row.state) as ReviewJobState;
      if (state in counts) counts[state] = num(row.n);
    }
    return counts;
  }

  async get(id: number): Promise<ReviewJobRecord | undefined> {
    const rows = asRows<ReviewJobRow>(await this.sql.unsafe(`SELECT * FROM review_jobs WHERE id = $1`, [id]));
    return rows[0] ? mapRow(rows[0]) : undefined;
  }

  async cancelQueuedForIssue(owner: string, repo: string, issueNumber: number): Promise<number> {
    const rows = asRows<{ id: unknown }>(
      await this.sql.unsafe(
        `UPDATE review_jobs SET state = 'cancelled', leased_by = NULL, leased_until = NULL, updated_at = NOW()
         WHERE owner = $1 AND repo = $2 AND issue_number = $3 AND kind = ANY($4::text[]) AND state IN ('queued', 'leased')
         RETURNING id`,
        [owner, repo, issueNumber, pgTextArrayLiteral(WORKER_JOB_KINDS)]
      )
    );
    return rows.length;
  }

  async countSucceeded(kind: JobKind, owner: string, repo: string, issueNumber: number): Promise<number> {
    const rows = asRows<{ n: unknown }>(
      await this.sql.unsafe(
        `SELECT COUNT(*)::bigint AS n FROM review_jobs
         WHERE kind = $1 AND owner = $2 AND repo = $3 AND issue_number = $4 AND state = 'succeeded'`,
        [kind, owner, repo, issueNumber]
      )
    );
    return rows[0] ? num(rows[0].n) : 0;
  }
}

export async function createPgReviewJobStore(databaseUrl: string): Promise<PgReviewJobStore> {
  const store = new PgReviewJobStore(createBunSqlClient(databaseUrl));
  await store.migrate();
  return store;
}

export async function renderQueueMetrics(store: ReviewJobStore): Promise<string> {
  const counts = await store.countByState();
  const lines = ["# HELP jumi_review_jobs Number of review jobs by state.", "# TYPE jumi_review_jobs gauge"];
  for (const state of REVIEW_JOB_STATES) {
    lines.push(`jumi_review_jobs{state="${state}"} ${counts[state]}`);
  }
  return `${lines.join("\n")}\n`;
}
