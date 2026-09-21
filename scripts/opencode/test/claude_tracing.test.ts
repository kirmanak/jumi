import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_TRACING_PLUGIN_DIR,
  claudeTracingEnv,
  claudeTracingPluginDir,
  phoenixPluginEndpoint,
  setClaudeTracingPluginDirForTests,
} from "../src/claude_tracing.ts";
import { PUBLIC_PHOENIX_HOST } from "../src/phoenix.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const pluginDir = join(repoRoot, "claude-plugins/claude-code-tracing");
const hooks = join(pluginDir, "hooks");

const originalEndpoint = process.env.PHOENIX_OTLP_ENDPOINT;
const originalAgent = process.env.AGENT_INSTANCE;

afterEach(() => {
  setClaudeTracingPluginDirForTests(undefined);
  if (originalEndpoint === undefined) delete process.env.PHOENIX_OTLP_ENDPOINT;
  else process.env.PHOENIX_OTLP_ENDPOINT = originalEndpoint;
  if (originalAgent === undefined) delete process.env.AGENT_INSTANCE;
  else process.env.AGENT_INSTANCE = originalAgent;
});

describe("phoenixPluginEndpoint", () => {
  test("strips the OpenCode exporter's OTLP path instead of copying it blindly", () => {
    // The stored value serves an exporter that POSTs OTLP to <base>/v1/traces.
    // The plugin builds <base>/v1/projects/<name>/spans, so a verbatim copy
    // would reach /v1/traces/v1/projects/... and nothing would land.
    expect(phoenixPluginEndpoint("http://phoenix.phoenix.svc:6006/v1/traces")).toBe("http://phoenix.phoenix.svc:6006");
    expect(phoenixPluginEndpoint("http://phoenix.phoenix.svc:6006/v1/traces/")).toBe("http://phoenix.phoenix.svc:6006");
    expect(phoenixPluginEndpoint("http://phoenix.phoenix.svc:6006/")).toBe("http://phoenix.phoenix.svc:6006");
    expect(phoenixPluginEndpoint("  http://phoenix.phoenix.svc:6006  ")).toBe("http://phoenix.phoenix.svc:6006");
    expect(phoenixPluginEndpoint("http://phoenix.phoenix.svc:6006/ingest")).toBe(
      "http://phoenix.phoenix.svc:6006/ingest"
    );
  });

  test("refuses the public hostname, junk, and non-HTTP schemes", () => {
    expect(phoenixPluginEndpoint(`https://${PUBLIC_PHOENIX_HOST}`)).toBeUndefined();
    expect(phoenixPluginEndpoint(`https://${PUBLIC_PHOENIX_HOST}/v1/traces`)).toBeUndefined();
    expect(phoenixPluginEndpoint("grpc://phoenix.phoenix.svc:4317")).toBeUndefined();
    expect(phoenixPluginEndpoint("phoenix.phoenix.svc:6006")).toBeUndefined();
    expect(phoenixPluginEndpoint("   ")).toBeUndefined();
    expect(phoenixPluginEndpoint(undefined)).toBeUndefined();
  });
});

describe("claudeTracingEnv", () => {
  test("is empty without an endpoint, so the child runs untraced instead of failing", () => {
    delete process.env.PHOENIX_OTLP_ENDPOINT;
    setClaudeTracingPluginDirForTests(pluginDir);
    expect(claudeTracingEnv({ kind: "review", owner: "o", repo: "r" })).toEqual({});
    expect(claudeTracingPluginDir()).toBeUndefined();
  });

  test("is empty when the plugin is not in the image", () => {
    process.env.PHOENIX_OTLP_ENDPOINT = "http://phoenix.phoenix.svc:6006";
    setClaudeTracingPluginDirForTests("/no/such/plugin");
    expect(claudeTracingEnv({ kind: "review", owner: "o", repo: "r" })).toEqual({});
    expect(claudeTracingPluginDir()).toBeUndefined();
  });

  test("names the factory source as the project and carries the job id", () => {
    process.env.PHOENIX_OTLP_ENDPOINT = "http://phoenix.phoenix.svc:6006/v1/traces";
    process.env.AGENT_INSTANCE = "jumi-worker";
    setClaudeTracingPluginDirForTests(pluginDir);
    expect(
      claudeTracingEnv({ kind: "implement", owner: "kirmanak", repo: "jumi", sha: "abc", jobId: "job-7" })
    ).toEqual({
      PHOENIX_ENDPOINT: "http://phoenix.phoenix.svc:6006",
      ARIZE_PROJECT_NAME: "jumi-worker",
      ARIZE_TRACE_ENABLED: "true",
      ARIZE_LOG_PROMPTS: "false",
      JUMI_AGENT_INSTANCE: "jumi-worker",
      JUMI_TRACE_KIND: "implement",
      JUMI_OWNER: "kirmanak",
      JUMI_REPO: "jumi",
      JUMI_SHA: "abc",
      JUMI_JOB_ID: "job-7",
    });

    // Engine keeps the default source, not a `claude-code` harness dump.
    delete process.env.AGENT_INSTANCE;
    expect(claudeTracingEnv({ kind: "review", owner: "kirmanak", repo: "jumi" }).ARIZE_PROJECT_NAME).toBe("jumi");
  });

  test("points at the vendored image path by default", () => {
    expect(CLAUDE_TRACING_PLUGIN_DIR).toBe("/app/claude-plugins/claude-code-tracing");
  });
});

interface Captured {
  url: string;
  body: { data: Array<{ name: string; span_kind: string; attributes: Record<string, unknown> }> };
}

/** Run the vendored hooks against a fake Phoenix and collect what they POST. */
async function withPluginRun(
  run: (ctx: {
    env: Record<string, string>;
    state: string;
    hook: (name: string, input: unknown) => Promise<number>;
  }) => Promise<void>
): Promise<Captured[]> {
  const captured: Captured[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      captured.push({ url: new URL(req.url).pathname, body: await req.json() });
      return Response.json({ total_received: 1, total_queued: 1 }, { status: 202 });
    },
  });
  const state = await mkdtemp(join(tmpdir(), "arize-state-"));
  try {
    process.env.PHOENIX_OTLP_ENDPOINT = `http://127.0.0.1:${server.port}/v1/traces`;
    process.env.AGENT_INSTANCE = "jumi-worker";
    setClaudeTracingPluginDirForTests(pluginDir);
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: state,
      ...claudeTracingEnv({ kind: "implement", owner: "kirmanak", repo: "jumi", sha: "deadbeef", jobId: "job-42" }),
    };
    const hook = async (name: string, input: unknown): Promise<number> => {
      const proc = Bun.spawn(["bash", join(hooks, name)], {
        env,
        stdin: new TextEncoder().encode(JSON.stringify(input)),
        stdout: "pipe",
        stderr: "pipe",
      });
      return await proc.exited;
    };
    await run({ env, state, hook });
  } finally {
    server.stop(true);
    await rm(state, { recursive: true, force: true });
  }
  return captured;
}

const hasShellTools =
  Bun.which("bash") !== null &&
  Bun.which("jq") !== null &&
  (Bun.which("python3") !== null || Bun.which("curl") !== null);

describe.if(hasShellTools)("vendored claude-code-tracing hooks", () => {
  test("post OpenInference spans that carry the Jumi job id and no prompt text", async () => {
    const transcript = join(await mkdtemp(join(tmpdir(), "arize-transcript-")), "transcript.jsonl");
    // A turn before this one, so the span must not reprint it.
    await writeFile(
      transcript,
      `${JSON.stringify({
        type: "assistant",
        message: { model: "claude-opus-5", content: [{ type: "text", text: "EARLIER TURN" }], usage: {} },
      })}\n`
    );

    const spans = await withPluginRun(async ({ hook }) => {
      const session = { session_id: "claude-session-1", cwd: "/work", transcript_path: transcript };
      expect(await hook("session_start.sh", session)).toBe(0);
      expect(await hook("user_prompt_submit.sh", { ...session, prompt: "SECRET TASK PROSE" })).toBe(0);
      expect(await hook("pre_tool_use.sh", { ...session, tool_use_id: "t1" })).toBe(0);
      expect(
        await hook("post_tool_use.sh", {
          ...session,
          tool_use_id: "t1",
          tool_name: "Bash",
          tool_input: { command: "bun test" },
          tool_response: "2 pass",
        })
      ).toBe(0);
      await appendFile(
        transcript,
        `${JSON.stringify({
          type: "assistant",
          message: {
            model: "claude-opus-5",
            content: [{ type: "text", text: "done" }],
            usage: { input_tokens: 11, output_tokens: 3 },
          },
        })}\n`
      );
      expect(await hook("stop.sh", session)).toBe(0);
      expect(await hook("session_end.sh", session)).toBe(0);
    });

    // Project name is the factory source, not the plugin's `claude-code` default.
    expect(new Set(spans.map((s) => s.url))).toEqual(new Set(["/v1/projects/jumi-worker/spans"]));

    const byName = new Map(spans.map((s) => [s.body.data[0]?.name ?? "", s.body.data[0]]));
    const tool = byName.get("Bash");
    const turn = byName.get("Turn 1");
    expect(tool).toBeDefined();
    expect(turn).toBeDefined();

    // The kind travels as the span kind, not upstream's hardcoded CHAIN.
    expect(tool?.span_kind).toBe("TOOL");
    expect(turn?.span_kind).toBe("LLM");

    // Job identity on every span, under the keys the OpenCode exporter writes.
    for (const span of [tool, turn]) {
      expect(span?.attributes.job_id).toBe("job-42");
      expect(span?.attributes["session.id"]).toBe("job-42");
      expect(span?.attributes.kind).toBe("implement");
      expect(span?.attributes.owner).toBe("kirmanak");
      expect(span?.attributes.repo).toBe("jumi");
      expect(span?.attributes.sha).toBe("deadbeef");
      expect(span?.attributes.agent_instance).toBe("jumi-worker");
    }

    // Tool names, arguments and results ride along; prompt prose does not.
    expect(tool?.attributes["tool.name"]).toBe("Bash");
    expect(tool?.attributes["tool.command"]).toBe("bun test");
    expect(tool?.attributes["output.value"]).toBe("2 pass");
    expect(turn?.attributes["input.value"]).toBeUndefined();
    expect(turn?.attributes["llm.model_name"]).toBe("claude-opus-5");
    expect(turn?.attributes["llm.token_count.prompt"]).toBe(11);
    expect(turn?.attributes["output.value"]).toBe("done");
    expect(JSON.stringify(spans)).not.toContain("SECRET TASK PROSE");
    // Only this turn's transcript lines; the conversation is not reprinted.
    expect(JSON.stringify(spans)).not.toContain("EARLIER TURN");
  });

  test("an unreachable Phoenix leaves the hooks exiting clean", async () => {
    const state = await mkdtemp(join(tmpdir(), "arize-state-"));
    try {
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "",
        HOME: state,
        // Reserved-discard port: the connect fails fast and locally.
        PHOENIX_ENDPOINT: "http://127.0.0.1:9",
        ARIZE_PROJECT_NAME: "jumi",
        ARIZE_TRACE_ENABLED: "true",
        ARIZE_LOG_PROMPTS: "false",
        ARIZE_HTTP_TIMEOUT: "2",
        JUMI_JOB_ID: "job-42",
      };
      const input = { session_id: "claude-session-2", cwd: "/work" };
      for (const name of ["session_start.sh", "user_prompt_submit.sh", "stop.sh", "session_end.sh"]) {
        const proc = Bun.spawn(["bash", join(hooks, name)], {
          env,
          stdin: new TextEncoder().encode(JSON.stringify(input)),
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(await proc.exited).toBe(0);
        // Claude Code adds a UserPromptSubmit hook's stdout to the context, and
        // the parent classifies the child's stderr. The plugin stays off both.
        expect(await new Response(proc.stdout).text()).toBe("");
        expect(await new Response(proc.stderr).text()).toBe("");
      }
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  });
});
