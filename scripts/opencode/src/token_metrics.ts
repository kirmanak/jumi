/** Process-local OpenCode token counters for Prometheus /metrics. */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

export const TOKEN_TYPES = ["input", "cached_input", "output", "cache_write", "reasoning"] as const;
export type TokenType = (typeof TOKEN_TYPES)[number];

type TokenKey = string;
type SessionKey = string;

const counters = new Map<TokenKey, number>();
const gauges = new Map<TokenKey, number>();
const sessions = new Map<SessionKey, number>();
let lastSuccessSeconds = 0;
let errors = 0;

const COLUMN_BY_TYPE: Record<TokenType, string> = {
  input: "tokens_input",
  cached_input: "tokens_cache_read",
  output: "tokens_output",
  cache_write: "tokens_cache_write",
  reasoning: "tokens_reasoning",
};

function agentInstance(): string {
  return process.env.AGENT_INSTANCE?.trim() || "jumi";
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

export function normalizeOpenCodeModel(raw: string | null | undefined): string {
  if (!raw) return "unknown";
  const text = String(raw).trim();
  if (!text) return "unknown";
  if (text.startsWith("{")) {
    try {
      const data = JSON.parse(text) as Record<string, unknown>;
      const modelId = data.id ?? data.modelID ?? data.model;
      const provider = data.providerID ?? data.provider;
      if (typeof modelId === "string" && typeof provider === "string" && modelId && provider) {
        return `${provider}/${modelId}`;
      }
      if (typeof modelId === "string" && modelId) return modelId;
    } catch {
      // Fall through to the raw string.
    }
  }
  return text;
}

function tokenKey(model: string, tokenType: TokenType): TokenKey {
  return `${model}\0${tokenType}`;
}

function add(map: Map<string, number>, key: string, value: number): void {
  map.set(key, (map.get(key) ?? 0) + value);
}

export function resetTokenMetricsForTests(): void {
  counters.clear();
  gauges.clear();
  sessions.clear();
  lastSuccessSeconds = 0;
  errors = 0;
}

export function recordOpenCodeDb(path: string): void {
  if (!existsSync(path)) return;
  try {
    // Read-write: OpenCode uses WAL. After proc.kill()/143 the -wal may be
    // uncheckpointed; SQLITE_OPEN_READONLY cannot recreate -shm and drops tokens.
    // The child is already dead and the workspace is deleted next.
    const db = new Database(path);
    try {
      const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
      if (!tables.some((row) => row.name === "session")) return;
      const rows = db
        .query(
          `SELECT
            model,
            COALESCE(SUM(tokens_input), 0) AS tokens_input,
            COALESCE(SUM(tokens_output), 0) AS tokens_output,
            COALESCE(SUM(tokens_cache_read), 0) AS tokens_cache_read,
            COALESCE(SUM(tokens_cache_write), 0) AS tokens_cache_write,
            COALESCE(SUM(tokens_reasoning), 0) AS tokens_reasoning,
            COUNT(*) AS session_count
          FROM session
          GROUP BY model`
        )
        .all() as Array<{
        model: string | null;
        tokens_input: number;
        tokens_output: number;
        tokens_cache_read: number;
        tokens_cache_write: number;
        tokens_reasoning: number;
        session_count: number;
      }>;
      for (const row of rows) {
        const model = normalizeOpenCodeModel(row.model);
        add(sessions, model, Number(row.session_count) || 0);
        for (const tokenType of TOKEN_TYPES) {
          const value = Number(row[COLUMN_BY_TYPE[tokenType] as keyof typeof row]) || 0;
          add(counters, tokenKey(model, tokenType), value);
          gauges.set(tokenKey(model, tokenType), counters.get(tokenKey(model, tokenType)) ?? 0);
        }
      }
      lastSuccessSeconds = Math.floor(Date.now() / 1000);
    } finally {
      db.close();
    }
  } catch {
    errors += 1;
  }
}

function seriesLabels(model: string, tokenType?: TokenType): string {
  const parts = [
    `agent_instance="${escapeLabel(agentInstance())}"`,
    'source="opencode"',
    'profile="default"',
    `model="${escapeLabel(model)}"`,
  ];
  if (tokenType) parts.push(`token_type="${escapeLabel(tokenType)}"`);
  return parts.join(",");
}

export function renderTokenMetrics(): string {
  const agent = escapeLabel(agentInstance());
  const lines: string[] = [
    "# HELP ai_token_exporter_up 1 if the process can serve token series",
    "# TYPE ai_token_exporter_up gauge",
    `ai_token_exporter_up{agent_instance="${agent}"} 1`,
    "# HELP ai_token_exporter_last_success_seconds Unix time of last successful OpenCode DB read",
    "# TYPE ai_token_exporter_last_success_seconds gauge",
    `ai_token_exporter_last_success_seconds{agent_instance="${agent}"} ${lastSuccessSeconds}`,
    "# HELP ai_token_exporter_errors OpenCode DB read failures in this process",
    "# TYPE ai_token_exporter_errors counter",
    `ai_token_exporter_errors{agent_instance="${agent}"} ${errors}`,
    "# HELP ai_tokens_total Cumulative AI tokens observed by this process",
    "# TYPE ai_tokens_total counter",
  ];

  const tokenEntries = [...counters.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [key, value] of tokenEntries) {
    const [model, tokenType] = key.split("\0") as [string, TokenType];
    lines.push(`ai_tokens_total{${seriesLabels(model, tokenType)}} ${value}`);
  }

  lines.push("# HELP ai_tokens Current in-process token totals (reset on process restart)");
  lines.push("# TYPE ai_tokens gauge");
  for (const [key, value] of [...gauges.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [model, tokenType] = key.split("\0") as [string, TokenType];
    lines.push(`ai_tokens{${seriesLabels(model, tokenType)}} ${value}`);
  }

  lines.push("# HELP ai_sessions Sessions recorded by this process");
  lines.push("# TYPE ai_sessions counter");
  for (const [model, value] of [...sessions.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`ai_sessions{${seriesLabels(model)}} ${value}`);
  }

  return `${lines.join("\n")}\n`;
}
