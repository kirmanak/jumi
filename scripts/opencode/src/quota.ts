/** Quota abort: Free/Go usage-limit retry classification. Live abort polls
 * the per-run isolated OpenCode log file (see git.ts); the DB check below is
 * the post-hoc classifier only.
 *
 * Why the log file: pinned OpenCode 1.15.5 keeps retry status in memory
 * (SessionStatus) and never writes a per-attempt row to the session DB while
 * sleeping on a multi-hour retry-after, and `opencode run` without
 * `--print-logs` emits only the `> build · <model>` banner to stderr (0 bytes
 * on both streams with `--format json`). The fully-formed quota error only
 * reaches OpenCode's own log file (`llm` service `stream error`, ~170ms after
 * stream start) before the child sleeps. Tailing that file needs no
 * `--print-logs`, no transcript dump to Loki, and no Phoenix. */

import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const QUOTA_STUCK_TEXT = "stuck: usage limit exceeded";

export const QUOTA_MESSAGE = "opencode stuck: usage limit exceeded";

/** Interval for the live log-file poll (see git.ts). Independent of the RSS sampler. */
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

/** Narrow live pattern for stream/log scans. Drops the parent's own
 * `stuck:` dialect (which OpenCode never emits) so tool traces or echoed file
 * content containing that literal cannot kill a healthy run. Kept in
 * `QUOTA_ERROR_RE`/`isQuotaText` for thrown errors and stuck comments. */
export const QUOTA_LIVE_RE =
  /FreeUsageLimitError|GoUsageLimitError|Free usage exceeded|Free limit reached|Go limit reached|free_tier_limit|account_rate_limit/i;

/** Retry context required around a live match. The quota failure is logged by
 * the `llm` service as `message="stream error"` with the provider error
 * inline; permission-evaluation lines that merely echo a tool command
 * containing a quota string never contain this marker. */
const LOG_RETRY_RE = /stream error/i;

export function isQuotaText(text: string | null | undefined): boolean {
  if (!text) return false;
  return QUOTA_ERROR_RE.test(text);
}

export function isQuotaError(err: unknown): boolean {
  if (!err) return false;
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return isQuotaText(text);
}

export function isQuotaLiveText(text: string | null | undefined): boolean {
  if (!text) return false;
  return QUOTA_LIVE_RE.test(text);
}

/**
 * True when a single log line carries a quota failure in retry context:
 * a `stream error` line containing a Free/Go quota string. Line-scoped so a
 * permission line echoing `FreeUsageLimitError` from a tool command (no
 * `stream error` marker) never matches, and the parent's own `stuck:` dialect
 * (absent from `QUOTA_LIVE_RE`) never matches.
 */
export function isQuotaLogLine(line: string | null | undefined): boolean {
  if (!line) return false;
  if (!LOG_RETRY_RE.test(line)) return false;
  return QUOTA_LIVE_RE.test(line);
}

/**
 * Scan free-form log text for a quota retry line. Splits into lines so the
 * retry marker and the quota string must share one log line. Never throws;
 * tests only the regex, never logs the transcript.
 */
export function hasQuotaInLogText(text: string | null | undefined): boolean {
  if (!text) return false;
  // Bound the split for pathological single-line blobs; quota lines are
  // early and short, and the per-run isolated log stays small.
  const capped = text.length > 10_000_000 ? text.slice(0, 10_000_000) : text;
  for (const line of capped.split(/\r?\n/)) {
    if (isQuotaLogLine(line)) return true;
  }
  return false;
}

const MAX_LOG_FILES = 20;
const MAX_LOG_BYTES_PER_FILE = 10_000_000;

/**
 * Best-effort live/post-hoc scan of the per-run isolated OpenCode log dir
 * (`<xdg-data>/opencode/log`, fresh per run so any hit belongs to this
 * child). Handles both layouts: the single `opencode.log` (1.18.x) and the
 * timestamped `*.log` rotation (1.15.5, keeps last 10). Returns false when the
 * dir is missing, empty, or unreadable. Never throws; never logs content.
 */
export function hasQuotaInLogDir(logDir: string | null | undefined): boolean {
  if (!logDir) return false;
  let entries: string[];
  try {
    if (!existsSync(logDir)) return false;
    entries = readdirSync(logDir);
  } catch {
    return false;
  }
  let checked = 0;
  for (const entry of entries) {
    if (checked >= MAX_LOG_FILES) break;
    if (entry.startsWith(".")) continue;
    const abs = join(logDir, entry);
    let size = 0;
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
      size = st.size;
      if (size <= 0) continue;
    } catch {
      continue;
    }
    checked += 1;
    try {
      const capped = Math.min(size, MAX_LOG_BYTES_PER_FILE);
      // Read the whole (capped) file; per-run logs stay small and quota can
      // sit early (first failure) or late (quota after hours of work).
      const buf = readFileSync(abs);
      const text = buf.length > capped ? buf.subarray(0, capped).toString("utf8") : buf.toString("utf8");
      if (hasQuotaInLogText(text)) return true;
      // When capped in the middle, also check the tail window so a late quota
      // line past the head cap still fires.
      if (buf.length > capped) {
        const tail = buf.subarray(buf.length - Math.min(buf.length, 1_000_000)).toString("utf8");
        if (hasQuotaInLogText(tail)) return true;
      }
    } catch {}
  }
  return false;
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
 * `.jumi-tmp/opencode-session.db`). The live abort signal is the per-run
 * isolated log file (`hasQuotaInLogDir`); the pinned OpenCode never persists
 * a per-attempt retry row while it sleeps on a multi-hour retry-after, so
 * this must not be polled as the abort trigger.
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
