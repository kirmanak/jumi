import { $ } from "bun";

export interface GitConfig {
  serverUrl: string; // e.g. "https://gitea.kirmanak.stream"
  token: string;
  botUsername: string;
  botEmail: string;
  owner: string;
  repo: string;
  /** local path where the repo has been checked out by actions/checkout */
  workdir: string;
}

/**
 * Configure git identity and credential embedding in the remote URL so that
 * `git push` works without a credential helper.
 */
export async function configureGit(cfg: GitConfig): Promise<void> {
  const { workdir, botUsername, botEmail, serverUrl, token, owner, repo } =
    cfg;
  const authenticatedUrl = serverUrl.replace(
    /^(https?:\/\/)/,
    `$1${botUsername}:${token}@`
  );
  const remoteUrl = `${authenticatedUrl}/${owner}/${repo}.git`;

  await $`git -C ${workdir} config user.name ${botUsername}`.quiet();
  await $`git -C ${workdir} config user.email ${botEmail}`.quiet();
  await $`git -C ${workdir} remote set-url origin ${remoteUrl}`.quiet();
}

/**
 * Returns true if the working tree has uncommitted changes (tracked or new
 * staged files).
 */
export async function isDirty(workdir: string): Promise<boolean> {
  const result = await $`git -C ${workdir} status --porcelain`.quiet();
  return result.stdout.toString().trim().length > 0;
}

/**
 * Create and push a new branch for an issue. Returns the branch name.
 */
export async function createIssueBranch(
  workdir: string,
  issueNumber: number
): Promise<string> {
  const ts = Date.now();
  const branch = `opencode/issue${issueNumber}-${ts}`;
  await $`git -C ${workdir} checkout -b ${branch}`.quiet();
  return branch;
}

/**
 * Fetch the PR head branch from origin and check it out.
 */
export async function checkoutPRBranch(
  workdir: string,
  branchRef: string
): Promise<void> {
  // branchRef is the short branch name on the head repo (same-repo PRs only)
  await $`git -C ${workdir} fetch origin ${branchRef}`.quiet();
  await $`git -C ${workdir} checkout ${branchRef}`.quiet();
  await $`git -C ${workdir} reset --hard origin/${branchRef}`.quiet();
}

/**
 * Stage all changes, commit with the provided message, and push.
 */
export async function commitAndPush(
  workdir: string,
  branch: string,
  message: string
): Promise<void> {
  await $`git -C ${workdir} add -A`.quiet();
  await $`git -C ${workdir} commit -m ${message}`.quiet();
  await $`git -C ${workdir} push origin ${branch}`.quiet();
}

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

/**
 * Build a short commit message from the working-tree diff stat without
 * invoking the AI agent (avoids giving the agent another chance to modify files).
 */
export async function generateCommitMessage(
  workdir: string
): Promise<string> {
  const [diffStat, untrackedRaw] = await Promise.all([
    $`git -C ${workdir} diff --stat`.quiet().text(),
    $`git -C ${workdir} ls-files --others --exclude-standard`.quiet().text(),
  ]);

  const trackedCount = diffStat.trim() ? diffStat.trim().split("\n").length : 0;
  const untrackedFiles = untrackedRaw.trim().split("\n").filter(Boolean);
  const untrackedCount = untrackedFiles.length;

  const total = trackedCount + untrackedCount;
  if (total === 0) return "opencode: apply AI suggestions";

  const parts: string[] = [];
  if (untrackedCount > 0) parts.push(`add ${untrackedCount} file${untrackedCount > 1 ? "s" : ""}`);
  if (trackedCount > 0) parts.push(`update ${trackedCount} file${trackedCount > 1 ? "s" : ""}`);

  return `opencode: ${parts.join(" and ")}`;
}
