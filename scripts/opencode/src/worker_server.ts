import { GiteaAPI } from "./api.ts";
import { scrubSecretEnv } from "./config.ts";
import {
  parseIssueCommentPayload,
  parsePullRejectedPayload,
  shouldEnqueueIssueCommentFollowUp,
  shouldEnqueuePullRejectedFollowUp,
} from "./followup_webhook.ts";
import { parseIssuesPayload, shouldEnqueueIssue } from "./issue_webhook.ts";
import { ensureOpenCodeWellKnownAuth } from "./opencode_auth.ts";
import type { EnqueueResult, ReviewQueue } from "./queue.ts";
import { renderTokenMetrics } from "./token_metrics.ts";
import type { IssueJob } from "./types.ts";
import { verifyGiteaSignature } from "./webhook.ts";
import {
  createIssueQueue,
  handleIssueCancel,
  issueJobKey,
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

export function isWorkerWebhookEvent(event: string | null, eventType: string | null): boolean {
  return isIssuesWebhookEvent(event, eventType) || isFollowUpWebhookEvent(event, eventType);
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
        const result: EnqueueResult = deps.queue.enqueue(job);
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
      const result: EnqueueResult = deps.queue.enqueue(job);
      logger(`${result.queued ? "queued" : "deduped"} ${result.key} delivery=${delivery}`);
      return json(202, result);
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}

async function main() {
  const config = loadWorkerConfig();
  scrubSecretEnv();
  await ensureOpenCodeWellKnownAuth({
    home: config.home,
    url: config.opencodeWellKnownUrl,
    key: config.opencodeWellKnownKey,
    token: config.opencodeWellKnownToken,
    logger: log,
  });
  const api = new GiteaAPI(config.giteaUrl, config.giteaToken);
  const queue: ReviewQueue<IssueJob> = createIssueQueue(config, api);
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: createWorkerFetchHandler(config, {
      queue,
      cancel: (owner, repo, issueNumber) => handleIssueCancel(config, api, owner, repo, issueNumber, queue),
    }),
  });

  const scan = () => {
    void runAssignedIssueScan(config, api, queue).catch((err) => {
      log(`scan failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  scan();
  setInterval(scan, config.scanIntervalMs);

  log(`listening on ${server.hostname}:${server.port}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[worker] Fatal error:", err);
    process.exit(1);
  });
}
