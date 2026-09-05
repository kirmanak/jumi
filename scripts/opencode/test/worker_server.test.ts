import { describe, expect, test } from "bun:test";
import type { IssueJob } from "../src/types.ts";
import type { WorkerQueueLike } from "../src/worker.ts";
import { createWorkerFetchHandler } from "../src/worker_server.ts";
import {
  encodeJson,
  makeIssue,
  makeIssuePayload,
  makeUser,
  makeWorkerConfig,
  responseJson,
  signBody,
} from "./fixtures.ts";

function makeQueue(): WorkerQueueLike & { jobs: IssueJob[] } {
  const jobs: IssueJob[] = [];
  return {
    jobs,
    enqueue(job) {
      jobs.push(job);
      return { key: `${job.owner}/${job.repo}#${job.issueNumber}`, queued: true };
    },
  };
}

async function signedRequest(
  body: unknown,
  overrides: RequestInit & { event?: string; eventType?: string; secret?: string } = {}
): Promise<Request> {
  const raw = encodeJson(body);
  const secret = overrides.secret ?? "webhook-secret";
  const signature = await signBody(raw, secret);
  const headers = new Headers(overrides.headers);
  headers.set("content-type", "application/json");
  headers.set("x-gitea-signature", signature);
  headers.set("x-gitea-event", overrides.event ?? "issues");
  if (overrides.eventType) headers.set("x-gitea-event-type", overrides.eventType);
  headers.set("x-gitea-delivery", "delivery-1");
  return new Request("https://worker.test/webhooks/gitea", {
    method: overrides.method ?? "POST",
    body: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
    headers,
  });
}

describe("createWorkerFetchHandler", () => {
  test("serves healthz and basic HTTP errors", async () => {
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue: makeQueue() });

    expect((await handler(new Request("https://worker.test/healthz"))).status).toBe(200);
    expect(await responseJson(await handler(new Request("https://worker.test/healthz")))).toEqual({ ok: true });
    expect((await handler(new Request("https://worker.test/missing"))).status).toBe(404);
    expect((await handler(new Request("https://worker.test/webhooks/gitea"))).status).toBe(405);
    expect((await handler(new Request("https://worker.test/webhooks/gitea", { method: "POST" }))).status).toBe(415);
  });

  test("serves Prometheus token metrics without auth", async () => {
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue: makeQueue() });
    const response = await handler(new Request("https://worker.test/metrics"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const body = await response.text();
    expect(body).toContain("ai_token_exporter_up");
    expect((await handler(new Request("https://worker.test/metrics", { method: "POST" }))).status).toBe(405);
  });

  test("rejects invalid signatures", async () => {
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue: makeQueue() });
    expect((await handler(await signedRequest(makeIssuePayload(), { secret: "wrong" }))).status).toBe(401);
  });

  test("returns ok for ping events", async () => {
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue: makeQueue() });
    const response = await handler(await signedRequest({ zen: "pong" }, { event: "ping" }));
    expect(response.status).toBe(200);
    expect(await responseJson(response)).toEqual({ ok: true });
  });

  test("skips unsupported events", async () => {
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue: makeQueue() });
    const response = await handler(await signedRequest(makeIssuePayload(), { event: "push" }));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "unsupported event push" });
  });

  test("enqueues Gitea issue_assign deliveries (Event=issues, Event-Type=issue_assign)", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue });
    const response = await handler(
      await signedRequest(makeIssuePayload({ action: "assigned" }), { event: "issues", eventType: "issue_assign" })
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#12", queued: true });
    expect(queue.jobs).toHaveLength(1);
  });

  test("enqueues assigned issue events", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue });
    const response = await handler(await signedRequest(makeIssuePayload()));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#12", queued: true });
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]?.delivery).toBe("delivery-1");
    expect(queue.jobs[0]?.issueNumber).toBe(12);
  });

  test("cancels when the bot is unassigned", async () => {
    const cancelled: Array<{ owner: string; repo: string; issueNumber: number }> = [];
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue: makeQueue(),
      cancel: async (owner, repo, issueNumber) => {
        cancelled.push({ owner, repo, issueNumber });
        return { key: `${owner}/${repo}#${issueNumber}`, cancelled: true };
      },
    });
    const response = await handler(
      await signedRequest(
        makeIssuePayload({
          action: "unassigned",
          issue: makeIssue({ assignee: makeUser({ login: "alice" }), assignees: [makeUser({ login: "alice" })] }),
        })
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#12", cancelled: true });
    expect(cancelled).toEqual([{ owner: "kirmanak", repo: "demo", issueNumber: 12 }]);
  });

  test("skips pull request issues", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue });
    const response = await handler(
      await signedRequest(makeIssuePayload({ issue: makeIssue({ pull_request: { merged_at: null } }) }))
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "pull request issue" });
    expect(queue.jobs).toHaveLength(0);
  });

  test("returns bad request for valid signatures with invalid payloads", async () => {
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue: makeQueue() });
    const response = await handler(await signedRequest({ action: "assigned" }));
    expect(response.status).toBe(400);
    expect((await responseJson(response)).error).toContain("missing repository");
  });
});
