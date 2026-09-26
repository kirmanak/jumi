import { describe, expect, test } from "bun:test";
import { buildBoardGroups, createBoardFetchHandler } from "../src/board.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import { createFetchHandler } from "../src/server.ts";
import { makeConfig, makeIssueJob, makeJob } from "./fixtures.ts";

function boardRequest(path = "/board", headers: Record<string, string> = {}): Request {
  return new Request(`https://board.test${path}`, { method: "GET", headers: new Headers(headers) });
}

const EDGE_HEADERS = { "X-Forwarded-User": "operator" };

async function seedStore(): Promise<MemoryReviewJobStore> {
  const store = new MemoryReviewJobStore();
  await store.enqueue(makeJob({ delivery: "d-1", prNumber: 7, headSha: "abc123" }));
  await store.enqueueIssue(makeIssueJob({ delivery: "d-2", issueNumber: 12 }));
  // Sits use numbers that do not collide with the enqueued rows above,
  // since enqueue clears the sit for its own number.
  await store.sits.remember("kirmanak", "demo", 21, "ci-not-completed");
  await store.sits.remember("kirmanak", "demo", 22, "no-changes");
  return store;
}

describe("operator board read API", () => {
  test("401 without edge identity, including signature-only", async () => {
    const store = await seedStore();
    const handler = createBoardFetchHandler({ store, getGrantNotice: () => undefined, logger: () => {} });

    const missing = await handler(boardRequest());
    expect(missing.status).toBe(401);
    expect(missing.headers.get("Cache-Control")).toBe("no-store");

    const signatureOnly = await handler(
      boardRequest("/board", {
        "X-Gitea-Signature": "deadbeef",
        Authorization: "Bearer webhook-secret",
      })
    );
    expect(signatureOnly.status).toBe(401);
  });

  test("200 group split with kick present/omitted and commit omitted when unknown", async () => {
    const store = await seedStore();
    const handler = createBoardFetchHandler({ store, getGrantNotice: () => undefined, logger: () => {} });

    const response = await handler(boardRequest("/board", EDGE_HEADERS));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;

    const inProgress = body.in_progress as Record<string, unknown>[];
    const needsKick = body.needs_kick as Record<string, unknown>[];
    const sitting = body.sitting as Record<string, unknown>[];

    expect(inProgress).toHaveLength(2);
    expect(needsKick).toHaveLength(1);
    expect(sitting).toHaveLength(1);

    // Ledger rows carry no kick button.
    for (const item of inProgress) expect(item).not.toHaveProperty("kick");
    // Kickable sit carries a server-provided effect; terminal sit carries none.
    expect(needsKick[0]).toMatchObject({ reason: "ci-not-completed", kick: { effect: expect.any(String) } });
    expect(Object.keys(needsKick[0].kick as object)).toEqual(["effect"]);
    expect(sitting[0]).toMatchObject({ reason: "no-changes" });
    expect(sitting[0]).not.toHaveProperty("kick");

    // Commit known on the review row, omitted on the issue row with no head SHA.
    const withCommit = inProgress.find((item) => item.number === 7);
    expect(withCommit).toMatchObject({ commit: "abc123", headSha: "abc123" });
    const withoutCommit = inProgress.find((item) => item.number === 12);
    expect(withCommit).toBeDefined();
    expect(withoutCommit).toBeDefined();
    expect(withoutCommit).not.toHaveProperty("commit");
    expect(withoutCommit).not.toHaveProperty("headSha");

    // No tokens, secrets, or raw payloads leak into items.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("bot-token");
    expect(raw).not.toContain("webhook-secret");
    for (const item of [...inProgress, ...needsKick, ...sitting]) {
      expect(item).not.toHaveProperty("payload");
      expect(item).not.toHaveProperty("resultMarkdown");
    }

    // CamelCase aliases match by value but share no reference with the canonical groups.
    expect(body.inProgress).toEqual(inProgress);
    expect(body.needsKick).toEqual(needsKick);
    expect(body.sitting_on_purpose).toEqual(sitting);
    expect(body.inProgress).not.toBe(inProgress);
    expect(body.needsKick).not.toBe(needsKick);
    expect(body.sitting_on_purpose).not.toBe(sitting);

    // Single trailing slash serves instead of 404.
    const slashed = await handler(boardRequest("/board/", EDGE_HEADERS));
    expect(slashed.status).toBe(200);
  });

  test("buildBoardGroups splits sits without per-row forge calls", async () => {
    const store = await seedStore();
    const groups = await buildBoardGroups(store);
    expect(groups.in_progress).toHaveLength(2);
    expect(groups.needs_kick.map((item) => item.reason)).toEqual(["ci-not-completed"]);
    expect(groups.sitting.map((item) => item.reason)).toEqual(["no-changes"]);
  });

  test("board paths stay 404 on the webhook host", async () => {
    const handler = createFetchHandler(makeConfig(), {
      queue: {
        enqueue: () => ({ key: "k", queued: true }),
      },
    });
    expect((await handler(new Request("https://reviewer.test/board"))).status).toBe(404);
    expect((await handler(new Request("https://reviewer.test/api/board"))).status).toBe(404);
  });

  test("ledger failure is 503 with no cached list", async () => {
    const failing = {
      listInflight: async (): Promise<never[]> => {
        throw new Error("db down");
      },
      sits: { list: async () => [] },
    };
    const handler = createBoardFetchHandler({
      store: failing as unknown as MemoryReviewJobStore,
      getGrantNotice: () => undefined,
      logger: () => {},
    });
    const response = await handler(boardRequest("/board", EDGE_HEADERS));
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "queue unavailable" });
  });
});
