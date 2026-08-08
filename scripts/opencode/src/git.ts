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

const OPENCODE_STDERR_MAX_BYTES = 64_000;

/** Strip ANSI/VT100 CSI escape sequences from a string. */
function stripAnsi(str: string): string {
  // Matches all CSI sequences: ESC [ ... <letter>
  return str.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[a-zA-Z]`, "g"), "");
}

/**
 * Run `opencode run` with a prompt string and return the stdout as a string.
 * ANSI escape codes are stripped.
 *
 * The prompt is written to a temp file and fed to the process via stdin to
 * avoid OS ARG_MAX limits for large PR diffs. Both stdout and stderr are
 * consumed concurrently to prevent pipe-buffer deadlocks (64KB on Linux).
 * A non-zero exit code is surfaced as a thrown Error.
 */
export interface OpenCodeRunOptions {
  model: string;
  workdir: string;
  configPath?: string;
  home?: string;
  sanitizeEnv?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Optional review label for structured diagnostics (e.g. org/repo#123). */
  reviewLabel?: string;
  /** RSS sample interval for the OpenCode child (ms). Default 5000. */
  memorySampleIntervalMs?: number;
  logger?: (message: string) => void;
}

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
    OPENCODE_MODEL: opts.model,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DB: openCodeDbPath,
  };

  if (opts.configPath) env.OPENCODE_CONFIG = opts.configPath;
  return env;
}

const OPENCODE_STDERR_LOG_MAX_BYTES = 2_000;

function truncateNote(label: string, maxBytes: number): string {
  return `\n\n[${label} truncated at ${maxBytes} bytes]`;
}

async function readStreamLimited(
  stream: ReadableStream<Uint8Array>,
  label: string,
  maxBytes?: number
): Promise<{ text: string; totalBytes: number }> {
  const chunks: Uint8Array[] = [];
  let capturedBytes = 0;
  let totalBytes = 0;
  const reader = stream.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (!maxBytes || maxBytes <= 0) {
        chunks.push(value);
        capturedBytes += value.byteLength;
        continue;
      }
      if (capturedBytes >= maxBytes) continue;

      const remaining = maxBytes - capturedBytes;
      const chunk = value.byteLength <= remaining ? value : value.slice(0, remaining);
      chunks.push(chunk);
      capturedBytes += chunk.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const captured = new Uint8Array(capturedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    captured.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const output = new TextDecoder().decode(captured);
  const text = maxBytes && maxBytes > 0 && totalBytes > maxBytes ? `${output}${truncateNote(label, maxBytes)}` : output;
  return { text, totalBytes };
}

function countToolishLines(stderr: string): number {
  if (!stderr) return 0;
  let n = 0;
  for (const line of stderr.split("\n")) {
    if (/^\s*(➜|→|✱|•)\s/.test(line) || /\b(Bash|Read|Grep|Glob|Edit|Write)\b/.test(line)) n += 1;
  }
  return n;
}

export async function runOpenCode(prompt: string, opts: OpenCodeRunOptions): Promise<string> {
  const log = opts.logger ?? ((message: string) => console.log(message));
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

  try {
    const proc = Bun.spawn(["opencode", "run", "--dir", opts.workdir, "-m", opts.model], {
      stdin: Bun.file(tmpPath),
      stdout: "pipe",
      stderr: "pipe",
      env: buildEnv(opts, tempRoot, dbPath),
    });

    const childPid = proc.pid;
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
    const timeout = opts.timeoutMs && opts.timeoutMs > 0 ? setTimeout(() => proc.kill(), opts.timeoutMs) : undefined;

    // Consume stdout, stderr, and the exit code concurrently.
    // Reading stderr in parallel is required to prevent a deadlock when the
    // child writes more than the OS pipe buffer (~64KB) to stderr. Keep only a
    // bounded prefix so verbose OpenCode logs cannot grow the reviewer heap
    // without bound.
    let stdoutResult: { text: string; totalBytes: number } = { text: "", totalBytes: 0 };
    let stderrResult: { text: string; totalBytes: number } = { text: "", totalBytes: 0 };
    let exitCode: number | null = null;
    let runError: unknown;
    try {
      [stdoutResult, stderrResult, exitCode] = await Promise.all([
        readStreamLimited(proc.stdout, "opencode output", opts.maxOutputBytes),
        readStreamLimited(proc.stderr, "opencode stderr", OPENCODE_STDERR_MAX_BYTES),
        proc.exited,
      ]);
    } catch (err) {
      runError = err;
    } finally {
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

    if (runError) throw runError;

    if (exitCode !== 0) {
      throw new Error(`opencode exited with code ${exitCode}${stderr ? `:\n${stderr}` : ""}`);
    }

    // Do not dump full OpenCode tool transcripts into the parent log stream —
    // permission-denial payloads alone can be multi‑KB of repeated JSON and the
    // post-OOM trail showed parent RSS climbing after opencode_end.
    if (stderr) {
      const logBytes = byteLength(stderr);
      const preview =
        logBytes <= OPENCODE_STDERR_LOG_MAX_BYTES
          ? stderr
          : `${stderr.slice(0, OPENCODE_STDERR_LOG_MAX_BYTES)}\n…[stderr log capped at ${OPENCODE_STDERR_LOG_MAX_BYTES} bytes; total ${logBytes}]`;
      log(`[opencode stderr] ${preview}`);
    }

    return stdout;
  } finally {
    tracker?.stop();
    await rm(tmpDir, { recursive: true, force: true });
  }
}
