import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GiteaPR, GiteaRepo, ReviewJob } from "./types.ts";

interface GitAuth {
  giteaUrl: string;
  username: string;
  token: string;
}

export type GitRunner = (
  args: string[],
  opts: { cwd: string; env: Record<string, string | undefined> }
) => Promise<string>;

export interface CheckoutPullRequestWorkspaceOptions {
  workdir: string;
  repo: GiteaRepo;
  pr: GiteaPR;
  giteaUrl: string;
  username: string;
  token: string;
  gitRunner?: GitRunner;
  logger?: (message: string) => void;
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const reader = stream.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output).trim();
}

function normalizeGiteaUrl(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

function validateCloneUrl(value: string, giteaUrl: string): string {
  const clone = new URL(value);
  const gitea = new URL(normalizeGiteaUrl(giteaUrl));
  if (clone.protocol !== "https:" && clone.protocol !== "http:")
    throw new Error(`Unsupported clone URL protocol: ${clone.protocol}`);
  if (clone.username || clone.password || clone.search || clone.hash)
    throw new Error("Clone URL must not include credentials, query, or fragment");
  if (clone.origin !== gitea.origin) throw new Error("Clone URL origin does not match configured Gitea URL");
  if (gitea.pathname !== "/" && !clone.pathname.startsWith(gitea.pathname)) {
    throw new Error("Clone URL path is outside configured Gitea URL");
  }
  return clone.toString();
}

function gitEnv(auth: GitAuth): Record<string, string | undefined> {
  const giteaUrl = normalizeGiteaUrl(auth.giteaUrl);
  const basic = Buffer.from(`${auth.username}:${auth.token}`).toString("base64");
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    SSL_CERT_FILE: process.env.SSL_CERT_FILE,
    SSL_CERT_DIR: process.env.SSL_CERT_DIR,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_CONFIG_COUNT: "7",
    GIT_CONFIG_KEY_0: `http.${giteaUrl}.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
    GIT_CONFIG_KEY_2: "core.hooksPath",
    GIT_CONFIG_VALUE_2: "/dev/null",
    GIT_CONFIG_KEY_3: "filter.lfs.required",
    GIT_CONFIG_VALUE_3: "false",
    GIT_CONFIG_KEY_4: "filter.lfs.smudge",
    GIT_CONFIG_VALUE_4: "",
    GIT_CONFIG_KEY_5: "filter.lfs.process",
    GIT_CONFIG_VALUE_5: "",
    GIT_CONFIG_KEY_6: "protocol.file.allow",
    GIT_CONFIG_VALUE_6: "never",
  };
}

async function runGit(args: string[], opts: { cwd: string; env: Record<string, string | undefined> }): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: opts.env,
  });

  const [stdout, stderr, exitCode] = await Promise.all([readStream(proc.stdout), readStream(proc.stderr), proc.exited]);
  if (exitCode !== 0) {
    const details = [stdout, stderr].filter(Boolean).join("\n");
    throw new Error(`git ${args.join(" ")} failed with exit code ${exitCode}${details ? `:\n${details}` : ""}`);
  }
  return stdout;
}

function assertSha(value: string, label: string): string {
  if (!/^[0-9a-f]{7,40}$/i.test(value)) throw new Error(`Invalid ${label} SHA: ${value}`);
  return value;
}

export async function createReviewWorkspace(root: string, job: ReviewJob): Promise<string> {
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, `jumi-${job.owner}-${job.repo}-${job.prNumber}-`));
}

export async function checkoutPullRequestWorkspace(opts: CheckoutPullRequestWorkspaceOptions): Promise<void> {
  const git = opts.gitRunner ?? runGit;
  const env = gitEnv({ giteaUrl: opts.giteaUrl, username: opts.username, token: opts.token });
  const headSha = assertSha(opts.pr.head.sha, "PR head");
  const baseSha = assertSha(opts.pr.base.sha, "PR target");
  const prRef = `refs/pull/${opts.pr.number}/head`;
  const remotePrRef = `refs/remotes/origin/pr/${opts.pr.number}/head`;
  const targetBranch = "jumi/target";
  const baseCloneUrl = validateCloneUrl(opts.repo.clone_url, opts.giteaUrl);

  opts.logger?.(`Cloning ${opts.repo.full_name} into review workspace`);
  await git(["clone", baseCloneUrl, opts.workdir], { cwd: dirname(opts.workdir), env });

  opts.logger?.(`Fetching target branch ${opts.pr.base.ref}`);
  await git(["fetch", "origin", `+refs/heads/${opts.pr.base.ref}:refs/remotes/origin/${opts.pr.base.ref}`], {
    cwd: opts.workdir,
    env,
  });
  await git(["branch", "--force", targetBranch, baseSha], { cwd: opts.workdir, env });

  try {
    opts.logger?.(`Fetching PR ref ${prRef}`);
    await git(["fetch", "origin", `+${prRef}:${remotePrRef}`], { cwd: opts.workdir, env });
  } catch (err) {
    if (!opts.pr.head.repo?.clone_url) throw err;
    const headCloneUrl = validateCloneUrl(opts.pr.head.repo.clone_url, opts.giteaUrl);
    opts.logger?.(`Fetching PR head branch ${opts.pr.head.ref} from source repository`);
    await git(["remote", "add", "pr-head", headCloneUrl], { cwd: opts.workdir, env });
    await git(["fetch", "pr-head", `+refs/heads/${opts.pr.head.ref}:refs/remotes/pr-head/${opts.pr.head.ref}`], {
      cwd: opts.workdir,
      env,
    });
  }

  opts.logger?.(`Checking out PR head ${headSha} with target branch ${targetBranch}`);
  await git(["checkout", "--force", "-B", `jumi/pr-${opts.pr.number}`, headSha], { cwd: opts.workdir, env });
  const checkedOutHead = await git(["rev-parse", "HEAD"], { cwd: opts.workdir, env });
  if (checkedOutHead !== headSha) throw new Error(`Checked out ${checkedOutHead}, expected PR head ${headSha}`);
  const checkedOutBase = await git(["rev-parse", targetBranch], { cwd: opts.workdir, env });
  if (checkedOutBase !== baseSha)
    throw new Error(`Target ref ${targetBranch} is ${checkedOutBase}, expected ${baseSha}`);
}

export async function removeReviewWorkspace(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
