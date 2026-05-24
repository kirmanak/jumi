import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
}

function buildEnv(opts: OpenCodeRunOptions, tempRoot: string): Record<string, string> | undefined {
  if (!opts.sanitizeEnv) {
    const env = { ...process.env, TMPDIR: tempRoot } as Record<string, string>;
    if (opts.configPath) env.OPENCODE_CONFIG = opts.configPath;
    return env;
  }

  const env: Record<string, string> = {
    HOME: opts.home ?? process.env.HOME ?? opts.workdir,
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    TMPDIR: tempRoot,
    OPENCODE_MODEL: opts.model,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  };

  if (opts.configPath) env.OPENCODE_CONFIG = opts.configPath;
  return env;
}

function truncateNote(label: string, maxBytes: number): string {
  return `\n\n[${label} truncated at ${maxBytes} bytes]`;
}

async function readStreamLimited(
  stream: ReadableStream<Uint8Array>,
  label: string,
  maxBytes?: number
): Promise<string> {
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
  return maxBytes && maxBytes > 0 && totalBytes > maxBytes ? `${output}${truncateNote(label, maxBytes)}` : output;
}

export async function runOpenCode(prompt: string, opts: OpenCodeRunOptions): Promise<string> {
  const tempRoot = join(opts.workdir, ".jumi-tmp");
  await mkdir(tempRoot, { recursive: true });

  const tmpDir = await mkdtemp(join(tempRoot, "opencode-prompt-"));
  const tmpPath = join(tmpDir, "prompt.txt");
  await writeFile(tmpPath, prompt);

  try {
    const proc = Bun.spawn(["opencode", "run", "--dir", opts.workdir, "-m", opts.model], {
      stdin: Bun.file(tmpPath),
      stdout: "pipe",
      stderr: "pipe",
      env: buildEnv(opts, tempRoot),
    });

    const timeout = opts.timeoutMs && opts.timeoutMs > 0 ? setTimeout(() => proc.kill(), opts.timeoutMs) : undefined;

    // Consume stdout, stderr, and the exit code concurrently.
    // Reading stderr in parallel is required to prevent a deadlock when the
    // child writes more than the OS pipe buffer (~64KB) to stderr. Keep only a
    // bounded prefix so verbose OpenCode logs cannot grow the reviewer heap
    // without bound.
    const [stdoutRaw, stderrRaw, exitCode] = await Promise.all([
      readStreamLimited(proc.stdout, "opencode output", opts.maxOutputBytes),
      readStreamLimited(proc.stderr, "opencode stderr", OPENCODE_STDERR_MAX_BYTES),
      proc.exited,
    ]);

    if (timeout) clearTimeout(timeout);

    const stdout = stripAnsi(stdoutRaw).trim();
    const stderr = stripAnsi(stderrRaw).trim();

    if (exitCode !== 0) {
      throw new Error(`opencode exited with code ${exitCode}${stderr ? `:\n${stderr}` : ""}`);
    }

    if (stderr) {
      console.log(stderr);
    }

    return stdout;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
