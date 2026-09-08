import { isAssignedToBot } from "./assignee.ts";
import { extractClosingIssueNumber, type IssueApi, isAssignedForeignPR, isInScopeJumiPR } from "./gitea_issues.ts";
import type { GiteaPushPayload, IssueJob } from "./types.ts";
import type { WebhookPolicy } from "./webhook.ts";
import { assertRepositoryPolicy } from "./webhook.ts";

export type PushWebhookPolicy = WebhookPolicy & { botUsername: string };

export type PushWebhookDecision =
  | { type: "enqueue"; jobs: Omit<IssueJob, "delivery" | "receivedAt">[] }
  | { type: "skip"; reason: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Invalid webhook payload: missing ${name}`);
  return value;
}

function isZeroSha(value: string | undefined): boolean {
  if (!value) return true;
  return /^0+$/.test(value);
}

export function parsePushPayload(rawBody: Uint8Array): GiteaPushPayload {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBody));
  if (!isObject(parsed)) throw new Error("Invalid webhook payload: expected object");
  const repository = parsed.repository;
  if (!isObject(repository)) throw new Error("Invalid webhook payload: missing repository");
  requireString(parsed.ref, "ref");
  requireString(repository.full_name, "repository.full_name");
  requireString(repository.default_branch, "repository.default_branch");
  requireString(repository.clone_url, "repository.clone_url");
  return parsed as unknown as GiteaPushPayload;
}

function pushSender(payload: GiteaPushPayload): string {
  return payload.pusher?.login || payload.sender?.login || "push";
}

export async function shouldEnqueuePushConflicts(
  payload: GiteaPushPayload,
  policy: PushWebhookPolicy,
  api: Pick<IssueApi, "listOpenPulls" | "getIssue">
): Promise<PushWebhookDecision> {
  const defaultRef = `refs/heads/${payload.repository.default_branch}`;
  if (!payload.ref.startsWith("refs/heads/")) {
    return { type: "skip", reason: "not a branch ref" };
  }
  if (isZeroSha(payload.after)) {
    return { type: "skip", reason: "deleted ref" };
  }
  if (payload.ref !== defaultRef) {
    return { type: "skip", reason: "not the default branch" };
  }

  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = assertRepositoryPolicy(payload.repository, policy));
  } catch (err) {
    return { type: "skip", reason: err instanceof Error ? err.message : String(err) };
  }

  const pulls = await api.listOpenPulls(owner, repo);
  const jobs: Omit<IssueJob, "delivery" | "receivedAt">[] = [];
  const sender = pushSender(payload);

  for (const pr of pulls) {
    if (isAssignedForeignPR(pr, owner, repo, policy.botUsername)) {
      jobs.push({
        owner,
        repo,
        issueNumber: pr.number,
        action: "push",
        title: pr.title,
        body: pr.body ?? "",
        htmlUrl: pr.html_url,
        issueUpdatedAt: pr.updated_at,
        defaultBranch: payload.repository.default_branch,
        cloneUrl: payload.repository.clone_url,
        mode: "conflict",
        prNumber: pr.number,
        headSha: pr.head.sha,
        trigger: { event: "push", sender },
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
        action: "push",
        title: issue.title,
        body: issue.body ?? "",
        htmlUrl: issue.html_url,
        issueUpdatedAt: issue.updated_at,
        defaultBranch: payload.repository.default_branch,
        cloneUrl: payload.repository.clone_url,
        mode: "conflict",
        prNumber: pr.number,
        headSha: pr.head.sha,
        trigger: { event: "push", sender },
      });
    } catch (err) {
      if (err instanceof Error && /→ 404\b/.test(err.message)) continue;
      throw err;
    }
  }

  if (jobs.length === 0) return { type: "skip", reason: "no managed jumi PRs" };
  return { type: "enqueue", jobs };
}
