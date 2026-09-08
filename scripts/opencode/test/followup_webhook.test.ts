import { describe, expect, test } from "bun:test";
import {
  followUpSkipReason,
  shouldEnqueueIssueCommentFollowUp,
  shouldEnqueuePullAssign,
  shouldEnqueuePullRejectedFollowUp,
} from "../src/followup_webhook.ts";
import type { IssueJob } from "../src/types.ts";
import type { WorkerQueueLike } from "../src/worker.ts";
import { createWorkerFetchHandler } from "../src/worker_server.ts";
import {
  encodeJson,
  makeIssue,
  makeIssueCommentPayload,
  makePayload,
  makePR,
  makeRepo,
  makeUser,
  makeWorkerConfig,
  responseJson,
  signBody,
} from "./fixtures.ts";

const policy = {
  giteaUrl: "https://gitea.kirmanak.stream",
  allowedOrgs: ["kirmanak"],
  allowedRepos: [],
  botUsername: "jumi",
};

function reviewCommentPayload() {
  return makePayload({
    action: "reviewed",
    pull_request: makePR({
      user: makeUser({ login: "jumi" }),
      body: "Fixes #12",
      head: {
        label: "kirmanak:jumi/issue-12-fix-the-thing",
        ref: "jumi/issue-12-fix-the-thing",
        sha: "headsha",
        repo: makePayload().repository,
        repo_id: 10,
      },
    }),
    review: { id: 9, body: "please change this" },
  });
}

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
  headers.set("x-gitea-event", overrides.event ?? "issue_comment");
  if (overrides.eventType) headers.set("x-gitea-event-type", overrides.eventType);
  headers.set("x-gitea-delivery", "delivery-1");
  return new Request("https://worker.test/webhooks/gitea", {
    method: overrides.method ?? "POST",
    body: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
    headers,
  });
}

describe("shouldEnqueueIssueCommentFollowUp", () => {
  test("enqueues issue_comment created on a PR whose body Fixes #12", () => {
    const decision = shouldEnqueueIssueCommentFollowUp(makeIssueCommentPayload(), policy, "issue_comment");
    expect(decision.type).toBe("enqueue");
    if (decision.type === "enqueue") {
      expect(decision.job.mode).toBe("follow-up");
      expect(decision.job.issueNumber).toBe(12);
      expect(decision.job.prNumber).toBe(127);
      expect(decision.job.trigger).toEqual({
        event: "issue_comment",
        commentId: 55,
        sender: "alice",
      });
    }
  });

  test("skips issue_comment when issue.pull_request is null", () => {
    const decision = shouldEnqueueIssueCommentFollowUp(
      makeIssueCommentPayload({ issue: makeIssue({ pull_request: null, is_pull: false, body: "Fixes #12" }) }),
      policy,
      "issue_comment"
    );
    expect(decision).toEqual({ type: "skip", reason: "not a pull request comment" });
  });

  test("skips sender jumi", () => {
    const decision = shouldEnqueueIssueCommentFollowUp(
      makeIssueCommentPayload({ sender: makeUser({ login: "jumi" }) }),
      policy,
      "issue_comment"
    );
    expect(decision).toEqual({ type: "skip", reason: "sender is bot" });
  });

  test("skips sender jumi even when body is a current-head failure sticky", () => {
    const decision = shouldEnqueueIssueCommentFollowUp(
      makeIssueCommentPayload({
        sender: makeUser({ login: "jumi" }),
        comment: {
          id: 38022,
          body: [
            "<!-- jumi-review:kirmanak/demo#127 -->",
            "### Jumi OpenCode review",
            "",
            "Reviewed commit: `a62c750c0ffee000000000000000000000000000`",
            "",
            "<!-- jumi-check: failure -->",
          ].join("\n"),
          user: makeUser({ login: "jumi" }),
          created_at: "",
          updated_at: "",
        },
      }),
      policy,
      "issue_comment"
    );
    expect(decision).toEqual({ type: "skip", reason: "sender is bot" });
  });

  test("skips action edited / deleted", () => {
    expect(
      shouldEnqueueIssueCommentFollowUp(makeIssueCommentPayload({ action: "edited" }), policy, "issue_comment")
    ).toEqual({ type: "skip", reason: "unsupported action edited" });
    expect(
      shouldEnqueueIssueCommentFollowUp(makeIssueCommentPayload({ action: "deleted" }), policy, "issue_comment")
    ).toEqual({ type: "skip", reason: "unsupported action deleted" });
  });

  test("skips empty body", () => {
    const decision = shouldEnqueueIssueCommentFollowUp(
      makeIssueCommentPayload({
        comment: { id: 55, body: "  ", user: makeUser({ login: "alice" }), created_at: "", updated_at: "" },
      }),
      policy,
      "issue_comment"
    );
    expect(decision).toEqual({ type: "skip", reason: "empty comment body" });
  });

  test("skips jumi-check and jumi-worker bodies", () => {
    expect(
      shouldEnqueueIssueCommentFollowUp(
        makeIssueCommentPayload({
          comment: {
            id: 1,
            body: "<!-- jumi-check:kirmanak/demo#12 -->\nfindings",
            user: makeUser({ login: "alice" }),
            created_at: "",
            updated_at: "",
          },
        }),
        policy,
        "issue_comment"
      )
    ).toEqual({ type: "skip", reason: "jumi internal comment" });
    expect(
      shouldEnqueueIssueCommentFollowUp(
        makeIssueCommentPayload({
          comment: {
            id: 2,
            body: "<!-- jumi-worker:kirmanak/demo#12 -->\nJumi is implementing this issue.",
            user: makeUser({ login: "alice" }),
            created_at: "",
            updated_at: "",
          },
        }),
        policy,
        "issue_comment"
      )
    ).toEqual({ type: "skip", reason: "jumi internal comment" });
  });

  test("uses payload.pull_request head.ref over a Fix #N title", () => {
    const repository = makeRepo();
    const decision = shouldEnqueueIssueCommentFollowUp(
      makeIssueCommentPayload({
        repository,
        issue: makeIssue({
          number: 127,
          title: "Fix #11 leftover",
          body: "Fixes #12",
          html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/127",
          user: makeUser({ login: "jumi" }),
          pull_request: { merged_at: null },
        }),
        pull_request: makePR({
          number: 127,
          title: "Fix #11 leftover",
          body: "Fixes #12",
          user: makeUser({ login: "jumi" }),
          head: {
            label: "kirmanak:jumi/issue-12-fix-the-thing",
            ref: "jumi/issue-12-fix-the-thing",
            sha: "headsha",
            repo: repository,
            repo_id: repository.id,
          },
        }),
        sender: makeUser({ login: "alice" }),
      }),
      policy,
      "issue_comment"
    );
    expect(decision.type).toBe("enqueue");
    if (decision.type === "enqueue") {
      expect(decision.job.issueNumber).toBe(12);
      expect(decision.job.prNumber).toBe(127);
    }
  });

  test("enqueues a comment on an assigned foreign PR keyed by the PR number", () => {
    const repository = makeRepo();
    const decision = shouldEnqueueIssueCommentFollowUp(
      makeIssueCommentPayload({
        repository,
        issue: makeIssue({
          number: 50,
          title: "chore(deps)",
          body: "",
          html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/50",
          user: makeUser({ login: "renovate" }),
          pull_request: { merged_at: null },
        }),
        pull_request: makePR({
          number: 50,
          title: "chore(deps)",
          body: "",
          user: makeUser({ login: "renovate" }),
          assignee: makeUser({ login: "jumi" }),
          assignees: [makeUser({ login: "jumi" })],
          head: {
            label: "kirmanak:renovate/all-digest",
            ref: "renovate/all-digest",
            sha: "headsha",
            repo: repository,
            repo_id: repository.id,
          },
        }),
      }),
      policy,
      "issue_comment"
    );
    expect(decision.type).toBe("enqueue");
    if (decision.type === "enqueue") {
      expect(decision.job.mode).toBe("follow-up");
      expect(decision.job.issueNumber).toBe(50);
      expect(decision.job.prNumber).toBe(50);
    }
  });

  test("skips a comment on an unassigned foreign PR", () => {
    const repository = makeRepo();
    const decision = shouldEnqueueIssueCommentFollowUp(
      makeIssueCommentPayload({
        repository,
        issue: makeIssue({
          number: 50,
          title: "chore(deps)",
          body: "",
          html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/50",
          user: makeUser({ login: "renovate" }),
          assignee: makeUser({ login: "alice" }),
          assignees: [makeUser({ login: "alice" })],
          pull_request: { merged_at: null },
        }),
        pull_request: makePR({
          number: 50,
          title: "chore(deps)",
          body: "",
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
      policy,
      "issue_comment"
    );
    expect(decision).toEqual({ type: "skip", reason: "not a jumi pull request" });
  });

  test("skips when issue no longer assigned", () => {
    const payload = makeIssueCommentPayload();
    const pr = {
      id: 1,
      number: 127,
      title: "Fix",
      body: "Fixes #12",
      state: "open" as const,
      user: makeUser({ login: "jumi" }),
      head: {
        label: "kirmanak:jumi/issue-12-fix",
        ref: "jumi/issue-12-fix-the-thing",
        sha: "abc",
        repo: payload.repository,
        repo_id: payload.repository.id,
      },
      base: {
        label: "kirmanak:main",
        ref: "main",
        sha: "def",
        repo: payload.repository,
        repo_id: payload.repository.id,
      },
      merged: false,
      created_at: "",
      updated_at: "",
      html_url: payload.issue.html_url,
    };
    const issue = makeIssue({
      assignee: makeUser({ login: "alice" }),
      assignees: [makeUser({ login: "alice" })],
    });
    expect(followUpSkipReason(pr, issue, "kirmanak", "demo", "jumi")).toBe("not assigned to bot");
    expect(shouldEnqueueIssueCommentFollowUp(payload, policy, "issue_comment", issue).type).toBe("skip");
  });
});

describe("shouldEnqueuePullRejectedFollowUp", () => {
  test("enqueues pull_request_rejected for a jumi PR", () => {
    const decision = shouldEnqueuePullRejectedFollowUp(
      makePayload({
        action: "reviewed",
        pull_request: makePR({
          user: makeUser({ login: "jumi" }),
          body: "Fixes #12",
          head: {
            label: "kirmanak:jumi/issue-12-fix-the-thing",
            ref: "jumi/issue-12-fix-the-thing",
            sha: "headsha",
            repo: makePayload().repository,
            repo_id: 10,
          },
        }),
        review: { id: 9, body: "please change this" },
      }),
      policy,
      "pull_request_rejected"
    );
    expect(decision.type).toBe("enqueue");
    if (decision.type === "enqueue") {
      expect(decision.job.mode).toBe("follow-up");
      expect(decision.job.issueNumber).toBe(12);
      expect(decision.job.trigger?.reviewId).toBe(9);
      expect(decision.job.trigger?.body).toBe("please change this");
    }
  });

  test("enqueues a comment review webhook with content and no id", () => {
    const decision = shouldEnqueuePullRejectedFollowUp(
      makePayload({
        action: "reviewed",
        pull_request: makePR({
          user: makeUser({ login: "jumi" }),
          body: "Fixes #12",
          head: {
            label: "kirmanak:jumi/issue-12-fix-the-thing",
            ref: "jumi/issue-12-fix-the-thing",
            sha: "headsha",
            repo: makePayload().repository,
            repo_id: 10,
          },
        }),
        review: { type: "pull_request_review_comment", content: "please rename" },
      }),
      policy,
      "pull_request_comment"
    );
    expect(decision.type).toBe("enqueue");
    if (decision.type === "enqueue") {
      expect(decision.job.trigger?.reviewId).toBeUndefined();
      expect(decision.job.trigger?.body).toBe("please rename");
    }
  });

  test("enqueues pull_request_rejected for an assigned foreign PR", () => {
    const repository = makeRepo();
    const decision = shouldEnqueuePullRejectedFollowUp(
      makePayload({
        action: "reviewed",
        pull_request: makePR({
          number: 50,
          title: "chore(deps)",
          body: "",
          user: makeUser({ login: "renovate" }),
          assignee: makeUser({ login: "jumi" }),
          assignees: [makeUser({ login: "jumi" })],
          head: {
            label: "kirmanak:renovate/all-digest",
            ref: "renovate/all-digest",
            sha: "headsha",
            repo: repository,
            repo_id: repository.id,
          },
        }),
        review: { id: 9, body: "please change this" },
      }),
      policy,
      "pull_request_rejected"
    );
    expect(decision.type).toBe("enqueue");
    if (decision.type === "enqueue") {
      expect(decision.job.issueNumber).toBe(50);
      expect(decision.job.prNumber).toBe(50);
    }
  });
});

describe("shouldEnqueuePullAssign", () => {
  test("enqueues follow-up when the bot is assigned", () => {
    const repository = makeRepo();
    const decision = shouldEnqueuePullAssign(
      makePayload({
        action: "assigned",
        pull_request: makePR({
          number: 50,
          user: makeUser({ login: "renovate" }),
          assignee: makeUser({ login: "jumi" }),
          assignees: [makeUser({ login: "jumi" })],
          head: {
            label: "kirmanak:renovate/all-digest",
            ref: "renovate/all-digest",
            sha: "headsha",
            repo: repository,
            repo_id: repository.id,
          },
        }),
      }),
      policy
    );
    expect(decision.type).toBe("enqueue");
    if (decision.type === "enqueue") {
      expect(decision.job.mode).toBe("follow-up");
      expect(decision.job.issueNumber).toBe(50);
      expect(decision.job.prNumber).toBe(50);
    }
  });

  test("cancels when the bot is unassigned", () => {
    const repository = makeRepo();
    const decision = shouldEnqueuePullAssign(
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
      policy
    );
    expect(decision).toEqual({ type: "cancel", owner: "kirmanak", repo: "demo", issueNumber: 50 });
  });

  test("skips opened and synchronize", () => {
    expect(shouldEnqueuePullAssign(makePayload({ action: "opened" }), policy)).toEqual({
      type: "skip",
      reason: "unsupported action opened",
    });
    expect(shouldEnqueuePullAssign(makePayload({ action: "synchronize" }), policy)).toEqual({
      type: "skip",
      reason: "unsupported action synchronize",
    });
  });
});

describe("createWorkerFetchHandler follow-up events", () => {
  test("enqueues issue_comment created on a jumi PR", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue });
    const response = await handler(await signedRequest(makeIssueCommentPayload(), { event: "issue_comment" }));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#12", queued: true });
    expect(queue.jobs[0]?.mode).toBe("follow-up");
    expect(queue.jobs[0]?.prNumber).toBe(127);
  });

  test("enqueues X-Gitea-Event: pull_request_rejected for a jumi PR", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue });
    const response = await handler(
      await signedRequest(
        makePayload({
          action: "reviewed",
          pull_request: makePR({
            user: makeUser({ login: "jumi" }),
            body: "Fixes #12",
            head: {
              label: "kirmanak:jumi/issue-12-fix-the-thing",
              ref: "jumi/issue-12-fix-the-thing",
              sha: "headsha",
              repo: makePayload().repository,
              repo_id: 10,
            },
          }),
        }),
        { event: "pull_request_rejected" }
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#12", queued: true });
    expect(queue.jobs[0]?.mode).toBe("follow-up");
  });

  test("skips X-Gitea-Event: pull_request opened", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue });
    const response = await handler(await signedRequest(makePayload(), { event: "pull_request" }));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "unsupported action opened" });
    expect(queue.jobs).toHaveLength(0);
  });

  test("accepts Event-Type pull_request_review_comment with Event pull_request_comment", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue });
    const response = await handler(
      await signedRequest(reviewCommentPayload(), {
        event: "pull_request_comment",
        eventType: "pull_request_review_comment",
      })
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#12", queued: true });
    expect(queue.jobs[0]?.mode).toBe("follow-up");
    expect(queue.jobs[0]?.trigger?.reviewId).toBe(9);
  });

  test("enqueues PR-payload comment review with content and no id", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue });
    const response = await handler(
      await signedRequest(
        makePayload({
          action: "reviewed",
          pull_request: makePR({
            user: makeUser({ login: "jumi" }),
            body: "Fixes #12",
            head: {
              label: "kirmanak:jumi/issue-12-fix-the-thing",
              ref: "jumi/issue-12-fix-the-thing",
              sha: "headsha",
              repo: makePayload().repository,
              repo_id: 10,
            },
          }),
          review: { type: "pull_request_review_comment", content: "please rename" },
        }),
        { event: "pull_request_comment", eventType: "pull_request_review_comment" }
      )
    );
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ key: "kirmanak/demo#12", queued: true });
    expect(queue.jobs[0]?.mode).toBe("follow-up");
    expect(queue.jobs[0]?.trigger?.reviewId).toBeUndefined();
    expect(queue.jobs[0]?.trigger?.body).toBe("please rename");
  });

  test("Event pull_request_comment with a review-shaped payload never 400s", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue });
    const body = reviewCommentPayload();
    expect("issue" in body).toBe(false);
    expect("comment" in body).toBe(false);
    const response = await handler(await signedRequest(body, { event: "pull_request_comment" }));
    expect(response.status).toBe(202);
    const json = await responseJson(response);
    expect(json).not.toHaveProperty("error");
    expect(json).toEqual({ key: "kirmanak/demo#12", queued: true });
    expect(queue.jobs[0]?.mode).toBe("follow-up");
  });
});
