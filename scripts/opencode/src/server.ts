import { GiteaAPI } from "./api.ts";
import type { ServiceConfig } from "./config.ts";
import { loadConfig } from "./config.ts";
import type { EnqueueResult } from "./queue.ts";
import { ReviewQueue } from "./queue.ts";
import { reviewPullRequest } from "./review.ts";
import type { ReviewJob } from "./types.ts";
import { parsePullRequestPayload, validateWebhookPayload, verifyGiteaSignature } from "./webhook.ts";
import { createReviewWorkspace, removeReviewWorkspace } from "./workspace.ts";

function log(message: string) {
  console.log(`[server] ${message}`);
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

export interface ReviewQueueLike {
  enqueue(job: ReviewJob): EnqueueResult;
}

export interface FetchHandlerDeps {
  queue: ReviewQueueLike;
  logger?: (message: string) => void;
}

export function createReviewQueue(
  config: ServiceConfig,
  api = new GiteaAPI(config.giteaUrl, config.giteaToken),
  logger: (message: string) => void = log
): ReviewQueue {
  return new ReviewQueue(
    async (job: ReviewJob) => {
      const workspace = await createReviewWorkspace(config.workdir, job);
      try {
        const result = await reviewPullRequest({
          api,
          owner: job.owner,
          repo: job.repo,
          prNumber: job.prNumber,
          expectedHeadSha: job.headSha,
          model: config.model,
          workspace,
          giteaUrl: config.giteaUrl,
          giteaToken: config.giteaToken,
          botUsername: config.botUsername,
          opencodeConfig: config.opencodeConfig,
          home: config.home,
          sanitizeOpenCodeEnv: true,
          timeoutMs: config.opencodeTimeoutMs,
          maxFiles: config.maxFiles,
          maxPatchBytes: config.maxPatchBytes,
          maxOutputBytes: config.maxOutputBytes,
          logger: (message) => logger(message),
        });
        logger(`${job.owner}/${job.repo}#${job.prNumber} ${result.status}${result.reason ? `: ${result.reason}` : ""}`);
      } finally {
        await removeReviewWorkspace(workspace);
      }
    },
    config.queueConcurrency,
    logger
  );
}

export function createFetchHandler(config: ServiceConfig, deps: FetchHandlerDeps) {
  const logger = deps.logger ?? log;
  return async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return json(200, { ok: true });
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
    if (event !== "pull_request") return json(202, { skipped: `unsupported event ${event ?? "unknown"}` });

    try {
      const payload = parsePullRequestPayload(rawBody);
      const validation = validateWebhookPayload(payload, {
        giteaUrl: config.giteaUrl,
        allowedOrgs: config.allowedOrgs,
        allowedRepos: config.allowedRepos,
      });
      if ("skip" in validation) return json(202, { skipped: validation.skip });

      const delivery = request.headers.get("x-gitea-delivery") ?? crypto.randomUUID();
      const result = deps.queue.enqueue({ ...validation, delivery });
      logger(`${result.queued ? "queued" : "deduped"} ${result.key} delivery=${delivery}`);
      return json(202, result);
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}

async function main() {
  const config = loadConfig();
  const queue = createReviewQueue(config);

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: createFetchHandler(config, { queue }),
  });

  log(`listening on ${server.hostname}:${server.port}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[server] Fatal error:", err);
    process.exit(1);
  });
}
