import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  byteLength,
  finalizeMemoryTracker,
  formatBytes,
  logDiagnostic,
  type MemoryPeakState,
  type MemorySample,
  pathSizeBytes,
  sampleMemory,
  trackMemoryPeak,
} from "./diagnostics.ts";
import type { Engine, EngineResult, EngineRunOptions } from "./engine.ts";
import { exportOpenCodeTrace } from "./phoenix.ts";
import { recordOpenCodeDb } from "./token_metrics.ts";

const OPENCODE_STDERR_MAX_BYTES = 64_000;

/** Strip ANSI/VT100 CSI escape sequences from a string. */
function stripAnsi(str: string): string {
  // Matches all CSI sequences: ESC [ ... <letter>
  return str.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[a-zA-Z]`, "g"), "");
}

/**
 * OpenCode Engine impl #0: run to completion in `opts.workdir`.
 * Stdout is logs (ANSI stripped), not the deliverable. Timeout and non-zero
 * exit are returned for the parent to fail closed. Abort still throws.
 *
 * The prompt is written to a temp file and fed to `opencode run` via stdin to
 * avoid OS ARG_MAX limits for large PR diffs. Both stdout and stderr are
 * consumed concurrently to prevent pipe-buffer deadlocks (64KB on Linux).
 */
export type OpenCodeRunOptions = EngineRunOptions;

function buildEnv(
  opts: OpenCodeRunOptions,
  tempRoot: string,
  openCodeDbPath: string
): Record<string, string> | undefined {
  // Per-review SQLite path under the workspace temp dir so session DB does not
  // accumulate on HOME across runs (OOM trail: 1.5GiB shared opencode.db).
  if (!opts.sanitizeEnv) {
    const env = { ...process.env, TMPDIR: tempRoot, OPENCODE_DB: openCodeDbPath } as Record<string, string>;
    if (opts.configPath) env.OPENCODE_CONFIG = opts.configPath;
    return env;
  }

  const env: Record<string, string> = {
    HOME: opts.home ?? process.env.HOME ?? opts.workdir,
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    TMPDIR: tempRoot,
    XDG_CONFIG_HOME: join(tempRoot, "xdg-config"),
    OPENCODE_MODEL: opts.model,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DB: openCodeDbPath,
  };

  if (opts.configPath) env.OPENCODE_CONFIG = opts.configPath;
  if (opts.extraEnv) {
    for (const [key, value] of Object.entries(opts.extraEnv)) {
      if (key.startsWith("GITEA_")) continue;
      env[key] = value;
    }
  }
  return env;
}

function truncateNote(label: string, maxBytes: number, keep: "head" | "tail" = "head"): string {
  if (keep === "tail") return `[${label} truncated at ${maxBytes} bytes; kept last]\n\n`;
  return `\n\n[${label} truncated at ${maxBytes} bytes]`;
}

function concatChunks(chunks: Uint8Array[], capturedBytes: number): Uint8Array {
  const captured = new Uint8Array(capturedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    captured.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return captured;
}

function retainChunk(
  chunks: Uint8Array[],
  state: { capturedBytes: number },
  value: Uint8Array,
  maxBytes: number,
  keep: "head" | "tail"
): void {
  if (keep === "head") {
    if (state.capturedBytes >= maxBytes) return;
    const remaining = maxBytes - state.capturedBytes;
    const chunk = value.byteLength <= remaining ? value : value.slice(0, remaining);
    chunks.push(chunk);
    state.capturedBytes += chunk.byteLength;
    return;
  }

  chunks.push(value);
  state.capturedBytes += value.byteLength;
  while (state.capturedBytes > maxBytes && chunks.length > 0) {
    const overflow = state.capturedBytes - maxBytes;
    const first = chunks[0];
    if (!first) break;
    if (first.byteLength <= overflow) {
      chunks.shift();
      state.capturedBytes -= first.byteLength;
    } else {
      chunks[0] = first.slice(overflow);
      state.capturedBytes -= overflow;
    }
  }
}

async function readStreamLimited(
  stream: ReadableStream<Uint8Array>,
  label: string,
  maxBytes?: number,
  keep: "head" | "tail" = "head"
): Promise<{ text: string; totalBytes: number }> {
  const chunks: Uint8Array[] = [];
  const state = { capturedBytes: 0 };
  let totalBytes = 0;
  const reader = stream.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (!maxBytes || maxBytes <= 0) {
        chunks.push(value);
        state.capturedBytes += value.byteLength;
        continue;
      }
      retainChunk(chunks, state, value, maxBytes, keep);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new TextDecoder().decode(concatChunks(chunks, state.capturedBytes));
  if (maxBytes && maxBytes > 0 && totalBytes > maxBytes) {
    const text =
      keep === "tail"
        ? `${truncateNote(label, maxBytes, "tail")}${output}`
        : `${output}${truncateNote(label, maxBytes, "head")}`;
    return { text, totalBytes };
  }
  return { text: output, totalBytes };
}

function countToolishLines(stderr: string): number {
  if (!stderr) return 0;
  let n = 0;
  for (const line of stderr.split("\n")) {
    if (/^\s*(➜|→|✱|•)\s/.test(line) || /\b(Bash|Read|Grep|Glob|Edit|Write)\b/.test(line)) n += 1;
  }
  return n;
}

function engineExitMessage(exitCode: number | null, stderr: string): string {
  return `opencode exited with code ${exitCode}${stderr ? `:\n${stderr}` : ""}`;
}

export async function runOpenCode(opts: OpenCodeRunOptions): Promise<EngineResult> {
  const log = opts.logger ?? ((message: string) => console.log(message));
  const prompt = opts.prompt;
  const tempRoot = join(opts.workdir, ".jumi-tmp");
  await mkdir(tempRoot, { recursive: true });

  const tmpDir = await mkdtemp(join(tempRoot, "opencode-prompt-"));
  const tmpPath = join(tmpDir, "prompt.txt");
  await writeFile(tmpPath, prompt);

  const home = opts.home ?? process.env.HOME ?? opts.workdir;
  // Always isolate session DB under the review temp dir (deleted with workspace).
  const dbPath = join(tempRoot, "opencode-session.db");
  const promptBytes = byteLength(prompt);
  const dbBefore = await pathSizeBytes(dbPath);
  const parentBefore = await sampleMemory(process.pid);

  logDiagnostic(log, "opencode_start", {
    review: opts.reviewLabel,
    model: opts.model,
    prompt_bytes: promptBytes,
    prompt_bytes_h: formatBytes(promptBytes),
    opencode_db: dbPath,
    opencode_db_bytes: dbBefore,
    opencode_db_h: formatBytes(dbBefore),
    home,
    parent_rss_bytes: parentBefore.rssBytes,
    parent_rss_h: formatBytes(parentBefore.rssBytes),
    cgroup_bytes: parentBefore.cgroupBytes,
    cgroup_h: formatBytes(parentBefore.cgroupBytes),
    timeout_ms: opts.timeoutMs ?? 0,
  });

  let tracker: MemoryPeakState | undefined;
  let finalSample: MemorySample | undefined;

  if (opts.abortSignal?.aborted) {
    const err = new Error("cancelled");
    err.name = "AbortError";
    throw err;
  }

  try {
    const proc = Bun.spawn(["opencode", "run", "--dir", opts.workdir, "-m", opts.model], {
      stdin: Bun.file(tmpPath),
      stdout: "pipe",
      stderr: "pipe",
      env: buildEnv(opts, tempRoot, dbPath),
    });

    const childPid = proc.pid;
    await opts.onPid?.(childPid);
    const onAbort = () => {
      try {
        proc.kill();
      } catch {
        return;
      }
    };
    if (opts.abortSignal?.aborted) onAbort();
    else opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
    let trackerStartedAt = Date.now();
    tracker = trackMemoryPeak(childPid, opts.memorySampleIntervalMs ?? 5_000, (sample, peaks) => {
      logDiagnostic(log, "opencode_sample", {
        review: opts.reviewLabel,
        sample: peaks.n,
        child_rss_bytes: sample.rssBytes,
        child_rss_h: formatBytes(sample.rssBytes),
        child_rss_peak_bytes: peaks.rss,
        child_rss_peak_h: formatBytes(peaks.rss),
        cgroup_bytes: sample.cgroupBytes,
        cgroup_h: formatBytes(sample.cgroupBytes),
        cgroup_peak_bytes: peaks.cgroup,
        cgroup_peak_h: formatBytes(peaks.cgroup),
        elapsed_ms: Date.now() - trackerStartedAt,
      });
    });
    trackerStartedAt = tracker.startedAtMs;
    let timedOut = false;
    const timeout =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            proc.kill();
          }, opts.timeoutMs)
        : undefined;

    // Consume stdout, stderr, and the exit code concurrently.
    // Reading stderr in parallel is required to prevent a deadlock when the
    // child writes more than the OS pipe buffer (~64KB) to stderr. Keep only a
    // bounded tail so verbose OpenCode logs cannot grow the reviewer heap
    // without bound; tool traces live at the end, not behind the banner.
    let stdoutResult: { text: string; totalBytes: number } = { text: "", totalBytes: 0 };
    let stderrResult: { text: string; totalBytes: number } = { text: "", totalBytes: 0 };
    let exitCode: number | null = null;
    let runError: unknown;
    try {
      [stdoutResult, stderrResult, exitCode] = await Promise.all([
        readStreamLimited(proc.stdout, "opencode output", opts.maxOutputBytes),
        readStreamLimited(proc.stderr, "opencode stderr", OPENCODE_STDERR_MAX_BYTES, "tail"),
        proc.exited,
      ]);
    } catch (err) {
      runError = err;
    } finally {
      opts.abortSignal?.removeEventListener("abort", onAbort);
      if (timeout) clearTimeout(timeout);
      finalSample = await finalizeMemoryTracker(tracker, childPid);
    }

    const dbAfter = await pathSizeBytes(dbPath);
    const parentAfter = await sampleMemory(process.pid);

    const stdout = stripAnsi(stdoutResult.text).trim();
    const stderr = stripAnsi(stderrResult.text).trim();
    const toolishLines = countToolishLines(stderr);

    logDiagnostic(log, "opencode_end", {
      review: opts.reviewLabel,
      exit_code: exitCode,
      duration_ms: Date.now() - tracker.startedAtMs,
      samples: tracker.samples,
      child_rss_start_bytes: tracker.start.rssBytes,
      child_rss_start_h: formatBytes(tracker.start.rssBytes),
      child_rss_peak_bytes: tracker.peakRssBytes,
      child_rss_peak_h: formatBytes(tracker.peakRssBytes),
      child_rss_end_bytes: finalSample.rssBytes,
      child_rss_end_h: formatBytes(finalSample.rssBytes),
      cgroup_start_bytes: tracker.start.cgroupBytes,
      cgroup_start_h: formatBytes(tracker.start.cgroupBytes),
      cgroup_peak_bytes: tracker.peakCgroupBytes,
      cgroup_peak_h: formatBytes(tracker.peakCgroupBytes),
      cgroup_end_bytes: finalSample.cgroupBytes,
      cgroup_end_h: formatBytes(finalSample.cgroupBytes),
      parent_rss_end_bytes: parentAfter.rssBytes,
      parent_rss_end_h: formatBytes(parentAfter.rssBytes),
      stdout_bytes: stdoutResult.totalBytes,
      stdout_bytes_h: formatBytes(stdoutResult.totalBytes),
      stderr_bytes: stderrResult.totalBytes,
      stderr_bytes_h: formatBytes(stderrResult.totalBytes),
      stderr_toolish_lines: toolishLines,
      opencode_db_bytes: dbAfter,
      opencode_db_h: formatBytes(dbAfter),
      opencode_db_delta_bytes: dbBefore !== null && dbAfter !== null ? dbAfter - dbBefore : null,
      run_error: runError instanceof Error ? runError.message.slice(0, 200) : runError ? "true" : null,
    });
    recordOpenCodeDb(dbPath);
    await exportOpenCodeTrace({ dbPath, trace: opts.trace });

    if (opts.abortSignal?.aborted) {
      const err = new Error("cancelled");
      err.name = "AbortError";
      throw err;
    }

    if (runError) throw runError;

    if (timedOut) {
      return { status: "timeout", exitCode, stdout, message: engineExitMessage(exitCode, stderr) };
    }

    if (exitCode === 0) {
      // Log the already-bounded stderr capture (last 64 KiB). Do not pass
      // --print-logs: that is a different firehose. The old 2 KiB log-head cap
      // hid tool traces behind the OpenCode banner.
      if (stderr) {
        log(`[opencode stderr] ${stderr}`);
      }
      return { status: "ok", exitCode: 0, stdout };
    }

    return { status: "exit", exitCode, stdout, message: engineExitMessage(exitCode, stderr) };
  } finally {
    tracker?.stop();
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export const openCodeEngine: Engine = runOpenCode;
