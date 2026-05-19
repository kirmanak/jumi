import { $ } from "bun";

/** Strip ANSI/VT100 CSI escape sequences from a string. */
function stripAnsi(str: string): string {
  // Matches all CSI sequences: ESC [ ... <letter>
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
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
export async function runOpenCode(
  prompt: string,
  model: string,
  workdir: string
): Promise<string> {
  const tmpPath = `/tmp/opencode-prompt-${crypto.randomUUID()}.txt`;
  await Bun.write(tmpPath, prompt);

  try {
    const proc = Bun.spawn(["opencode", "run", "--print-logs", "-m", model], {
      cwd: workdir,
      stdin: Bun.file(tmpPath),
      stdout: "pipe",
      stderr: "pipe",
    });

    // Consume stdout, stderr, and the exit code concurrently.
    // Reading stderr in parallel is required to prevent a deadlock when the
    // child writes more than the OS pipe buffer (~64KB) to stderr.
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      throw new Error(
        `opencode exited with code ${exitCode}` +
          (stderr.trim() ? `:\n${stripAnsi(stderr).trim()}` : "")
      );
    }

    if (stderr.trim()) {
      console.log(stripAnsi(stderr).trim());
    }

    return stripAnsi(stdout).trim();
  } finally {
    await $`rm -f ${tmpPath}`.quiet().nothrow();
  }
}
