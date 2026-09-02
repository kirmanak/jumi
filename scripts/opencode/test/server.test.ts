import { describe, expect, test } from "bun:test";
import type { ReviewQueueLike } from "../src/server.ts";
import { createFetchHandler } from "../src/server.ts";
import type { ReviewJob } from "../src/types.ts";
import { encodeJson, makeConfig, makePayload, responseJson, signBody } from "./fixtures.ts";

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
});
