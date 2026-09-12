import { describe, expect, test } from "bun:test";
import { enqueueFollowUpFromReview, shouldHandoverFollowUp, TOO_MANY_FOLLOWUP_ROUNDS } from "../src/handover.ts";
import type { ReviewApi } from "../src/review.ts";
import { MemoryReviewJobStore, WORKER_JOB_KINDS } from "../src/review_jobs.ts";
import { stuckMarker } from "../src/stuck.ts";
import { makeComment, makeIssue, makeIssueJob, makeJob, makePR, makeRepo, makeUser } from "./fixtures.ts";

function makeApi(overrides: Partial<ReviewApi> = {}): ReviewApi & { comments: string[] } {
  const comments: string[] = [];
  const defaults: ReviewApi = {
    getRepo: async () => makeRepo(),
    getPR: async () =>
      makePR({
        body: "Fixes #12",
        user: makeUser({ login: "jumi" }),
        head: { ...makePR().head, ref: "jumi/issue-12-fix", sha: "headsha" },
      }),
    getPRFiles: async () => [],
    getIssue: async () => makeIssue(),
    listIssueComments: async () => [],
    findStickyIssueComment: async () => undefined,
    createIssueComment: async (_owner, _repo, _index, body) => {
      comments.push(body);
      return makeComment({ body });
    },
    updateIssueComment: async (_owner, _repo, commentId, body) => {
      comments.push(body);
      return makeComment({ id: commentId, body });
    },
    listPullReviewComments: async () => [],
    listPullReviews: async () => [],
    createPullReview: async () => ({ id: 1 }),
    submitPullReview: async () => ({ id: 1 }),
    resolvePullComment: async () => undefined,
    unresolvePullComment: async () => undefined,
    dismissPullReview: async () => ({ id: 1 }),
    createCommitStatus: async (_owner, _repo, _sha, status) => status,
  };
  return { ...defaults, ...overrides, comments };
}

async function seedSucceededFollowUps(store: MemoryReviewJobStore, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await store.enqueueIssue(
      makeIssueJob({
        mode: "follow-up",
        issueNumber: 12,
        prNumber: 7,
        headSha: `sha${i}`,
        delivery: `follow-${i}`,
      })
    );
    const leased = await store.lease("worker-1", 60_000, undefined, WORKER_JOB_KINDS);
    await store.markPublished(leased!.id, leased!.leasedBy!, { state: "succeeded" });
  }
}

describe("shouldHandoverFollowUp", () => {
  test("only current-head failure trailer on a published sticky", () => {
    expect(
      shouldHandoverFollowUp({
        published: { status: "posted" },
        markdown: "blocking\n<!-- jumi-check: failure -->",
      })
    ).toBe(true);
    expect(
      shouldHandoverFollowUp({
        published: { status: "updated" },
        markdown: "blocking\n<!-- jumi-check: failure; 1 blocking -->",
      })
    ).toBe(true);
    expect(
      shouldHandoverFollowUp({
        published: { status: "posted" },
        markdown: "ok\n<!-- jumi-check: success -->",
      })
    ).toBe(false);
    expect(
      shouldHandoverFollowUp({
        published: { status: "posted" },
        markdown: "no trailer",
      })
    ).toBe(false);
    expect(
      shouldHandoverFollowUp({
        published: { status: "skipped", reason: "Incomplete review: no output" },
        markdown: "blocking\n<!-- jumi-check: failure -->",
      })
    ).toBe(false);
    expect(
      shouldHandoverFollowUp({
        published: { status: "posted" },
        markdown: "",
      })
    ).toBe(false);
  });
});

describe("enqueueFollowUpFromReview", () => {
  test("inserts a follow-up job when the closing issue is still assigned to jumi", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000);
    const api = makeApi();
    const logs: string[] = [];
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row: leased!,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "Please fix tests\n<!-- jumi-check: failure -->",
      logger: (message) => logs.push(message),
    });
    expect(result).toEqual({ key: "follow-up:kirmanak/demo#7:headsha", queued: true });
    const follow = store.rows.find((row) => row.kind === "follow-up");
    expect(follow?.state).toBe("queued");
    expect(follow?.issueNumber).toBe(12);
    expect(follow?.prNumber).toBe(7);
    expect(follow?.headSha).toBe("headsha");
    expect(follow?.payload?.title).toBe("Fix the thing");
    expect(api.comments).toEqual([]);
    expect(logs.some((line) => line.includes("persist-insert skipped"))).toBe(false);
  });

  test("does not insert when the issue is unassigned", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000);
    const api = makeApi({
      getIssue: async () => makeIssue({ assignee: makeUser({ login: "alice" }), assignees: [] }),
    });
    const logs: string[] = [];
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row: leased!,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "blocking\n<!-- jumi-check: failure -->",
      logger: (message) => logs.push(message),
    });
    expect(result).toBeUndefined();
    expect(store.rows.some((row) => row.kind === "follow-up")).toBe(false);
    expect(api.comments).toEqual([]);
    expect(logs).toEqual(["persist-insert skipped: unassigned"]);
  });

  test("does not insert when HEAD moved", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000);
    const api = makeApi({
      getPR: async () => makePR({ body: "Fixes #12", head: { ...makePR().head, sha: "other" } }),
    });
    const logs: string[] = [];
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row: leased!,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "blocking\n<!-- jumi-check: failure -->",
      logger: (message) => logs.push(message),
    });
    expect(result).toBeUndefined();
    expect(store.rows.some((row) => row.kind === "follow-up")).toBe(false);
    expect(api.comments).toEqual([]);
    expect(logs).toEqual(["persist-insert skipped: head moved"]);
  });

  test("failure trailer at follow-up cap posts stuck and does not enqueue", async () => {
    const store = new MemoryReviewJobStore();
    await seedSucceededFollowUps(store, 3);
    await store.enqueue(makeJob());
    const review = await store.lease("engine-1", 60_000);
    const api = makeApi();
    const logs: string[] = [];
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row: review!,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "blocking\n<!-- jumi-check: failure -->",
      logger: (message) => logs.push(message),
    });
    expect(result).toBeUndefined();
    expect(store.rows.filter((row) => row.kind === "follow-up" && row.state === "queued")).toHaveLength(0);
    expect(api.comments).toEqual([`${stuckMarker("kirmanak", "demo", 7)}\n${TOO_MANY_FOLLOWUP_ROUNDS}`]);
    expect(logs).toEqual(["persist-insert skipped: round cap"]);
  });

  test("failure trailer below maxFollowupRounds enqueues and does not post stuck", async () => {
    const store = new MemoryReviewJobStore();
    await seedSucceededFollowUps(store, 2);
    await store.enqueue(makeJob());
    const review = await store.lease("engine-1", 60_000);
    const api = makeApi();
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row: review!,
      botUsername: "jumi",
      published: { status: "updated", commentId: 1 },
      markdown: "blocking\n<!-- jumi-check: failure -->",
    });
    expect(result).toEqual({ key: "follow-up:kirmanak/demo#7:headsha", queued: true });
    expect(api.comments).toEqual([]);
  });

  test("follow-up cap sticks at configured maxFollowupRounds, not only 3", async () => {
    const store = new MemoryReviewJobStore();
    await seedSucceededFollowUps(store, 3);
    await store.enqueue(makeJob());
    const review = await store.lease("engine-1", 60_000);
    const blockedApi = makeApi();
    const blocked = await enqueueFollowUpFromReview({
      store,
      api: blockedApi,
      row: review!,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "blocking\n<!-- jumi-check: failure -->",
    });
    expect(blocked).toBeUndefined();
    expect(blockedApi.comments.at(-1)).toContain(TOO_MANY_FOLLOWUP_ROUNDS);
    const allowedApi = makeApi();
    const allowed = await enqueueFollowUpFromReview({
      store,
      api: allowedApi,
      row: review!,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "blocking\n<!-- jumi-check: failure -->",
      maxFollowupRounds: 5,
    });
    expect(allowed).toEqual({ key: "follow-up:kirmanak/demo#7:headsha", queued: true });
    expect(allowedApi.comments).toEqual([]);
  });

  test("does not insert without a closing issue", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000);
    const api = makeApi({ getPR: async () => makePR({ body: "no close keyword" }) });
    const logs: string[] = [];
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row: leased!,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "blocking\n<!-- jumi-check: failure -->",
      logger: (message) => logs.push(message),
    });
    expect(result).toBeUndefined();
    expect(store.rows.some((row) => row.kind === "follow-up")).toBe(false);
    expect(api.comments).toEqual([]);
    expect(logs).toEqual(["persist-insert skipped: no closer"]);
  });

  test("success trailer neither enqueues nor posts stuck", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000);
    const api = makeApi();
    const logs: string[] = [];
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row: leased!,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "ok\n<!-- jumi-check: success -->",
      logger: (message) => logs.push(message),
    });
    expect(result).toBeUndefined();
    expect(store.rows.some((row) => row.kind === "follow-up")).toBe(false);
    expect(api.comments).toEqual([]);
    expect(logs).toEqual(["persist-insert skipped: success trailer"]);
  });

  test("incomplete review neither enqueues nor posts stuck", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000);
    const api = makeApi();
    const logs: string[] = [];
    const result = await enqueueFollowUpFromReview({
      store,
      api,
      row: leased!,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "no trailer",
      logger: (message) => logs.push(message),
    });
    expect(result).toBeUndefined();
    expect(store.rows.some((row) => row.kind === "follow-up")).toBe(false);
    expect(api.comments).toEqual([]);
    expect(logs).toEqual(["persist-insert skipped: incomplete"]);
  });

  test("round cap does not unassign the issue", async () => {
    const store = new MemoryReviewJobStore();
    await seedSucceededFollowUps(store, 3);
    await store.enqueue(makeJob());
    const review = await store.lease("engine-1", 60_000);
    const issue = makeIssue();
    const api = makeApi({
      getIssue: async () => issue,
    });
    await enqueueFollowUpFromReview({
      store,
      api,
      row: review!,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "blocking\n<!-- jumi-check: failure -->",
    });
    expect(issue.assignee?.login).toBe("jumi");
    expect(issue.assignees?.map((user) => user.login)).toEqual(["jumi"]);
    expect(api.comments.some((body) => body.includes("unassign"))).toBe(false);
  });
});
