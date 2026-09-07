import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CONTRACT_PATH = "deploy/contract.md";
export const REVIEWER_LOADER_PATH = "scripts/opencode/src/config.ts";
export const WORKER_LOADER_PATH = "scripts/opencode/src/worker_config.ts";
const SEMVER_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const LOADER_ENV_HELPER_RE = /(?:requireEnv|optionalEnv|intEnv|csvEnv)\(\s*\w+\s*,\s*"([A-Z][A-Z0-9_]*)"/g;
const LOADER_ENV_PROP_RE = /\b(?:resolved|env)\.([A-Z][A-Z0-9_]*)\b/g;
const REQUIRE_ENV_RE = /requireEnv\(\s*\w+\s*,\s*"([A-Z][A-Z0-9_]*)"/g;

export type BumpKind = "major" | "minor" | "patch" | "initial";
export type VersionDecision = BumpKind | "reuse";
export type ImageName = "reviewer" | "worker";

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

export interface ImageContract {
  requiredEnv: string[];
  optionalEnv: string[];
  ports: string[];
  runAs: string;
  probes: string[];
  command: string;
  imageTarget: string;
  volumes: string[];
}

export type ContractEnvIssueKind = "missing" | "extra" | "required_as_optional" | "optional_as_required" | "duplicate";

export interface ContractEnvIssue {
  image: ImageName;
  name: string;
  kind: ContractEnvIssueKind;
}

export interface DeployContract {
  reviewer: ImageContract;
  worker: ImageContract;
}

export interface ReleasePlan {
  version: string;
  bump: VersionDecision;
  body: string;
}

export function parseSemVerTag(tag: string): SemVer | null {
  const match = SEMVER_TAG.exec(tag.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function formatSemVerTag(version: SemVer): string {
  return `v${version.major}.${version.minor}.${version.patch}`;
}

export function compareSemVer(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

function emptyImage(): ImageContract {
  return {
    requiredEnv: [],
    optionalEnv: [],
    ports: [],
    runAs: "",
    probes: [],
    command: "",
    imageTarget: "",
    volumes: [],
  };
}

function headingSection(markdown: string, level: number, title: string): string {
  const re = new RegExp(`^#{${level}}\\s+${title}\\s*$`, "im");
  const match = re.exec(markdown);
  if (!match || match.index === undefined) return "";
  const start = match.index + match[0].length;
  const rest = markdown.slice(start);
  const next = new RegExp(`^#{1,${level}}\\s+`, "m").exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

function listValues(sectionText: string): string[] {
  return sectionText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) =>
      line
        .slice(2)
        .trim()
        .replace(/^`([^`]+)`$/, "$1")
    );
}

function firstValue(values: string[]): string {
  return values[0] ?? "";
}

function parseImage(section: string): ImageContract {
  return {
    requiredEnv: listValues(headingSection(section, 4, "required env")),
    optionalEnv: listValues(headingSection(section, 4, "optional env")),
    ports: listValues(headingSection(section, 4, "ports")),
    runAs: firstValue(listValues(headingSection(section, 4, "runAs"))),
    probes: listValues(headingSection(section, 4, "probes")),
    command: firstValue(listValues(headingSection(section, 4, "command"))),
    imageTarget: firstValue(listValues(headingSection(section, 4, "image target"))),
    volumes: listValues(headingSection(section, 4, "volumes")),
  };
}

export function loaderEnvNames(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(LOADER_ENV_HELPER_RE)) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(LOADER_ENV_PROP_RE)) {
    names.add(match[1]);
  }
  return [...names].sort();
}

function requireEnvNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(REQUIRE_ENV_RE)) {
    names.add(match[1]);
  }
  return names;
}

export function gitOpsLoaderEnv(image: ImageName, source: string): { required: string[]; optional: string[] } {
  const names = loaderEnvNames(source);
  const requiredSet = requireEnvNames(source);
  if (image === "worker") requiredSet.add("DATABASE_URL");
  if (image === "reviewer") requiredSet.delete("DATABASE_URL");
  return {
    required: names.filter((name) => requiredSet.has(name)).sort(),
    optional: names.filter((name) => !requiredSet.has(name)).sort(),
  };
}

export function formatContractEnvIssue(issue: ContractEnvIssue): string {
  if (issue.kind === "missing") {
    return `${issue.image} loader env \`${issue.name}\` is missing from deploy/contract.md required/optional env`;
  }
  if (issue.kind === "extra") {
    return `${issue.image} contract env \`${issue.name}\` is not read by the loader`;
  }
  if (issue.kind === "required_as_optional") {
    return `${issue.image} env \`${issue.name}\` is required GitOps but listed as optional`;
  }
  if (issue.kind === "optional_as_required") {
    return `${issue.image} env \`${issue.name}\` is optional but listed as required`;
  }
  return `${issue.image} env \`${issue.name}\` is listed as both required and optional`;
}

export function contractEnvIssues(
  contract: DeployContract,
  reviewerSrc: string,
  workerSrc: string
): ContractEnvIssue[] {
  const issues: ContractEnvIssue[] = [];
  for (const image of ["reviewer", "worker"] as const) {
    const expected = gitOpsLoaderEnv(image, image === "reviewer" ? reviewerSrc : workerSrc);
    const listedRequired = contract[image].requiredEnv;
    const listedOptional = contract[image].optionalEnv;
    const requiredSet = new Set(listedRequired);
    const optionalSet = new Set(listedOptional);
    const listed = new Set([...listedRequired, ...listedOptional]);
    const expectedNames = new Set([...expected.required, ...expected.optional]);
    for (const name of listedRequired) {
      if (optionalSet.has(name)) issues.push({ image, name, kind: "duplicate" });
    }
    for (const name of expectedNames) {
      if (!listed.has(name)) issues.push({ image, name, kind: "missing" });
    }
    for (const name of listed) {
      if (!expectedNames.has(name)) issues.push({ image, name, kind: "extra" });
    }
    for (const name of expected.required) {
      if (optionalSet.has(name) && !requiredSet.has(name)) {
        issues.push({ image, name, kind: "required_as_optional" });
      }
    }
    for (const name of expected.optional) {
      if (requiredSet.has(name) && !optionalSet.has(name)) {
        issues.push({ image, name, kind: "optional_as_required" });
      }
    }
  }
  return issues;
}

export function parseContract(markdown: string): DeployContract {
  if (!markdown.trim()) {
    return { reviewer: emptyImage(), worker: emptyImage() };
  }
  const reviewer = headingSection(markdown, 3, "reviewer");
  const worker = headingSection(markdown, 3, "worker");
  if (!reviewer || !worker) {
    throw new Error("deploy/contract.md must contain ### reviewer and ### worker");
  }
  return { reviewer: parseImage(reviewer), worker: parseImage(worker) };
}

function addedLines(previous: string, current: string): string[] {
  const prevLines = new Set(previous.split("\n"));
  return current.split("\n").filter((line) => !prevLines.has(line));
}

export function hasBreakingMarker(previous: string, current: string): boolean {
  return addedLines(previous, current).some((line) => {
    const trimmed = line.trim();
    return /^#{1,6}\s*BREAKING\b/i.test(trimmed) || /(^|\s)BREAKING(\s|:|$)/.test(trimmed);
  });
}

function removedItems(previous: string[], current: string[]): string[] {
  const next = new Set(current);
  return previous.filter((item) => !next.has(item));
}

function addedItems(previous: string[], current: string[]): string[] {
  const prev = new Set(previous);
  return current.filter((item) => !prev.has(item));
}

export function removedRequiredFields(previous: ImageContract, current: ImageContract): string[] {
  const removed: string[] = [];
  for (const key of removedItems(previous.requiredEnv, current.requiredEnv)) {
    removed.push(`env ${key}`);
  }
  for (const port of removedItems(previous.ports, current.ports)) {
    removed.push(`port ${port}`);
  }
  if (previous.runAs && previous.runAs !== current.runAs) removed.push(`user ${previous.runAs}`);
  for (const probe of removedItems(previous.probes, current.probes)) {
    removed.push(`probe ${probe}`);
  }
  if (previous.command && previous.command !== current.command) removed.push(`command ${previous.command}`);
  if (previous.imageTarget && previous.imageTarget !== current.imageTarget) {
    removed.push(`target ${previous.imageTarget}`);
  }
  return removed;
}

function hasRequiredGitOpsChange(previous: ImageContract, current: ImageContract): boolean {
  return (
    addedItems(previous.requiredEnv, current.requiredEnv).length > 0 ||
    removedItems(previous.requiredEnv, current.requiredEnv).length > 0 ||
    addedItems(previous.ports, current.ports).length > 0 ||
    removedItems(previous.ports, current.ports).length > 0 ||
    previous.runAs !== current.runAs ||
    addedItems(previous.probes, current.probes).length > 0 ||
    removedItems(previous.probes, current.probes).length > 0 ||
    previous.command !== current.command ||
    previous.imageTarget !== current.imageTarget
  );
}

function hasOptionalGitOpsChange(previous: ImageContract, current: ImageContract): boolean {
  return (
    addedItems(previous.optionalEnv, current.optionalEnv).length > 0 ||
    removedItems(previous.optionalEnv, current.optionalEnv).length > 0 ||
    addedItems(previous.volumes, current.volumes).length > 0 ||
    removedItems(previous.volumes, current.volumes).length > 0
  );
}

export function classifyBump(previousMarkdown: string | null, currentMarkdown: string): BumpKind {
  if (previousMarkdown === null) return "initial";
  if (hasBreakingMarker(previousMarkdown, currentMarkdown)) return "major";
  const previous = parseContract(previousMarkdown);
  const current = parseContract(currentMarkdown);
  if (
    hasRequiredGitOpsChange(previous.reviewer, current.reviewer) ||
    hasRequiredGitOpsChange(previous.worker, current.worker)
  ) {
    return "major";
  }
  if (
    hasOptionalGitOpsChange(previous.reviewer, current.reviewer) ||
    hasOptionalGitOpsChange(previous.worker, current.worker)
  ) {
    return "minor";
  }
  return "patch";
}

export function nextVersionFrom(latestTag: string | null, bump: BumpKind): string {
  if (bump === "initial" || latestTag === null) return "v1.0.0";
  const parsed = parseSemVerTag(latestTag);
  if (!parsed) return "v1.0.0";
  if (bump === "major") return formatSemVerTag({ major: parsed.major + 1, minor: 0, patch: 0 });
  if (bump === "minor") return formatSemVerTag({ major: parsed.major, minor: parsed.minor + 1, patch: 0 });
  return formatSemVerTag({ major: parsed.major, minor: parsed.minor, patch: parsed.patch + 1 });
}

function requiresEnvBullet(image: ImageName, key: string): string {
  if (image === "worker" && key === "DATABASE_URL") {
    return `- **requires** \`${key}\``;
  }
  return `- **requires** \`${key}\` (new; missing → crash)`;
}

function gitOpsBullets(image: ImageName, previous: ImageContract, current: ImageContract): string[] {
  const bullets: string[] = [];
  for (const key of addedItems(previous.requiredEnv, current.requiredEnv)) {
    bullets.push(requiresEnvBullet(image, key));
  }
  for (const key of removedItems(previous.requiredEnv, current.requiredEnv)) {
    bullets.push(`- **removed** \`${key}\` (was required)`);
  }
  for (const port of addedItems(previous.ports, current.ports)) {
    bullets.push(`- **port** \`${port}\` (new)`);
  }
  for (const port of removedItems(previous.ports, current.ports)) {
    bullets.push(`- **removed port** \`${port}\``);
  }
  if (previous.runAs !== current.runAs && (previous.runAs || current.runAs)) {
    bullets.push(`- **runAs** \`${previous.runAs || "none"}\` → \`${current.runAs || "none"}\``);
  }
  for (const probe of addedItems(previous.probes, current.probes)) {
    bullets.push(`- **probe** \`${probe}\` (new)`);
  }
  for (const probe of removedItems(previous.probes, current.probes)) {
    bullets.push(`- **removed probe** \`${probe}\``);
  }
  if (previous.command !== current.command && (previous.command || current.command)) {
    bullets.push(`- **command** \`${previous.command || "none"}\` → \`${current.command || "none"}\``);
  }
  if (previous.imageTarget !== current.imageTarget && (previous.imageTarget || current.imageTarget)) {
    bullets.push(`- **image target** \`${previous.imageTarget || "none"}\` → \`${current.imageTarget || "none"}\``);
  }
  for (const volume of addedItems(previous.volumes, current.volumes)) {
    bullets.push(`- **volume** \`${volume}\` (new)`);
  }
  for (const volume of removedItems(previous.volumes, current.volumes)) {
    bullets.push(`- **removed volume** \`${volume}\``);
  }
  return bullets;
}

function formatGitOpsSection(previousMarkdown: string | null, currentMarkdown: string): string {
  if (previousMarkdown === null) return "none";
  const previous = parseContract(previousMarkdown);
  const current = parseContract(currentMarkdown);
  const reviewer = gitOpsBullets("reviewer", previous.reviewer, current.reviewer);
  const worker = gitOpsBullets("worker", previous.worker, current.worker);
  if (reviewer.length === 0 && worker.length === 0) return "none";
  const reviewerBlock = reviewer.length > 0 ? reviewer.join("\n") : "- none";
  const workerBlock = worker.length > 0 ? worker.join("\n") : "- none";
  return `### reviewer\n${reviewerBlock}\n### worker\n${workerBlock}`;
}

function formatBreakingSection(previousMarkdown: string | null, currentMarkdown: string): string {
  if (previousMarkdown === null) return "none";
  const bullets: string[] = [];
  if (hasBreakingMarker(previousMarkdown, currentMarkdown)) {
    bullets.push("- BREAKING marker in deploy/contract.md");
  }
  const previous = parseContract(previousMarkdown);
  const current = parseContract(currentMarkdown);
  for (const image of ["reviewer", "worker"] as const) {
    for (const field of removedRequiredFields(previous[image], current[image])) {
      bullets.push(`- ${image}: removed required ${field}`);
    }
  }
  return bullets.length > 0 ? bullets.join("\n") : "none";
}

export function buildReleaseBody(opts: {
  previousContract: string | null;
  currentContract: string;
  changes: string[];
}): string {
  const gitOps = formatGitOpsSection(opts.previousContract, opts.currentContract);
  const breaking = formatBreakingSection(opts.previousContract, opts.currentContract);
  const changes = opts.changes.length > 0 ? opts.changes.map((line) => `- ${line}`).join("\n") : "- none";
  return `## GitOps\n${gitOps}\n\n## Breaking\n${breaking}\n\n## Changes\n${changes}\n`;
}

export function workflowRebuildsOnTag(yaml: string): boolean {
  const hasTagTrigger = /tags:\s*\["v\*"\]/.test(yaml) || /tags:\s*\n\s*-\s*"v\*"/m.test(yaml);
  if (!hasTagTrigger) return false;
  if (/if:\s*\$\{\{\s*github\.ref_type\s*!=\s*'tag'\s*\}\}/.test(yaml)) return false;
  if (/if:\s*\$\{\{\s*github\.event_name\s*!=\s*'push'\s*\|\|\s*github\.ref_type\s*!=\s*'tag'/.test(yaml)) {
    return false;
  }
  return true;
}

export function shouldSkipImageBuild(refType: string): boolean {
  return refType === "tag";
}

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result.stdout.trim();
}

function gitAllowFail(args: string[], cwd: string): string | null {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout;
}

export function listSemverTags(repoDir: string): string[] {
  const out = gitAllowFail(["tag", "--list", "v*"], repoDir) ?? "";
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((tag) => parseSemVerTag(tag))
    .sort((a, b) => compareSemVer(parseSemVerTag(a)!, parseSemVerTag(b)!));
}

export function headSemverTag(repoDir: string): string | null {
  const pointed = gitAllowFail(["tag", "--points-at", "HEAD"], repoDir) ?? "";
  const tags = pointed
    .split("\n")
    .map((line) => line.trim())
    .filter((tag) => parseSemVerTag(tag))
    .sort((a, b) => compareSemVer(parseSemVerTag(a)!, parseSemVerTag(b)!));
  return tags.at(-1) ?? null;
}

export function latestSemverTag(repoDir: string): string | null {
  const tags = listSemverTags(repoDir);
  return tags.at(-1) ?? null;
}

export function contractAt(repoDir: string, ref: string): string | null {
  return gitAllowFail(["show", `${ref}:${CONTRACT_PATH}`], repoDir);
}

export function currentContract(repoDir: string): string {
  return readFileSync(join(repoDir, CONTRACT_PATH), "utf8");
}

export function changesSince(repoDir: string, tag: string | null): string[] {
  const range = tag ? `${tag}..HEAD` : "HEAD";
  const out = tag
    ? (gitAllowFail(["log", "--oneline", range], repoDir) ?? "")
    : (gitAllowFail(["log", "--oneline", "-1"], repoDir) ?? "");
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function computeRelease(repoDir: string): ReleasePlan {
  const current = currentContract(repoDir);
  const headTag = headSemverTag(repoDir);
  if (headTag) {
    const older = listSemverTags(repoDir).filter((tag) => tag !== headTag);
    const previousTag = older.at(-1) ?? null;
    const previous = previousTag ? (contractAt(repoDir, previousTag) ?? "") : null;
    return {
      version: headTag,
      bump: "reuse",
      body: buildReleaseBody({
        previousContract: previous,
        currentContract: current,
        changes: changesSince(repoDir, previousTag),
      }),
    };
  }
  const latest = latestSemverTag(repoDir);
  const previous = latest ? (contractAt(repoDir, latest) ?? "") : null;
  const bump = classifyBump(previous, current);
  return {
    version: nextVersionFrom(latest, bump),
    bump,
    body: buildReleaseBody({
      previousContract: previous,
      currentContract: current,
      changes: changesSince(repoDir, latest),
    }),
  };
}

function repoRoot(cwd = process.cwd()): string {
  return git(["rev-parse", "--show-toplevel"], cwd);
}

interface GiteaTag {
  name?: string;
  commit?: { sha?: string };
  id?: string;
}

export async function publishRelease(opts: {
  serverUrl: string;
  token: string;
  owner: string;
  repo: string;
  sha: string;
  version: string;
  body: string;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}): Promise<{ tagCreated: boolean; releaseCreated: boolean }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = `${opts.serverUrl.replace(/\/+$/, "")}/api/v1/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}`;
  const headers = {
    Authorization: `token ${opts.token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  async function request(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text().catch(() => "");
    if (res.status === 403) {
      throw new Error(
        `Gitea API 403 ${method} ${path}. The default Actions token cannot write tags/releases. Do not add a PAT; fix token permissions.`
      );
    }
    return { status: res.status, text };
  }

  const existingTag = await request("GET", `/tags/${encodeURIComponent(opts.version)}`);
  let tagCreated = false;
  if (existingTag.status === 200) {
    const parsed = JSON.parse(existingTag.text) as GiteaTag;
    const sha = parsed.commit?.sha ?? parsed.id ?? "";
    if (sha && sha !== opts.sha) {
      throw new Error(`Refusing to move immutable tag ${opts.version} from ${sha} to ${opts.sha}`);
    }
  } else if (existingTag.status === 404) {
    const created = await request("POST", "/tags", {
      tag_name: opts.version,
      target: opts.sha,
      message: opts.version,
    });
    if (created.status !== 200 && created.status !== 201) {
      throw new Error(`Gitea API POST /tags → ${created.status}: ${created.text}`);
    }
    tagCreated = true;
  } else {
    throw new Error(`Gitea API GET /tags/${opts.version} → ${existingTag.status}: ${existingTag.text}`);
  }

  const existingRelease = await request("GET", `/releases/tags/${encodeURIComponent(opts.version)}`);
  let releaseCreated = false;
  if (existingRelease.status === 200) {
    return { tagCreated, releaseCreated };
  }
  if (existingRelease.status !== 404) {
    throw new Error(
      `Gitea API GET /releases/tags/${opts.version} → ${existingRelease.status}: ${existingRelease.text}`
    );
  }
  const createdRelease = await request("POST", "/releases", {
    tag_name: opts.version,
    target_commitish: opts.sha,
    name: opts.version,
    body: opts.body,
    draft: false,
    prerelease: false,
  });
  if (createdRelease.status !== 200 && createdRelease.status !== 201) {
    throw new Error(`Gitea API POST /releases → ${createdRelease.status}: ${createdRelease.text}`);
  }
  releaseCreated = true;
  return { tagCreated, releaseCreated };
}

async function main(args: string[]): Promise<void> {
  const command = args[0] ?? "next-version";
  const root = repoRoot();
  const plan = computeRelease(root);
  if (command === "next-version") {
    process.stdout.write(`${plan.version}\n`);
    return;
  }
  if (command === "release-body") {
    process.stdout.write(plan.body);
    return;
  }
  if (command === "skip-build") {
    process.stdout.write(
      `${shouldSkipImageBuild(process.env.REF_TYPE ?? process.env.GITHUB_REF_TYPE ?? "") ? "yes" : "no"}\n`
    );
    return;
  }
  if (command === "publish") {
    const token = process.env.GITHUB_TOKEN || process.env.GITEA_TOKEN;
    const repository = process.env.GITHUB_REPOSITORY;
    const serverUrl = process.env.GITHUB_SERVER_URL || process.env.GITEA_URL;
    const sha = process.env.GITHUB_SHA;
    if (!token) throw new Error("GITHUB_TOKEN is required to publish a release");
    if (!repository?.includes("/")) throw new Error("GITHUB_REPOSITORY is required");
    if (!serverUrl) throw new Error("GITHUB_SERVER_URL is required");
    if (!sha) throw new Error("GITHUB_SHA is required");
    const [owner, repo] = repository.split("/");
    const result = await publishRelease({
      serverUrl,
      token,
      owner,
      repo,
      sha,
      version: plan.version,
      body: plan.body,
    });
    console.log(
      `Published ${plan.version} bump=${plan.bump} tagCreated=${result.tagCreated} releaseCreated=${result.releaseCreated}`
    );
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
