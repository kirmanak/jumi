import { describe, expect, test } from "bun:test";
import { enqueueFollowUpFromReview, shouldHandoverFollowUp } from "../src/handover.ts";
import type { ReviewApi } from "../src/review.ts";
import { MemoryReviewJobStore, WORKER_JOB_KINDS } from "../src/review_jobs.ts";
import { makeComment, makeIssue, makeIssueJob, makeJob, makePR, makeRepo, makeUser } from "./fixtures.ts";

function makeApi(overrides: Partial<ReviewApi> = {}): ReviewApi {
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
    createIssueComment: async (_owner, _repo, _index, body) => makeComment({ body }),
    updateIssueComment: async (_owner, _repo, commentId, body) => makeComment({ id: commentId, body }),
    createCommitStatus: async (_owner, _repo, _sha, status) => status,
  };
  return { ...defaults, ...overrides };
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
    const result = await enqueueFollowUpFromReview({
      store,
      api: makeApi(),
      row: leased!,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "Please fix tests\n<!-- jumi-check: failure -->",
    });
    expect(result).toEqual({ key: "follow-up:kirmanak/demo#7:headsha", queued: true });
    const follow = store.rows.find((row) => row.kind === "follow-up");
    expect(follow?.state).toBe("queued");
    expect(follow?.issueNumber).toBe(12);
    expect(follow?.prNumber).toBe(7);
    expect(follow?.headSha).toBe("headsha");
    expect(follow?.payload?.title).toBe("Fix the thing");
  });

  test("does not insert when the issue is unassigned", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000);
    const result = await enqueueFollowUpFromReview({
      store,
      api: makeApi({
        getIssue: async () => makeIssue({ assignee: makeUser({ login: "alice" }), assignees: [] }),
      }),
      row: leased!,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "blocking\n<!-- jumi-check: failure -->",
    });
    expect(result).toBeUndefined();
    expect(store.rows.some((row) => row.kind === "follow-up")).toBe(false);
  });

  test("does not insert when HEAD moved", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000);
    const result = await enqueueFollowUpFromReview({
      store,
      api: makeApi({
        getPR: async () => makePR({ body: "Fixes #12", head: { ...makePR().head, sha: "other" } }),
      }),
      row: leased!,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "blocking\n<!-- jumi-check: failure -->",
    });
    expect(result).toBeUndefined();
  });

  test("follow-up cap sticks at configured maxFollowupRounds, not only 3", async () => {
    const store = new MemoryReviewJobStore();
    for (const sha of ["sha1", "sha2", "sha3"]) {
      await store.enqueueIssue(
        makeIssueJob({ mode: "follow-up", issueNumber: 12, prNumber: 7, headSha: sha, delivery: sha })
      );
      const leased = await store.lease("worker-1", 60_000, undefined, WORKER_JOB_KINDS);
      await store.markPublished(leased!.id, leased!.leasedBy!, { state: "succeeded" });
    }
    await store.enqueue(makeJob());
    const review = await store.lease("engine-1", 60_000);
    const blocked = await enqueueFollowUpFromReview({
      store,
      api: makeApi(),
      row: review!,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "blocking\n<!-- jumi-check: failure -->",
    });
    expect(blocked).toBeUndefined();
    const allowed = await enqueueFollowUpFromReview({
      store,
      api: makeApi(),
      row: review!,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "blocking\n<!-- jumi-check: failure -->",
      maxFollowupRounds: 5,
    });
    expect(allowed).toEqual({ key: "follow-up:kirmanak/demo#7:headsha", queued: true });
  });

  test("does not insert without a closing issue", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const leased = await store.lease("engine-1", 60_000);
    const result = await enqueueFollowUpFromReview({
      store,
      api: makeApi({ getPR: async () => makePR({ body: "no close keyword" }) }),
      row: leased!,
      botUsername: "jumi",
      published: { status: "posted", commentId: 1 },
      markdown: "blocking\n<!-- jumi-check: failure -->",
    });
    expect(result).toBeUndefined();
  });
});
