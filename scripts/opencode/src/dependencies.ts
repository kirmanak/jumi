import { pullRequestClosesIssue } from "./gitea_issues.ts";
import type { LinkedIssue, Pull } from "./ports.ts";

export const DEPENDENCY_GRAPH_CAP = 32;
export const DEPENDENCY_CYCLE_REASON = "stuck: dependency cycle";

export type BlockerCheck =
  | { status: "ready" }
  | { status: "blocked"; blockers: LinkedIssue[] }
  | { status: "stuck"; reason: string };

function issueKey(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${number}`;
}

export function formatIssueRef(
  issue: { owner: string; repo: string; number: number },
  homeOwner: string,
  homeRepo: string
): string {
  if (issue.owner === homeOwner && issue.repo === homeRepo) return `#${issue.number}`;
  return `${issue.owner}/${issue.repo}#${issue.number}`;
}

export function blockedOnComment(
  blockers: readonly { owner: string; repo: string; number: number }[],
  homeOwner: string,
  homeRepo: string
): string {
  const refs = [...blockers]
    .sort((a, b) => {
      const ownerCmp = a.owner.localeCompare(b.owner);
      if (ownerCmp !== 0) return ownerCmp;
      const repoCmp = a.repo.localeCompare(b.repo);
      if (repoCmp !== 0) return repoCmp;
      return a.number - b.number;
    })
    .map((issue) => formatIssueRef(issue, homeOwner, homeRepo));
  return `blocked on ${refs.join(", ")}`;
}

type OpenPullsApi = {
  listOpenPulls(owner: string, repo: string): Promise<Pull[]>;
};

async function cachedOpenPulls(
  api: OpenPullsApi,
  cache: Map<string, Pull[]>,
  owner: string,
  repo: string
): Promise<Pull[]> {
  const key = `${owner}/${repo}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const pulls = await api.listOpenPulls(owner, repo);
  cache.set(key, pulls);
  return pulls;
}

export async function isBlockerUnresolved(
  issue: LinkedIssue,
  api: OpenPullsApi,
  cache: Map<string, Pull[]> = new Map()
): Promise<boolean> {
  if (issue.state === "open") return true;
  const pulls = await cachedOpenPulls(api, cache, issue.owner, issue.repo);
  return pulls.some((pr) => pullRequestClosesIssue(pr, issue.number));
}

export async function checkIssueBlockers(
  api: {
    listIssueDependencies(owner: string, repo: string, index: number): Promise<LinkedIssue[]>;
    listOpenPulls(owner: string, repo: string): Promise<Pull[]>;
  },
  owner: string,
  repo: string,
  issueNumber: number
): Promise<BlockerCheck> {
  const seen = new Set<string>();
  const stack = new Set<string>();
  const unresolved = new Map<string, LinkedIssue>();
  const pullsCache = new Map<string, Pull[]>();

  const walk = async (curOwner: string, curRepo: string, number: number): Promise<"ok" | "cycle" | "cap"> => {
    const key = issueKey(curOwner, curRepo, number);
    if (stack.has(key)) return "cycle";
    if (seen.has(key)) return "ok";
    if (seen.size >= DEPENDENCY_GRAPH_CAP) return "cap";
    seen.add(key);
    stack.add(key);
    const deps = await api.listIssueDependencies(curOwner, curRepo, number);
    for (const dep of deps) {
      const child = await walk(dep.owner, dep.repo, dep.number);
      if (child !== "ok") {
        stack.delete(key);
        return child;
      }
      if (await isBlockerUnresolved(dep, api, pullsCache)) {
        unresolved.set(issueKey(dep.owner, dep.repo, dep.number), dep);
      }
    }
    stack.delete(key);
    return "ok";
  };

  const result = await walk(owner, repo, issueNumber);
  if (result === "cycle" || result === "cap") return { status: "stuck", reason: DEPENDENCY_CYCLE_REASON };
  if (unresolved.size === 0) return { status: "ready" };
  return { status: "blocked", blockers: [...unresolved.values()] };
}
