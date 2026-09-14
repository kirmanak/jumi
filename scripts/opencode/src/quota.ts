/** Quota abort: Free/Go usage-limit retry detection from the per-run OpenCode session DB. */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

export const QUOTA_STUCK_TEXT = "stuck: usage limit exceeded";

export const QUOTA_MESSAGE = "opencode stuck: usage limit exceeded";

export const QUOTA_POLL_INTERVAL_MS = 5_000;

const QUOTA_PATTERNS = [
  "FreeUsageLimitError",
  "GoUsageLimitError",
  "Free usage exceeded",
  "Free limit reached",
  "Go limit reached",
  "usage limit reached",
  "free_tier_limit",
  "account_rate_limit",
] as const;

export const QUOTA_ERROR_RE =
  /FreeUsageLimitError|GoUsageLimitError|Free usage exceeded|Free limit reached|Go limit reached|usage limit reached|free_tier_limit|account_rate_limit|stuck:\s*usage limit exceeded/i;

export function isQuotaText(text: string | null | undefined): boolean {
  if (!text) return false;
  return QUOTA_ERROR_RE.test(text);
}

export function isQuotaError(err: unknown): boolean {
  if (!err) return false;
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return isQuotaText(text);
}

function tableNames(db: Database): Set<string> {
  try {
    const rows = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    return new Set(rows.map((row) => row.name));
  } catch {
    return new Set();
  }
}

function tableHasQuota(db: Database, table: string): boolean {
  // Use SQL LIKE so large part/message blobs never enter the parent heap.
  // LIKE is case-insensitive for ASCII by default; ordinary 429s ("429",
  // "Too Many Requests") do not contain these quota strings and stay retries.
  const where = QUOTA_PATTERNS.map(() => `data LIKE ?`).join(" OR ");
  const params = QUOTA_PATTERNS.map((pattern) => `%${pattern}%`);
  try {
    const row = db.query(`SELECT 1 AS hit FROM "${table}" WHERE ${where} LIMIT 1`).get(...params) as
      | { hit: number }
      | null
      | undefined;
    return Boolean(row?.hit);
  } catch {
    return false;
  }
}

function hasQuotaInOpenDb(db: Database): boolean {
  const tables = tableNames(db);
  for (const table of ["message", "part", "session_message"] as const) {
    if (!tables.has(table)) continue;
    if (tableHasQuota(db, table)) return true;
  }
  return false;
}

/**
 * Best-effort quota check against the per-run OpenCode session DB the parent
 * already knows about (`OPENCODE_DB` under `.jumi-tmp/opencode-session.db`).
 *
 * Returns false when the DB is missing, not yet initialized, locked (child is
 * writing WAL), or contains no quota/retry record. Never throws: the caller
 * polls this while the child runs and treats false as "keep waiting".
 */
export function hasQuotaRetryInDb(dbPath: string | null | undefined): boolean {
  if (!dbPath) return false;
  if (!existsSync(dbPath)) return false;
  // While the child is alive its -shm exists so readonly works. After
  // proc.kill() the -wal may be uncheckpointed and readonly cannot recreate
  // -shm (same WAL note as token_metrics); fall back to read-write then.
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      return hasQuotaInOpenDb(db);
    } finally {
      db.close();
    }
  } catch {
    // Fall through to read-write.
  }
  try {
    const db = new Database(dbPath);
    try {
      return hasQuotaInOpenDb(db);
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}
