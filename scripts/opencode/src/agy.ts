import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgyStreamParser } from "./agy_usage.ts";
import { looksLikeProviderAuthDeath, providerAuthDeathMessage } from "./auth.ts";
import { limitText, readStreamLimited, scrubbedKey, stripAnsi } from "./claude.ts";
import { observeEngineRun } from "./control_metrics.ts";
import { logDiagnostic } from "./diagnostics.ts";
import {
  type Engine,
  EngineFailedError,
  type EngineResult,
  type EngineRunOptions,
  redactEngineText,
} from "./engine.ts";
import { agyConversationPath } from "./fallback.ts";
import { resolveOpenCodePrompt } from "./git.ts";
import { looksLikeInfraStderr } from "./infra.ts";
import { recordAgyUsage } from "./token_metrics.ts";

/** stream-json keeps per-step usage even when the child is killed before `result`. */
export const AGY_OUTPUT_FORMAT = "stream-json";
/** Unattended auto-approve. Without it print mode soft-denies tools and can return an empty SUCCESS. */
export const AGY_SKIP_PERMISSIONS = "--dangerously-skip-permissions";
/** Leave the child time to emit its `result` envelope before the parent kill. */
export const AGY_PRINT_TIMEOUT_MARGIN_MS = 30_000;
/** Linux MAX_ARG_STRLEN is 128 KiB; longer prompts go through a file pointer. */
export const AGY_ARGV_PROMPT_MAX_BYTES = 96_000;
export const AGY_SETTINGS_DIR = join(".gemini", "antigravity-cli");
/** Only seeded when absent: never overwrite a logged-in settings file. */
export const AGY_SEED_SETTINGS = { enableTelemetry: false, useG1Credits: false } as const;
const AGY_PROJECT_AGENT_NAMES = [".agents", ".agent"] as const;

const AGY_STDERR_MAX_BYTES = 64_000;
const AGY_AUTH_RE = /Please sign in|authentication required/i;

function isEnoent(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && err.code === "ENOENT");
}

async function stashAgyProjectAgents(workdir: string, stashRoot: string): Promise<string[]> {
  const moved: string[] = [];
  for (const name of AGY_PROJECT_AGENT_NAMES) {
    try {
      await rename(join(workdir, name), join(stashRoot, name));
      moved.push(name);
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
  }
  return moved;
}

async function restoreAgyProjectAgents(workdir: string, stashRoot: string, moved: string[]): Promise<void> {
  for (const name of moved) {
    await rename(join(stashRoot, name), join(workdir, name)).catch(() => {});
  }
}

function agyEnv(opts: EngineRunOptions, tempRoot: string): Record<string, string> {
  if (!opts.sanitizeEnv) {
    const env = { ...process.env, TMPDIR: tempRoot } as Record<string, string>;
    delete env.XDG_CONFIG_HOME;
    return env;
  }

  const env: Record<string, string> = {
    HOME: opts.home ?? process.env.HOME ?? opts.workdir,
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    TMPDIR: tempRoot,
  };
  if (opts.extraEnv) {
    for (const [key, value] of Object.entries(opts.extraEnv)) {
      if (scrubbedKey(key)) continue;
      env[key] = value;
    }
  }
  return env;
}

/**
 * Best-effort: write telemetry-off / credit-overages-off settings only when the
 * CLI has no settings file yet. `agy models` may rewrite it, so this is not a
 * runtime assert.
 */
export async function seedAgySettings(home: string | undefined): Promise<void> {
  if (!home) return;
  const dir = join(home, AGY_SETTINGS_DIR);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, "settings.json"), `${JSON.stringify(AGY_SEED_SETTINGS, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    return;
  }
}

/**
 * The print-mode prompt is never allowed to start with `/`, so no slash
 * command or checkout skill is expanded from it.
 */
export function agyPromptArg(prompt: string): string {
  return prompt.trimStart().startsWith("/") ? `Task:\n${prompt}` : prompt;
}

export function agyPrintTimeout(timeoutMs: number | undefined): string | undefined {
  if (!timeoutMs || timeoutMs <= 0) return undefined;
  const ms = timeoutMs > AGY_PRINT_TIMEOUT_MARGIN_MS * 2 ? timeoutMs - AGY_PRINT_TIMEOUT_MARGIN_MS : timeoutMs;
  return `${Math.max(1, Math.floor(ms / 1000))}s`;
}

export function agyArgv(opts: EngineRunOptions, prompt: string, conversationId?: string): string[] {
  const args = ["agy", "-p", agyPromptArg(prompt), "--output-format", AGY_OUTPUT_FORMAT, AGY_SKIP_PERMISSIONS];
  args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  const printTimeout = agyPrintTimeout(opts.timeoutMs);
  if (printTimeout) args.push("--print-timeout", printTimeout);
  if (opts.continueSession) {
    if (conversationId) args.push("--conversation", conversationId);
    else args.push("--continue");
  }
  return args;
}

export function looksLikeAgyAuthDeath(text: string): boolean {
  return AGY_AUTH_RE.test(text) || looksLikeProviderAuthDeath(text);
}

async function readConversationId(workdir: string): Promise<string | undefined> {
  try {
    return (await readFile(agyConversationPath(workdir), "utf8")).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function readAgyStdout(stream: ReadableStream<Uint8Array>, parser: AgyStreamParser): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(value);
    }
  } finally {
    reader.releaseLock();
    parser.end();
  }
}

function engineExitMessage(exitCode: number | null, detail: string): string {
  return `agy exited with code ${exitCode}${detail ? `:\n${detail}` : ""}`;
}

/** Why a clean exit is not a completed run, or undefined when it is. */
export function agyIncompleteReason(parser: AgyStreamParser): string | undefined {
  const result = parser.result();
  if (!result) return undefined;
  if (result.status && result.status.toUpperCase() !== "SUCCESS") {
    return `agy result status ${result.status}${result.error ? `: ${result.error}` : ""}`;
  }
  if (!result.response?.trim() && result.deniedActions.length > 0) {
    return `agy returned an empty response with denied actions: ${result.deniedActions.join(", ")}`;
  }
  return undefined;
}

function cancelled(): Error {
  const err = new Error("cancelled");
  err.name = "AbortError";
  return err;
}

export async function runAgy(opts: EngineRunOptions): Promise<EngineResult> {
  const log = opts.logger ?? ((message: string) => console.log(message));
  const prompt = await resolveOpenCodePrompt(opts);
  const tempRoot = join(opts.workdir, ".jumi-tmp");
  await mkdir(tempRoot, { recursive: true });

  const tmpDir = await mkdtemp(join(tempRoot, "agy-prompt-"));
  const startedAtMs = Date.now();
  const stashRoot = join(tmpDir, "project-agents");
  let movedAgents: string[] = [];

  if (opts.abortSignal?.aborted) {
    await rm(tmpDir, { recursive: true, force: true });
    throw cancelled();
  }

  try {
    let promptArg = prompt;
    if (new TextEncoder().encode(prompt).byteLength > AGY_ARGV_PROMPT_MAX_BYTES) {
      const promptPath = join(tmpDir, "prompt.txt");
      await writeFile(promptPath, prompt);
      promptArg = `Read ${promptPath} and follow the instructions in it exactly.`;
    }
    const env = agyEnv(opts, tempRoot);
    await seedAgySettings(env.HOME);
    const conversationId = opts.continueSession ? await readConversationId(opts.workdir) : undefined;
    const args = agyArgv(opts, promptArg, conversationId);
    if (opts.trace?.kind === "review") {
      await mkdir(stashRoot, { recursive: true });
      movedAgents = await stashAgyProjectAgents(opts.workdir, stashRoot);
    }
    const proc = (() => {
      try {
        return Bun.spawn(args, {
          cwd: opts.workdir,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new EngineFailedError(message, true);
      }
    })();

    await opts.onPid?.(proc.pid);
    const onAbort = () => {
      try {
        proc.kill();
      } catch {
        return;
      }
    };
    if (opts.abortSignal?.aborted) onAbort();
    else opts.abortSignal?.addEventListener("abort", onAbort, { once: true });

    let timedOut = false;
    const timeout =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            proc.kill();
          }, opts.timeoutMs)
        : undefined;

    const parser = new AgyStreamParser(opts.model);
    let stderrResult: { text: string; totalBytes: number } = { text: "", totalBytes: 0 };
    let exitCode: number | null = null;
    let runError: unknown;
    try {
      [, stderrResult, exitCode] = await Promise.all([
        readAgyStdout(proc.stdout, parser),
        readStreamLimited(proc.stderr, "agy stderr", AGY_STDERR_MAX_BYTES, "tail"),
        proc.exited,
      ]);
    } catch (err) {
      runError = err;
    } finally {
      opts.abortSignal?.removeEventListener("abort", onAbort);
      if (timeout) clearTimeout(timeout);
    }

    // Parent-held usage at child end, whatever the outcome (ok, non-zero,
    // timeout, 143, cancel). Fail-open: no usage records nothing.
    recordAgyUsage(parser.usage());
    const newConversation = parser.conversationId();
    if (newConversation) await writeFile(agyConversationPath(opts.workdir), `${newConversation}\n`).catch(() => {});

    const stdoutResult = limitText(parser.text(), "agy output", opts.maxOutputBytes);
    const stdout = redactEngineText(stripAnsi(stdoutResult.text).trim(), opts);
    const stderr = redactEngineText(stripAnsi(stderrResult.text).trim(), opts);
    const envelope = parser.result();
    const combined = [stderr, stdout].filter(Boolean).join("\n");
    const durationMs = Date.now() - startedAtMs;
    const auth =
      !timedOut && exitCode !== 143 && looksLikeAgyAuthDeath([stderr, envelope?.error].filter(Boolean).join("\n"));

    if (opts.abortSignal?.aborted) throw cancelled();

    if (runError) {
      const message = redactEngineText(runError instanceof Error ? runError.message : String(runError), opts);
      if (auth || looksLikeAgyAuthDeath(message)) {
        if (stderr) log(`[agy stderr] ${stderr}`);
        const authMessage = providerAuthDeathMessage();
        observeEngineRun(opts, { status: "exit", infra: false, auth: true, durationMs, message: authMessage });
        throw new EngineFailedError(authMessage, false, { auth: true });
      }
      const isInfra = looksLikeInfraStderr(message);
      observeEngineRun(opts, { status: "exit", infra: isInfra, durationMs, message });
      throw new EngineFailedError(message, isInfra);
    }

    if (stderr) log(`[agy stderr] ${stderr}`);
    if (exitCode !== 0 || envelope?.error) {
      // Record the exact envelope so the first live quota/5xx miss is known verbatim.
      logDiagnostic(log, "agy_error", {
        exit_code: exitCode,
        status: envelope?.status ?? null,
        error: envelope?.error ?? null,
      });
    }

    if (timedOut) {
      return observeEngineRun(opts, {
        status: "timeout",
        exitCode,
        stdout,
        message: engineExitMessage(exitCode, combined),
        infra: false,
        durationMs,
      });
    }

    const incomplete = exitCode === 0 ? agyIncompleteReason(parser) : undefined;
    if (exitCode === 0 && !incomplete) return observeEngineRun(opts, { status: "ok", exitCode: 0, stdout, durationMs });

    if (auth) {
      return observeEngineRun(opts, {
        status: "exit",
        exitCode,
        stdout,
        message: providerAuthDeathMessage(),
        infra: false,
        auth: true,
        durationMs,
      });
    }

    if (incomplete) {
      return observeEngineRun(opts, {
        status: "exit",
        exitCode,
        stdout,
        message: [incomplete, combined].filter(Boolean).join("\n"),
        infra: false,
        durationMs,
      });
    }

    return observeEngineRun(opts, {
      status: "exit",
      exitCode,
      stdout,
      message: engineExitMessage(exitCode, combined),
      infra: looksLikeInfraStderr(combined),
      durationMs,
    });
  } catch (err) {
    if (err instanceof EngineFailedError) throw err;
    if (err instanceof Error && (err.name === "AbortError" || err.message === "cancelled")) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (looksLikeAgyAuthDeath(message)) {
      throw new EngineFailedError(providerAuthDeathMessage(), false, { auth: true });
    }
    if (looksLikeInfraStderr(message)) throw new EngineFailedError(message, true);
    throw err;
  } finally {
    await restoreAgyProjectAgents(opts.workdir, stashRoot, movedAgents);
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export const agyEngine: Engine = runAgy;
