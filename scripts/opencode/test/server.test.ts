import { describe, expect, test } from "bun:test";
import { MemoryReviewJobStore, QueueUnavailableError, renderQueueMetrics } from "../src/review_jobs.ts";
import type { ReviewQueueLike } from "../src/server.ts";
import { createFetchHandler, shouldSeedOpenCodeAuth, startReviewer } from "../src/server.ts";
import type { ReviewJob } from "../src/types.ts";
import {
  encodeJson,
  makeBranch,
  makeConfig,
  makeJob,
  makePayload,
  makePR,
  responseJson,
  signBody,
} from "./fixtures.ts";

function makeQueue(): ReviewQueueLike & { jobs: ReviewJob[] } {
  const jobs: ReviewJob[] = [];
  return {
    jobs,
    enqueue(job) {
      jobs.push(job);
      return { key: `${job.owner}/${job.repo}#${job.prNumber}:${job.headSha}`, queued: true };
    },
  };
}

async function signedRequest(
  body: unknown,
  overrides: RequestInit & { event?: string; secret?: string } = {}
): Promise<Request> {
  const raw = encodeJson(body);
  const secret = overrides.secret ?? "webhook-secret";
  const signature = await signBody(raw, secret);
  const headers = new Headers(overrides.headers);
  headers.set("content-type", "application/json");
  headers.set("x-gitea-signature", signature);
  headers.set("x-gitea-event", overrides.event ?? "pull_request");
  headers.set("x-gitea-delivery", "delivery-1");
  return new Request("https://reviewer.test/webhooks/gitea", {
    method: overrides.method ?? "POST",
    body: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
    headers,
  });
}

describe("createFetchHandler", () => {
  test("serves health and basic HTTP errors", async () => {
    const handler = createFetchHandler(makeConfig(), { queue: makeQueue() });

    expect((await handler(new Request("https://reviewer.test/healthz"))).status).toBe(200);
    expect((await handler(new Request("https://reviewer.test/missing"))).status).toBe(404);
    expect((await handler(new Request("https://reviewer.test/webhooks/gitea"))).status).toBe(405);
    expect((await handler(new Request("https://reviewer.test/webhooks/gitea", { method: "POST" }))).status).toBe(415);
  });

  test("serves Prometheus token metrics without auth", async () => {
    const handler = createFetchHandler(makeConfig(), { queue: makeQueue() });
    const response = await handler(new Request("https://reviewer.test/metrics"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const body = await response.text();
    expect(body).toContain('ai_token_exporter_up{agent_instance="jumi"} 1');
    expect((await handler(new Request("https://reviewer.test/metrics", { method: "POST" }))).status).toBe(405);
  });

  test("rejects invalid auth, oversized payloads, and bad signatures", async () => {
    const config = makeConfig({ webhookAuthToken: "auth-token", maxWebhookBytes: 5 });
    const handler = createFetchHandler(config, { queue: makeQueue() });

    expect((await handler(await signedRequest(makePayload()))).status).toBe(401);
    expect(
      (await handler(await signedRequest({ long: "payload" }, { headers: { authorization: "Bearer auth-token" } })))
        .status
    ).toBe(413);

    const badSignatureRequest = await signedRequest(makePayload(), {
      headers: { authorization: "Bearer auth-token" },
      secret: "wrong",
    });
    expect(
      (
        await createFetchHandler(makeConfig({ webhookAuthToken: "auth-token" }), { queue: makeQueue() })(
          badSignatureRequest
        )
      ).status
    ).toBe(401);
  });

  test("skips unsupported events", async () => {
    const handler = createFetchHandler(makeConfig(), { queue: makeQueue() });
    const response = await handler(await signedRequest(makePayload(), { event: "push" }));

    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "unsupported event push" });
  });

  test("enqueues valid pull request events", async () => {
    const queue = makeQueue();
    const handler = createFetchHandler(makeConfig(), { queue });
    const response = await handler(await signedRequest(makePayload()));

    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#7:headsha", queued: true });
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]?.delivery).toBe("delivery-1");
  });

  test("returns bad request for valid signatures with invalid payloads", async () => {
    const handler = createFetchHandler(makeConfig(), { queue: makeQueue() });
    const response = await handler(await signedRequest({ action: "opened" }));

    expect(response.status).toBe(400);
    expect((await responseJson(response)).error).toContain("missing repository");
  });

  test("does not enqueue a stale SHA when GET PR head differs", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob({ headSha: "sha2", prUpdatedAt: "2026-05-23T00:00:01Z" }));
    const handler = createFetchHandler(makeConfig({ role: "router" }), {
      queue: store,
      getPR: async () => makePR({ head: makeBranch({ sha: "sha2" }) }),
    });
    const response = await handler(
      await signedRequest(
        makePayload({
          action: "synchronize",
          pull_request: makePR({
            head: makeBranch({ sha: "sha1" }),
            updated_at: "2026-05-23T00:00:01Z",
          }),
        })
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#7:sha1", queued: false });
    expect(store.rows.find((row) => row.headSha === "sha2")?.state).toBe("queued");
    expect(store.rows.find((row) => row.headSha === "sha1")).toBeUndefined();
  });

  test("enqueues when GET PR fails", async () => {
    const queue = makeQueue();
    const handler = createFetchHandler(makeConfig(), {
      queue,
      getPR: async () => {
        throw new Error("gitea down");
      },
    });
    const response = await handler(await signedRequest(makePayload()));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#7:headsha", queued: true });
    expect(queue.jobs).toHaveLength(1);
  });

  test("router enqueues when GET PR fails", async () => {
    const store = new MemoryReviewJobStore();
    const handler = createFetchHandler(makeConfig({ role: "router" }), {
      queue: store,
      getPR: async () => {
        throw new Error("gitea down");
      },
    });
    const response = await handler(await signedRequest(makePayload()));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#7:headsha", queued: true });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.state).toBe("queued");
  });

  test("returns 503 when the queue backend is down", async () => {
    const handler = createFetchHandler(makeConfig(), {
      queue: {
        enqueue() {
          throw new QueueUnavailableError(new Error("connection refused"));
        },
      },
    });
    const response = await handler(await signedRequest(makePayload()));
    expect(response.status).toBe(503);
    expect(await responseJson(response)).toEqual({ error: "queue unavailable" });
  });

  test("router webhook persists a job and serves queue metrics", async () => {
    const store = new MemoryReviewJobStore();
    const handler = createFetchHandler(makeConfig({ role: "router" }), {
      queue: store,
      renderMetrics: () => renderQueueMetrics(store),
    });
    const response = await handler(await signedRequest(makePayload()));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#7:headsha", queued: true });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.state).toBe("queued");

    const metrics = await handler(new Request("https://reviewer.test/metrics"));
    expect(await metrics.text()).toContain('jumi_review_jobs{state="queued"} 1');
  });

  test("engine does not expose the webhook", async () => {
    const handler = createFetchHandler(makeConfig({ role: "engine" }), {
      queue: makeQueue(),
      webhookEnabled: false,
    });
    expect((await handler(await signedRequest(makePayload()))).status).toBe(404);
  });
});

describe("shouldSeedOpenCodeAuth", () => {
  test("router does not seed OpenCode auth", () => {
    expect(shouldSeedOpenCodeAuth("router")).toBe(false);
    expect(shouldSeedOpenCodeAuth("engine")).toBe(true);
    expect(shouldSeedOpenCodeAuth("monolith")).toBe(true);
  });
});

describe("startReviewer", () => {
  test("router does not call ensureOpenCodeWellKnownAuth", async () => {
    let seeded = 0;
    const store = new MemoryReviewJobStore();
    await startReviewer(makeConfig({ role: "router", databaseUrl: "postgres://unused" }), {
      store,
      listen: false,
      ensureAuth: async () => {
        seeded++;
        return undefined;
      },
    });
    expect(seeded).toBe(0);
  });

  test("engine seeds OpenCode auth and does not spawn OpenCode on boot", async () => {
    let seeded = 0;
    let ran = 0;
    const store = new MemoryReviewJobStore();
    await startReviewer(makeConfig({ role: "engine", databaseUrl: "postgres://unused" }), {
      store,
      listen: false,
      ensureAuth: async () => {
        seeded++;
        return undefined;
      },
      extras: {
        openCodeRunner: async () => {
          ran++;
          return { status: "ok" };
        },
      },
    });
    expect(seeded).toBe(1);
    expect(ran).toBe(0);
  });
});
