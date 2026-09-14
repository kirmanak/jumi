import { parseWorkflowJobPayload, shouldEnqueueWorkflowJobFollowUp } from "./ci_webhook.ts";
import {
  parseIssueCommentPayload,
  parsePullRejectedPayload,
  shouldEnqueueIssueCommentFollowUpWithTrust,
  shouldEnqueuePullAssign,
  shouldEnqueuePullRejectedFollowUpWithTrust,
} from "./followup_webhook.ts";
import { type IssueApi, upsertWorkerComment } from "./gitea_issues.ts";
import {
  blockedIssueJobsToEnqueue,
  isDependencyWakeAction,
  parseIssuesPayload,
  shouldEnqueueIssue,
} from "./issue_webhook.ts";
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

export type WorkerWebhookApi = Pick<IssueApi, "listOpenPulls" | "getIssue"> &
  Partial<Pick<IssueApi, "getRepo" | "listIssueBlocks" | "getPR" | "getCollaboratorPermission">> & {
    rememberInstallation?: (installationId: string, owner?: string, repo?: string) => void;
  };

export interface HandleWorkerWebhookDeps {
  queue: WorkerWebhookQueue;
  api?: WorkerWebhookApi;
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
      const decision = await shouldEnqueuePullAssign(parsePullRequestPayload(rawBody), policy, deps.api, logger);
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
      logger(`invalid webhook payload: ${err instanceof Error ? err.message : String(err)}`);
      return json(400, { error: "invalid webhook payload" });
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
      const decision = await shouldEnqueueWorkflowJobFollowUp(payload, policy, deps.api, logger);
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
      logger(`workflow job webhook failed: ${err instanceof Error ? err.message : String(err)}`);
      return json(500, { error: "internal error" });
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
      const decision = await shouldEnqueuePushConflicts(payload, policy, deps.api, logger);
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
      logger(`push webhook failed: ${err instanceof Error ? err.message : String(err)}`);
      return json(500, { error: "internal error" });
    }
  }

  try {
    if (isFollowUpWebhookEvent(event, eventType)) {
      const eventName = event ?? eventType ?? "issue_comment";
      const decision = isPullRequestPayloadFollowUp(event, eventType)
        ? await shouldEnqueuePullRejectedFollowUpWithTrust(
            parsePullRejectedPayload(rawBody),
            policy,
            eventName,
            undefined,
            deps.api
          )
        : await shouldEnqueueIssueCommentFollowUpWithTrust(
            parseIssueCommentPayload(rawBody),
            policy,
            eventName,
            undefined,
            deps.api
          );
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

    if (decision.type === "cancel") {
      const result = deps.cancel
        ? await deps.cancel(decision.owner, decision.repo, decision.issueNumber)
        : { key: cancelKey(decision.owner, decision.repo, decision.issueNumber), cancelled: true as const };
      logger(`cancelled ${result.key}`);
      return json(202, result);
    }

    const receivedAt = new Date().toISOString();
    const jobs: IssueJob[] = [];
    const seen = new Set<string>();
    const addJob = (partial: Omit<IssueJob, "delivery" | "receivedAt">) => {
      const key = `${partial.owner}/${partial.repo}#${partial.issueNumber}`;
      if (seen.has(key)) return;
      seen.add(key);
      jobs.push({ ...partial, delivery, receivedAt });
    };

    if (decision.type === "enqueue") addJob(decision.job);

    if (isDependencyWakeAction(payload.action) && deps.api?.listIssueBlocks) {
      try {
        const woken = await blockedIssueJobsToEnqueue(payload, policy, {
          listIssueBlocks: deps.api.listIssueBlocks,
          getIssue: deps.api.getIssue,
          getRepo: deps.api.getRepo,
        });
        for (const partial of woken) addJob(partial);
      } catch (err) {
        if (jobs.length === 0) {
          logger(`failed to list blocked issues: ${err instanceof Error ? err.message : String(err)}`);
          return skipped("failed to list blocked issues", logger);
        }
      }
    }

    if (jobs.length === 0) {
      if (decision.type === "skip") return skipped(decision.reason, logger);
      return skipped("no blocked issues to wake", logger);
    }

    if (jobs.length === 1) {
      const job = jobs[0];
      if (!job) return skipped("no blocked issues to wake", logger);
      const result: EnqueueResult = await deps.queue.enqueue(job);
      logger(`${result.queued ? "queued" : "deduped"} ${result.key} delivery=${delivery}`);
      return json(202, result);
    }

    const keys: string[] = [];
    for (const job of jobs) {
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
    logger(`invalid webhook payload: ${err instanceof Error ? err.message : String(err)}`);
    return json(400, { error: "invalid webhook payload" });
  }
}
