import { isAssignedToBot } from "./assignee.ts";
import { MAX_FOLLOWUP_ROUNDS } from "./followup.ts";
import { extractClosingIssueNumber } from "./gitea_issues.ts";
import type { EnqueueResult } from "./queue.ts";
import type { ReviewApi, ReviewResult } from "./review.ts";
import type { ReviewJobRecord, ReviewJobStore } from "./review_jobs.ts";
import type { GiteaIssue, GiteaPR, GiteaRepo, IssueJob } from "./types.ts";
import { parseReviewOutput } from "./verdict.ts";

export function isCurrentHeadFailureTrailer(markdown: string | null | undefined): boolean {
  if (!markdown) return false;
  const parsed = parseReviewOutput(markdown);
  return !parsed.verdict.incomplete && parsed.verdict.state === "failure";
}

export function shouldHandoverFollowUp(opts: { published: ReviewResult; markdown?: string | null }): boolean {
  if (opts.published.status !== "posted" && opts.published.status !== "updated") return false;
  return isCurrentHeadFailureTrailer(opts.markdown);
}

function followUpJobFrom(
  owner: string,
  repo: string,
  issue: GiteaIssue,
  pr: GiteaPR,
  repository: Pick<GiteaRepo, "default_branch" | "clone_url">,
  delivery: string
): IssueJob {
  return {
    delivery,
    owner,
    repo,
    issueNumber: issue.number,
    action: "review-failure",
    title: issue.title,
    body: issue.body ?? "",
    htmlUrl: issue.html_url,
    issueUpdatedAt: issue.updated_at,
    defaultBranch: repository.default_branch,
    cloneUrl: repository.clone_url,
    receivedAt: new Date().toISOString(),
    mode: "follow-up",
    prNumber: pr.number,
    headSha: pr.head.sha,
    trigger: { event: "review-failure", sender: "jumi" },
  };
}

export async function enqueueFollowUpFromReview(opts: {
  store: ReviewJobStore;
  api: Pick<ReviewApi, "getPR" | "getIssue" | "getRepo">;
  row: ReviewJobRecord;
  botUsername: string;
  published: ReviewResult;
  markdown?: string | null;
  maxFollowupRounds?: number;
}): Promise<EnqueueResult | undefined> {
  if (!shouldHandoverFollowUp({ published: opts.published, markdown: opts.markdown })) return undefined;

  const pr = await opts.api.getPR(opts.row.owner, opts.row.repo, opts.row.prNumber);
  if (pr.head.sha !== opts.row.headSha) return undefined;

  const issueNumber = extractClosingIssueNumber(pr);
  if (issueNumber === undefined) return undefined;

  const [issue, repo] = await Promise.all([
    opts.api.getIssue(opts.row.owner, opts.row.repo, issueNumber),
    opts.api.getRepo(opts.row.owner, opts.row.repo),
  ]);
  if (issue.state !== "open" || !isAssignedToBot(issue, opts.botUsername)) return undefined;

  const followUpSucceeded = await opts.store.countSucceeded("follow-up", opts.row.owner, opts.row.repo, issueNumber);
  if (followUpSucceeded >= (opts.maxFollowupRounds ?? MAX_FOLLOWUP_ROUNDS)) return undefined;

  return opts.store.enqueueIssue(
    followUpJobFrom(opts.row.owner, opts.row.repo, issue, pr, repo, `review-failure-${opts.row.id}`)
  );
}
