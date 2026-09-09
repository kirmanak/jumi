import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOpenCodeTraceRequest,
  exportOpenCodeTrace,
  PUBLIC_PHOENIX_HOST,
  resetTraceExportForTests,
  setTraceFetchForTests,
  setTraceTimeoutForTests,
  traceExportErrors,
} from "../src/phoenix.ts";
import { renderTokenMetrics } from "../src/token_metrics.ts";

const originalEndpoint = process.env.PHOENIX_OTLP_ENDPOINT;
const originalAgent = process.env.AGENT_INSTANCE;

afterEach(() => {
  resetTraceExportForTests();
  if (originalEndpoint === undefined) delete process.env.PHOENIX_OTLP_ENDPOINT;
  else process.env.PHOENIX_OTLP_ENDPOINT = originalEndpoint;
  if (originalAgent === undefined) delete process.env.AGENT_INSTANCE;
  else process.env.AGENT_INSTANCE = originalAgent;
});

interface PbField {
  id: number;
  wire: number;
  bytes?: Uint8Array;
  varint?: bigint;
}

function decodeVarint(buf: Uint8Array, offset: number): { value: bigint; next: number } {
  let result = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length) {
    const byte = buf[i++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
  }
  return { value: result, next: i };
}

function decodeFields(buf: Uint8Array): PbField[] {
  const fields: PbField[] = [];
  let i = 0;
  while (i < buf.length) {
    const tag = decodeVarint(buf, i);
    i = tag.next;
    const id = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (wire === 0) {
      const v = decodeVarint(buf, i);
      fields.push({ id, wire, varint: v.value });
      i = v.next;
    } else if (wire === 1) {
      i += 8;
      fields.push({ id, wire });
    } else if (wire === 2) {
      const len = decodeVarint(buf, i);
      i = len.next;
      const n = Number(len.value);
      fields.push({ id, wire, bytes: buf.subarray(i, i + n) });
      i += n;
    } else {
      break;
    }
  }
  return fields;
}

function utf8(bytes: Uint8Array | undefined): string {
  return bytes ? new TextDecoder().decode(bytes) : "";
}

function anyValue(fields: PbField[]): string | number | boolean | undefined {
  const str = fields.find((f) => f.id === 1);
  if (str?.bytes) return utf8(str.bytes);
  const bool = fields.find((f) => f.id === 2);
  if (bool?.varint != null) return bool.varint !== 0n;
  const int = fields.find((f) => f.id === 3);
  if (int?.varint != null) return Number(int.varint);
  return undefined;
}

function keyValues(fields: PbField[], fieldId: number): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const field of fields.filter((f) => f.id === fieldId && f.bytes)) {
    const kv = decodeFields(field.bytes!);
    const key = utf8(kv.find((f) => f.id === 1)?.bytes);
    const valueMsg = kv.find((f) => f.id === 2)?.bytes;
    if (!key || !valueMsg) continue;
    const value = anyValue(decodeFields(valueMsg));
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function decodeSpans(buf: Uint8Array): Array<{ name: string; attrs: Record<string, string | number | boolean> }> {
  const request = decodeFields(buf);
  const resourceSpans = request.find((f) => f.id === 1)?.bytes;
  if (!resourceSpans) return [];
  const rs = decodeFields(resourceSpans);
  const scopeSpans = rs.find((f) => f.id === 2)?.bytes;
  if (!scopeSpans) return [];
  const ss = decodeFields(scopeSpans);
  return ss
    .filter((f) => f.id === 2 && f.bytes)
    .map((f) => {
      const span = decodeFields(f.bytes!);
      return {
        name: utf8(span.find((s) => s.id === 5)?.bytes),
        attrs: keyValues(span, 9),
      };
    });
}

function decodeResourceAttrs(buf: Uint8Array): Record<string, string | number | boolean> {
  const request = decodeFields(buf);
  const resourceSpans = request.find((f) => f.id === 1)?.bytes;
  if (!resourceSpans) return {};
  const resource = decodeFields(resourceSpans).find((f) => f.id === 1)?.bytes;
  if (!resource) return {};
  return keyValues(decodeFields(resource), 1);
}

function writeTraceDb(
  path: string,
  opts: {
    tools?: Array<{
      tool: string;
      status: string;
      command?: string;
      path?: string;
      name?: string;
      output?: string;
      error?: string;
      start?: number;
      end?: number;
      extraInput?: Record<string, unknown>;
    }>;
    assistant?: { modelID?: string; providerID?: string; input?: number; output?: number; error?: string };
  } = {}
): void {
  const db = new Database(path);
  db.run("CREATE TABLE session (id TEXT PRIMARY KEY, time_created INTEGER, time_updated INTEGER)");
  db.run(
    "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)"
  );
  db.run(
    "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)"
  );
  db.run("INSERT INTO session VALUES (?, ?, ?)", ["ses1", 1_000, 5_000]);
  const assistant = opts.assistant ?? { modelID: "grok-4.6", providerID: "xai", input: 10, output: 3 };
  db.run("INSERT INTO message VALUES (?, ?, ?, ?, ?)", [
    "msg1",
    "ses1",
    1_000,
    2_000,
    JSON.stringify({
      role: "assistant",
      modelID: assistant.modelID,
      providerID: assistant.providerID,
      tokens: { input: assistant.input ?? 0, output: assistant.output ?? 0 },
      time: { created: 1_000, completed: 2_000 },
      error: assistant.error ? { message: assistant.error } : undefined,
    }),
  ]);
  let i = 0;
  for (const tool of opts.tools ?? []) {
    i += 1;
    db.run("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)", [
      `part${i}`,
      "msg1",
      "ses1",
      tool.start ?? 1_100,
      tool.end ?? 1_200,
      JSON.stringify({
        type: "tool",
        tool: tool.tool,
        callID: `call${i}`,
        state: {
          status: tool.status,
          input: {
            ...(tool.command ? { command: tool.command } : {}),
            ...(tool.path ? { filePath: tool.path } : {}),
            ...(tool.name ? { name: tool.name } : {}),
            ...tool.extraInput,
          },
          output: tool.output,
          error: tool.error,
          time: { start: tool.start ?? 1_100, end: tool.end ?? 1_200 },
        },
      }),
    ]);
  }
  db.close();
}

describe("buildOpenCodeTraceRequest", () => {
  test("builds an AGENT root with truncated TOOL and LLM children", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-phoenix-"));
    const dbPath = join(dir, "opencode-session.db");
    try {
      writeTraceDb(dbPath, {
        tools: [
          {
            tool: "bash",
            status: "completed",
            command: "ls -la /work",
            output: "HUGE_STDOUT_BODY_MUST_NOT_APPEAR",
            start: 1_100,
            end: 1_250,
          },
          {
            tool: "read",
            status: "completed",
            path: "src/git.ts",
            output: "FILE_BODY_MUST_NOT_APPEAR",
          },
          {
            tool: "skill",
            status: "error",
            name: "gitops-apply-review",
            error: "denied",
          },
          {
            tool: "mystery",
            status: "completed",
            extraInput: { blob: "do-not-guess-this-body" },
            output: "secret-output",
          },
        ],
      });
      const body = buildOpenCodeTraceRequest(dbPath, {
        kind: "review",
        owner: "personal",
        repo: "jumi",
        sha: "abc123",
        jobId: "42",
      });
      expect(body).toBeDefined();
      const text = new TextDecoder().decode(body);
      expect(text).not.toContain("HUGE_STDOUT_BODY_MUST_NOT_APPEAR");
      expect(text).not.toContain("FILE_BODY_MUST_NOT_APPEAR");
      expect(text).not.toContain("do-not-guess-this-body");
      expect(text).not.toContain("secret-output");
      const resource = decodeResourceAttrs(body!);
      expect(resource["openinference.project.name"]).toBe("jumi");
      expect(resource.kind).toBe("review");
      expect(resource.owner).toBe("personal");
      expect(resource.repo).toBe("jumi");
      expect(resource.sha).toBe("abc123");
      expect(resource.job_id).toBe("42");
      expect(resource.agent_instance).toBe("jumi");
      const spans = decodeSpans(body!);
      expect(spans[0]?.name).toBe("jumi review");
      expect(spans[0]?.attrs["openinference.span.kind"]).toBe("AGENT");
      const llm = spans.find((s) => s.attrs["openinference.span.kind"] === "LLM");
      expect(llm?.attrs["llm.model_name"]).toBe("grok-4.6");
      expect(llm?.attrs["llm.provider"]).toBe("xai");
      expect(llm?.attrs["llm.token_count.prompt"]).toBe(10);
      const bash = spans.find((s) => s.name === "bash");
      expect(bash?.attrs["openinference.span.kind"]).toBe("TOOL");
      expect(bash?.attrs["tool.status"]).toBe("completed");
      expect(bash?.attrs["tool.duration_ms"]).toBe(150);
      expect(String(bash?.attrs["tool.parameters"])).toContain("ls -la /work");
      const skill = spans.find((s) => s.name === "skill:gitops-apply-review");
      expect(skill?.attrs["tool.status"]).toBe("error");
      const mystery = spans.find((s) => s.name === "mystery");
      expect(mystery?.attrs["tool.status"]).toBe("completed");
      expect(mystery?.attrs["tool.parameters"]).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("truncates command heads and skips missing tables", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-phoenix-"));
    try {
      const dbPath = join(dir, "opencode-session.db");
      writeTraceDb(dbPath, {
        tools: [{ tool: "bash", status: "completed", command: "x".repeat(400) }],
      });
      const body = buildOpenCodeTraceRequest(dbPath, { kind: "implement", owner: "a", repo: "b" });
      const bash = decodeSpans(body!).find((s) => s.name === "bash");
      const params = JSON.parse(String(bash?.attrs["tool.parameters"])) as { command: string };
      expect(params.command.length).toBe(256);

      const sessionOnly = join(dir, "session-only.db");
      const db = new Database(sessionOnly);
      db.run("CREATE TABLE session (id TEXT)");
      db.close();
      expect(buildOpenCodeTraceRequest(sessionOnly)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("exportOpenCodeTrace", () => {
  test("skips when endpoint is unset", async () => {
    delete process.env.PHOENIX_OTLP_ENDPOINT;
    let called = false;
    setTraceFetchForTests(async () => {
      called = true;
      return new Response(null, { status: 200 });
    });
    await exportOpenCodeTrace({ dbPath: "/no/such.db" });
    expect(called).toBe(false);
    expect(traceExportErrors()).toBe(0);
  });

  test("rejects the public Phoenix hostname", async () => {
    process.env.PHOENIX_OTLP_ENDPOINT = `https://${PUBLIC_PHOENIX_HOST}`;
    let called = false;
    setTraceFetchForTests(async () => {
      called = true;
      return new Response(null, { status: 200 });
    });
    await exportOpenCodeTrace({ dbPath: "/no/such.db" });
    expect(called).toBe(false);
    expect(traceExportErrors()).toBe(1);
  });

  test("POSTs OTLP protobuf and records HTTP failures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-phoenix-"));
    const dbPath = join(dir, "opencode-session.db");
    try {
      writeTraceDb(dbPath, { tools: [{ tool: "bash", status: "completed", command: "pwd" }] });
      process.env.PHOENIX_OTLP_ENDPOINT = "http://phoenix.internal:6006";
      process.env.AGENT_INSTANCE = "jumi-worker";
      const posts: Array<{ url: string; type: string | null; project: string | null; body: Uint8Array }> = [];
      setTraceFetchForTests(async (url, init) => {
        const headers = new Headers(init?.headers);
        posts.push({
          url,
          type: headers.get("content-type"),
          project: headers.get("phoenix-project"),
          body: new Uint8Array(init?.body as Uint8Array),
        });
        return new Response(null, { status: 200 });
      });
      await exportOpenCodeTrace({
        dbPath,
        trace: { kind: "follow-up", owner: "personal", repo: "jumi", sha: "def", jobId: "9" },
      });
      expect(posts).toHaveLength(1);
      expect(posts[0].url).toBe("http://phoenix.internal:6006/v1/traces");
      expect(posts[0].type).toBe("application/x-protobuf");
      expect(posts[0].project).toBe("jumi-worker");
      const resource = decodeResourceAttrs(posts[0].body);
      expect(resource["openinference.project.name"]).toBe("jumi-worker");
      expect(resource.kind).toBe("follow-up");
      expect(traceExportErrors()).toBe(0);

      setTraceFetchForTests(async () => new Response("no", { status: 503 }));
      await exportOpenCodeTrace({ dbPath });
      expect(traceExportErrors()).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("unreadable database increments errors without throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-phoenix-"));
    const dbPath = join(dir, "opencode-session.db");
    try {
      await writeFile(dbPath, "not sqlite");
      process.env.PHOENIX_OTLP_ENDPOINT = "http://127.0.0.1:9";
      await expect(exportOpenCodeTrace({ dbPath })).resolves.toBeUndefined();
      expect(traceExportErrors()).toBe(1);
      expect(renderTokenMetrics()).toContain('ai_trace_exporter_errors{agent_instance="jumi"} 1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("timeout increments errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-phoenix-"));
    const dbPath = join(dir, "opencode-session.db");
    try {
      writeTraceDb(dbPath);
      process.env.PHOENIX_OTLP_ENDPOINT = "http://phoenix.internal:6006";
      setTraceTimeoutForTests(20);
      setTraceFetchForTests(
        (_url, init) =>
          new Promise((_, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          })
      );
      await exportOpenCodeTrace({ dbPath });
      expect(traceExportErrors()).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
