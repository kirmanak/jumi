import { describe, expect, test } from "bun:test";
import { byteLength } from "../src/diagnostics.ts";
import {
  fitReviewThread,
  type ReviewComment,
  type ReviewThread,
  serializeReviewThread,
} from "../src/review_context.ts";

function makeReviewComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 55,
    author: "jumi",
    created_at: "2026-05-23T00:00:00Z",
    body: "comment",
    ...overrides,
  };
}

describe("fitReviewThread", () => {
  test("is a no-op under the byte cap", () => {
    const thread: ReviewThread = {
      comments: [makeReviewComment({ body: "hello" })],
      linkedIssues: [
        {
          number: 12,
          state: "open",
          author: "alice",
          html_url: "https://gitea.kirmanak.stream/kirmanak/demo/issues/12",
          title: "Fix the thing",
          body: "Please implement this.",
          comments: [makeReviewComment({ id: 1, author: "alice", body: "ack" })],
        },
      ],
    };

    const result = fitReviewThread(thread, 200_000);
    expect(result.truncated).toBe(false);
    expect(result.droppedCommentBodies).toBe(0);
    expect(result.thread).toEqual(thread);
    expect(thread.comments[0]?.body).toBe("hello");
  });

  test("empties the oldest comment first", () => {
    const oldest = makeReviewComment({
      id: 1,
      created_at: "2026-01-01T00:00:00Z",
      body: `old-${"a".repeat(800)}`,
    });
    const newest = makeReviewComment({
      id: 2,
      created_at: "2026-06-01T00:00:00Z",
      body: `new-${"b".repeat(800)}`,
    });
    const thread: ReviewThread = { comments: [newest, oldest], linkedIssues: [] };
    const fullBytes = byteLength(serializeReviewThread(thread));
    const omittedThread: ReviewThread = {
      comments: [newest, { ...oldest, body: "[omitted; thread budget]" }],
      linkedIssues: [],
    };
    const omittedBytes = byteLength(serializeReviewThread(omittedThread));
    const maxBytes = omittedBytes + Math.floor((fullBytes - omittedBytes) / 2);

    const result = fitReviewThread(thread, maxBytes);
    expect(result.thread.comments.find((comment) => comment.id === 1)?.body).toBe("[omitted; thread budget]");
    expect(result.thread.comments.find((comment) => comment.id === 2)?.body).toBe(newest.body);
    expect(result.droppedCommentBodies).toBe(1);
    expect(result.truncated).toBe(true);
    expect(byteLength(serializeReviewThread(result.thread))).toBeLessThanOrEqual(maxBytes);
    expect(oldest.body.startsWith("old-")).toBe(true);
  });

  test("keeps titles when comment bodies are dropped", () => {
    const thread: ReviewThread = {
      comments: [],
      linkedIssues: [
        {
          number: 12,
          state: "open",
          author: "alice",
          html_url: "https://gitea.kirmanak.stream/kirmanak/demo/issues/12",
          title: "Keep this title",
          body: "issue body",
          comments: [
            makeReviewComment({
              id: 9,
              created_at: "2026-01-01T00:00:00Z",
              body: "c".repeat(50_000),
            }),
          ],
        },
      ],
    };

    const result = fitReviewThread(thread, 5_000);
    expect(result.thread.linkedIssues[0]?.title).toBe("Keep this title");
    expect(result.thread.linkedIssues[0]?.number).toBe(12);
    expect(result.thread.linkedIssues[0]?.author).toBe("alice");
    expect(result.thread.linkedIssues[0]?.comments[0]?.created_at).toBe("2026-01-01T00:00:00Z");
    expect(byteLength(serializeReviewThread(result.thread))).toBeLessThanOrEqual(5_000);
  });

  test("shrinks a 91k-style comment to a 32_768-byte prefix", () => {
    const body = "x".repeat(91_000);
    const thread: ReviewThread = {
      comments: [makeReviewComment({ body })],
      linkedIssues: [],
    };
    const maxBytes = 80_000;
    expect(byteLength(serializeReviewThread(thread))).toBeGreaterThan(maxBytes);

    const result = fitReviewThread(thread, maxBytes);
    expect(result.thread.comments[0]?.body.endsWith("\n[truncated]")).toBe(true);
    const prefix = result.thread.comments[0]?.body.slice(0, -"\n[truncated]".length) ?? "";
    expect(byteLength(prefix)).toBe(32_768);
    expect(byteLength(serializeReviewThread(result.thread))).toBeLessThanOrEqual(maxBytes);
  });
});
