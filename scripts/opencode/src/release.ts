import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CONTRACT_PATH = "deploy/contract.md";
export const REVIEWER_LOADER_PATH = "scripts/opencode/src/config.ts";
export const WORKER_LOADER_PATH = "scripts/opencode/src/worker_config.ts";
const SEMVER_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
/** `helper(env, <ref>)` where `<ref>` is a literal, a const identifier, or a const map property. */
const LOADER_ENV_HELPER_RE = /\b(requireEnv|requirePem|optionalEnv|intEnv|csvEnv)\(\s*\w+\s*,\s*([^,)]+)/g;
const LOADER_ENV_PROP_RE = /\b(?:resolved|env)\.([A-Z][A-Z0-9_]*)\b/g;
const LOADER_ENV_INDEX_RE = /\b(?:resolved|env)\[\s*([^\]]+?)\s*\]/g;
/** Helpers that throw when the variable is unset. */
const REQUIRING_HELPERS = new Set(["requireEnv", "requirePem"]);
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const CONST_ENV_NAME_RE = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*"([A-Za-z_][A-Za-z0-9_]*)"/g;
const CONST_ENV_MAP_RE = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*\{([^}]*)\}/g;
const CONST_ENV_MAP_ENTRY_RE = /([A-Za-z_$][\w$]*)\s*:\s*"([A-Za-z_][A-Za-z0-9_]*)"/g;
/** Shared forge bind the worker loader delegates to; its env belongs to both images. */
const FORGE_BIND_FN = "loadForgeBind";
/** `if (forge === "github") { ... }`: everything inside is required only when `FORGE=github`. */
const FORGE_GITHUB_IF_RE = /\bif\s*\(\s*(?:\w+\.)?forge\s*===\s*"github"\s*\)\s*\{/g;

export type BumpKind = "major" | "minor" | "patch" | "initial";
export type VersionDecision = BumpKind | "reuse";
export type ImageName = "reviewer" | "worker";

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

export interface ImageContract {
  /** Loader fails process start when unset under the default `FORGE` (`requireEnv` / `requirePem`). */
  requiredEnv: string[];
  /** GitOps must set it, but the loader tolerates unset (local/dev mode, or another `FORGE`). */
  gitOpsEnv: string[];
  optionalEnv: string[];
  ports: string[];
  runAs: string;
  probes: string[];
  command: string;
  imageTarget: string;
  volumes: string[];
}

export type ContractEnvIssueKind =
  | "missing"
  | "extra"
  | "required_as_optional"
  | "optional_as_required"
  | "forge_conditional_as_required"
  | "forge_conditional_as_optional"
  | "duplicate";

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
    gitOpsEnv: [],
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
    gitOpsEnv: listValues(headingSection(section, 4, "gitops env")),
    optionalEnv: listValues(headingSection(section, 4, "optional env")),
    ports: listValues(headingSection(section, 4, "ports")),
    runAs: firstValue(listValues(headingSection(section, 4, "runAs"))),
    probes: listValues(headingSection(section, 4, "probes")),
    command: firstValue(listValues(headingSection(section, 4, "command"))),
    imageTarget: firstValue(listValues(headingSection(section, 4, "image target"))),
    volumes: listValues(headingSection(section, 4, "volumes")),
  };
}

/** Env names behind constants: `const X = "NAME"` and `const M = { key: "NAME" }` (`M.key`). */
function constEnvNames(source: string): Map<string, string> {
  const consts = new Map<string, string>();
  for (const match of source.matchAll(CONST_ENV_NAME_RE)) {
    if (ENV_NAME_RE.test(match[2])) consts.set(match[1], match[2]);
  }
  for (const match of source.matchAll(CONST_ENV_MAP_RE)) {
    for (const entry of match[2].matchAll(CONST_ENV_MAP_ENTRY_RE)) {
      if (ENV_NAME_RE.test(entry[2])) consts.set(`${match[1]}.${entry[1]}`, entry[2]);
    }
  }
  return consts;
}

/** `null` for refs with no env name behind them: helper definitions (`env[name]`), computed keys. */
function resolveEnvRef(ref: string, consts: Map<string, string>): string | null {
  const trimmed = ref.trim();
  const literal = /^"([A-Za-z_][A-Za-z0-9_]*)"$/.exec(trimmed);
  if (literal) return ENV_NAME_RE.test(literal[1]) ? literal[1] : null;
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?$/.test(trimmed)) return consts.get(trimmed) ?? null;
  return null;
}

function matchingBrace(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

/** Text of `function <name>(...) { ... }`, or `""` when the source does not declare it. */
function functionBlock(source: string, name: string): string {
  const decl = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  if (!decl) return "";
  let cursor = decl.index + decl[0].length - 1;
  let depth = 0;
  for (; cursor < source.length; cursor++) {
    if (source[cursor] === "(") depth++;
    else if (source[cursor] === ")" && --depth === 0) break;
  }
  const open = source.indexOf("{", cursor);
  if (open < 0) return "";
  const end = matchingBrace(source, open);
  return end < 0 ? "" : source.slice(decl.index, end + 1);
}

/** A loader that calls the shared forge bind reads its env too, even across files. */
function withSharedForgeBind(source: string, shared: string): string {
  if (!new RegExp(`\\b${FORGE_BIND_FN}\\s*\\(`).test(source)) return source;
  if (new RegExp(`function\\s+${FORGE_BIND_FN}\\b`).test(source)) return source;
  const block = functionBlock(shared, FORGE_BIND_FN);
  return block ? `${source}\n${block}` : source;
}

function forgeGithubRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const match of source.matchAll(FORGE_GITHUB_IF_RE)) {
    const open = match.index + match[0].length - 1;
    const end = matchingBrace(source, open);
    if (end > open) ranges.push([open, end]);
  }
  return ranges;
}

interface EnvRead {
  name: string;
  /** The read throws when the variable is unset. */
  requiring: boolean;
  index: number;
}

function envReads(source: string, consts: Map<string, string>): EnvRead[] {
  const reads: EnvRead[] = [];
  for (const match of source.matchAll(LOADER_ENV_HELPER_RE)) {
    const name = resolveEnvRef(match[2], consts);
    if (name) reads.push({ name, requiring: REQUIRING_HELPERS.has(match[1]), index: match.index });
  }
  for (const match of source.matchAll(LOADER_ENV_PROP_RE)) {
    reads.push({ name: match[1], requiring: false, index: match.index });
  }
  for (const match of source.matchAll(LOADER_ENV_INDEX_RE)) {
    const name = resolveEnvRef(match[1], consts);
    if (name) reads.push({ name, requiring: false, index: match.index });
  }
  return reads;
}

/** `sharedSource` holds helpers the loader imports (the reviewer loader for the worker). */
export function loaderEnvNames(source: string, sharedSource = ""): string[] {
  const consts = constEnvNames(`${source}\n${sharedSource}`);
  const names = new Set(envReads(withSharedForgeBind(source, sharedSource), consts).map((read) => read.name));
  return [...names].sort();
}

/**
 * Process-start env as the loader sees it: `requireEnv`/`requirePem` → required, the same call
 * reached only under `FORGE=github` → gitOps (forge-conditional), every other read → optional.
 */
export function gitOpsLoaderEnv(
  source: string,
  sharedSource = ""
): { required: string[]; gitOps: string[]; optional: string[] } {
  const scanned = withSharedForgeBind(source, sharedSource);
  const consts = constEnvNames(`${source}\n${sharedSource}`);
  const reads = envReads(scanned, consts);
  const ranges = forgeGithubRanges(scanned);
  const forgeOnly = (index: number): boolean => ranges.some(([start, end]) => index > start && index < end);
  const required: string[] = [];
  const gitOps: string[] = [];
  const optional: string[] = [];
  for (const name of [...new Set(reads.map((read) => read.name))].sort()) {
    const requiring = reads.filter((read) => read.name === name && read.requiring);
    if (requiring.some((read) => !forgeOnly(read.index))) required.push(name);
    else if (requiring.length > 0) gitOps.push(name);
    else optional.push(name);
  }
  return { required, gitOps, optional };
}

export function formatContractEnvIssue(issue: ContractEnvIssue): string {
  if (issue.kind === "missing") {
    return `${issue.image} loader env \`${issue.name}\` is missing from deploy/contract.md required/gitops/optional env`;
  }
  if (issue.kind === "extra") {
    return `${issue.image} contract env \`${issue.name}\` is not read by the loader`;
  }
  if (issue.kind === "required_as_optional") {
    return `${issue.image} env \`${issue.name}\` fails process start when unset but is not listed as required env`;
  }
  if (issue.kind === "optional_as_required") {
    return `${issue.image} env \`${issue.name}\` does not fail process start when unset but is listed as required env (use gitops env if GitOps must set it)`;
  }
  if (issue.kind === "forge_conditional_as_required") {
    return `${issue.image} env \`${issue.name}\` only fails process start when \`FORGE=github\` but is listed as required env (use gitops env)`;
  }
  if (issue.kind === "forge_conditional_as_optional") {
    return `${issue.image} env \`${issue.name}\` fails process start when \`FORGE=github\` but is listed as optional env (use gitops env)`;
  }
  return `${issue.image} env \`${issue.name}\` is listed under more than one of required/gitops/optional env`;
}

export function contractEnvIssues(
  contract: DeployContract,
  reviewerSrc: string,
  workerSrc: string
): ContractEnvIssue[] {
  const issues: ContractEnvIssue[] = [];
  for (const image of ["reviewer", "worker"] as const) {
    const expected = image === "reviewer" ? gitOpsLoaderEnv(reviewerSrc) : gitOpsLoaderEnv(workerSrc, reviewerSrc);
    const listedRequired = contract[image].requiredEnv;
    const listedGitOps = contract[image].gitOpsEnv;
    const listedOptional = contract[image].optionalEnv;
    const requiredSet = new Set(listedRequired);
    const gitOpsSet = new Set(listedGitOps);
    const optionalSet = new Set([...listedGitOps, ...listedOptional]);
    const listed = new Set([...listedRequired, ...listedGitOps, ...listedOptional]);
    const expectedNames = new Set([...expected.required, ...expected.gitOps, ...expected.optional]);
    const seen = new Set<string>();
    for (const name of [...listedRequired, ...listedGitOps, ...listedOptional]) {
      if (seen.has(name)) issues.push({ image, name, kind: "duplicate" });
      seen.add(name);
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
    for (const name of expected.gitOps) {
      if (!listed.has(name) || gitOpsSet.has(name)) continue;
      issues.push({
        image,
        name,
        kind: requiredSet.has(name) ? "forge_conditional_as_required" : "forge_conditional_as_optional",
      });
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

/** Env GitOps must set: fails process start (`required env`) or chart-only (`gitops env`). */
function gitOpsRequiredEnv(image: ImageContract): string[] {
  return [...image.requiredEnv, ...image.gitOpsEnv];
}

export function removedRequiredFields(previous: ImageContract, current: ImageContract): string[] {
  const removed: string[] = [];
  for (const key of removedItems(gitOpsRequiredEnv(previous), gitOpsRequiredEnv(current))) {
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
    addedItems(gitOpsRequiredEnv(previous), gitOpsRequiredEnv(current)).length > 0 ||
    removedItems(gitOpsRequiredEnv(previous), gitOpsRequiredEnv(current)).length > 0 ||
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

function requiresEnvBullet(current: ImageContract, key: string): string {
  if (current.requiredEnv.includes(key)) {
    return `- **requires** \`${key}\` (new; missing → crash)`;
  }
  return `- **requires** \`${key}\` (new; GitOps must set; unset → local/dev, no crash)`;
}

function gitOpsBullets(previous: ImageContract, current: ImageContract): string[] {
  const bullets: string[] = [];
  const prevGitOps = gitOpsRequiredEnv(previous);
  const nextGitOps = gitOpsRequiredEnv(current);
  for (const key of addedItems(prevGitOps, nextGitOps)) {
    bullets.push(requiresEnvBullet(current, key));
  }
  for (const key of removedItems(prevGitOps, nextGitOps)) {
    bullets.push(`- **removed** \`${key}\` (was required)`);
  }
  for (const key of addedItems(previous.requiredEnv, current.requiredEnv)) {
    if (previous.gitOpsEnv.includes(key)) {
      bullets.push(`- **process start** \`${key}\` now fails when unset (was GitOps-only)`);
    }
  }
  for (const key of addedItems(previous.gitOpsEnv, current.gitOpsEnv)) {
    if (previous.requiredEnv.includes(key)) {
      bullets.push(`- **process start** \`${key}\` no longer fails when unset (GitOps must still set it)`);
    }
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
  for (const key of addedItems(previous.optionalEnv, current.optionalEnv)) {
    bullets.push(`- **optional env** \`${key}\` (new)`);
  }
  for (const key of removedItems(previous.optionalEnv, current.optionalEnv)) {
    bullets.push(`- **removed optional env** \`${key}\``);
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
  const reviewer = gitOpsBullets(previous.reviewer, current.reviewer);
  const worker = gitOpsBullets(previous.worker, current.worker);
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

interface GitHubRefObject {
  sha?: string;
  type?: string;
  url?: string;
}

interface GitHubRef {
  ref?: string;
  object?: GitHubRefObject;
}

interface GitHubTagObject {
  sha?: string;
  tag?: string;
  object?: GitHubRefObject;
}

export function touchesGitHubWorkflows(repoDir: string, sha = "HEAD"): boolean {
  const out =
    gitAllowFail(
      ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha, "--", ".github/workflows"],
      repoDir
    ) ?? "";
  return (
    out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean).length > 0
  );
}

export function advertisedNextVersion(repoDir: string, sha = "HEAD"): string | null {
  const plan = computeRelease(repoDir);
  if (plan.bump !== "reuse" && touchesGitHubWorkflows(repoDir, sha)) {
    return null;
  }
  return plan.version;
}

export function peeledCommitForTag(repoDir: string, tag: string): string | null {
  const out = gitAllowFail(["rev-parse", `${tag}^{commit}`], repoDir);
  const sha = out?.trim() ?? "";
  return sha || null;
}

function changesBetween(repoDir: string, fromTag: string | null, toRef: string): string[] {
  const out = fromTag
    ? (gitAllowFail(["log", "--oneline", `${fromTag}..${toRef}`], repoDir) ?? "")
    : (gitAllowFail(["log", "--oneline", "-1", toRef], repoDir) ?? "");
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function releaseBodyForTag(repoDir: string, tag: string): string {
  const tags = listSemverTags(repoDir);
  const idx = tags.indexOf(tag);
  const previousTag = idx > 0 ? tags[idx - 1] : null;
  const previousContract = previousTag ? (contractAt(repoDir, previousTag) ?? "") : null;
  const current = contractAt(repoDir, tag) ?? "";
  return buildReleaseBody({
    previousContract: previousContract,
    currentContract: current,
    changes: changesBetween(repoDir, previousTag, tag),
  });
}

export async function publishGitHubRelease(opts: {
  apiUrl: string;
  token: string;
  owner: string;
  repo: string;
  sha: string;
  version: string;
  body: string;
  makeLatest?: boolean;
  skipMissingRelease?: boolean;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}): Promise<{ tagCreated: boolean; releaseCreated: boolean }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = `${opts.apiUrl.replace(/\/+$/, "")}/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}`;
  const headers = {
    Authorization: `Bearer ${opts.token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "jumi",
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
        `GitHub API 403 ${method} ${path}. The default Actions token cannot write tags/releases. Do not add a PAT; fix token permissions.`
      );
    }
    return { status: res.status, text };
  }

  async function peeledCommit(refSha: string, refType: string): Promise<string> {
    if (refType !== "tag") return refSha;
    const tagObj = await request("GET", `/git/tags/${refSha}`);
    if (tagObj.status !== 200) {
      throw new Error(`GitHub API GET /git/tags/${refSha} → ${tagObj.status}: ${tagObj.text}`);
    }
    const parsed = JSON.parse(tagObj.text) as GitHubTagObject;
    const peeled = parsed.object?.sha ?? "";
    if (!peeled) throw new Error(`GitHub tag object ${refSha} is missing peeled commit`);
    return peeled;
  }

  const refPath = `/git/ref/tags/${encodeURIComponent(opts.version)}`;
  const existingRef = await request("GET", refPath);
  let tagCreated = false;
  if (existingRef.status === 200) {
    const parsed = JSON.parse(existingRef.text) as GitHubRef;
    const refSha = parsed.object?.sha ?? "";
    const refType = parsed.object?.type ?? "";
    if (!refSha) throw new Error(`GitHub ref tags/${opts.version} is missing object sha`);
    const peeled = await peeledCommit(refSha, refType);
    if (peeled !== opts.sha) {
      throw new Error(`Refusing to move immutable tag ${opts.version} from ${peeled} to ${opts.sha}`);
    }
  } else if (existingRef.status === 404) {
    const tagObj = await request("POST", "/git/tags", {
      tag: opts.version,
      message: opts.version,
      object: opts.sha,
      type: "commit",
    });
    if (tagObj.status !== 200 && tagObj.status !== 201) {
      throw new Error(`GitHub API POST /git/tags → ${tagObj.status}: ${tagObj.text}`);
    }
    const parsedTag = JSON.parse(tagObj.text) as { sha?: string };
    const tagObjectSha = parsedTag.sha ?? "";
    if (!tagObjectSha) throw new Error("GitHub API POST /git/tags did not return a tag object sha");
    const ref = await request("POST", "/git/refs", {
      ref: `refs/tags/${opts.version}`,
      sha: tagObjectSha,
    });
    if (ref.status === 200 || ref.status === 201) {
      tagCreated = true;
    } else if (ref.status === 422) {
      const retry = await request("GET", refPath);
      if (retry.status !== 200) {
        throw new Error(`GitHub API POST /git/refs → ${ref.status}: ${ref.text}`);
      }
      const reparsed = JSON.parse(retry.text) as GitHubRef;
      const retrySha = reparsed.object?.sha ?? "";
      const retryType = reparsed.object?.type ?? "";
      if (!retrySha) throw new Error(`GitHub ref tags/${opts.version} is missing object sha`);
      const peeled = await peeledCommit(retrySha, retryType);
      if (peeled !== opts.sha) {
        throw new Error(`Refusing to move immutable tag ${opts.version} from ${peeled} to ${opts.sha}`);
      }
    } else {
      throw new Error(`GitHub API POST /git/refs → ${ref.status}: ${ref.text}`);
    }
  } else {
    throw new Error(`GitHub API GET ${refPath} → ${existingRef.status}: ${existingRef.text}`);
  }

  const existingRelease = await request("GET", `/releases/tags/${encodeURIComponent(opts.version)}`);
  if (existingRelease.status === 200) {
    return { tagCreated, releaseCreated: false };
  }
  if (existingRelease.status !== 404) {
    throw new Error(
      `GitHub API GET /releases/tags/${opts.version} → ${existingRelease.status}: ${existingRelease.text}`
    );
  }
  const createdRelease = await request("POST", "/releases", {
    tag_name: opts.version,
    ...(tagCreated ? { target_commitish: opts.sha } : {}),
    name: opts.version,
    body: opts.body,
    draft: false,
    prerelease: false,
    generate_release_notes: false,
    make_latest: opts.makeLatest === false ? "false" : "true",
  });
  if (createdRelease.status === 404 && opts.skipMissingRelease) {
    return { tagCreated, releaseCreated: false };
  }
  if (createdRelease.status !== 200 && createdRelease.status !== 201) {
    throw new Error(`GitHub API POST /releases → ${createdRelease.status}: ${createdRelease.text}`);
  }
  return { tagCreated, releaseCreated: true };
}

export async function runPublishGitHub(opts: {
  repoDir: string;
  apiUrl: string;
  token: string;
  owner: string;
  repo: string;
  sha: string;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}): Promise<void> {
  const { repoDir: root, apiUrl, token, owner, repo, sha, fetchImpl } = opts;
  const plan = computeRelease(root);
  const latest = latestSemverTag(root);
  if (plan.bump === "reuse") {
    const result = await publishGitHubRelease({
      apiUrl,
      token,
      owner,
      repo,
      sha,
      version: plan.version,
      body: plan.body,
      fetchImpl,
    });
    console.log(
      `Published ${plan.version} bump=reuse tagCreated=${result.tagCreated} releaseCreated=${result.releaseCreated}`
    );
    const older = listSemverTags(root).filter((tag) => tag !== plan.version);
    const previousLatest = older.at(-1) ?? null;
    if (previousLatest && previousLatest !== plan.version) {
      const tagCommit = peeledCommitForTag(root, previousLatest);
      if (tagCommit) {
        const backfill = await publishGitHubRelease({
          apiUrl,
          token,
          owner,
          repo,
          sha: tagCommit,
          version: previousLatest,
          body: releaseBodyForTag(root, previousLatest),
          makeLatest: false,
          skipMissingRelease: true,
          fetchImpl,
        });
        console.log(
          `Backfilled ${previousLatest} tagCreated=${backfill.tagCreated} releaseCreated=${backfill.releaseCreated}`
        );
      }
    }
    return;
  }
  if (touchesGitHubWorkflows(root, sha)) {
    console.log(
      `Skipping new version ${plan.version} on ${sha} because it touches .github/workflows; backfilling latest tag if needed`
    );
    if (latest) {
      const tagCommit = peeledCommitForTag(root, latest);
      if (tagCommit) {
        const backfill = await publishGitHubRelease({
          apiUrl,
          token,
          owner,
          repo,
          sha: tagCommit,
          version: latest,
          body: releaseBodyForTag(root, latest),
          fetchImpl,
        });
        console.log(`Backfilled ${latest} tagCreated=${backfill.tagCreated} releaseCreated=${backfill.releaseCreated}`);
      }
    }
    return;
  }
  const result = await publishGitHubRelease({
    apiUrl,
    token,
    owner,
    repo,
    sha,
    version: plan.version,
    body: plan.body,
    fetchImpl,
  });
  console.log(
    `Published ${plan.version} bump=${plan.bump} tagCreated=${result.tagCreated} releaseCreated=${result.releaseCreated}`
  );
  if (latest && latest !== plan.version) {
    const tagCommit = peeledCommitForTag(root, latest);
    if (tagCommit) {
      const backfill = await publishGitHubRelease({
        apiUrl,
        token,
        owner,
        repo,
        sha: tagCommit,
        version: latest,
        body: releaseBodyForTag(root, latest),
        makeLatest: false,
        fetchImpl,
      });
      console.log(`Backfilled ${latest} tagCreated=${backfill.tagCreated} releaseCreated=${backfill.releaseCreated}`);
    }
  }
}

async function main(args: string[]): Promise<void> {
  const command = args[0] ?? "next-version";
  const root = repoRoot();
  const plan = computeRelease(root);
  if (command === "next-version") {
    const version = advertisedNextVersion(root);
    process.stdout.write(`${version ?? ""}\n`);
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
  if (command === "publish-github") {
    const token = process.env.GITHUB_TOKEN;
    const repository = process.env.GITHUB_REPOSITORY;
    const apiUrl = process.env.GITHUB_API_URL || "https://api.github.com";
    const sha = process.env.GITHUB_SHA;
    if (!token) throw new Error("GITHUB_TOKEN is required to publish a release");
    if (!repository?.includes("/")) throw new Error("GITHUB_REPOSITORY is required");
    if (!sha) throw new Error("GITHUB_SHA is required");
    const [owner, repo] = repository.split("/");
    await runPublishGitHub({ repoDir: root, apiUrl, token, owner, repo, sha });
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
