import { hostname } from "node:os";
import { parseWorkflowJobPayload, shouldEnqueueWorkflowJobFollowUp } from "./ci_webhook.ts";
import { scrubSecretEnv } from "./config.ts";
import {
  parseIssueCommentPayload,
  parsePullRejectedPayload,
  shouldEnqueueIssueCommentFollowUp,
  shouldEnqueuePullRejectedFollowUp,
} from "./followup_webhook.ts";
import { createGiteaForge } from "./forge.ts";
import type { IssueApi } from "./gitea_issues.ts";
import { parseIssuesPayload, shouldEnqueueIssue } from "./issue_webhook.ts";
import { ensureOpenCodeWellKnownAuth } from "./opencode_auth.ts";
import { parsePushPayload, shouldEnqueuePushConflicts } from "./push_webhook.ts";
import type { EnqueueResult, ReviewQueue } from "./queue.ts";
import { createPgReviewJobStore, isQueueUnavailable, QUEUE_POLL_MS, type ReviewJobStore } from "./review_jobs.ts";
import { renderTokenMetrics } from "./token_metrics.ts";
import type { IssueJob } from "./types.ts";
import { verifyGiteaSignature } from "./webhook.ts";
import {
  abortIssueQueue,
  createIssueQueue,
  handleIssueCancel,
  issueJobKey,
  processWorkerTick,
  reclaimExpiredWorkerJobs,
  runAssignedIssueScan,
  type WorkerQueueLike,
} from "./worker.ts";
import type { WorkerConfig } from "./worker_config.ts";
import { loadWorkerConfig } from "./worker_config.ts";

function log(message: string) {
  console.log(`[worker] ${message}`);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function authMatches(actual: string | null, expected?: string): boolean {
  if (!expected) return true;
  return actual === expected || actual === `Bearer ${expected}`;
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

export function isWorkerWebhookEvent(event: string | null, eventType: string | null): boolean {
  return (
    isIssuesWebhookEvent(event, eventType) ||
    isFollowUpWebhookEvent(event, eventType) ||
    isPushWebhookEvent(event, eventType) ||
    isWorkflowJobWebhookEvent(event, eventType)
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

export interface WorkerFetchHandlerDeps {
  queue: WorkerQueueLike;
  api?: Pick<IssueApi, "listOpenPulls" | "getIssue">;
  cancel?: (owner: string, repo: string, issueNumber: number) => Promise<{ key: string; cancelled: true }>;
  logger?: (message: string) => void;
}

export function createWorkerFetchHandler(config: WorkerConfig, deps: WorkerFetchHandlerDeps) {
  const logger = deps.logger ?? log;
  return async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return json(200, { ok: true });
    if (url.pathname === "/metrics") {
      if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "method not allowed" });
      return new Response(renderTokenMetrics(), {
        status: 200,
        headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
      });
    }
    if (url.pathname !== "/webhooks/gitea") return json(404, { error: "not found" });
    if (request.method !== "POST") return json(405, { error: "method not allowed" });
    if (!request.headers.get("content-type")?.includes("application/json")) {
      return json(415, { error: "expected application/json" });
    }
    if (!authMatches(request.headers.get("authorization"), config.webhookAuthToken)) {
      return json(401, { error: "invalid authorization header" });
    }

    const rawBody = new Uint8Array(await request.arrayBuffer());
    if (rawBody.byteLength > config.maxWebhookBytes) {
      return json(413, { error: "webhook payload too large" });
    }
    const signatureOk = await verifyGiteaSignature(
      rawBody,
      config.webhookSecret,
      request.headers.get("x-gitea-signature")
    );
    if (!signatureOk) return json(401, { error: "invalid signature" });

    const event = request.headers.get("x-gitea-event");
    const eventType = request.headers.get("x-gitea-event-type");
    if (event === "ping" || eventType === "ping") return json(200, { ok: true });
    if (event === "pull_request") {
      return json(202, { skipped: `unsupported event ${event}` });
    }
    // Gitea 1.27: assignment uses X-Gitea-Event=issues and X-Gitea-Event-Type=issue_assign.
    // Accept either header so a proxy that copies Event-Type into Event still works.
    if (!isWorkerWebhookEvent(event, eventType)) {
      return json(202, { skipped: `unsupported event ${event ?? eventType ?? "unknown"}` });
    }

    const policy = {
      giteaUrl: config.giteaUrl,
      allowedOrgs: config.allowedOrgs,
      allowedRepos: config.allowedRepos,
      botUsername: config.botUsername,
    };

    if (isWorkflowJobWebhookEvent(event, eventType)) {
      if (!deps.api) return json(202, { skipped: "not an in-scope jumi pull request" });
      let payload: ReturnType<typeof parseWorkflowJobPayload>;
      try {
        payload = parseWorkflowJobPayload(rawBody);
      } catch {
        return json(202, { skipped: "malformed workflow_job payload" });
      }
      try {
        const decision = await shouldEnqueueWorkflowJobFollowUp(payload, policy, deps.api);
        if (decision.type === "skip") return json(202, { skipped: decision.reason });
        const delivery = request.headers.get("x-gitea-delivery") ?? crypto.randomUUID();
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
      if (!deps.api) return json(202, { skipped: "no managed jumi PRs" });
      let payload: ReturnType<typeof parsePushPayload>;
      try {
        payload = parsePushPayload(rawBody);
      } catch {
        return json(202, { skipped: "malformed push payload" });
      }
      try {
        const decision = await shouldEnqueuePushConflicts(payload, policy, deps.api);
        if (decision.type === "skip") return json(202, { skipped: decision.reason });
        const delivery = request.headers.get("x-gitea-delivery") ?? crypto.randomUUID();
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
        if (decision.type === "skip") return json(202, { skipped: decision.reason });
        const delivery = request.headers.get("x-gitea-delivery") ?? crypto.randomUUID();
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

      if (decision.type === "skip") return json(202, { skipped: decision.reason });
      if (decision.type === "cancel") {
        const result = deps.cancel
          ? await deps.cancel(decision.owner, decision.repo, decision.issueNumber)
          : { key: issueJobKey(decision), cancelled: true as const };
        logger(`cancelled ${result.key}`);
        return json(202, result);
      }

      const delivery = request.headers.get("x-gitea-delivery") ?? crypto.randomUUID();
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
  };
}

function workerId(): string {
  return `worker-${hostname()}-${process.pid}-${crypto.randomUUID()}`;
}

function bindAbort(signal: AbortSignal | undefined, fn: () => void): void {
  if (!signal) return;
  if (signal.aborted) {
    fn();
    return;
  }
  signal.addEventListener("abort", fn, { once: true });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true }
    );
  });
}

async function main() {
  const config = loadWorkerConfig();
  scrubSecretEnv();
  const shutdown = new AbortController();
  const onSignal = (signal: string) => {
    log(`received ${signal}, shutting down`);
    if (!shutdown.signal.aborted) shutdown.abort();
  };
  process.once("SIGTERM", () => onSignal("SIGTERM"));
  process.once("SIGINT", () => onSignal("SIGINT"));
  await ensureOpenCodeWellKnownAuth({
    home: config.home,
    url: config.opencodeWellKnownUrl,
    key: config.opencodeWellKnownKey,
    token: config.opencodeWellKnownToken,
    logger: log,
  });
  const api = createGiteaForge(config.giteaUrl, config.giteaToken);
  const store: ReviewJobStore | undefined = config.databaseUrl
    ? await createPgReviewJobStore(config.databaseUrl)
    : undefined;
  const ramQueue: ReviewQueue<IssueJob> | undefined = store ? undefined : createIssueQueue(config, api);
  const aborts = new Map<string, AbortController>();
  const pids = new Map<string, number>();
  const queue: WorkerQueueLike = store ? { enqueue: (job) => store.enqueueIssue(job) } : ramQueue!;
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: createWorkerFetchHandler(config, {
      queue,
      api,
      cancel: (owner, repo, issueNumber) =>
        handleIssueCancel(config, api, owner, repo, issueNumber, ramQueue, store, aborts, pids),
    }),
  });

  const scan = () => {
    void runAssignedIssueScan(config, api, queue).catch((err) => {
      log(`scan failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  scan();
  setInterval(scan, config.scanIntervalMs);
  if (ramQueue) bindAbort(shutdown.signal, () => abortIssueQueue(ramQueue));

  if (store) {
    const leasedBy = workerId();
    const run = async () => {
      while (!shutdown.signal.aborted) {
        try {
          await reclaimExpiredWorkerJobs(store, config.maxJobAttempts, log);
          const result = await processWorkerTick(
            store,
            config,
            api,
            leasedBy,
            { abortSignal: shutdown.signal },
            log,
            aborts,
            pids
          );
          if (result === "idle") await sleep(QUEUE_POLL_MS, shutdown.signal);
        } catch (err) {
          if (shutdown.signal.aborted) return;
          log(`worker tick failed: ${err instanceof Error ? err.message : String(err)}`);
          await sleep(QUEUE_POLL_MS, shutdown.signal).catch(() => undefined);
        }
      }
    };
    void run();
  }

  log(`listening on ${server.hostname}:${server.port}${store ? " ledger=postgres" : ""}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[worker] Fatal error:", err);
    process.exit(1);
  });
}
