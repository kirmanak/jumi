import type { GiteaComment, GiteaIssue, GiteaPR, GiteaRepo } from "./types.ts";

export interface IssueApi {
  getRepo(owner: string, repo: string): Promise<GiteaRepo>;
  getIssue(owner: string, repo: string, index: number): Promise<GiteaIssue>;
  listOpenPulls(owner: string, repo: string): Promise<GiteaPR[]>;
  createPullRequest(
    owner: string,
    repo: string,
    pull: { title: string; body: string; head: string; base: string }
  ): Promise<GiteaPR>;
  searchAssignedIssues(): Promise<GiteaIssue[]>;
  findStickyIssueComment(
    owner: string,
    repo: string,
    index: number,
    botUsername: string,
    marker: string
  ): Promise<{ id: number } | undefined>;
  createIssueComment(owner: string, repo: string, index: number, body: string): Promise<GiteaComment>;
  updateIssueComment(owner: string, repo: string, commentId: number, body: string): Promise<GiteaComment>;
}

export function workerMarker(owner: string, repo: string, issueNumber: number): string {
  return `<!-- jumi-worker:${owner}/${repo}#${issueNumber} -->`;
}

export function closesIssuePattern(issueNumber: number): RegExp {
  // Gitea DEFAULT_CLOSE_KEYWORDS: close, closes, closed, fix, fixes, fixed, resolve, resolves, resolved.
  return new RegExp(String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#${issueNumber}\b`, "i");
}

export function pullRequestClosesIssue(
  pr: { title: string; body?: string | null; state?: string },
  issueNumber: number
): boolean {
  if (pr.state && pr.state !== "open") return false;
  const pattern = closesIssuePattern(issueNumber);
  return pattern.test(pr.title) || pattern.test(pr.body ?? "");
}

export async function findOpenClosingPullRequest(
  api: Pick<IssueApi, "listOpenPulls">,
  owner: string,
  repo: string,
  issueNumber: number,
  botUsername?: string
): Promise<GiteaPR | undefined> {
  const pulls = await api.listOpenPulls(owner, repo);
  return pulls.find((pr) => {
    if (!pullRequestClosesIssue(pr, issueNumber)) return false;
    if (botUsername && pr.user?.login !== botUsername) return false;
    return true;
  });
}

export async function upsertWorkerComment(
  api: IssueApi,
  owner: string,
  repo: string,
  issueNumber: number,
  botUsername: string,
  body: string
): Promise<void> {
  const marker = workerMarker(owner, repo, issueNumber);
  const text = `${marker}\n${body}`;
  const existing = await api.findStickyIssueComment(owner, repo, issueNumber, botUsername, marker);
  if (existing) {
    await api.updateIssueComment(owner, repo, existing.id, text);
    return;
  }
  await api.createIssueComment(owner, repo, issueNumber, text);
}
