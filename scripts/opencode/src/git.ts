import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

function buildEnv(opts: OpenCodeRunOptions): Record<string, string> | undefined {
  if (!opts.sanitizeEnv) {
    return opts.configPath
      ? ({ ...process.env, OPENCODE_CONFIG: opts.configPath } as Record<string, string>)
      : undefined;
  }

  const env: Record<string, string> = {
    HOME: opts.home ?? process.env.HOME ?? opts.workdir,
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    OPENCODE_MODEL: opts.model,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  };

  if (opts.configPath) env.OPENCODE_CONFIG = opts.configPath;
  return env;
}

function limitOutput(output: string, maxBytes?: number): string {
  if (!maxBytes || maxBytes <= 0) return output;
  const encoded = new TextEncoder().encode(output);
  if (encoded.byteLength <= maxBytes) return output;
  const truncated = new TextDecoder().decode(encoded.slice(0, maxBytes));
  return `${truncated}\n\n[opencode output truncated at ${maxBytes} bytes]`;
}

export async function runOpenCode(prompt: string, opts: OpenCodeRunOptions): Promise<string> {
  const tmpDir = await mkdtemp(join(tmpdir(), "opencode-prompt-"));
  const tmpPath = join(tmpDir, "prompt.txt");
  await writeFile(tmpPath, prompt);

  try {
    const proc = Bun.spawn(["opencode", "run", "--print-logs", "--dir", opts.workdir, "-m", opts.model], {
      stdin: Bun.file(tmpPath),
      stdout: "pipe",
      stderr: "pipe",
      env: buildEnv(opts),
    });

    const timeout = opts.timeoutMs && opts.timeoutMs > 0 ? setTimeout(() => proc.kill(), opts.timeoutMs) : undefined;

    // Consume stdout, stderr, and the exit code concurrently.
    // Reading stderr in parallel is required to prevent a deadlock when the
    // child writes more than the OS pipe buffer (~64KB) to stderr.
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (timeout) clearTimeout(timeout);

    if (exitCode !== 0) {
      throw new Error(`opencode exited with code ${exitCode}${stderr.trim() ? `:\n${stripAnsi(stderr).trim()}` : ""}`);
    }

    if (stderr.trim()) {
      console.log(stripAnsi(stderr).trim());
    }

    return limitOutput(stripAnsi(stdout).trim(), opts.maxOutputBytes);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
