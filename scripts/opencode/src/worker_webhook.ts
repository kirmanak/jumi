import { parseWorkflowJobPayload, shouldEnqueueWorkflowJobFollowUp } from "./ci_webhook.ts";
import {
  parseIssueCommentPayload,
  parsePullRejectedPayload,
  shouldEnqueueIssueCommentFollowUp,
  shouldEnqueuePullAssign,
  shouldEnqueuePullRejectedFollowUp,
} from "./followup_webhook.ts";
import { type IssueApi, upsertWorkerComment } from "./gitea_issues.ts";
import { parseIssuesPayload, shouldEnqueueIssue } from "./issue_webhook.ts";
import { parsePushPayload, shouldEnqueuePushConflicts } from "./push_webhook.ts";
import type { EnqueueResult } from "./queue.ts";
import { isQueueUnavailable, type ReviewJobStore } from "./review_jobs.ts";
import type { IssueJob } from "./types.ts";
import { parsePullRequestPayload, peekWebhookAction, type WebhookPolicy } from "./webhook.ts";

export type WorkerWebhookPolicy = WebhookPolicy & {
  botUsername: string;
  followupIgnoreLogins?: readonly string[];
};

export interface WorkerWebhookQueue {
  enqueue(job: IssueJob): EnqueueResult | Promise<EnqueueResult>;
}

export interface HandleWorkerWebhookDeps {
  queue: WorkerWebhookQueue;
  api?: Pick<IssueApi, "listOpenPulls" | "getIssue">;
  cancel?: (owner: string, repo: string, issueNumber: number) => Promise<{ key: string; cancelled: true }>;
  logger?: (message: string) => void;
}

/** Gitea HookEventType.Event() maps issues/issue_assign/issue_label/issue_milestone → "issues". */
export function isIssuesWebhookEvent(event: string | null, eventType: string | null): boolean {
  return event === "issues" || event === "issue_assign" || eventType === "issues" || eventType === "issue_assign";
}

const FOLLOWUP_EVENTS = new Set([
  "issue_comment",
  "pull_request_comment",
  "pull_request_rejected",
  "pull_request_review_comment",
  "pull_request_review_rejected",
]);

export function isFollowUpWebhookEvent(event: string | null, eventType: string | null): boolean {
  if (event === "pull_request") return false;
  return FOLLOWUP_EVENTS.has(event ?? "") || FOLLOWUP_EVENTS.has(eventType ?? "");
}

export function isPushWebhookEvent(event: string | null, eventType: string | null): boolean {
  return event === "push" || eventType === "push";
}

export function isWorkflowJobWebhookEvent(event: string | null, eventType: string | null): boolean {
  return event === "workflow_job" || eventType === "workflow_job";
}

export function isPullAssignWebhookEvent(event: string | null, eventType: string | null): boolean {
  return event === "pull_request" || event === "pull_request_assign" || eventType === "pull_request_assign";
}

export function isWorkerWebhookEvent(event: string | null, eventType: string | null): boolean {
  return (
    isIssuesWebhookEvent(event, eventType) ||
    isFollowUpWebhookEvent(event, eventType) ||
    isPushWebhookEvent(event, eventType) ||
    isWorkflowJobWebhookEvent(event, eventType) ||
    isPullAssignWebhookEvent(event, eventType)
  );
}

function isPullRejectedEvent(event: string | null, eventType: string | null): boolean {
  return (
    event === "pull_request_rejected" ||
    eventType === "pull_request_rejected" ||
    eventType === "pull_request_review_rejected"
  );
}

function isPullRequestPayloadFollowUp(event: string | null, eventType: string | null): boolean {
  if (event === "pull_request" || event === "issue_comment") return false;
  return (
    isPullRejectedEvent(event, eventType) ||
    event === "pull_request_comment" ||
    eventType === "pull_request_review_comment"
  );
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function skipped(reason: string, logger: (message: string) => void): Response {
  logger(`skipped ${reason}`);
  return json(202, { skipped: reason });
}

function cancelKey(owner: string, repo: string, issueNumber: number): string {
  return `${owner}/${repo}#${issueNumber}`;
}

export async function cancelLedgerWorkerJobs(opts: {
  store: Pick<ReviewJobStore, "cancelQueuedForIssue">;
  api: Pick<IssueApi, "findStickyIssueComment" | "createIssueComment" | "updateIssueComment">;
  owner: string;
  repo: string;
  issueNumber: number;
  botUsername: string;
  logger?: (message: string) => void;
}): Promise<{ key: string; cancelled: true }> {
  const key = cancelKey(opts.owner, opts.repo, opts.issueNumber);
  const cancelled = await opts.store.cancelQueuedForIssue(opts.owner, opts.repo, opts.issueNumber);
  if (cancelled > 0) {
    try {
      await upsertWorkerComment(opts.api, opts.owner, opts.repo, opts.issueNumber, opts.botUsername, "stopped");
    } catch (err) {
      opts.logger?.(`stopped comment failed ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { key, cancelled: true };
}

export async function handleWorkerWebhookEvent(
  rawBody: Uint8Array,
  event: string | null,
  eventType: string | null,
  delivery: string,
  policy: WorkerWebhookPolicy,
  deps: HandleWorkerWebhookDeps
): Promise<Response> {
  const logger = deps.logger ?? ((message: string) => console.log(message));
  if (event === "ping" || eventType === "ping") return json(200, { ok: true });
  // Gitea 1.27: PR assignment is pull_request_assign; X-Gitea-Event is still pull_request.
  // Handle only assigned/unassigned. Any other pull_request action skips 202, never 400.
  if (isPullAssignWebhookEvent(event, eventType)) {
    const action = peekWebhookAction(rawBody);
    if (action !== "assigned" && action !== "unassigned") {
      return skipped(
        action ? `unsupported action ${action}` : `unsupported event ${event ?? eventType ?? "pull_request"}`,
        logger
      );
    }
    try {
      const decision = shouldEnqueuePullAssign(parsePullRequestPayload(rawBody), policy);
      if (decision.type === "skip") return skipped(decision.reason, logger);
      if (decision.type === "cancel") {
        const result = deps.cancel
          ? await deps.cancel(decision.owner, decision.repo, decision.issueNumber)
          : { key: cancelKey(decision.owner, decision.repo, decision.issueNumber), cancelled: true as const };
        logger(`cancelled ${result.key}`);
        return json(202, result);
      }
      const job: IssueJob = {
        ...decision.job,
        delivery,
        receivedAt: new Date().toISOString(),
      };
      const result: EnqueueResult = await deps.queue.enqueue(job);
      logger(`${result.queued ? "queued" : "deduped"} ${result.key} delivery=${delivery}`);
      return json(202, result);
    } catch (err) {
      if (isQueueUnavailable(err)) {
        logger(`queue unavailable: ${err.message}`);
        return json(503, { error: "queue unavailable" });
      }
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  // Gitea 1.27: assignment uses X-Gitea-Event=issues and X-Gitea-Event-Type=issue_assign.
  // Accept either header so a proxy that copies Event-Type into Event still works.
  if (!isWorkerWebhookEvent(event, eventType)) {
    return skipped(`unsupported event ${event ?? eventType ?? "unknown"}`, logger);
  }

  if (isWorkflowJobWebhookEvent(event, eventType)) {
    if (!deps.api) return skipped("not an in-scope jumi pull request", logger);
    let payload: ReturnType<typeof parseWorkflowJobPayload>;
    try {
      payload = parseWorkflowJobPayload(rawBody);
    } catch {
      return skipped("malformed workflow_job payload", logger);
    }
    try {
      const decision = await shouldEnqueueWorkflowJobFollowUp(payload, policy, deps.api);
      if (decision.type === "skip") return skipped(decision.reason, logger);
      const receivedAt = new Date().toISOString();
      const keys: string[] = [];
      for (const partial of decision.jobs) {
        const job: IssueJob = { ...partial, delivery, receivedAt };
        const result: EnqueueResult = await deps.queue.enqueue(job);
        keys.push(result.key);
        logger(`${result.queued ? "queued" : "deduped"} ${result.key} delivery=${delivery}`);
      }
      return json(202, { queued: true, keys });
    } catch (err) {
      if (isQueueUnavailable(err)) {
        logger(`queue unavailable: ${err.message}`);
        return json(503, { error: "queue unavailable" });
      }
      return json(500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (isPushWebhookEvent(event, eventType)) {
    if (!deps.api) return skipped("no managed jumi PRs", logger);
    let payload: ReturnType<typeof parsePushPayload>;
    try {
      payload = parsePushPayload(rawBody);
    } catch {
      return skipped("malformed push payload", logger);
    }
    try {
      const decision = await shouldEnqueuePushConflicts(payload, policy, deps.api);
      if (decision.type === "skip") return skipped(decision.reason, logger);
      const receivedAt = new Date().toISOString();
      const keys: string[] = [];
      for (const partial of decision.jobs) {
        const job: IssueJob = { ...partial, delivery, receivedAt };
        const result: EnqueueResult = await deps.queue.enqueue(job);
        keys.push(result.key);
        logger(`${result.queued ? "queued" : "deduped"} ${result.key} delivery=${delivery}`);
      }
      return json(202, { queued: true, keys });
    } catch (err) {
      if (isQueueUnavailable(err)) {
        logger(`queue unavailable: ${err.message}`);
        return json(503, { error: "queue unavailable" });
      }
      return json(500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  try {
    if (isFollowUpWebhookEvent(event, eventType)) {
      const eventName = event ?? eventType ?? "issue_comment";
      const decision = isPullRequestPayloadFollowUp(event, eventType)
        ? shouldEnqueuePullRejectedFollowUp(parsePullRejectedPayload(rawBody), policy, eventName)
        : shouldEnqueueIssueCommentFollowUp(parseIssueCommentPayload(rawBody), policy, eventName);
      if (decision.type === "skip") return skipped(decision.reason, logger);
      const job: IssueJob = {
        ...decision.job,
        delivery,
        receivedAt: new Date().toISOString(),
      };
      const result: EnqueueResult = await deps.queue.enqueue(job);
      logger(`${result.queued ? "queued" : "deduped"} ${result.key} delivery=${delivery}`);
      return json(202, result);
    }

    const payload = parseIssuesPayload(rawBody);
    const decision = shouldEnqueueIssue(payload, policy);

    if (decision.type === "skip") return skipped(decision.reason, logger);
    if (decision.type === "cancel") {
      const result = deps.cancel
        ? await deps.cancel(decision.owner, decision.repo, decision.issueNumber)
        : { key: cancelKey(decision.owner, decision.repo, decision.issueNumber), cancelled: true as const };
      logger(`cancelled ${result.key}`);
      return json(202, result);
    }

    const job: IssueJob = {
      ...decision.job,
      delivery,
      receivedAt: new Date().toISOString(),
    };
    const result: EnqueueResult = await deps.queue.enqueue(job);
    logger(`${result.queued ? "queued" : "deduped"} ${result.key} delivery=${delivery}`);
    return json(202, result);
  } catch (err) {
    if (isQueueUnavailable(err)) {
      logger(`queue unavailable: ${err.message}`);
      return json(503, { error: "queue unavailable" });
    }
    return json(400, { error: err instanceof Error ? err.message : String(err) });
  }
}
