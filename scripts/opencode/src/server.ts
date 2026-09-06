import { hostname } from "node:os";
import type { ServiceConfig } from "./config.ts";
import { loadConfig, scrubSecretEnv } from "./config.ts";
import { formatBytes, logDiagnostic, sampleMemory } from "./diagnostics.ts";
import type { Engine } from "./engine.ts";
import { createGiteaForge } from "./forge.ts";
import { enqueueFollowUpFromReview } from "./handover.ts";
import { ensureOpenCodeWellKnownAuth } from "./opencode_auth.ts";
import type { EnqueueResult } from "./queue.ts";
import { ReviewQueue } from "./queue.ts";
import type { PersistReviewResult, ReviewApi, ReviewResult, WorkspacePreparer } from "./review.ts";
import { publishReviewResult, reviewJobKey, reviewPullRequest } from "./review.ts";
import {
  createPgReviewJobStore,
  HEARTBEAT_MS,
  hasPersistedResult,
  isQueueUnavailable,
  QUEUE_POLL_MS,
  REVIEW_KIND,
  type ReviewJobRecord,
  type ReviewJobStore,
  renderQueueMetrics,
} from "./review_jobs.ts";
import { renderTokenMetrics } from "./token_metrics.ts";
import type { ReviewJob } from "./types.ts";
import { parsePullRequestPayload, validateWebhookPayload, verifyGiteaSignature } from "./webhook.ts";
import type { GitRunner } from "./workspace.ts";
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

export function shouldSeedOpenCodeAuth(role: ServiceConfig["role"]): boolean {
  return role !== "router";
}

export interface ReviewQueueLike {
  enqueue(job: ReviewJob): EnqueueResult | Promise<EnqueueResult>;
}

export interface FetchHandlerDeps {
  queue: ReviewQueueLike;
  logger?: (message: string) => void;
  renderMetrics?: () => string | Promise<string>;
  webhookEnabled?: boolean;
  getPR?: ReviewApi["getPR"];
}

export interface RunReviewJobExtras {
  persistResult?: (result: PersistReviewResult) => Promise<void>;
  engine?: Engine;
  openCodeRunner?: Engine;
  workspacePreparer?: WorkspacePreparer;
  gitRunner?: GitRunner;
}

export async function runReviewJob(
  config: ServiceConfig,
  job: ReviewJob,
  api: ReviewApi,
  logger: (message: string) => void = log,
  extras: RunReviewJobExtras = {}
): Promise<ReviewResult> {
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
      persistResult: extras.persistResult,
      engine: extras.engine ?? extras.openCodeRunner,
      workspacePreparer: extras.workspacePreparer,
      gitRunner: extras.gitRunner,
    });
    logger(`${job.owner}/${job.repo}#${job.prNumber} ${result.status}${result.reason ? `: ${result.reason}` : ""}`);
    return result;
  } finally {
    const before = await sampleMemory(process.pid);
    logDiagnostic(logger, "workspace_remove_start", {
      review: `${job.owner}/${job.repo}#${job.prNumber}`,
      workspace,
      parent_rss_bytes: before.rssBytes,
      parent_rss_h: formatBytes(before.rssBytes),
      cgroup_bytes: before.cgroupBytes,
      cgroup_h: formatBytes(before.cgroupBytes),
    });
    await removeReviewWorkspace(workspace);
    const after = await sampleMemory(process.pid);
    logDiagnostic(logger, "workspace_remove_end", {
      review: `${job.owner}/${job.repo}#${job.prNumber}`,
      workspace,
      parent_rss_bytes: after.rssBytes,
      parent_rss_h: formatBytes(after.rssBytes),
      cgroup_bytes: after.cgroupBytes,
      cgroup_h: formatBytes(after.cgroupBytes),
    });
  }
}

export function createReviewQueue(
  config: ServiceConfig,
  api: ReviewApi = createGiteaForge(config.giteaUrl, config.giteaToken),
  logger: (message: string) => void = log
): ReviewQueue {
  return new ReviewQueue(
    async (job: ReviewJob) => {
      await runReviewJob(config, job, api, logger);
    },
    config.queueConcurrency,
    logger
  );
}

export function createFetchHandler(config: ServiceConfig, deps: FetchHandlerDeps) {
  const logger = deps.logger ?? log;
  const webhookEnabled = deps.webhookEnabled ?? true;
  return async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return json(200, { ok: true });
    if (url.pathname === "/metrics") {
      if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "method not allowed" });
      const body = await (deps.renderMetrics ?? renderTokenMetrics)();
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
      });
    }
    if (url.pathname !== "/webhooks/gitea") return json(404, { error: "not found" });
    if (!webhookEnabled) return json(404, { error: "not found" });
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
      const job = { ...validation, delivery };
      if (deps.getPR) {
        try {
          const pr = await deps.getPR(job.owner, job.repo, job.prNumber);
          if (job.headSha !== pr.head.sha) {
            const key = reviewJobKey(job);
            logger(`stale head ${key} current=${pr.head.sha}`);
            return json(202, { key, queued: false });
          }
        } catch (err) {
          logger(`pr head lookup failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const result = await deps.queue.enqueue(job);
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

function publishedState(result: ReviewResult): "succeeded" | "skipped" {
  return result.status === "skipped" ? "skipped" : "succeeded";
}

export async function publishPersistedJob(
  api: ReviewApi,
  config: ServiceConfig,
  row: ReviewJobRecord,
  logger: (message: string) => void = log
): Promise<ReviewResult> {
  const result = await publishReviewResult({
    api,
    owner: row.owner,
    repo: row.repo,
    prNumber: row.prNumber,
    expectedHeadSha: row.headSha,
    botUsername: config.botUsername,
    resultMarkdown: row.resultMarkdown,
    resultReason: row.resultReason,
    error: row.error,
    logger,
  });
  return result;
}

export async function reclaimExpiredJobs(
  store: ReviewJobStore,
  api: ReviewApi,
  config: ServiceConfig,
  logger: (message: string) => void = log
): Promise<ReclaimResultSummary> {
  const { requeued, publish } = await store.reclaimExpired(config.maxJobAttempts, undefined, HEARTBEAT_MS, [
    REVIEW_KIND,
  ]);
  for (const row of requeued) {
    logger(`requeued ${row.jobKey} attempt=${row.attempt}`);
  }
  for (const row of publish) {
    try {
      const result = await publishAndCompleteJob(store, api, config, row, logger);
      logger(`reclaim-published ${row.jobKey} ${result.status}${result.reason ? `: ${result.reason}` : ""}`);
    } catch (err) {
      logger(`reclaim-publish failed ${row.jobKey}: ${err instanceof Error ? err.message : String(err)}`);
      try {
        if (row.leasedBy == null) throw new Error(`cannot expire lease for job ${row.id}`);
        await store.expireLease(row.id, row.leasedBy);
      } catch (expireErr) {
        logger(
          `reclaim expire failed ${row.jobKey}: ${expireErr instanceof Error ? expireErr.message : String(expireErr)}`
        );
      }
    }
  }
  return { requeued: requeued.length, published: publish.length };
}

export interface ReclaimResultSummary {
  requeued: number;
  published: number;
}

async function handoverFollowUp(
  store: ReviewJobStore,
  api: ReviewApi,
  config: ServiceConfig,
  row: ReviewJobRecord,
  published: ReviewResult,
  logger: (message: string) => void
): Promise<void> {
  try {
    const current = await store.get(row.id);
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row: current ?? row,
      botUsername: config.botUsername,
      published,
      markdown: current?.resultMarkdown ?? row.resultMarkdown,
    });
    if (result?.queued) logger(`handover follow-up ${result.key}`);
  } catch (err) {
    logger(`handover failed ${row.jobKey}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function publishAndCompleteJob(
  store: ReviewJobStore,
  api: ReviewApi,
  config: ServiceConfig,
  row: ReviewJobRecord,
  logger: (message: string) => void
): Promise<ReviewResult> {
  const result = await publishPersistedJob(api, config, row, logger);
  if (row.leasedBy == null) throw new Error(`cannot mark published for job ${row.id}`);
  const failed = Boolean(row.error) && !row.resultMarkdown;
  await store.markPublished(row.id, row.leasedBy, {
    state: failed ? "failed" : publishedState(result),
    reason: result.reason,
  });
  await handoverFollowUp(store, api, config, row, result, logger);
  return result;
}

export async function processEngineTick(
  store: ReviewJobStore,
  config: ServiceConfig,
  api: ReviewApi,
  leasedBy: string,
  extras: RunReviewJobExtras = {},
  logger: (message: string) => void = log
): Promise<"idle" | "processed"> {
  const row = await store.lease(leasedBy, config.leaseMs, undefined, [REVIEW_KIND]);
  if (!row) return "idle";

  let heartbeatStopped = false;
  const heartbeat = setInterval(() => {
    if (heartbeatStopped) return;
    void store.heartbeat(row.id, leasedBy, config.leaseMs);
  }, HEARTBEAT_MS);
  const stopHeartbeat = () => {
    heartbeatStopped = true;
    clearInterval(heartbeat);
  };

  try {
    const job: ReviewJob = {
      delivery: row.delivery,
      owner: row.owner,
      repo: row.repo,
      prNumber: row.prNumber,
      action: "synchronize",
      headSha: row.headSha,
      receivedAt: new Date(row.createdAt).toISOString(),
    };
    const result = await runReviewJob(config, job, api, logger, {
      ...extras,
      persistResult: async (persisted) => {
        await store.saveResult(row.id, leasedBy, persisted);
      },
    });
    stopHeartbeat();
    await store.markPublished(row.id, leasedBy, { state: publishedState(result), reason: result.reason });
    await handoverFollowUp(store, api, config, row, result, logger);
    return "processed";
  } catch (err) {
    logger(`engine job ${row.jobKey} failed: ${err instanceof Error ? err.message : String(err)}`);
    stopHeartbeat();
    let published = false;
    try {
      const current = await store.get(row.id);
      if (current && current.leasedBy !== leasedBy) {
        published = true;
      } else if (current && hasPersistedResult(current)) {
        await publishAndCompleteJob(store, api, config, current, logger);
        published = true;
      }
    } catch (publishErr) {
      logger(
        `engine publish failed ${row.jobKey}: ${publishErr instanceof Error ? publishErr.message : String(publishErr)}`
      );
    }
    if (!published) {
      try {
        await store.expireLease(row.id, leasedBy);
      } catch (expireErr) {
        logger(
          `engine expire failed ${row.jobKey}: ${expireErr instanceof Error ? expireErr.message : String(expireErr)}`
        );
      }
    }
    return "processed";
  } finally {
    stopHeartbeat();
  }
}

function engineId(): string {
  return `engine-${hostname()}-${process.pid}-${crypto.randomUUID()}`;
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

export interface StartReviewerDeps {
  api?: ReviewApi;
  store?: ReviewJobStore;
  ensureAuth?: typeof ensureOpenCodeWellKnownAuth;
  logger?: (message: string) => void;
  extras?: RunReviewJobExtras;
  signal?: AbortSignal;
  listen?: boolean;
}

export interface StartedReviewer {
  role: ServiceConfig["role"];
  server?: ReturnType<typeof Bun.serve>;
  store?: ReviewJobStore;
  stop: () => void;
}

async function serveAndWait(
  config: ServiceConfig,
  fetch: (request: Request) => Promise<Response>,
  logger: (message: string) => void,
  deps: StartReviewerDeps
): Promise<StartedReviewer> {
  if (deps.listen === false) {
    return { role: config.role, store: deps.store, stop: () => undefined };
  }
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch,
  });
  logger(`listening on ${server.hostname}:${server.port} role=${config.role}`);
  return {
    role: config.role,
    server,
    store: deps.store,
    stop: () => server.stop(true),
  };
}

export async function startReviewer(config: ServiceConfig, deps: StartReviewerDeps = {}): Promise<StartedReviewer> {
  const logger = deps.logger ?? log;
  const api = deps.api ?? createGiteaForge(config.giteaUrl, config.giteaToken);

  if (shouldSeedOpenCodeAuth(config.role)) {
    await (deps.ensureAuth ?? ensureOpenCodeWellKnownAuth)({
      home: config.home,
      url: config.opencodeWellKnownUrl,
      key: config.opencodeWellKnownKey,
      token: config.opencodeWellKnownToken,
      logger,
    });
  }

  if (config.role === "monolith") {
    const queue = createReviewQueue(config, api, logger);
    return serveAndWait(
      config,
      createFetchHandler(config, { queue, logger, getPR: (owner, repo, index) => api.getPR(owner, repo, index) }),
      logger,
      deps
    );
  }

  const store = deps.store ?? (await createPgReviewJobStore(config.databaseUrl ?? ""));
  deps = { ...deps, store };

  if (config.role === "router") {
    const started = await serveAndWait(
      config,
      createFetchHandler(config, {
        queue: store,
        logger,
        renderMetrics: () => renderQueueMetrics(store),
        getPR: (owner, repo, index) => api.getPR(owner, repo, index),
      }),
      logger,
      deps
    );
    if (deps.listen !== false) {
      const reclaim = new AbortController();
      const run = async () => {
        while (!reclaim.signal.aborted) {
          try {
            await reclaimExpiredJobs(store, api, config, logger);
          } catch (err) {
            if (reclaim.signal.aborted) return;
            logger(`reclaim failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          await sleep(QUEUE_POLL_MS, reclaim.signal).catch(() => undefined);
        }
      };
      void run();
      const stop = started.stop;
      started.stop = () => {
        reclaim.abort();
        stop();
      };
      deps.signal?.addEventListener("abort", () => started.stop(), { once: true });
    }
    return started;
  }

  const leasedBy = engineId();
  const started = await serveAndWait(
    config,
    createFetchHandler(config, {
      queue: {
        enqueue: () => {
          throw new Error("engine does not accept webhooks");
        },
      },
      logger,
      webhookEnabled: false,
    }),
    logger,
    deps
  );
  if (deps.listen !== false) {
    const run = async () => {
      while (!deps.signal?.aborted) {
        try {
          const result = await processEngineTick(store, config, api, leasedBy, deps.extras, logger);
          if (result === "idle") await sleep(QUEUE_POLL_MS, deps.signal);
        } catch (err) {
          if (deps.signal?.aborted) return;
          logger(`engine tick failed: ${err instanceof Error ? err.message : String(err)}`);
          await sleep(QUEUE_POLL_MS, deps.signal).catch(() => undefined);
        }
      }
    };
    void run();
  }
  return started;
}

async function main() {
  const config = loadConfig();
  scrubSecretEnv();
  await startReviewer(config);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[server] Fatal error:", err);
    process.exit(1);
  });
}
