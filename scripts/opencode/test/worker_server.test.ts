import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MemoryReviewJobStore, QueueUnavailableError } from "../src/review_jobs.ts";
import type { IssueJob } from "../src/types.ts";
import type { WorkerQueueLike } from "../src/worker.ts";
import { createWorkerFetchHandler } from "../src/worker_server.ts";
import {
  encodeJson,
  makeIssue,
  makeIssuePayload,
  makePayload,
  makePR,
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
    const logs: string[] = [];
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue: makeQueue(),
      logger: (message) => logs.push(message),
    });
    const response = await handler(await signedRequest(makeIssuePayload(), { event: "status" }));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "unsupported event status" });
    expect(logs.some((line) => line.includes("skipped unsupported event status"))).toBe(true);
  });

  test("does not scan on a timer or at boot", async () => {
    const src = await readFile(join(import.meta.dir, "../src/worker_server.ts"), "utf8");
    expect(src).not.toContain("runAssignedIssueScan");
    expect(src).not.toContain("scanIntervalMs");
    expect(src).not.toContain("scanAssignedIssues");
    const worker = await readFile(join(import.meta.dir, "../src/worker.ts"), "utf8");
    expect(worker).not.toContain("searchAssignedIssues");
    expect(worker).not.toContain("scanAssignedIssues");
  });

  test("skips X-Gitea-Event: pull_request opened", async () => {
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue: makeQueue() });
    const response = await handler(await signedRequest(makePayload(), { event: "pull_request" }));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "unsupported action opened" });
  });

  test("skips pull_request synchronize 202 never 400", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue });
    const response = await handler(
      await signedRequest(makePayload({ action: "synchronize" }), { event: "pull_request" })
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "unsupported action synchronize" });
    expect(queue.jobs).toHaveLength(0);
  });

  test("skips malformed non-assign pull_request 202 never 400", async () => {
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue: makeQueue() });
    const response = await handler(await signedRequest({ action: "opened" }, { event: "pull_request" }));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "unsupported action opened" });
  });

  test("enqueues follow-up when a foreign PR is assigned to the bot", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue });
    const repository = makePayload().repository;
    const response = await handler(
      await signedRequest(
        makePayload({
          action: "assigned",
          pull_request: makePR({
            number: 50,
            title: "chore(deps)",
            body: "",
            user: makeUser({ login: "renovate" }),
            assignee: makeUser({ login: "jumi" }),
            assignees: [makeUser({ login: "jumi" })],
            html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/50",
            head: {
              label: "kirmanak:renovate/all-digest",
              ref: "renovate/all-digest",
              sha: "headsha",
              repo: repository,
              repo_id: repository.id,
            },
          }),
        }),
        { event: "pull_request", eventType: "pull_request_assign" }
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#50", queued: true });
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]?.mode).toBe("follow-up");
    expect(queue.jobs[0]?.issueNumber).toBe(50);
    expect(queue.jobs[0]?.prNumber).toBe(50);
  });

  test("skips PR-assign when the closing issue is already assigned to the bot", async () => {
    const queue = makeQueue();
    const cancelled: Array<{ owner: string; repo: string; issueNumber: number }> = [];
    const loaded: number[] = [];
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue,
      api: {
        listOpenPulls: async () => [],
        getIssue: async (_owner, _repo, index) => {
          loaded.push(index);
          return makeIssue();
        },
      },
      cancel: async (owner, repo, issueNumber) => {
        cancelled.push({ owner, repo, issueNumber });
        return { key: `${owner}/${repo}#${issueNumber}`, cancelled: true };
      },
    });
    const repository = makePayload().repository;
    const response = await handler(
      await signedRequest(
        makePayload({
          action: "assigned",
          pull_request: makePR({
            number: 127,
            title: "Fix the thing",
            body: "Fixes #12",
            user: makeUser({ login: "jumi" }),
            assignee: makeUser({ login: "jumi" }),
            assignees: [makeUser({ login: "jumi" })],
            html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/127",
            head: {
              label: "kirmanak:jumi/issue-12-fix-the-thing",
              ref: "jumi/issue-12-fix-the-thing",
              sha: "headsha",
              repo: repository,
              repo_id: repository.id,
            },
          }),
        }),
        { event: "pull_request", eventType: "pull_request_assign" }
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "closing issue already assigned" });
    expect(queue.jobs).toHaveLength(0);
    expect(cancelled).toEqual([]);
    expect(loaded).toEqual([12]);
  });

  test("skips PR-assign when getIssue of the closer fails", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue,
      api: {
        listOpenPulls: async () => [],
        getIssue: async () => {
          throw new Error("gitea 502");
        },
      },
    });
    const repository = makePayload().repository;
    const response = await handler(
      await signedRequest(
        makePayload({
          action: "assigned",
          pull_request: makePR({
            number: 127,
            title: "Fix the thing",
            body: "Fixes #12",
            user: makeUser({ login: "jumi" }),
            assignee: makeUser({ login: "jumi" }),
            assignees: [makeUser({ login: "jumi" })],
            html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/127",
            head: {
              label: "kirmanak:jumi/issue-12-fix-the-thing",
              ref: "jumi/issue-12-fix-the-thing",
              sha: "headsha",
              repo: repository,
              repo_id: repository.id,
            },
          }),
        }),
        { event: "pull_request", eventType: "pull_request_assign" }
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "failed to load issue: gitea 502" });
    expect(queue.jobs).toHaveLength(0);
  });

  test("cancels when a foreign PR is unassigned from the bot", async () => {
    const cancelled: Array<{ owner: string; repo: string; issueNumber: number }> = [];
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue: makeQueue(),
      cancel: async (owner, repo, issueNumber) => {
        cancelled.push({ owner, repo, issueNumber });
        return { key: `${owner}/${repo}#${issueNumber}`, cancelled: true };
      },
    });
    const repository = makePayload().repository;
    const response = await handler(
      await signedRequest(
        makePayload({
          action: "unassigned",
          pull_request: makePR({
            number: 50,
            user: makeUser({ login: "renovate" }),
            assignee: makeUser({ login: "alice" }),
            assignees: [makeUser({ login: "alice" })],
            head: {
              label: "kirmanak:renovate/all-digest",
              ref: "renovate/all-digest",
              sha: "headsha",
              repo: repository,
              repo_id: repository.id,
            },
          }),
        }),
        { event: "pull_request", eventType: "pull_request_assign" }
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#50", cancelled: true });
    expect(cancelled).toEqual([{ owner: "kirmanak", repo: "demo", issueNumber: 50 }]);
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

  test("first-run assign still 202s on the in-memory queue without a store", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue });
    const response = await handler(await signedRequest(makeIssuePayload({ action: "assigned" })));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#12", queued: true });
    expect(queue.jobs[0]?.mode).toBeUndefined();
  });

  test("ledger enqueue uses the implement job key", async () => {
    const store = new MemoryReviewJobStore();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue: { enqueue: (job) => store.enqueueIssue(job) },
    });
    const response = await handler(await signedRequest(makeIssuePayload({ action: "assigned" })));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "implement:kirmanak/demo#12", queued: true });
    expect(store.rows[0]?.kind).toBe("implement");
    expect(store.rows[0]?.state).toBe("queued");
  });

  test("fails closed with 503 when the ledger is unavailable", async () => {
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue: {
        enqueue() {
          throw new QueueUnavailableError("down");
        },
      },
    });
    const response = await handler(await signedRequest(makeIssuePayload({ action: "assigned" })));
    expect(response.status).toBe(503);
    expect(await responseJson(response)).toEqual({ error: "queue unavailable" });
  });
});
