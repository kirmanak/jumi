import { isAssignedToBot } from "./assignee.ts";
import { extractClosingIssueNumber, type IssueApi, isAssignedForeignPR, isInScopeJumiPR } from "./gitea_issues.ts";
import type { GiteaWorkflowJobPayload, IssueJob } from "./types.ts";
import type { WebhookPolicy } from "./webhook.ts";
import { assertRepositoryPolicy } from "./webhook.ts";

export type CiWebhookPolicy = WebhookPolicy & { botUsername: string };

export type CiWebhookDecision =
  | { type: "enqueue"; jobs: Omit<IssueJob, "delivery" | "receivedAt">[] }
  | { type: "skip"; reason: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Invalid webhook payload: missing ${name}`);
  return value;
}

export function parseWorkflowJobPayload(rawBody: Uint8Array): GiteaWorkflowJobPayload {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBody));
  if (!isObject(parsed)) throw new Error("Invalid webhook payload: expected object");
  const repository = parsed.repository;
  if (!isObject(repository)) throw new Error("Invalid webhook payload: missing repository");
  requireString(repository.full_name, "repository.full_name");
  requireString(repository.default_branch, "repository.default_branch");
  requireString(repository.clone_url, "repository.clone_url");
  if (parsed.workflow_job != null && !isObject(parsed.workflow_job)) {
    throw new Error("Invalid webhook payload: missing workflow_job");
  }
  return parsed as unknown as GiteaWorkflowJobPayload;
}

function workflowJobSender(payload: GiteaWorkflowJobPayload): string {
  return payload.sender?.login || "workflow_job";
}

function jobHeadMatches(
  prSha: string,
  prRef: string,
  job: { head_sha?: string; head_branch?: string } | undefined
): boolean {
  if (!job) return false;
  const sha = (job.head_sha ?? "").toLowerCase();
  const branch = job.head_branch ?? "";
  if (sha && sha === prSha.toLowerCase()) return true;
  if (branch && branch === prRef) return true;
  return false;
}

export async function shouldEnqueueWorkflowJobFollowUp(
  payload: GiteaWorkflowJobPayload,
  policy: CiWebhookPolicy,
  api: Pick<IssueApi, "listOpenPulls" | "getIssue">
): Promise<CiWebhookDecision> {
  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = assertRepositoryPolicy(payload.repository, policy));
  } catch (err) {
    return { type: "skip", reason: err instanceof Error ? err.message : String(err) };
  }

  const job = payload.workflow_job;
  if (!job || (!job.head_sha && !job.head_branch)) {
    return { type: "skip", reason: "not an in-scope jumi pull request" };
  }

  const pulls = await api.listOpenPulls(owner, repo);
  const jobs: Omit<IssueJob, "delivery" | "receivedAt">[] = [];
  const sender = workflowJobSender(payload);

  for (const pr of pulls) {
    if (!jobHeadMatches(pr.head.sha, pr.head.ref, job)) continue;
    if (isAssignedForeignPR(pr, owner, repo, policy.botUsername)) {
      jobs.push({
        owner,
        repo,
        issueNumber: pr.number,
        action: payload.action || "completed",
        title: pr.title,
        body: pr.body ?? "",
        htmlUrl: pr.html_url,
        issueUpdatedAt: pr.updated_at,
        defaultBranch: payload.repository.default_branch,
        cloneUrl: payload.repository.clone_url,
        mode: "follow-up",
        prNumber: pr.number,
        headSha: pr.head.sha,
        trigger: { event: "workflow_job", sender },
      });
      continue;
    }
    if (!isInScopeJumiPR(pr, owner, repo, policy.botUsername)) continue;
    const issueNumber = extractClosingIssueNumber(pr);
    if (issueNumber === undefined) continue;
    try {
      const issue = await api.getIssue(owner, repo, issueNumber);
      if (issue.state !== "open" || !isAssignedToBot(issue, policy.botUsername)) continue;
      jobs.push({
        owner,
        repo,
        issueNumber,
        action: payload.action || "completed",
        title: issue.title,
        body: issue.body ?? "",
        htmlUrl: issue.html_url,
        issueUpdatedAt: issue.updated_at,
        defaultBranch: payload.repository.default_branch,
        cloneUrl: payload.repository.clone_url,
        mode: "follow-up",
        prNumber: pr.number,
        headSha: pr.head.sha,
        trigger: { event: "workflow_job", sender },
      });
    } catch (err) {
      if (err instanceof Error && /→ 404\b/.test(err.message)) continue;
      throw err;
    }
  }

  if (jobs.length === 0) return { type: "skip", reason: "not an in-scope jumi pull request" };
  return { type: "enqueue", jobs };
}
