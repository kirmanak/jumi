import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGY_OUTPUT_FORMAT,
  AGY_SEED_SETTINGS,
  AGY_SETTINGS_DIR,
  AGY_SKIP_PERMISSIONS,
  AgyReviewDisabledError,
  agyArgv,
  agyPrintTimeout,
  agyPromptArg,
  runAgy,
} from "../src/agy.ts";
import { AgyStreamParser } from "../src/agy_usage.ts";
import { providerAuthDeathMessage } from "../src/auth.ts";
import { resetControlMetricsForTests } from "../src/control_metrics.ts";
import { registeredEngine, runRegisteredEngine } from "../src/engine_dispatch.ts";
import { agyConversationPath, withEngineChain } from "../src/fallback.ts";
import { formatRunnerStamp, type NamedRunner, runnerStamp } from "../src/runners.ts";
import { renderTokenMetrics, resetTokenMetricsForTests } from "../src/token_metrics.ts";

const originalPath = process.env.PATH;

afterEach(() => {
  resetControlMetricsForTests();
  resetTokenMetricsForTests();
  process.env.PATH = originalPath;
});

interface FakeEnv {
  workdir: string;
  home: string;
  argsLog: string;
}

/** Fake binaries append one line of argv per call to `$ARGS_LOG`. */
async function withFakeBins(bins: Record<string, string>, run: (env: FakeEnv) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "fake-agy-"));
  const workdir = await mkdtemp(join(tmpdir(), "fake-agy-work-"));
  const home = await mkdtemp(join(tmpdir(), "fake-agy-home-"));
  try {
    for (const [name, script] of Object.entries(bins)) {
      const bin = join(dir, name);
      await writeFile(bin, script);
      await chmod(bin, 0o755);
    }
    process.env.PATH = `${dir}:${originalPath ?? ""}`;
    await run({ workdir, home, argsLog: join(dir, "args.log") });
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
}

function fakeBin(name: string, body: string): string {
  return `#!/bin/sh
printf '${name} %s\\n' "$*" >> "$ARGS_LOG"
${body}
`;
}

async function argLines(argsLog: string): Promise<string[]> {
  try {
    return (await readFile(argsLog, "utf8")).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function tokenLine(model: string, tokenType: string, value: number): string {
  return `ai_tokens_total{agent_instance="jumi",source="agy",profile="default",model="${model}",token_type="${tokenType}"} ${value}`;
}

const INIT_EVENT = JSON.stringify({ event: "init", conversation_id: "conv-123" });

function stepEvent(stepId: string, usage: Record<string, number>): string {
  return JSON.stringify({ event: "step_update", step_id: stepId, usage });
}

function resultEvent(fields: Record<string, unknown>): string {
  return JSON.stringify({ event: "result", conversation_id: "conv-123", ...fields });
}

const SUCCESS_RESULT = resultEvent({
  status: "SUCCESS",
  response: "wrote JUMI_PR.md",
  usage: {
    input_tokens: 12000,
    output_tokens: 300,
    thinking_tokens: 40,
    cache_read_tokens: 9000,
    total_tokens: 21340,
  },
});

describe("agyArgv", () => {
  test("print mode with stream-json, skip-permissions, model, effort, lease print-timeout", () => {
    const args = agyArgv({ model: "gemini-3-pro", effort: "high", workdir: "/work", timeoutMs: 600_000 }, "prompt");
    expect(args).toEqual([
      "agy",
      "-p",
      "prompt",
      "--output-format",
      AGY_OUTPUT_FORMAT,
      AGY_SKIP_PERMISSIONS,
      "--model",
      "gemini-3-pro",
      "--effort",
      "high",
      "--print-timeout",
      "570s",
    ]);
    expect(AGY_OUTPUT_FORMAT).toBe("stream-json");
  });

  test("resumes only a known conversation, and only on continueSession", () => {
    expect(agyArgv({ model: "m", workdir: "/w" }, "p", "conv-1")).not.toContain("--conversation");
    expect(agyArgv({ model: "m", workdir: "/w", continueSession: true }, "p")).not.toContain("--conversation");
    expect(agyArgv({ model: "m", workdir: "/w", continueSession: true }, "p", "conv-1").slice(-2)).toEqual([
      "--conversation",
      "conv-1",
    ]);
  });

  test("never lets the print prompt start with a slash command", () => {
    expect(agyPromptArg("/review now")).toBe("Task:\n/review now");
    expect(agyPromptArg("  /skill")).toStartWith("Task:");
    expect(agyPromptArg("Read JUMI_TASK.md")).toBe("Read JUMI_TASK.md");
  });

  test("print-timeout comes from the lease and is omitted without one", () => {
    expect(agyPrintTimeout(undefined)).toBeUndefined();
    expect(agyPrintTimeout(0)).toBeUndefined();
    expect(agyPrintTimeout(10_000)).toBe("10s");
    expect(agyPrintTimeout(3_600_000)).toBe("3570s");
  });
});

describe("AgyStreamParser", () => {
  function parse(lines: string[]): AgyStreamParser {
    const parser = new AgyStreamParser("fallback-model");
    parser.push(new TextEncoder().encode(`${lines.join("\n")}\n`));
    parser.end();
    return parser;
  }

  test("takes usage from the terminal result event", () => {
    const parser = parse([INIT_EVENT, stepEvent("s1", { input_tokens: 5, output_tokens: 1 }), SUCCESS_RESULT]);
    expect(parser.usage()).toEqual(
      new Map([["fallback-model", { input: 12000, cached_input: 9000, output: 300, cache_write: 0, reasoning: 40 }]])
    );
    expect(parser.result()).toEqual({
      status: "SUCCESS",
      response: "wrote JUMI_PR.md",
      error: undefined,
      deniedActions: [],
    });
    expect(parser.conversationId()).toBe("conv-123");
    expect(parser.text()).toBe("wrote JUMI_PR.md");
  });

  test("falls back to accumulated per-step usage when killed before result", () => {
    const parser = parse([
      INIT_EVENT,
      stepEvent("s1", { input_tokens: 10, output_tokens: 1 }),
      stepEvent("s1", { input_tokens: 10, output_tokens: 4, thinking_tokens: 2 }),
      JSON.stringify({ event: "step_update", step: { id: "s2", usage: { input_tokens: 5, cache_read_tokens: 7 } } }),
    ]);
    expect(parser.result()).toBeUndefined();
    expect(parser.usage()).toEqual(
      new Map([["fallback-model", { input: 15, cached_input: 7, output: 4, cache_write: 0, reasoning: 2 }]])
    );
  });

  test("missing usage and non-json lines are fail-open", () => {
    const parser = parse(["{not json", resultEvent({ status: "SUCCESS", response: "ok", usage: "nope" })]);
    expect(parser.usage()).toBeUndefined();
    expect(parser.text()).toBe("{not json\nok");
  });
});

describe("runAgy", () => {
  test("spawns agy in the worktree with HOME, scrubbed forge secrets, and seeded settings", async () => {
    await withFakeBins(
      {
        agy: fakeBin(
          "agy",
          `printf '%s\\n' "{\\"event\\":\\"result\\",\\"status\\":\\"SUCCESS\\",\\"response\\":\\"HOME=$HOME SECRET=$GITEA_BOT_TOKEN CWD=$(pwd)\\"}"`
        ),
      },
      async ({ workdir, home, argsLog }) => {
        const result = await runAgy({
          prompt: "Read JUMI_TASK.md",
          model: "gemini-3-pro",
          effort: "high",
          workdir,
          home,
          sanitizeEnv: true,
          trace: { kind: "implement", owner: "kirmanak", repo: "jumi" },
          extraEnv: { ARGS_LOG: argsLog, GITEA_BOT_TOKEN: "should-not-pass" },
        });
        expect(result.status).toBe("ok");
        expect(result.stdout).toBe(`HOME=${home} SECRET= CWD=${workdir}`);
        const [line] = await argLines(argsLog);
        expect(line).toContain(`agy -p Read JUMI_TASK.md --output-format stream-json ${AGY_SKIP_PERMISSIONS}`);
        expect(line).toContain("--model gemini-3-pro --effort high");
        const settings = JSON.parse(await readFile(join(home, AGY_SETTINGS_DIR, "settings.json"), "utf8"));
        expect(settings).toEqual(AGY_SEED_SETTINGS);
      }
    );
  });

  test("does not overwrite an existing settings file", async () => {
    await withFakeBins(
      { agy: fakeBin("agy", `printf '%s\\n' '${SUCCESS_RESULT}'`) },
      async ({ workdir, home, argsLog }) => {
        const dir = join(home, AGY_SETTINGS_DIR);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "settings.json"), '{"account":"logged-in"}');
        await runAgy({ prompt: "p", model: "m", workdir, home, sanitizeEnv: true, extraEnv: { ARGS_LOG: argsLog } });
        expect(await readFile(join(dir, "settings.json"), "utf8")).toBe('{"account":"logged-in"}');
      }
    );
  });

  test("reviewer spawn is fail-closed and never execs agy", async () => {
    await withFakeBins({ agy: fakeBin("agy", "exit 0") }, async ({ workdir, argsLog }) => {
      await expect(
        runAgy({
          prompt: "p",
          model: "m",
          workdir,
          sanitizeEnv: true,
          extraEnv: { ARGS_LOG: argsLog },
          trace: { kind: "review", owner: "o", repo: "r" },
        })
      ).rejects.toBeInstanceOf(AgyReviewDisabledError);
      expect(await argLines(argsLog)).toEqual([]);
    });
  });

  test("records result usage under source=agy", async () => {
    await withFakeBins(
      { agy: fakeBin("agy", `printf '%s\\n' '${INIT_EVENT}'\nprintf '%s\\n' '${SUCCESS_RESULT}'`) },
      async ({ workdir, argsLog }) => {
        const result = await runAgy({
          prompt: "p",
          model: "gemini-3-pro",
          workdir,
          sanitizeEnv: true,
          extraEnv: { ARGS_LOG: argsLog },
        });
        expect(result.status).toBe("ok");
        const text = renderTokenMetrics();
        expect(text).toContain(tokenLine("gemini-3-pro", "input", 12000));
        expect(text).toContain(tokenLine("gemini-3-pro", "cached_input", 9000));
        expect(text).toContain(tokenLine("gemini-3-pro", "output", 300));
        expect(text).toContain(tokenLine("gemini-3-pro", "reasoning", 40));
        expect(text).toContain(
          'ai_sessions{agent_instance="jumi",source="agy",profile="default",model="gemini-3-pro"} 1'
        );
        expect((await readFile(agyConversationPath(workdir), "utf8")).trim()).toBe("conv-123");
      }
    );
  });

  test("records per-step usage when the parent kills the child before result", async () => {
    await withFakeBins(
      {
        agy: fakeBin(
          "agy",
          `printf '%s\\n' '${stepEvent("s1", { input_tokens: 12000, output_tokens: 3 })}'
printf '%s\\n' '${stepEvent("s2", { input_tokens: 500, output_tokens: 7 })}'
exec sleep 30`
        ),
      },
      async ({ workdir, argsLog }) => {
        const result = await runAgy({
          prompt: "p",
          model: "gemini-3-pro",
          workdir,
          sanitizeEnv: true,
          timeoutMs: 500,
          extraEnv: { ARGS_LOG: argsLog },
        });
        expect(result.status).toBe("timeout");
        const text = renderTokenMetrics();
        expect(text).toContain(tokenLine("gemini-3-pro", "input", 12500));
        expect(text).toContain(tokenLine("gemini-3-pro", "output", 10));
      }
    );
  });

  test("empty SUCCESS with denied actions fails closed", async () => {
    const denied = resultEvent({ status: "SUCCESS", response: "", denied_actions: ["RunCommand"] });
    await withFakeBins({ agy: fakeBin("agy", `printf '%s\\n' '${denied}'`) }, async ({ workdir, argsLog }) => {
      const result = await runAgy({
        prompt: "p",
        model: "m",
        workdir,
        sanitizeEnv: true,
        extraEnv: { ARGS_LOG: argsLog },
      });
      expect(result.status).toBe("exit");
      expect(result.exitCode).toBe(0);
      expect(result.auth).toBeFalsy();
      expect(result.message).toContain("denied actions: RunCommand");
    });
  });

  test("non-SUCCESS status on exit 0 is not a completed run", async () => {
    const failed = resultEvent({ status: "ERROR", error: "boom" });
    await withFakeBins({ agy: fakeBin("agy", `printf '%s\\n' '${failed}'`) }, async ({ workdir, argsLog }) => {
      const result = await runAgy({
        prompt: "p",
        model: "m",
        workdir,
        sanitizeEnv: true,
        extraEnv: { ARGS_LOG: argsLog },
      });
      expect(result.status).toBe("exit");
      expect(result.message).toContain("agy result status ERROR: boom");
    });
  });

  test("unauthed CLI is auth death", async () => {
    await withFakeBins(
      { agy: fakeBin("agy", `printf 'Please sign in to continue\\n' >&2\nexit 1`) },
      async ({ workdir, argsLog }) => {
        const result = await runAgy({
          prompt: "p",
          model: "m",
          workdir,
          sanitizeEnv: true,
          extraEnv: { ARGS_LOG: argsLog },
        });
        expect(result.status).toBe("exit");
        expect(result.auth).toBe(true);
        expect(result.message).toBe(providerAuthDeathMessage());
      }
    );
  });
});

describe("agy dispatch and chain", () => {
  const agy: NamedRunner = { name: "agy", type: "agy", model: "gemini-3-pro", effort: "high" };
  const claude: NamedRunner = { name: "claude", type: "claude", model: "claude-opus-5", effort: "high" };
  const claudeBin = fakeBin("claude", `printf '%s\\n' '{"type":"result","result":"claude done"}'`);

  test("runRegisteredEngine dispatches type agy to the agy binary", async () => {
    await withFakeBins({ agy: fakeBin("agy", `printf '%s\\n' '${SUCCESS_RESULT}'`) }, async ({ workdir, argsLog }) => {
      const result = await runRegisteredEngine({
        type: "agy",
        prompt: "p",
        model: "gemini-3-pro",
        workdir,
        sanitizeEnv: true,
        extraEnv: { ARGS_LOG: argsLog },
      });
      expect(result.status).toBe("ok");
      expect(await argLines(argsLog)).toHaveLength(1);
    });
  });

  test("auth miss hops to the next runner, and extras never --continue across runners", async () => {
    await withFakeBins(
      {
        agy: fakeBin("agy", `printf '%s\\n' '${INIT_EVENT}'\nprintf 'authentication required\\n' >&2\nexit 1`),
        claude: claudeBin,
      },
      async ({ workdir, argsLog }) => {
        const engine = withEngineChain(registeredEngine, { chain: [agy, claude] });
        const base = { prompt: "p", model: agy.model, workdir, sanitizeEnv: true, extraEnv: { ARGS_LOG: argsLog } };
        const first = await engine(base);
        expect(first.status).toBe("ok");
        expect(first.runner).toEqual(runnerStamp(claude));
        const extra = await engine({ ...base, continueSession: true });
        expect(extra.status).toBe("ok");
        const lines = await argLines(argsLog);
        expect(lines.map((line) => line.split(" ")[0])).toEqual(["agy", "claude", "claude"]);
        expect(lines[1]).not.toContain("--continue");
        expect(lines[2]).toContain("--continue");
        expect(lines[2]).not.toContain("--conversation");
        await expect(readFile(agyConversationPath(workdir), "utf8")).rejects.toThrow();
      }
    );
  });

  test("RESOURCE_EXHAUSTED hops as provider unavailable", async () => {
    await withFakeBins(
      {
        agy: fakeBin(
          "agy",
          `printf '%s\\n' '${resultEvent({ status: "ERROR", error: "RESOURCE_EXHAUSTED" })}'\nexit 1`
        ),
        claude: claudeBin,
      },
      async ({ workdir, argsLog }) => {
        const engine = withEngineChain(registeredEngine, { chain: [agy, claude] });
        const result = await engine({
          prompt: "p",
          model: agy.model,
          workdir,
          sanitizeEnv: true,
          extraEnv: { ARGS_LOG: argsLog },
        });
        expect(result.status).toBe("ok");
        expect(result.runner).toEqual(runnerStamp(claude));
      }
    );
  });

  test("same-runner extras resume the agy conversation", async () => {
    await withFakeBins(
      {
        agy: fakeBin("agy", `printf '%s\\n' '${INIT_EVENT}'\nprintf '%s\\n' '${SUCCESS_RESULT}'`),
        claude: claudeBin,
      },
      async ({ workdir, argsLog }) => {
        const engine = withEngineChain(registeredEngine, { chain: [agy, claude] });
        const base = { prompt: "p", model: agy.model, workdir, sanitizeEnv: true, extraEnv: { ARGS_LOG: argsLog } };
        const first = await engine(base);
        expect(first.runner).toEqual(runnerStamp(agy));
        expect(formatRunnerStamp(first.runner!)).toBe("_Jumi · agy · gemini-3-pro (high)_");
        await engine({ ...base, continueSession: true });
        const lines = await argLines(argsLog);
        expect(lines.map((line) => line.split(" ")[0])).toEqual(["agy", "agy"]);
        expect(lines[0]).not.toContain("--conversation");
        expect(lines[1]).toContain("--conversation conv-123");
      }
    );
  });
});
