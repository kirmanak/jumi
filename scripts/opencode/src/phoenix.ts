import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { TraceContext } from "./engine.ts";
import {
  encodeTracesRequest,
  type OtlpSpan,
  type OtlpValue,
  SPAN_KIND_INTERNAL,
  STATUS_CODE_ERROR,
  STATUS_CODE_OK,
} from "./otlp.ts";

export const PHOENIX_OTLP_TIMEOUT_MS = 5_000;
export const PUBLIC_PHOENIX_HOST = "phoenix.kirmanak.stream";
const HEAD_CHARS = 256;
const MAX_TOOL_SPANS = 256;
const KIND_ATTR = "openinference.span.kind";

export type { TraceContext, TraceKind } from "./engine.ts";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let errors = 0;
let fetchImpl: FetchLike = globalThis.fetch;
let timeoutMs = PHOENIX_OTLP_TIMEOUT_MS;

export function resetTraceExportForTests(): void {
  errors = 0;
  fetchImpl = globalThis.fetch;
  timeoutMs = PHOENIX_OTLP_TIMEOUT_MS;
}

export function setTraceFetchForTests(fn: FetchLike | undefined): void {
  fetchImpl = fn ?? globalThis.fetch;
}

export function setTraceTimeoutForTests(ms: number): void {
  timeoutMs = ms;
}

export function traceExportErrors(): number {
  return errors;
}

function agentInstance(): string {
  return process.env.AGENT_INSTANCE?.trim() || "jumi";
}

function phoenixEndpoint(): string {
  return process.env.PHOENIX_OTLP_ENDPOINT?.trim() || "";
}

function noteError(): void {
  errors += 1;
}

function head(value: unknown): string | undefined {
  if (value == null) return undefined;
  const text = String(value);
  if (!text) return undefined;
  return text.length <= HEAD_CHARS ? text : text.slice(0, HEAD_CHARS);
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function msToNano(ms: number): bigint {
  const safe = Number.isFinite(ms) && ms > 0 ? Math.trunc(ms) : Date.now();
  return BigInt(safe) * 1_000_000n;
}

function randomId(bytes: number): Uint8Array {
  const id = new Uint8Array(bytes);
  crypto.getRandomValues(id);
  return id;
}

function tableNames(db: Database): Set<string> {
  const rows = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function tracesUrl(endpoint: string): URL | undefined {
  try {
    const trimmed = endpoint.replace(/\/+$/, "");
    const url = new URL(trimmed.endsWith("/v1/traces") ? trimmed : `${trimmed}/v1/traces`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.hostname === PUBLIC_PHOENIX_HOST) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function filterAttrs(trace: TraceContext | undefined, agent: string): Record<string, OtlpValue> {
  const attrs: Record<string, OtlpValue> = { agent_instance: agent };
  if (!trace) return attrs;
  attrs.kind = trace.kind;
  attrs.owner = trace.owner;
  attrs.repo = trace.repo;
  if (trace.sha) attrs.sha = trace.sha;
  if (trace.jobId) attrs.job_id = trace.jobId;
  return attrs;
}

function spanTimes(
  startMs: number | undefined,
  endMs: number | undefined,
  fallbackStart: number,
  fallbackEnd: number
): { start: bigint; end: bigint } {
  const start = startMs && startMs > 0 ? startMs : fallbackStart;
  let end = endMs && endMs > 0 ? endMs : fallbackEnd;
  if (end < start) end = start;
  return { start: msToNano(start), end: msToNano(end) };
}

interface SessionRow {
  id: string;
  time_created: number | null;
  time_updated: number | null;
}

interface MessageRow {
  id: string;
  session_id: string;
  time_created: number | null;
  time_updated: number | null;
  role: string | null;
  model_id: string | null;
  provider_id: string | null;
  model_id_nested: string | null;
  provider_nested: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  msg_created: number | null;
  msg_completed: number | null;
  error: string | null;
}

interface PartRow {
  id: string;
  message_id: string;
  time_created: number | null;
  time_updated: number | null;
  type: string | null;
  tool: string | null;
  status: string | null;
  start_ms: number | null;
  end_ms: number | null;
  error: string | null;
  command: string | null;
  path: string | null;
  file_path: string | null;
  pattern: string | null;
  name: string | null;
  glob: string | null;
}

function readTrace(db: Database): { sessions: SessionRow[]; messages: MessageRow[]; parts: PartRow[] } | undefined {
  const tables = tableNames(db);
  if (!tables.has("session") || !tables.has("message") || !tables.has("part")) return undefined;
  const sessions = db
    .query("SELECT id, time_created, time_updated FROM session ORDER BY time_created, id")
    .all() as SessionRow[];
  const messages = db
    .query(
      `SELECT
        id,
        session_id,
        time_created,
        time_updated,
        json_extract(data, '$.role') AS role,
        json_extract(data, '$.modelID') AS model_id,
        json_extract(data, '$.providerID') AS provider_id,
        json_extract(data, '$.model.id') AS model_id_nested,
        json_extract(data, '$.model.providerID') AS provider_nested,
        json_extract(data, '$.tokens.input') AS tokens_input,
        json_extract(data, '$.tokens.output') AS tokens_output,
        json_extract(data, '$.time.created') AS msg_created,
        json_extract(data, '$.time.completed') AS msg_completed,
        substr(CAST(json_extract(data, '$.error.message') AS TEXT), 1, ${HEAD_CHARS}) AS error
      FROM message
      ORDER BY time_created, id`
    )
    .all() as MessageRow[];
  const parts = db
    .query(
      `SELECT
        id,
        message_id,
        time_created,
        time_updated,
        json_extract(data, '$.type') AS type,
        json_extract(data, '$.tool') AS tool,
        json_extract(data, '$.state.status') AS status,
        json_extract(data, '$.state.time.start') AS start_ms,
        json_extract(data, '$.state.time.end') AS end_ms,
        substr(CAST(json_extract(data, '$.state.error') AS TEXT), 1, ${HEAD_CHARS}) AS error,
        substr(CAST(json_extract(data, '$.state.input.command') AS TEXT), 1, ${HEAD_CHARS}) AS command,
        substr(CAST(json_extract(data, '$.state.input.path') AS TEXT), 1, ${HEAD_CHARS}) AS path,
        substr(CAST(json_extract(data, '$.state.input.filePath') AS TEXT), 1, ${HEAD_CHARS}) AS file_path,
        substr(CAST(json_extract(data, '$.state.input.pattern') AS TEXT), 1, ${HEAD_CHARS}) AS pattern,
        substr(CAST(json_extract(data, '$.state.input.name') AS TEXT), 1, ${HEAD_CHARS}) AS name,
        substr(CAST(json_extract(data, '$.state.input.glob') AS TEXT), 1, ${HEAD_CHARS}) AS glob
      FROM part
      WHERE json_extract(data, '$.type') = 'tool'
      ORDER BY time_created, id
      LIMIT ${MAX_TOOL_SPANS}`
    )
    .all() as PartRow[];
  return { sessions, messages, parts };
}

function toolName(row: PartRow): string {
  const tool = head(row.tool) ?? "tool";
  if (tool === "skill") {
    const skill = head(row.name);
    if (skill) return `skill:${skill}`;
  }
  return tool;
}

function toolParams(row: PartRow): string | undefined {
  const params: Record<string, string> = {};
  const command = head(row.command);
  const path = head(row.path) ?? head(row.file_path);
  const pattern = head(row.pattern);
  const name = head(row.name);
  const glob = head(row.glob);
  if (command) params.command = command;
  if (path) params.path = path;
  if (pattern) params.pattern = pattern;
  if (name) params.name = name;
  if (glob) params.glob = glob;
  const keys = Object.keys(params);
  if (keys.length === 0) return undefined;
  return JSON.stringify(params);
}

function buildSpans(
  trace: TraceContext | undefined,
  rows: { sessions: SessionRow[]; messages: MessageRow[]; parts: PartRow[] }
): OtlpSpan[] {
  const shared = filterAttrs(trace, agentInstance());
  const now = Date.now();
  const sessionStart = asNumber(rows.sessions[0]?.time_created) ?? now;
  const sessionEnd =
    asNumber(rows.sessions[rows.sessions.length - 1]?.time_updated) ??
    asNumber(rows.sessions[rows.sessions.length - 1]?.time_created) ??
    now;
  const rootTimes = spanTimes(sessionStart, sessionEnd, sessionStart, sessionEnd);
  const traceId = randomId(16);
  const rootId = randomId(8);
  const rootName = trace ? `jumi ${trace.kind}` : "jumi opencode";
  const spans: OtlpSpan[] = [
    {
      traceId,
      spanId: rootId,
      name: rootName,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: rootTimes.start,
      endTimeUnixNano: rootTimes.end,
      attributes: { ...shared, [KIND_ATTR]: "AGENT" },
      statusCode: STATUS_CODE_OK,
    },
  ];

  for (const message of rows.messages) {
    const role = String(message.role ?? "");
    const model = head(message.model_id) ?? head(message.model_id_nested);
    const provider = head(message.provider_id) ?? head(message.provider_nested);
    if (role !== "assistant") continue;
    if (!model && !provider) continue;
    const start = asNumber(message.msg_created) ?? asNumber(message.time_created) ?? sessionStart;
    const end = asNumber(message.msg_completed) ?? asNumber(message.time_updated) ?? start;
    const times = spanTimes(start, end, sessionStart, sessionEnd);
    const attrs: Record<string, OtlpValue> = { ...shared, [KIND_ATTR]: "LLM" };
    if (model) attrs["llm.model_name"] = model;
    if (provider) attrs["llm.provider"] = provider;
    const prompt = asNumber(message.tokens_input);
    const completion = asNumber(message.tokens_output);
    if (prompt != null) attrs["llm.token_count.prompt"] = Math.trunc(prompt);
    if (completion != null) attrs["llm.token_count.completion"] = Math.trunc(completion);
    const err = head(message.error);
    spans.push({
      traceId,
      spanId: randomId(8),
      parentSpanId: rootId,
      name: model ?? "llm",
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: times.start,
      endTimeUnixNano: times.end,
      attributes: attrs,
      statusCode: err ? STATUS_CODE_ERROR : STATUS_CODE_OK,
      statusMessage: err,
    });
  }

  for (const part of rows.parts) {
    const name = toolName(part);
    const status = head(part.status) ?? "unknown";
    const start = asNumber(part.start_ms) ?? asNumber(part.time_created) ?? sessionStart;
    const end = asNumber(part.end_ms) ?? asNumber(part.time_updated) ?? start;
    const times = spanTimes(start, end, sessionStart, sessionEnd);
    const startMs = asNumber(part.start_ms);
    const endMs = asNumber(part.end_ms);
    const attrs: Record<string, OtlpValue> = {
      ...shared,
      [KIND_ATTR]: "TOOL",
      "tool.name": name,
      "tool.status": status,
    };
    if (startMs != null && endMs != null) attrs["tool.duration_ms"] = Math.max(0, Math.trunc(endMs - startMs));
    const params = toolParams(part);
    if (params) attrs["tool.parameters"] = params;
    const err = head(part.error);
    const failed = status === "error" || Boolean(err);
    spans.push({
      traceId,
      spanId: randomId(8),
      parentSpanId: rootId,
      name,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: times.start,
      endTimeUnixNano: times.end,
      attributes: attrs,
      statusCode: failed ? STATUS_CODE_ERROR : STATUS_CODE_OK,
      statusMessage: err,
    });
  }

  return spans;
}

export function buildOpenCodeTraceRequest(dbPath: string, trace?: TraceContext): Uint8Array | undefined {
  if (!existsSync(dbPath)) return undefined;
  const db = new Database(dbPath);
  try {
    const rows = readTrace(db);
    if (!rows) return undefined;
    const agent = agentInstance();
    const spans = buildSpans(trace, rows);
    return encodeTracesRequest(
      {
        attributes: {
          "service.name": agent,
          "openinference.project.name": agent,
          ...filterAttrs(trace, agent),
        },
      },
      spans
    );
  } finally {
    db.close();
  }
}

export async function exportOpenCodeTrace(opts: { dbPath: string; trace?: TraceContext }): Promise<void> {
  const endpoint = phoenixEndpoint();
  if (!endpoint) return;
  const url = tracesUrl(endpoint);
  if (!url) {
    noteError();
    return;
  }
  let body: Uint8Array | undefined;
  try {
    body = buildOpenCodeTraceRequest(opts.dbPath, opts.trace);
  } catch {
    noteError();
    return;
  }
  if (!body) return;
  const agent = agentInstance();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-protobuf",
        "phoenix-project": agent,
      },
      body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      signal: ac.signal,
    });
    if (!response.ok) noteError();
  } catch {
    noteError();
  } finally {
    clearTimeout(timer);
  }
}
