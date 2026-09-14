/** Quota abort: Free/Go usage-limit retry classification. Live abort watches
 * the child stderr stream (see git.ts); this DB check is the post-hoc
 * classifier only. */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

export const QUOTA_STUCK_TEXT = "stuck: usage limit exceeded";

export const QUOTA_MESSAGE = "opencode stuck: usage limit exceeded";

/** Deprecated: live quota abort watches the child stderr stream; no polling. Kept for compat. */
export const QUOTA_POLL_INTERVAL_MS = 5_000;

// Free/Go usage-limit class only. Bare "usage limit reached" is intentionally
// absent: other providers emit similar text with a seconds-scale retry-after
// that OpenCode rides out and then succeeds.
const QUOTA_PATTERNS = [
  "FreeUsageLimitError",
  "GoUsageLimitError",
  "Free usage exceeded",
  "Free limit reached",
  "Go limit reached",
  "free_tier_limit",
  "account_rate_limit",
] as const;

export const QUOTA_ERROR_RE =
  /FreeUsageLimitError|GoUsageLimitError|Free usage exceeded|Free limit reached|Go limit reached|free_tier_limit|account_rate_limit|stuck:\s*usage limit exceeded/i;

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
  // Scope to the retry/error shape so task/feedback text quoting a quota
  // string in a user message never matches. SQL LIKE keeps large
  // part/message blobs out of the parent heap; candidate rows are then
  // verified with JSON.parse below.
  // The LIKE fragments tolerate JSON spacing (`"type":"retry"` vs
  // `"type": "retry"`).
  const scope =
    table === "part"
      ? `data LIKE '%"type"%retry%'`
      : table === "message"
        ? `data LIKE '%"error"%'`
        : `(data LIKE '%"type"%retry%' OR data LIKE '%"error"%')`;
  // Use SQL LIKE so large part/message blobs never enter the parent heap.
  // LIKE is case-insensitive for ASCII by default; ordinary 429s ("429",
  // "Too Many Requests") do not contain these quota strings and stay retries.
  const where = QUOTA_PATTERNS.map(() => `data LIKE ?`).join(" OR ");
  const params = QUOTA_PATTERNS.map((pattern) => `%${pattern}%`);
  try {
    const rows = db
      .query(`SELECT data AS data FROM "${table}" WHERE ${scope} AND (${where}) LIMIT 10`)
      .all(...params) as Array<{ data: unknown }>;
    for (const row of rows) {
      if (typeof row?.data !== "string") continue;
      if (rowIsQuotaData(row.data, table)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Verify a candidate row really is a retry/error record before matching
 * quota strings. `part` requires `type === "retry"` (both the live
 * SessionStatus shape and the persisted RetryPart shape); `message` /
 * `session_message` require an `error` field. Only error-related fields are
 * tested so quoted task text elsewhere in the row cannot match.
 */
function rowIsQuotaData(data: string, table: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  const rec = parsed as Record<string, unknown>;
  if (table === "part") {
    if (rec.type !== "retry") return false;
    // Retry shape varies by layer (SessionStatus: message/action vs
    // persisted RetryPart: error). Check the error-carrying fields only.
    const candidates: unknown[] = [rec.message, rec.error, rec.action];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && isQuotaText(candidate)) return true;
      if (candidate && typeof candidate === "object" && isQuotaText(JSON.stringify(candidate))) return true;
    }
    return false;
  }
  // message / session_message: assistant error records only. A user message
  // carrying the task/feedback text has no `error` field and never matches,
  // even when it quotes `FreeUsageLimitError`.
  if (rec.type === "retry") {
    const candidates: unknown[] = [rec.message, rec.error, (rec as Record<string, unknown>).action];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && isQuotaText(candidate)) return true;
      if (candidate && typeof candidate === "object" && isQuotaText(JSON.stringify(candidate))) return true;
    }
    return false;
  }
  if (!("error" in rec)) return false;
  const err = rec.error;
  if (typeof err === "string") return isQuotaText(err);
  if (err && typeof err === "object") return isQuotaText(JSON.stringify(err));
  return false;
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
 * Best-effort post-hoc quota classifier against the per-run OpenCode session
 * DB the parent already knows about (`OPENCODE_DB` under
 * `.jumi-tmp/opencode-session.db`). The live abort signal is the child
 * stderr stream; the pinned OpenCode never persists a per-attempt retry row
 * while it sleeps on a multi-hour retry-after, so this must not be polled as
 * the abort trigger.
 *
 * Returns false when the DB is missing, not yet initialized, locked, or
 * contains no quota/retry record. Never throws.
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
