import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Engine, EngineFailedError, type EngineResult } from "../src/engine.ts";
import {
  agyConversationPath,
  clearOpenCodeSession,
  hasResumableSession,
  isProviderUnavailableResult,
  looksLikeProviderUnavailable,
  openCodeLogDirPath,
  openCodeSessionDbPath,
  shouldHopInsteadOfQuotaStuck,
  withEngineChain,
  withModelHop,
} from "../src/fallback.ts";
import { runOpenCode } from "../src/git.ts";
import { QUOTA_MESSAGE } from "../src/quota.ts";

const unavailable: EngineResult = {
  status: "exit",
  exitCode: 1,
  message: "opencode exited with code 1:\n429 rate limit exceeded",
};

function ok(model: string): EngineResult {
  return { status: "ok", exitCode: 0, stdout: model };
}

describe("looksLikeProviderUnavailable", () => {
  test("hops on rate limit, quota, 5xx, and model gone", () => {
    expect(looksLikeProviderUnavailable("429 rate limit exceeded")).toBe(true);
    expect(looksLikeProviderUnavailable("You've hit your usage limit")).toBe(true);
    expect(looksLikeProviderUnavailable("You've hit your session limit · resets 12:50am (UTC)")).toBe(true);
    expect(
      looksLikeProviderUnavailable("claude exited with code 1:\nYou've hit your session limit · resets 12:50am (UTC)")
    ).toBe(true);
    expect(looksLikeProviderUnavailable("insufficient_quota")).toBe(true);
    expect(looksLikeProviderUnavailable("provider overloaded")).toBe(true);
    expect(looksLikeProviderUnavailable("503 service unavailable")).toBe(true);
    expect(looksLikeProviderUnavailable("502 bad gateway")).toBe(true);
    expect(looksLikeProviderUnavailable("model not found")).toBe(true);
    expect(looksLikeProviderUnavailable("unknown model")).toBe(true);
  });

  test("does not hop on infra, variant, timeout chatter, or generic errors", () => {
    expect(looksLikeProviderUnavailable("EACCES: mkdir '/data/.local/state'")).toBe(false);
    expect(looksLikeProviderUnavailable("missing API key")).toBe(false);
    expect(looksLikeProviderUnavailable("spawn opencode ENOENT")).toBe(false);
    expect(looksLikeProviderUnavailable("unknown variant xhigh")).toBe(false);
    expect(looksLikeProviderUnavailable("invalid provider options")).toBe(false);
    expect(looksLikeProviderUnavailable("opencode exited with code 1:\nbad things")).toBe(false);
  });
});

describe("isProviderUnavailableResult", () => {
  test("only after a non-infra, non-143 exit", () => {
    expect(isProviderUnavailableResult(unavailable)).toBe(true);
    expect(isProviderUnavailableResult({ status: "ok" })).toBe(false);
    expect(isProviderUnavailableResult({ status: "timeout", message: "429 rate limit exceeded" })).toBe(false);
    expect(isProviderUnavailableResult({ status: "exit", exitCode: 143, message: "429 rate limit exceeded" })).toBe(
      false
    );
    expect(isProviderUnavailableResult({ ...unavailable, infra: true })).toBe(false);
    expect(isProviderUnavailableResult({ ...unavailable, auth: true })).toBe(false);
    expect(
      isProviderUnavailableResult({
        status: "exit",
        exitCode: 1,
        stdout: "429 rate limit exceeded",
        message: "opencode exited with code 1",
      })
    ).toBe(false);
  });
});

describe("shouldHopInsteadOfQuotaStuck", () => {
  test("hops only when fallback is configured on a different provider", () => {
    expect(shouldHopInsteadOfQuotaStuck("opencode/big-pickle", undefined)).toBe(false);
    expect(shouldHopInsteadOfQuotaStuck("opencode/big-pickle", "")).toBe(false);
    expect(shouldHopInsteadOfQuotaStuck("opencode/big-pickle", "opencode/gpt-5.5")).toBe(false);
    expect(shouldHopInsteadOfQuotaStuck("opencode/big-pickle", "anthropic/claude-sonnet-4-6")).toBe(true);
    expect(shouldHopInsteadOfQuotaStuck("openai/gpt-5.5", "openai/gpt-5.4")).toBe(false);
  });

  test("hops onto an unprefixed catalog model such as claude", () => {
    expect(shouldHopInsteadOfQuotaStuck("opencode/muse-spark-1.3-contributor-free", "claude-opus-5")).toBe(true);
    expect(shouldHopInsteadOfQuotaStuck("opencode/muse-spark-1.3-contributor-free", "xai/grok-4.6")).toBe(true);
    expect(shouldHopInsteadOfQuotaStuck("claude-opus-5", "claude-opus-5")).toBe(false);
  });
});

describe("withModelHop", () => {
  test("unset fallback is identity: one primary call, no hop", async () => {
    const models: string[] = [];
    const engine: Engine = async (opts) => {
      models.push(opts.model);
      return unavailable;
    };
    const wrapped = withModelHop(engine, {});
    expect(wrapped).toBe(engine);
    const result = await wrapped({ model: "openai/gpt-5.5", workdir: "/tmp" });
    expect(result).toEqual(unavailable);
    expect(models).toEqual(["openai/gpt-5.5"]);
  });

  test("first call dies as provider-unavailable, second call with fallback succeeds", async () => {
    const calls: Array<{ model: string; variant?: string; continueSession?: boolean; hop?: boolean }> = [];
    const engine: Engine = async (opts) => {
      calls.push({
        model: opts.model,
        variant: opts.variant,
        continueSession: opts.continueSession,
        hop: opts.hop,
      });
      if (opts.model === "openai/gpt-5.5") return unavailable;
      return ok(opts.model);
    };
    const result = await withModelHop(engine, {
      fallbackModel: "anthropic/claude-sonnet-4-6",
      fallbackVariant: "high",
    })({ model: "openai/gpt-5.5", variant: "xhigh", workdir: "/tmp" });
    expect(result).toMatchObject(ok("anthropic/claude-sonnet-4-6"));
    expect(calls).toEqual([
      { model: "openai/gpt-5.5", variant: "xhigh", continueSession: undefined, hop: undefined },
      { model: "anthropic/claude-sonnet-4-6", variant: "high", continueSession: false, hop: true },
    ]);
  });

  test("fallback provider-unavailable fails closed with no hop back", async () => {
    const models: string[] = [];
    const engine: Engine = async (opts) => {
      models.push(opts.model);
      return unavailable;
    };
    const result = await withModelHop(engine, { fallbackModel: "anthropic/claude-sonnet-4-6" })({
      model: "openai/gpt-5.5",
      workdir: "/tmp",
    });
    expect(isProviderUnavailableResult(result)).toBe(true);
    expect(models).toEqual(["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"]);
  });

  test("does not hop on infra, timeout, 143, abort, or continueSession extras", async () => {
    const abortErr = new Error("cancelled");
    abortErr.name = "AbortError";
    const cases: Array<{
      result?: EngineResult;
      error?: Error;
      opts?: { continueSession?: boolean; abortSignal?: AbortSignal };
    }> = [
      { result: { status: "timeout", message: "429 rate limit exceeded" } },
      { result: { status: "exit", exitCode: 143, message: "429 rate limit exceeded" } },
      { result: { status: "exit", exitCode: 1, message: "EACCES: mkdir", infra: true } },
      { error: new EngineFailedError("EACCES: mkdir '/data/.local/state'", true) },
      { result: unavailable, opts: { continueSession: true } },
      { result: unavailable, opts: { abortSignal: AbortSignal.abort() } },
      { error: abortErr },
    ];
    for (const entry of cases) {
      let n = 0;
      const engine: Engine = async () => {
        n++;
        if (entry.error) throw entry.error;
        return entry.result!;
      };
      const wrapped = withModelHop(engine, { fallbackModel: "anthropic/claude-sonnet-4-6" });
      if (entry.error) {
        await expect(wrapped({ model: "openai/gpt-5.5", workdir: "/tmp" })).rejects.toBe(entry.error);
      } else {
        await wrapped({ model: "openai/gpt-5.5", workdir: "/tmp", ...entry.opts });
      }
      expect(n).toBe(1);
    }
  });

  test("does not hop when only stdout quotes a provider-unavailable string", async () => {
    const models: string[] = [];
    const stdoutHit: EngineResult = {
      status: "exit",
      exitCode: 1,
      stdout: "429 rate limit exceeded",
      message: "opencode exited with code 1",
    };
    const engine: Engine = async (opts) => {
      models.push(opts.model);
      return stdoutHit;
    };
    const result = await withModelHop(engine, { fallbackModel: "anthropic/claude-sonnet-4-6" })({
      model: "openai/gpt-5.5",
      workdir: "/tmp",
    });
    expect(result).toMatchObject(stdoutHit);
    expect(models).toEqual(["openai/gpt-5.5"]);
  });

  test("skips hop when lease extend fails", async () => {
    const models: string[] = [];
    const engine: Engine = async (opts) => {
      models.push(opts.model);
      return unavailable;
    };
    const result = await withModelHop(engine, {
      fallbackModel: "anthropic/claude-sonnet-4-6",
      remainingLeaseMs: () => 1_500_000,
      extendLease: async () => false,
    })({ model: "openai/gpt-5.5", workdir: "/tmp", timeoutMs: 900_000 });
    expect(result).toMatchObject(unavailable);
    expect(models).toEqual(["openai/gpt-5.5"]);
  });

  test("skips hop when remaining lease cannot cover the full timeout", async () => {
    const models: string[] = [];
    const engine: Engine = async (opts) => {
      models.push(opts.model);
      return unavailable;
    };
    const result = await withModelHop(engine, {
      fallbackModel: "anthropic/claude-sonnet-4-6",
      remainingLeaseMs: () => 1_000,
    })({ model: "openai/gpt-5.5", workdir: "/tmp", timeoutMs: 900_000 });
    expect(result).toMatchObject(unavailable);
    expect(models).toEqual(["openai/gpt-5.5"]);
  });

  test("extends lease then hops when remaining covers timeout", async () => {
    const models: string[] = [];
    let remaining = 1_000;
    let extended = 0;
    const engine: Engine = async (opts) => {
      models.push(opts.model);
      return opts.model.startsWith("anthropic/") ? ok(opts.model) : unavailable;
    };
    const result = await withModelHop(engine, {
      fallbackModel: "anthropic/claude-sonnet-4-6",
      remainingLeaseMs: () => remaining,
      extendLease: async () => {
        extended++;
        remaining = 1_500_000;
        return true;
      },
    })({ model: "openai/gpt-5.5", workdir: "/tmp", timeoutMs: 900_000 });
    expect(result).toMatchObject(ok("anthropic/claude-sonnet-4-6"));
    expect(extended).toBe(1);
    expect(models).toEqual(["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"]);
  });

  test("clears session DB and does not pass --continue on the hop", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-hop-"));
    try {
      await mkdir(join(dir, ".jumi-tmp"), { recursive: true });
      await writeFile(openCodeSessionDbPath(dir), "primary-session");
      const calls: Array<{ model: string; continueSession?: boolean }> = [];
      const engine: Engine = async (opts) => {
        calls.push({ model: opts.model, continueSession: opts.continueSession });
        if (opts.model === "openai/gpt-5.5") return unavailable;
        await Bun.file(openCodeSessionDbPath(dir))
          .exists()
          .then((exists) => {
            expect(exists).toBe(false);
          });
        return ok(opts.model);
      };
      await withModelHop(engine, { fallbackModel: "anthropic/claude-sonnet-4-6" })({
        model: "openai/gpt-5.5",
        workdir: dir,
      });
      expect(calls[1]).toEqual({ model: "anthropic/claude-sonnet-4-6", continueSession: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("after a hop, extras use the fallback model and may continue that session", async () => {
    const calls: Array<{ model: string; continueSession?: boolean; hop?: boolean }> = [];
    const engine: Engine = async (opts) => {
      calls.push({ model: opts.model, continueSession: opts.continueSession, hop: opts.hop });
      if (opts.model === "openai/gpt-5.5") return unavailable;
      return ok(opts.model);
    };
    const wrapped = withModelHop(engine, { fallbackModel: "anthropic/claude-sonnet-4-6" });
    await wrapped({ model: "openai/gpt-5.5", workdir: "/tmp" });
    await wrapped({ model: "openai/gpt-5.5", workdir: "/tmp", continueSession: true });
    expect(calls).toEqual([
      { model: "openai/gpt-5.5", continueSession: undefined, hop: undefined },
      { model: "anthropic/claude-sonnet-4-6", continueSession: false, hop: true },
      { model: "anthropic/claude-sonnet-4-6", continueSession: true, hop: undefined },
    ]);
  });

  test("auth exit class hops once", async () => {
    const authDeath: EngineResult = {
      status: "exit",
      exitCode: 1,
      message: "host: provider auth death",
      auth: true,
    };
    const models: string[] = [];
    const engine: Engine = async (opts) => {
      models.push(opts.model);
      if (opts.model === "openai/gpt-5.5") return authDeath;
      return ok(opts.model);
    };
    const result = await withModelHop(engine, { fallbackModel: "anthropic/claude-sonnet-4-6" })({
      model: "openai/gpt-5.5",
      workdir: "/tmp",
    });
    expect(result).toMatchObject(ok("anthropic/claude-sonnet-4-6"));
    expect(models).toEqual(["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"]);
  });

  test("EngineFailedError auth hops once", async () => {
    const models: string[] = [];
    const engine: Engine = async (opts) => {
      models.push(opts.model);
      if (opts.model === "openai/gpt-5.5") {
        throw new EngineFailedError("host: provider auth death", false, { auth: true });
      }
      return ok(opts.model);
    };
    const result = await withModelHop(engine, { fallbackModel: "anthropic/claude-sonnet-4-6" })({
      model: "openai/gpt-5.5",
      workdir: "/tmp",
    });
    expect(result).toMatchObject(ok("anthropic/claude-sonnet-4-6"));
    expect(models).toEqual(["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"]);
  });

  test("EngineFailedError provider-unavailable hops once", async () => {
    const models: string[] = [];
    const engine: Engine = async (opts) => {
      models.push(opts.model);
      if (opts.model === "openai/gpt-5.5") throw new EngineFailedError("429 rate limit exceeded", false);
      return ok(opts.model);
    };
    const result = await withModelHop(engine, { fallbackModel: "anthropic/claude-sonnet-4-6" })({
      model: "openai/gpt-5.5",
      workdir: "/tmp",
    });
    expect(result).toMatchObject(ok("anthropic/claude-sonnet-4-6"));
    expect(models).toEqual(["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"]);
  });

  test("quota stuck hops from scratch when fallback is a different provider", async () => {
    const quotaStuck: EngineResult = { status: "stuck", message: QUOTA_MESSAGE };
    const calls: Array<{ model: string; continueSession?: boolean; hop?: boolean }> = [];
    const engine: Engine = async (opts) => {
      calls.push({ model: opts.model, continueSession: opts.continueSession, hop: opts.hop });
      if (opts.model.startsWith("opencode/")) return quotaStuck;
      return ok(opts.model);
    };
    const result = await withModelHop(engine, { fallbackModel: "anthropic/claude-sonnet-4-6" })({
      model: "opencode/big-pickle",
      workdir: "/tmp",
    });
    expect(result).toMatchObject(ok("anthropic/claude-sonnet-4-6"));
    expect(calls).toEqual([
      { model: "opencode/big-pickle", continueSession: undefined, hop: undefined },
      { model: "anthropic/claude-sonnet-4-6", continueSession: false, hop: true },
    ]);
  });

  test("hop does not classify leftover primary quota logs as fallback stuck", async () => {
    const originalPath = process.env.PATH;
    const binDir = await mkdtemp(join(tmpdir(), "jumi-hop-bin-"));
    const workdir = await mkdtemp(join(tmpdir(), "jumi-hop-work-"));
    try {
      await writeFile(join(binDir, "opencode"), "#!/bin/sh\nprintf 'ok\\n'\n");
      await chmod(join(binDir, "opencode"), 0o755);
      process.env.PATH = `${binDir}:${originalPath ?? ""}`;
      const logDir = openCodeLogDirPath(workdir);
      await mkdir(logDir, { recursive: true });
      await writeFile(
        join(logDir, "opencode.log"),
        'timestamp=2026-09-14T00:00:00.000Z level=ERROR run=abc message="stream error" error.error="AI_APICallError: FreeUsageLimitError"\n'
      );
      const result = await withModelHop(runOpenCode, { fallbackModel: "anthropic/claude-sonnet-4-6" })({
        model: "opencode/big-pickle",
        workdir,
        sanitizeEnv: true,
        quotaPollIntervalMs: 0,
      });
      expect(result.status).toBe("ok");
      expect(result.stdout).toContain("ok");
    } finally {
      process.env.PATH = originalPath;
      await rm(binDir, { recursive: true, force: true });
      await rm(workdir, { recursive: true, force: true });
    }
  });

  test("quota stuck does not hop when fallback is the same provider", async () => {
    const quotaStuck: EngineResult = { status: "stuck", message: QUOTA_MESSAGE };
    const models: string[] = [];
    const engine: Engine = async (opts) => {
      models.push(opts.model);
      return quotaStuck;
    };
    const result = await withModelHop(engine, { fallbackModel: "opencode/gpt-5.5" })({
      model: "opencode/big-pickle",
      workdir: "/tmp",
    });
    expect(result).toMatchObject(quotaStuck);
    expect(models).toEqual(["opencode/big-pickle"]);
  });
});

describe("withEngineChain", () => {
  const spark = {
    name: "spark",
    type: "opencode" as const,
    model: "provider-a/spark",
    variant: "xhigh",
  };
  const grok = {
    name: "grok",
    type: "opencode" as const,
    model: "provider-b/grok",
    variant: "high",
  };

  test("single-entry claude chain still applies type and effort", async () => {
    const claude = {
      name: "claude",
      type: "claude" as const,
      model: "opus",
      effort: "high",
    };
    const calls: Array<{ type?: string; model: string; variant?: string; effort?: string }> = [];
    const engine: Engine = async (opts) => {
      calls.push({
        type: opts.type,
        model: opts.model,
        variant: opts.variant,
        effort: opts.effort,
      });
      return ok(opts.model);
    };
    const result = await withEngineChain(engine, { chain: [claude] })({
      model: claude.model,
      workdir: "/tmp",
    });
    expect(result).toMatchObject(ok(claude.model));
    expect(result.runner).toEqual({ type: "claude", model: claude.model, effort: "high" });
    expect(calls).toEqual([{ type: "claude", model: claude.model, variant: undefined, effort: "high" }]);
  });

  test("named Spark→Grok chain hops once from scratch", async () => {
    const calls: Array<{ model: string; variant?: string; continueSession?: boolean; hop?: boolean }> = [];
    const engine: Engine = async (opts) => {
      calls.push({
        model: opts.model,
        variant: opts.variant,
        continueSession: opts.continueSession,
        hop: opts.hop,
      });
      if (opts.model === spark.model) return unavailable;
      return ok(opts.model);
    };
    const result = await withEngineChain(engine, { chain: [spark, grok] })({
      model: spark.model,
      variant: spark.variant,
      workdir: "/tmp",
    });
    expect(result).toMatchObject(ok(grok.model));
    expect(result.runner).toEqual({ type: "opencode", model: grok.model, variant: grok.variant });
    expect(calls).toEqual([
      { model: spark.model, variant: spark.variant, continueSession: undefined, hop: undefined },
      { model: grok.model, variant: grok.variant, continueSession: false, hop: true },
    ]);
  });

  test("stamps the runner that ran on later calls after a hop, not the primary", async () => {
    const engine: Engine = async (opts) => (opts.model === spark.model ? unavailable : ok(opts.model));
    const run = withEngineChain(engine, { chain: [spark, grok] });
    const first = await run({ model: spark.model, variant: spark.variant, workdir: "/tmp" });
    const second = await run({ model: spark.model, variant: spark.variant, workdir: "/tmp" });
    expect(first.runner).toEqual({ type: "opencode", model: grok.model, variant: grok.variant });
    expect(second.runner).toEqual({ type: "opencode", model: grok.model, variant: grok.variant });
  });

  test("continueSession does not hop", async () => {
    let n = 0;
    const engine: Engine = async () => {
      n++;
      return unavailable;
    };
    const result = await withEngineChain(engine, { chain: [spark, grok] })({
      model: spark.model,
      workdir: "/tmp",
      continueSession: true,
    });
    expect(result).toMatchObject(unavailable);
    expect(n).toBe(1);
  });

  test("hopFromIncomplete advances once from scratch", async () => {
    const calls: Array<{ model: string; continueSession?: boolean; hop?: boolean }> = [];
    const engine: Engine = async (opts) => {
      calls.push({ model: opts.model, continueSession: opts.continueSession, hop: opts.hop });
      return ok(opts.model);
    };
    const run = withEngineChain(engine, { chain: [spark, grok] });
    await run({ model: spark.model, workdir: "/tmp" });
    const hopped = await run({ model: spark.model, workdir: "/tmp", hopFromIncomplete: true });
    expect(hopped).toMatchObject(ok(grok.model));
    expect(calls).toEqual([
      { model: spark.model, continueSession: undefined, hop: undefined },
      { model: grok.model, continueSession: false, hop: true },
    ]);
  });

  test("hopFromIncomplete with no next runner does not spawn", async () => {
    let n = 0;
    const engine: Engine = async () => {
      n++;
      return ok(spark.model);
    };
    const run = withEngineChain(engine, { chain: [spark] });
    await run({ model: spark.model, workdir: "/tmp" });
    const hopped = await run({ model: spark.model, workdir: "/tmp", hopFromIncomplete: true });
    expect(hopped).toEqual({ status: "ok" });
    expect(n).toBe(1);
  });

  test("hopFromIncomplete still hops on auth after the incomplete advance", async () => {
    const models: string[] = [];
    const claude = { name: "claude", type: "claude" as const, model: "claude-opus-5", effort: "high" as const };
    const engine: Engine = async (opts) => {
      models.push(opts.model);
      if (opts.model === grok.model) {
        return { status: "exit", exitCode: 1, message: "host: provider auth death", auth: true };
      }
      return ok(opts.model);
    };
    const run = withEngineChain(engine, { chain: [spark, grok, claude] });
    await run({ model: spark.model, workdir: "/tmp" });
    const hopped = await run({ model: spark.model, workdir: "/tmp", hopFromIncomplete: true });
    expect(hopped).toMatchObject(ok(claude.model));
    expect(models).toEqual([spark.model, grok.model, claude.model]);
  });

  test("infra does not hop", async () => {
    const infra = new EngineFailedError("EACCES: mkdir '/data/.local/state'", true);
    let n = 0;
    const engine: Engine = async () => {
      n++;
      throw infra;
    };
    await expect(
      withEngineChain(engine, { chain: [spark, grok] })({ model: spark.model, workdir: "/tmp" })
    ).rejects.toBe(infra);
    expect(n).toBe(1);
    expect(infra.runner).toEqual({ type: "opencode", model: spark.model, variant: spark.variant });
  });

  test("thrown failure after a hop carries the runner that failed, not the primary", async () => {
    const err = new EngineFailedError("EACCES: mkdir '/data/.local/state'", true);
    const engine: Engine = async (opts) => {
      if (opts.model === spark.model) return unavailable;
      throw err;
    };
    await expect(
      withEngineChain(engine, { chain: [spark, grok] })({
        model: spark.model,
        variant: spark.variant,
        workdir: "/tmp",
      })
    ).rejects.toBe(err);
    expect(err.runner).toEqual({ type: "opencode", model: grok.model, variant: grok.variant });
  });

  test("auth class hops", async () => {
    const models: string[] = [];
    const engine: Engine = async (opts) => {
      models.push(opts.model);
      if (opts.model === spark.model) {
        return { status: "exit", exitCode: 1, message: "host: provider auth death", auth: true };
      }
      return ok(opts.model);
    };
    const result = await withEngineChain(engine, { chain: [spark, grok] })({
      model: spark.model,
      workdir: "/tmp",
    });
    expect(result).toMatchObject(ok(grok.model));
    expect(models).toEqual([spark.model, grok.model]);
  });

  test("claude then grok hops on auth then unavailable", async () => {
    const claude = {
      name: "claude",
      type: "claude" as const,
      model: "opus",
      effort: "high",
    };
    const grok = {
      name: "grok",
      type: "opencode" as const,
      model: "opencode/grok-4.6",
      variant: "high",
    };
    const calls: Array<{ type?: string; model: string; variant?: string; effort?: string; hop?: boolean }> = [];
    const engine: Engine = async (opts) => {
      calls.push({
        type: opts.type,
        model: opts.model,
        variant: opts.variant,
        effort: opts.effort,
        hop: opts.hop,
      });
      if (opts.type === "claude") {
        return { status: "exit", exitCode: 1, message: "host: provider auth death", auth: true };
      }
      return ok(opts.model);
    };
    const result = await withEngineChain(engine, { chain: [claude, grok] })({
      model: claude.model,
      workdir: "/tmp",
    });
    expect(result).toMatchObject(ok(grok.model));
    expect(calls).toEqual([
      { type: "claude", model: claude.model, variant: undefined, effort: "high", hop: undefined },
      { type: "opencode", model: grok.model, variant: "high", effort: undefined, hop: true },
    ]);
  });

  test("claude session limit hops once to grok from scratch", async () => {
    const claude = { name: "claude", type: "claude" as const, model: "claude-opus-5", effort: "high" };
    const grok = { name: "grok", type: "opencode" as const, model: "xai/grok-4.6", variant: "high" };
    const sessionLimit: EngineResult = {
      status: "exit",
      exitCode: 1,
      message: "claude exited with code 1:\nYou've hit your session limit · resets 12:50am (UTC)",
    };
    const calls: Array<{ type?: string; model: string; continueSession?: boolean; hop?: boolean }> = [];
    const engine: Engine = async (opts) => {
      calls.push({ type: opts.type, model: opts.model, continueSession: opts.continueSession, hop: opts.hop });
      if (opts.type === "claude") return sessionLimit;
      return ok(opts.model);
    };
    const result = await withEngineChain(engine, { chain: [claude, grok] })({
      model: claude.model,
      workdir: "/tmp",
    });
    expect(result).toMatchObject(ok(grok.model));
    expect(calls).toEqual([
      { type: "claude", model: claude.model, continueSession: undefined, hop: undefined },
      { type: "opencode", model: grok.model, continueSession: false, hop: true },
    ]);
  });

  test("claude usage-limit stuck hops once to grok from scratch", async () => {
    const claude = { name: "claude", type: "claude" as const, model: "claude-opus-5", effort: "high" };
    const grok = { name: "grok", type: "opencode" as const, model: "xai/grok-4.6", variant: "high" };
    const usageLimit: EngineResult = {
      status: "stuck",
      exitCode: 1,
      message: QUOTA_MESSAGE,
      quota: "resetting",
    };
    const calls: Array<{ type?: string; model: string; continueSession?: boolean; hop?: boolean }> = [];
    const engine: Engine = async (opts) => {
      calls.push({ type: opts.type, model: opts.model, continueSession: opts.continueSession, hop: opts.hop });
      if (opts.type === "claude") return usageLimit;
      return ok(opts.model);
    };
    const result = await withEngineChain(engine, { chain: [claude, grok] })({
      model: claude.model,
      workdir: "/tmp",
    });
    expect(result).toMatchObject(ok(grok.model));
    expect(calls).toEqual([
      { type: "claude", model: claude.model, continueSession: undefined, hop: undefined },
      { type: "opencode", model: grok.model, continueSession: false, hop: true },
    ]);
  });

  test("last-runner claude usage-limit stuck is not converted to exit", async () => {
    const claude = { name: "claude", type: "claude" as const, model: "claude-opus-5", effort: "high" };
    const usageLimit: EngineResult = {
      status: "stuck",
      exitCode: 1,
      message: QUOTA_MESSAGE,
      quota: "resetting",
    };
    const engine: Engine = async () => usageLimit;
    const result = await withEngineChain(engine, { chain: [claude] })({
      model: claude.model,
      workdir: "/tmp",
    });
    expect(result).toMatchObject(usageLimit);
  });

  test("spark quota stuck hops once to unprefixed claude", async () => {
    const spark = {
      name: "spark",
      type: "opencode" as const,
      model: "opencode/muse-spark-1.3-contributor-free",
      variant: "xhigh",
    };
    const claude = { name: "claude", type: "claude" as const, model: "claude-opus-5", effort: "high" };
    const grok = { name: "grok", type: "opencode" as const, model: "xai/grok-4.6", variant: "high" };
    const quotaStuck: EngineResult = { status: "stuck", message: QUOTA_MESSAGE };
    const calls: Array<{ type?: string; model: string; continueSession?: boolean; hop?: boolean }> = [];
    const engine: Engine = async (opts) => {
      calls.push({ type: opts.type, model: opts.model, continueSession: opts.continueSession, hop: opts.hop });
      if (opts.model === spark.model) return quotaStuck;
      return ok(opts.model);
    };
    const result = await withEngineChain(engine, { chain: [spark, claude, grok] })({
      model: spark.model,
      workdir: "/tmp",
    });
    expect(result).toMatchObject(ok(claude.model));
    expect(calls).toEqual([
      { type: "opencode", model: spark.model, continueSession: undefined, hop: undefined },
      { type: "claude", model: claude.model, continueSession: false, hop: true },
    ]);
  });

  test("spark quota stuck hops once to grok on another provider", async () => {
    const spark = {
      name: "spark",
      type: "opencode" as const,
      model: "opencode/muse-spark-1.3-contributor-free",
      variant: "xhigh",
    };
    const grok = { name: "grok", type: "opencode" as const, model: "xai/grok-4.6", variant: "high" };
    const quotaStuck: EngineResult = { status: "stuck", message: QUOTA_MESSAGE };
    const models: string[] = [];
    const engine: Engine = async (opts) => {
      models.push(opts.model);
      if (opts.model === spark.model) return quotaStuck;
      return ok(opts.model);
    };
    const result = await withEngineChain(engine, { chain: [spark, grok] })({
      model: spark.model,
      workdir: "/tmp",
    });
    expect(result).toMatchObject(ok(grok.model));
    expect(models).toEqual([spark.model, grok.model]);
  });

  test("exhausting the chain fails closed", async () => {
    const models: string[] = [];
    const engine: Engine = async (opts) => {
      models.push(opts.model);
      return unavailable;
    };
    const result = await withEngineChain(engine, { chain: [spark, grok] })({
      model: spark.model,
      workdir: "/tmp",
    });
    expect(isProviderUnavailableResult(result)).toBe(true);
    expect(models).toEqual([spark.model, grok.model]);
  });
});

describe("hasResumableSession", () => {
  test("is true for OpenCode sqlite or an agy conversation id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-resume-"));
    try {
      expect(await hasResumableSession(dir)).toBe(false);
      await mkdir(join(dir, ".jumi-tmp"), { recursive: true });
      await writeFile(agyConversationPath(dir), "conv-123\n");
      expect(await hasResumableSession(dir)).toBe(true);
      await rm(agyConversationPath(dir), { force: true });
      await writeFile(openCodeSessionDbPath(dir), "db");
      expect(await hasResumableSession(dir)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("clearOpenCodeSession", () => {
  test("removes the session db and isolated log dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-session-"));
    try {
      const logDir = openCodeLogDirPath(dir);
      await mkdir(logDir, { recursive: true });
      await writeFile(openCodeSessionDbPath(dir), "db");
      await writeFile(join(logDir, "opencode.log"), 'message="stream error" error="FreeUsageLimitError"\n');
      await clearOpenCodeSession(dir);
      expect(await Bun.file(openCodeSessionDbPath(dir)).exists()).toBe(false);
      expect(await Bun.file(join(logDir, "opencode.log")).exists()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
