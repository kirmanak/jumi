import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IssueApi } from "../src/gitea_issues.ts";
import type { ReviewApi } from "../src/review.ts";
import { MemoryReviewJobStore, REVIEW_KIND, WORKER_JOB_KINDS, workerJobKey } from "../src/review_jobs.ts";
import { processEngineTick } from "../src/server.ts";
import { processWorkerTick } from "../src/worker.ts";
import {
  emptyCiMethods,
  makeComment,
  makeConfig,
  makeIssue,
  makeIssueJob,
  makeJob,
  makePR,
  makeRepo,
  makeUser,
  makeWorkerConfig,
} from "./fixtures.ts";

function makeReviewApi(overrides: Partial<ReviewApi> = {}): ReviewApi & { comments: string[] } {
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
    createCommitStatus: async (_owner, _repo, _sha, status) => status,
  };
  return { ...defaults, ...overrides, comments };
}

function makeIssueApi(overrides: Partial<IssueApi> = {}): IssueApi {
  const defaults: IssueApi = {
    getRepo: async () => makeRepo(),
    getIssue: async () => makeIssue(),
    listOpenPulls: async () => [],
    createPullRequest: async (_owner, _repo, pull) => makePR({ title: pull.title, body: pull.body }),
    searchAssignedIssues: async () => [],
    findStickyIssueComment: async () => undefined,
    createIssueComment: async (_owner, _repo, _index, body) => makeComment({ body }),
    updateIssueComment: async (_owner, _repo, _id, body) => makeComment({ body }),
    listIssueComments: async () => [],
    listPullReviewComments: async () => [],
    listPullReviews: async () => [],
    ...emptyCiMethods(),
  };
  return { ...defaults, ...overrides };
}

describe("job envelope kinds", () => {
  test("reviewer lease skips implement jobs; worker lease skips reviews", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    await store.enqueueIssue(makeIssueJob());
    const review = await store.lease("engine-1", 60_000, undefined, [REVIEW_KIND]);
    expect(review?.kind).toBe("review");
    expect(review?.jobKey).toBe("kirmanak/demo#7:headsha");
    const worker = await store.lease("worker-1", 60_000, undefined, WORKER_JOB_KINDS);
    expect(worker?.kind).toBe("implement");
    expect(worker?.jobKey).toBe("implement:kirmanak/demo#12");
    expect(await store.lease("engine-2", 60_000, undefined, [REVIEW_KIND])).toBeUndefined();
  });

  test("new follow-up SHA cancels queued predecessor for that PR", async () => {
    const store = new MemoryReviewJobStore();
    expect(await store.enqueueIssue(makeIssueJob({ mode: "follow-up", prNumber: 7, headSha: "old" }))).toEqual({
      key: "follow-up:kirmanak/demo#7:old",
      queued: true,
    });
    expect(await store.enqueueIssue(makeIssueJob({ mode: "follow-up", prNumber: 7, headSha: "new" }))).toEqual({
      key: "follow-up:kirmanak/demo#7:new",
      queued: true,
    });
    expect(store.rows.find((row) => row.headSha === "old")?.state).toBe("cancelled");
    expect(store.rows.find((row) => row.headSha === "new")?.state).toBe("queued");
  });

  test("review enqueue does not cancel a queued follow-up", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueueIssue(makeIssueJob({ mode: "follow-up", prNumber: 7, headSha: "headsha" }));
    await store.enqueue(makeJob({ headSha: "other" }));
    expect(store.rows.find((row) => row.kind === "follow-up")?.state).toBe("queued");
    expect(store.rows.find((row) => row.kind === "review" && row.headSha === "other")?.state).toBe("queued");
  });

  test("succeeded implement keeps identity and is not re-enqueued", async () => {
    const store = new MemoryReviewJobStore();
    const job = makeIssueJob();
    expect(await store.enqueueIssue(job)).toEqual({ key: workerJobKey(job), queued: true });
    const leased = await store.lease("worker-1", 60_000, undefined, WORKER_JOB_KINDS);
    await store.markPublished(leased!.id, "worker-1", { state: "succeeded" });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.state).toBe("succeeded");
    expect(store.rows[0]?.kind).toBe("implement");
    expect(await store.enqueueIssue(job)).toEqual({ key: workerJobKey(job), queued: false });
    expect(store.rows).toHaveLength(1);
  });

  test("human comment follow-up lands on the same envelope", async () => {
    const store = new MemoryReviewJobStore();
    const result = await store.enqueueIssue(
      makeIssueJob({
        mode: "follow-up",
        prNumber: 7,
        headSha: "headsha",
        trigger: { event: "issue_comment", commentId: 55, sender: "alice" },
      })
    );
    expect(result.queued).toBe(true);
    expect(store.rows[0]?.kind).toBe("follow-up");
    expect(store.rows[0]?.payload?.trigger?.commentId).toBe(55);
  });
});

describe("review failure handover to worker lease", () => {
  test("failure trailer insert then worker lease runs follow-up; first-run keeps identity", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "jumi-jobs-"));
    try {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      const api = makeReviewApi();
      await processEngineTick(store, makeConfig({ workdir: workspace }), api, "engine-1", {
        gitRunner: async (args) => {
          if (args[0] === "rev-parse") return "headsha";
          if (args[0] === "status") return "?? JUMI_REVIEW.md";
          throw new Error(`unexpected git ${args.join(" ")}`);
        },
        workspacePreparer: async () => undefined,
        openCodeRunner: async (_prompt, opts) => {
          await writeFile(join(opts.workdir, "JUMI_REVIEW.md"), "Please fix tests\n<!-- jumi-check: failure -->");
          return "stdout";
        },
      });
      expect(store.rows.find((row) => row.kind === "review")?.state).toBe("succeeded");
      const follow = store.rows.find((row) => row.kind === "follow-up");
      expect(follow?.state).toBe("queued");
      expect(follow?.jobKey).toBe("follow-up:kirmanak/demo#7:headsha");

      let ranFollowUp = 0;
      await processWorkerTick(store, makeWorkerConfig(), makeIssueApi(), "worker-1", {
        followUp: async () => {
          ranFollowUp++;
          return { status: "pushed", prNumber: 7, htmlUrl: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/7" };
        },
      });
      expect(ranFollowUp).toBe(1);
      expect(store.rows.find((row) => row.kind === "follow-up")?.state).toBe("succeeded");

      await store.enqueueIssue(makeIssueJob());
      let ranImplement = 0;
      await processWorkerTick(store, makeWorkerConfig(), makeIssueApi(), "worker-1", {
        implement: async () => {
          ranImplement++;
          return { status: "pr", prNumber: 3, htmlUrl: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/3" };
        },
      });
      expect(ranImplement).toBe(1);
      const implement = store.rows.find((row) => row.kind === "implement");
      expect(implement?.state).toBe("succeeded");
      expect(store.rows.filter((row) => row.kind === "implement")).toHaveLength(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("success trailer does not insert follow-up", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "jumi-jobs-ok-"));
    try {
      const store = new MemoryReviewJobStore();
      await store.enqueue(makeJob());
      await processEngineTick(store, makeConfig({ workdir: workspace }), makeReviewApi(), "engine-1", {
        gitRunner: async (args) => {
          if (args[0] === "rev-parse") return "headsha";
          if (args[0] === "status") return "?? JUMI_REVIEW.md";
          throw new Error(`unexpected git ${args.join(" ")}`);
        },
        workspacePreparer: async () => undefined,
        openCodeRunner: async (_prompt, opts) => {
          await writeFile(join(opts.workdir, "JUMI_REVIEW.md"), "Looks good\n<!-- jumi-check: success -->");
          return "stdout";
        },
      });
      expect(store.rows.some((row) => row.kind === "follow-up")).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
