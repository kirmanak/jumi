import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReleaseBody,
  classifyBump,
  computeRelease,
  contractEnvIssues,
  gitOpsLoaderEnv,
  nextVersionFrom,
  parseContract,
  parseSemVerTag,
  publishRelease,
  shouldSkipImageBuild,
  workflowRebuildsOnTag,
} from "../src/release.ts";

const repoRoot = join(process.cwd(), "../..");

const BASE_CONTRACT = `# Deploy contract

## GitOps

### reviewer

#### required env
- \`GITEA_URL\`
- \`GITEA_BOT_TOKEN\`
- \`GITEA_WEBHOOK_SECRET\`

#### optional env

#### ports
- \`3000\`

#### runAs
- \`10001:10001\`

#### probes
- \`GET /healthz port 3000\`

#### command
- \`bun run src/server.ts\`

#### image target
- \`runtime\`

#### volumes
- \`/data\`
- \`/work\`

### worker

#### required env
- \`GITEA_URL\`
- \`GITEA_BOT_TOKEN\`
- \`GITEA_WEBHOOK_SECRET\`

#### optional env

#### ports
- \`3000\`

#### runAs
- \`10001:10001\`

#### probes
- \`GET /healthz port 3000\`

#### command
- \`bun run src/worker_server.ts\`

#### image target
- \`worker\`

#### volumes
- \`/data\`
- \`/work\`
`;

function addListItem(contract: string, image: "reviewer" | "worker", heading: string, value: string): string {
  const headingIdx = contract.indexOf(`#### ${heading}`, contract.indexOf(`### ${image}`));
  const insertAt = contract.indexOf("\n", headingIdx) + 1;
  return `${contract.slice(0, insertAt)}- \`${value}\`\n${contract.slice(insertAt)}`;
}

function addRequiredEnv(contract: string, image: "reviewer" | "worker", key: string): string {
  return addListItem(contract, image, "required env", key);
}

function removeRequiredEnv(contract: string, key: string): string {
  return contract.replace(`- \`${key}\`\n`, "");
}

function git(args: string[], cwd: string): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
}

async function withRepo(setup: (dir: string) => Promise<void>, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "jumi-release-"));
  try {
    git(["init", "-b", "main"], dir);
    git(["config", "user.email", "jumi@example.com"], dir);
    git(["config", "user.name", "jumi"], dir);
    git(["config", "commit.gpgsign", "false"], dir);
    await setup(dir);
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("version bump", () => {
  test("no tag → v1.0.0 and GitOps none", () => {
    expect(classifyBump(null, BASE_CONTRACT)).toBe("initial");
    expect(nextVersionFrom(null, "initial")).toBe("v1.0.0");
    const body = buildReleaseBody({
      previousContract: null,
      currentContract: BASE_CONTRACT,
      changes: ["abc1234 baseline"],
    });
    expect(body).toContain("## GitOps\nnone\n");
    expect(body).toContain("## Breaking\nnone\n");
    expect(body).toContain("## Changes\n- abc1234 baseline\n");
  });

  test("unchanged contract → patch", () => {
    expect(classifyBump(BASE_CONTRACT, BASE_CONTRACT)).toBe("patch");
    expect(nextVersionFrom("v1.2.3", "patch")).toBe("v1.2.4");
    const body = buildReleaseBody({
      previousContract: BASE_CONTRACT,
      currentContract: BASE_CONTRACT,
      changes: ["def5678 fix queue"],
    });
    expect(body).toMatch(/^## GitOps\nnone\n\n## Breaking\nnone\n\n## Changes\n/m);
    expect(body).toContain("- def5678 fix queue");
  });

  test("additive required env → major with namespaced GitOps bullets", () => {
    const next = addRequiredEnv(BASE_CONTRACT, "reviewer", "FOO");
    expect(classifyBump(BASE_CONTRACT, next)).toBe("major");
    expect(nextVersionFrom("v1.0.0", "major")).toBe("v2.0.0");
    const body = buildReleaseBody({
      previousContract: BASE_CONTRACT,
      currentContract: next,
      changes: ["aaa1111 add FOO"],
    });
    expect(body).toContain(
      "## GitOps\n### reviewer\n- **requires** `FOO` (new; missing → crash)\n### worker\n- none\n"
    );
    expect(body).toContain("## Breaking\nnone\n");
  });

  test("additive optional volume → minor", () => {
    const next = addListItem(BASE_CONTRACT, "worker", "volumes", "/var/cache");
    expect(classifyBump(BASE_CONTRACT, next)).toBe("minor");
    expect(nextVersionFrom("v1.0.0", "minor")).toBe("v1.1.0");
    const body = buildReleaseBody({
      previousContract: BASE_CONTRACT,
      currentContract: next,
      changes: ["ddd4444 add cache volume"],
    });
    expect(body).toContain("### worker\n- **volume** `/var/cache` (new)\n");
    expect(body).toContain("## Breaking\nnone\n");
  });

  test("additive optional env → minor with GitOps bullets", () => {
    const next = addListItem(BASE_CONTRACT, "worker", "optional env", "MAX_FOLLOWUP_ROUNDS");
    expect(classifyBump(BASE_CONTRACT, next)).toBe("minor");
    expect(nextVersionFrom("v1.0.0", "minor")).toBe("v1.1.0");
    const body = buildReleaseBody({
      previousContract: BASE_CONTRACT,
      currentContract: next,
      changes: ["hhh8888 follow-up cap env"],
    });
    expect(body).toContain("### worker\n- **optional env** `MAX_FOLLOWUP_ROUNDS` (new)\n");
    expect(body).toContain("## Breaking\nnone\n");
  });

  test("additive port → major", () => {
    const next = addListItem(BASE_CONTRACT, "reviewer", "ports", "9090");
    expect(classifyBump(BASE_CONTRACT, next)).toBe("major");
    const body = buildReleaseBody({
      previousContract: BASE_CONTRACT,
      currentContract: next,
      changes: ["eee5555 add metrics port"],
    });
    expect(body).toContain("**port** `9090` (new)");
    expect(body).toContain("## Breaking\nnone\n");
  });

  test("removed required key → major", () => {
    const next = removeRequiredEnv(BASE_CONTRACT, "GITEA_WEBHOOK_SECRET");
    expect(classifyBump(BASE_CONTRACT, next)).toBe("major");
    expect(nextVersionFrom("v1.4.2", "major")).toBe("v2.0.0");
    const body = buildReleaseBody({
      previousContract: BASE_CONTRACT,
      currentContract: next,
      changes: ["bbb2222 drop webhook secret"],
    });
    expect(body).toContain("**removed** `GITEA_WEBHOOK_SECRET`");
    expect(body).toContain("removed required env GITEA_WEBHOOK_SECRET");
  });

  test("BREAKING marker → major even without key removal", () => {
    const next = `${BASE_CONTRACT}\n## BREAKING\n- app protocol change\n`;
    expect(classifyBump(BASE_CONTRACT, next)).toBe("major");
    const body = buildReleaseBody({
      previousContract: BASE_CONTRACT,
      currentContract: next,
      changes: ["ccc3333 break api"],
    });
    expect(body).toContain("## GitOps\nnone\n");
    expect(body).toContain("- BREAKING marker in deploy/contract.md");
  });

  test("reviewer and worker share one version", () => {
    const reviewerOnly = addRequiredEnv(BASE_CONTRACT, "reviewer", "FOO");
    const workerOnly = addRequiredEnv(BASE_CONTRACT, "worker", "BAR");
    const volumeOnly = addListItem(BASE_CONTRACT, "worker", "volumes", "/var/cache");
    expect(nextVersionFrom("v1.0.0", classifyBump(BASE_CONTRACT, reviewerOnly))).toBe("v2.0.0");
    expect(nextVersionFrom("v1.0.0", classifyBump(BASE_CONTRACT, workerOnly))).toBe("v2.0.0");
    expect(nextVersionFrom("v1.0.0", classifyBump(BASE_CONTRACT, volumeOnly))).toBe("v1.1.0");
    expect(nextVersionFrom("v1.0.0", classifyBump(BASE_CONTRACT, BASE_CONTRACT))).toBe("v1.0.1");
  });

  test("worker DATABASE_URL is GitOps-required, not Breaking, and does not claim crash", () => {
    const next = addRequiredEnv(BASE_CONTRACT, "worker", "DATABASE_URL");
    expect(classifyBump(BASE_CONTRACT, next)).toBe("major");
    const body = buildReleaseBody({
      previousContract: BASE_CONTRACT,
      currentContract: next,
      changes: ["fff6666 worker DATABASE_URL"],
    });
    expect(body).toContain("### worker\n- **requires** `DATABASE_URL`\n");
    expect(body).not.toContain("**requires** `DATABASE_URL` (new; missing → crash)");
    expect(body).toContain("## Breaking\nnone\n");
  });

  test("prose-only contract notes stay patch with GitOps none", () => {
    const next = `${BASE_CONTRACT}\nNotes changed without keys.\n`;
    expect(classifyBump(BASE_CONTRACT, next)).toBe("patch");
    const body = buildReleaseBody({
      previousContract: BASE_CONTRACT,
      currentContract: next,
      changes: ["ggg7777 notes"],
    });
    expect(body).toContain("## GitOps\nnone\n");
    expect(body).toContain("## Breaking\nnone\n");
  });
});

describe("deploy/contract.md", () => {
  test("parses live contract from origin/main intent", async () => {
    const markdown = await readFile(join(repoRoot, "deploy/contract.md"), "utf8");
    const parsed = parseContract(markdown);
    expect(parsed.reviewer.requiredEnv).toEqual(["GITEA_URL", "GITEA_BOT_TOKEN", "GITEA_WEBHOOK_SECRET"]);
    expect(parsed.reviewer.optionalEnv).toEqual([
      "HOST",
      "PORT",
      "GITEA_WEBHOOK_AUTH_TOKEN",
      "GITEA_ALLOWED_ORGS",
      "GITEA_ALLOWED_REPOS",
      "BOT_USERNAME",
      "FOLLOWUP_IGNORE_LOGINS",
      "OPENCODE_MODEL",
      "OPENCODE_CONFIG",
      "OPENCODE_WELLKNOWN_URL",
      "OPENCODE_WELLKNOWN_KEY",
      "OPENCODE_WELLKNOWN_TOKEN",
      "HOME",
      "WORKDIR",
      "QUEUE_CONCURRENCY",
      "MAX_FILES",
      "MAX_PATCH_BYTES",
      "MAX_OUTPUT_BYTES",
      "MAX_WEBHOOK_BYTES",
      "OPENCODE_TIMEOUT_MS",
      "JUMI_ROLE",
      "DATABASE_URL",
      "LEASE_MS",
      "MAX_JOB_ATTEMPTS",
      "PHOENIX_OTLP_ENDPOINT",
    ]);
    expect(parsed.worker.requiredEnv).toEqual(["GITEA_URL", "GITEA_BOT_TOKEN", "GITEA_WEBHOOK_SECRET", "DATABASE_URL"]);
    expect(parsed.worker.optionalEnv).toEqual([
      "HOST",
      "PORT",
      "GITEA_WEBHOOK_AUTH_TOKEN",
      "GITEA_ALLOWED_ORGS",
      "GITEA_ALLOWED_REPOS",
      "BOT_USERNAME",
      "FOLLOWUP_IGNORE_LOGINS",
      "OPENCODE_MODEL",
      "OPENCODE_CONFIG",
      "OPENCODE_WELLKNOWN_URL",
      "OPENCODE_WELLKNOWN_KEY",
      "OPENCODE_WELLKNOWN_TOKEN",
      "HOME",
      "WORKDIR",
      "QUEUE_CONCURRENCY",
      "MAX_OUTPUT_BYTES",
      "MAX_WEBHOOK_BYTES",
      "OPENCODE_TIMEOUT_MS",
      "FOLLOWUP_TIMEOUT_MS",
      "CONFLICT_TIMEOUT_MS",
      "MAX_FOLLOWUP_ROUNDS",
      "MAX_CONFLICT_ROUNDS",
      "LEASE_MS",
      "MAX_JOB_ATTEMPTS",
      "PHOENIX_OTLP_ENDPOINT",
    ]);
    expect(parsed.reviewer.ports).toEqual(["3000"]);
    expect(parsed.worker.ports).toEqual(["3000"]);
    expect(parsed.reviewer.runAs).toBe("10001:10001");
    expect(parsed.worker.runAs).toBe("10001:10001");
    expect(parsed.reviewer.probes).toEqual(["GET /healthz port 3000"]);
    expect(parsed.worker.probes).toEqual(["GET /healthz port 3000"]);
    expect(parsed.reviewer.command).toBe("bun run src/server.ts");
    expect(parsed.worker.command).toBe("bun run src/worker_server.ts");
    expect(parsed.reviewer.imageTarget).toBe("runtime");
    expect(parsed.worker.imageTarget).toBe("worker");
    expect(parsed.reviewer.volumes).toEqual(["/data", "/work"]);
    expect(parsed.worker.volumes).toEqual(["/data", "/work"]);
    expect(markdown).toContain("workflow_job");
  });

  test("loader env matches contract required and optional headings", async () => {
    const markdown = await readFile(join(repoRoot, "deploy/contract.md"), "utf8");
    const parsed = parseContract(markdown);
    const reviewerSrc = await readFile(join(repoRoot, "scripts/opencode/src/config.ts"), "utf8");
    const workerSrc = await readFile(join(repoRoot, "scripts/opencode/src/worker_config.ts"), "utf8");
    const reviewer = gitOpsLoaderEnv("reviewer", reviewerSrc);
    const worker = gitOpsLoaderEnv("worker", workerSrc);
    expect([...parsed.reviewer.requiredEnv].sort()).toEqual(reviewer.required);
    expect([...parsed.reviewer.optionalEnv].sort()).toEqual(reviewer.optional);
    expect([...parsed.worker.requiredEnv].sort()).toEqual(worker.required);
    expect([...parsed.worker.optionalEnv].sort()).toEqual(worker.optional);
    expect(contractEnvIssues(parsed, reviewerSrc, workerSrc)).toEqual([]);
    expect(parsed.worker.requiredEnv).toContain("DATABASE_URL");
    expect(parsed.reviewer.requiredEnv).not.toContain("DATABASE_URL");
    expect(parsed.reviewer.optionalEnv).toContain("DATABASE_URL");
  });

  test("CI fails when a loader env is missing or in the wrong heading", () => {
    const reviewerSrc = `requireEnv(resolved, "GITEA_URL");
optionalEnv(resolved, "HOST");
intEnv(resolved, "PORT", 3000);
`;
    const workerSrc = `requireEnv(resolved, "GITEA_URL");
optionalEnv(resolved, "DATABASE_URL");
intEnv(resolved, "MAX_FOLLOWUP_ROUNDS", 3);
`;
    const contract = parseContract(BASE_CONTRACT);
    expect(contractEnvIssues(contract, reviewerSrc, workerSrc)).toEqual([
      { image: "reviewer", name: "HOST", kind: "missing" },
      { image: "reviewer", name: "PORT", kind: "missing" },
      { image: "reviewer", name: "GITEA_BOT_TOKEN", kind: "extra" },
      { image: "reviewer", name: "GITEA_WEBHOOK_SECRET", kind: "extra" },
      { image: "worker", name: "DATABASE_URL", kind: "missing" },
      { image: "worker", name: "MAX_FOLLOWUP_ROUNDS", kind: "missing" },
      { image: "worker", name: "GITEA_BOT_TOKEN", kind: "extra" },
      { image: "worker", name: "GITEA_WEBHOOK_SECRET", kind: "extra" },
    ]);
    const swapped = parseContract(`# Deploy contract

## GitOps

### reviewer

#### required env
- \`HOST\`

#### optional env
- \`GITEA_URL\`

### worker

#### required env
- \`GITEA_URL\`

#### optional env
- \`GITEA_URL\`
`);
    const matchingReviewer = `requireEnv(resolved, "GITEA_URL");
optionalEnv(resolved, "HOST");
`;
    const matchingWorker = `requireEnv(resolved, "GITEA_URL");
`;
    expect(contractEnvIssues(swapped, matchingReviewer, matchingWorker)).toEqual([
      { image: "reviewer", name: "GITEA_URL", kind: "required_as_optional" },
      { image: "reviewer", name: "HOST", kind: "optional_as_required" },
      { image: "worker", name: "GITEA_URL", kind: "duplicate" },
    ]);
  });
});

describe("computeRelease git adapter", () => {
  test("no tag is v1.0.0 with GitOps none; unchanged contract patches; HEAD tag is reused", async () => {
    await withRepo(
      async (dir) => {
        await mkdir(join(dir, "deploy"));
        await writeFile(join(dir, "deploy/contract.md"), BASE_CONTRACT);
        git(["add", "deploy/contract.md"], dir);
        git(["commit", "-m", "baseline"], dir);
      },
      async (dir) => {
        const first = computeRelease(dir);
        expect(first.version).toBe("v1.0.0");
        expect(first.bump).toBe("initial");
        expect(first.body).toContain("## GitOps\nnone\n");

        git(["tag", "-a", "v1.0.0", "-m", "v1.0.0"], dir);
        const reused = computeRelease(dir);
        expect(reused.version).toBe("v1.0.0");
        expect(reused.bump).toBe("reuse");

        await mkdir(join(dir, "src"), { recursive: true });
        await writeFile(join(dir, "src/app.ts"), "export {}\n");
        git(["add", "src/app.ts"], dir);
        git(["commit", "-m", "code only"], dir);
        const patch = computeRelease(dir);
        expect(patch.version).toBe("v1.0.1");
        expect(patch.bump).toBe("patch");
        expect(patch.body).toContain("## GitOps\nnone\n");

        await writeFile(join(dir, "deploy/contract.md"), addRequiredEnv(BASE_CONTRACT, "worker", "DATABASE_URL"));
        git(["add", "deploy/contract.md"], dir);
        git(["commit", "-m", "require worker DATABASE_URL"], dir);
        const major = computeRelease(dir);
        expect(major.version).toBe("v2.0.0");
        expect(major.bump).toBe("major");
        expect(major.body).toContain("### worker\n- **requires** `DATABASE_URL`\n");
        expect(major.body).toContain("## Breaking\nnone\n");
        expect(major.body).not.toMatch(/^## GitOps\nnone\n/m);
      }
    );
  });
});

describe("image labels and no double-build", () => {
  test("Dockerfile and build scripts pass OCI source/version/revision", async () => {
    const dockerfile = await readFile(join(repoRoot, "Dockerfile"), "utf8");
    const reviewer = await readFile(join(repoRoot, ".gitea/scripts/build-reviewer-image.sh"), "utf8");
    const worker = await readFile(join(repoRoot, ".gitea/scripts/build-worker-image.sh"), "utf8");
    expect(dockerfile).toContain('org.opencontainers.image.source="https://gitea.kirmanak.stream/personal/jumi"');
    expect(dockerfile).toContain("org.opencontainers.image.version=");
    expect(dockerfile).toContain("org.opencontainers.image.revision=");
    expect(dockerfile).toContain("ARG VERSION=");
    expect(dockerfile).toContain("ARG REVISION=");
    expect(reviewer).toContain('--build-arg "VERSION=$' + '{VERSION}"');
    expect(reviewer).toContain('--build-arg "REVISION=$' + '{REVISION}"');
    expect(worker).toContain('--build-arg "VERSION=$' + '{VERSION}"');
    expect(worker).toContain('--build-arg "REVISION=$' + '{REVISION}"');
  });

  test("tag push does not start a second full Buildah", async () => {
    const reviewer = await readFile(join(repoRoot, ".gitea/workflows/jumi-reviewer-image.yml"), "utf8");
    const worker = await readFile(join(repoRoot, ".gitea/workflows/jumi-worker-image.yml"), "utf8");
    expect(workflowRebuildsOnTag(reviewer)).toBe(false);
    expect(workflowRebuildsOnTag(worker)).toBe(false);
    expect(shouldSkipImageBuild("tag")).toBe(true);
    expect(shouldSkipImageBuild("branch")).toBe(false);
    expect(reviewer).toContain("$" + "{IMAGE}:$" + "{VERSION}");
    expect(worker).toContain("$" + "{IMAGE}:$" + "{VERSION}");
    expect(reviewer).toContain("bun src/release.ts next-version");
    expect(worker).toContain("bun src/release.ts next-version");
    const release = await readFile(join(repoRoot, ".gitea/workflows/jumi-release.yml"), "utf8");
    expect(release).toContain("bun src/release.ts publish");
    expect(release).toContain("github.token");
    expect(release).not.toContain("tags:");
  });
});

describe("publishRelease", () => {
  test("creates annotated tag and release; refuses to move tags; 403 explains no PAT", async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const fetchImpl = async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      if (url.endsWith("/tags/v1.0.0") && method === "GET") return new Response("Not Found", { status: 404 });
      if (url.endsWith("/tags") && method === "POST") return new Response("{}", { status: 201 });
      if (url.endsWith("/releases/tags/v1.0.0") && method === "GET") return new Response("Not Found", { status: 404 });
      if (url.endsWith("/releases") && method === "POST") return new Response("{}", { status: 201 });
      return new Response("unexpected", { status: 500 });
    };
    const result = await publishRelease({
      serverUrl: "https://gitea.kirmanak.stream",
      token: "t",
      owner: "personal",
      repo: "jumi",
      sha: "abc",
      version: "v1.0.0",
      body: "## GitOps\nnone\n",
      fetchImpl,
    });
    expect(result).toEqual({ tagCreated: true, releaseCreated: true });
    expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/tags"))).toBe(true);
    expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/releases"))).toBe(true);

    const moveFetch = async (input: string) => {
      if (String(input).endsWith("/tags/v1.0.0")) {
        return new Response(JSON.stringify({ commit: { sha: "old" } }), { status: 200 });
      }
      return new Response("no", { status: 500 });
    };
    await expect(
      publishRelease({
        serverUrl: "https://gitea.kirmanak.stream",
        token: "t",
        owner: "personal",
        repo: "jumi",
        sha: "new",
        version: "v1.0.0",
        body: "x",
        fetchImpl: moveFetch,
      })
    ).rejects.toThrow("immutable tag");

    const forbidden = async () => new Response("nope", { status: 403 });
    await expect(
      publishRelease({
        serverUrl: "https://gitea.kirmanak.stream",
        token: "t",
        owner: "personal",
        repo: "jumi",
        sha: "abc",
        version: "v1.0.0",
        body: "x",
        fetchImpl: forbidden,
      })
    ).rejects.toThrow("Do not add a PAT");
  });
});

describe("parseSemVerTag", () => {
  test("accepts vX.Y.Z only", () => {
    expect(parseSemVerTag("v1.0.0")).toEqual({ major: 1, minor: 0, patch: 0 });
    expect(parseSemVerTag("v1.0.0-rc.1")).toBeNull();
    expect(parseSemVerTag("1.0.0")).toBeNull();
  });
});
