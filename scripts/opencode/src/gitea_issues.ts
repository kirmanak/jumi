import type {
  GiteaActionJob,
  GiteaComment,
  GiteaCommitStatus,
  GiteaIssue,
  GiteaPR,
  GiteaPullReview,
  GiteaPullReviewComment,
  GiteaRepo,
} from "./types.ts";

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
  listIssueComments(owner: string, repo: string, index: number): Promise<GiteaComment[]>;
  listPullReviewComments(owner: string, repo: string, index: number): Promise<GiteaPullReviewComment[]>;
  listPullReviews(owner: string, repo: string, index: number): Promise<GiteaPullReview[]>;
  listCommitStatuses(owner: string, repo: string, sha: string): Promise<GiteaCommitStatus[]>;
  listActionJobs(owner: string, repo: string, opts?: { status?: string }): Promise<GiteaActionJob[]>;
  getActionJobLogs(owner: string, repo: string, jobId: number): Promise<string>;
}

export function workerMarker(owner: string, repo: string, issueNumber: number): string {
  return `<!-- jumi-worker:${owner}/${repo}#${issueNumber} -->`;
}

export function closesIssuePattern(issueNumber: number): RegExp {
  // Gitea DEFAULT_CLOSE_KEYWORDS: close, closes, closed, fix, fixes, fixed, resolve, resolves, resolved.
  return new RegExp(String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#${issueNumber}\b`, "i");
}

export const JUMI_ISSUE_BRANCH = /^jumi\/issue-(\d+)-/;

export function pullRequestClosesIssue(
  pr: { title: string; body?: string | null; state?: string },
  issueNumber: number
): boolean {
  if (pr.state && pr.state !== "open") return false;
  const pattern = closesIssuePattern(issueNumber);
  return pattern.test(pr.title) || pattern.test(pr.body ?? "");
}

export function jumiIssueBranchNumber(ref: string | undefined): number | undefined {
  if (!ref) return undefined;
  const match = ref.match(JUMI_ISSUE_BRANCH);
  if (!match) return undefined;
  return Number(match[1]);
}

export function extractClosingIssueNumbers(pr: {
  number?: number;
  title: string;
  body?: string | null;
  head?: { ref?: string };
}): number[] {
  const text = `${pr.title}\n${pr.body ?? ""}`;
  const pattern = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)\b/gi;
  const seen = new Set<number>();
  const result: number[] = [];

  const add = (value: number) => {
    if (!Number.isFinite(value) || value <= 0) return;
    if (pr.number !== undefined && value === pr.number) return;
    if (seen.has(value)) return;
    seen.add(value);
    result.push(value);
  };

  for (const match of text.matchAll(pattern)) {
    add(Number(match[1]));
  }

  const fromBranch = jumiIssueBranchNumber(pr.head?.ref);
  if (fromBranch !== undefined) add(fromBranch);

  return result;
}

export function extractClosingIssueNumber(pr: {
  title: string;
  body?: string | null;
  head?: { ref?: string };
}): number | undefined {
  const text = `${pr.title}\n${pr.body ?? ""}`;
  const pattern = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)\b/gi;
  const matches = [...text.matchAll(pattern)].map((match) => Number(match[1]));
  const fromBranch = jumiIssueBranchNumber(pr.head?.ref);
  if (fromBranch !== undefined) {
    return matches.find((n) => n === fromBranch);
  }
  const fromClose = matches[0];
  if (fromClose === undefined || !Number.isFinite(fromClose)) return undefined;
  return fromClose;
}

function loginEquals(login: string | undefined, botUsername: string): boolean {
  return typeof login === "string" && login.toLowerCase() === botUsername.toLowerCase();
}

export function isJumiPrIdentity(
  pr: { user?: { login?: string }; head?: { ref?: string } },
  botUsername: string
): boolean {
  if (loginEquals(pr.user?.login, botUsername)) return true;
  return jumiIssueBranchNumber(pr.head?.ref) !== undefined;
}

export function isWipOrDraft(pr: { title: string; draft?: boolean }): boolean {
  if (pr.draft === true) return true;
  return pr.title.trim().toLowerCase().startsWith("wip:");
}

export function isInScopeJumiPR(pr: GiteaPR, owner: string, repo: string, botUsername: string): boolean {
  if (pr.state !== "open" || pr.merged) return false;
  if (isWipOrDraft(pr)) return false;
  if (!isJumiPrIdentity(pr, botUsername)) return false;
  if (!pr.head?.repo || pr.head.repo.full_name !== `${owner}/${repo}`) return false;
  return extractClosingIssueNumber(pr) !== undefined;
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
    if (botUsername && !isJumiPrIdentity(pr, botUsername)) return false;
    return true;
  });
}

export async function findOpenJumiClosingPullRequest(
  api: Pick<IssueApi, "listOpenPulls">,
  owner: string,
  repo: string,
  issueNumber: number,
  botUsername: string
): Promise<GiteaPR | undefined> {
  const pulls = await api.listOpenPulls(owner, repo);
  return pulls.find(
    (pr) => isInScopeJumiPR(pr, owner, repo, botUsername) && extractClosingIssueNumber(pr) === issueNumber
  );
}

export async function upsertWorkerComment(
  api: IssueApi,
  owner: string,
  repo: string,
  issueNumber: number,
  botUsername: string,
  body: string,
  opts?: { index?: number }
): Promise<void> {
  const marker = workerMarker(owner, repo, issueNumber);
  const text = `${marker}\n${body}`;
  const index = opts?.index ?? issueNumber;
  const existing = await api.findStickyIssueComment(owner, repo, index, botUsername, marker);
  if (existing) {
    await api.updateIssueComment(owner, repo, existing.id, text);
    return;
  }
  await api.createIssueComment(owner, repo, index, text);
}
