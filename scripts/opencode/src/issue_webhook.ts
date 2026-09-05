import { isAssignedToBot, isPullRequestIssue } from "./assignee.ts";
import type { GiteaIssue, GiteaIssuePayload, IssueJob } from "./types.ts";
import type { WebhookPolicy } from "./webhook.ts";
import { assertRepositoryPolicy } from "./webhook.ts";

const ENQUEUE_ACTIONS = new Set(["assigned", "opened", "reopened"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Invalid webhook payload: missing ${name}`);
  return value;
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid webhook payload: missing ${name}`);
  }
  return value;
}

export function parseIssuesPayload(rawBody: Uint8Array): GiteaIssuePayload {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBody));
  if (!isObject(parsed)) throw new Error("Invalid webhook payload: expected object");
  const repository = parsed.repository;
  const issue = parsed.issue;
  if (!isObject(repository)) throw new Error("Invalid webhook payload: missing repository");
  if (!isObject(issue)) throw new Error("Invalid webhook payload: missing issue");
  requireString(parsed.action, "action");
  requireString(repository.full_name, "repository.full_name");
  requireNumber(issue.number, "issue.number");
  requireString(issue.title, "issue.title");
  requireString(issue.html_url, "issue.html_url");
  requireString(issue.updated_at, "issue.updated_at");
  return parsed as unknown as GiteaIssuePayload;
}

export type IssueWebhookPolicy = WebhookPolicy & { botUsername: string };

export type IssueWebhookDecision =
  | { type: "enqueue"; job: Omit<IssueJob, "delivery" | "receivedAt"> }
  | { type: "cancel"; owner: string; repo: string; issueNumber: number }
  | { type: "skip"; reason: string };

export function issueJobFrom(
  owner: string,
  repo: string,
  issue: GiteaIssue,
  repository: { default_branch: string; clone_url: string },
  action: string
): Omit<IssueJob, "delivery" | "receivedAt"> {
  return {
    owner,
    repo,
    issueNumber: issue.number,
    action,
    title: issue.title,
    body: issue.body ?? "",
    htmlUrl: issue.html_url,
    issueUpdatedAt: issue.updated_at,
    defaultBranch: repository.default_branch,
    cloneUrl: repository.clone_url,
  };
}

export function shouldEnqueueIssue(payload: GiteaIssuePayload, policy: IssueWebhookPolicy): IssueWebhookDecision {
  const { owner, repo } = assertRepositoryPolicy(payload.repository, policy);

  if (isPullRequestIssue(payload.issue)) {
    return { type: "skip", reason: "pull request issue" };
  }

  if (payload.action === "unassigned") {
    if (!isAssignedToBot(payload.issue, policy.botUsername)) {
      return { type: "cancel", owner, repo, issueNumber: payload.issue.number };
    }
    return { type: "skip", reason: "bot still assigned" };
  }

  if (!ENQUEUE_ACTIONS.has(payload.action)) {
    return { type: "skip", reason: `unsupported action ${payload.action}` };
  }

  if (!isAssignedToBot(payload.issue, policy.botUsername)) {
    return { type: "skip", reason: "not assigned to bot" };
  }

  return {
    type: "enqueue",
    job: issueJobFrom(owner, repo, payload.issue, payload.repository, payload.action),
  };
}
