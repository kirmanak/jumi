import { describe, expect, test } from "bun:test";
import { byteLength } from "../src/diagnostics.ts";
import { isWritePermission, resolvePermissions } from "../src/permissions.ts";
import {
  fitReviewThread,
  mapReviewComment,
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

describe("isWritePermission", () => {
  test("accepts write-or-stronger, case-insensitively", () => {
    for (const permission of ["admin", "write", "maintain", "owner", "ADMIN", " Write ", "MAINTAIN", "Owner"]) {
      expect(isWritePermission(permission)).toBe(true);
    }
  });

  test("rejects triage/read/none/empty/unknown", () => {
    for (const permission of ["triage", "read", "none", "", "  ", "unknown", "collaborator"]) {
      expect(isWritePermission(permission)).toBe(false);
    }
    expect(isWritePermission(undefined)).toBe(false);
    expect(isWritePermission(null)).toBe(false);
  });
});

describe("resolvePermissions", () => {
  test("dedupes logins case-insensitively and lowercases the detail", async () => {
    const seen: string[] = [];
    const result = await resolvePermissions(
      {
        getCollaboratorPermission: async (_owner, _repo, login) => {
          seen.push(login);
          return "ADMIN";
        },
      },
      "kirmanak",
      "demo",
      ["Alice", "alice ", "ALICE", undefined, null, " ", "bob"]
    );
    // alice dedupes to one lookup; bob has no stubbed branch so returns admin too here;
    // the point is only distinct logins hit the forge.
    expect(result.lookups).toBe(2);
    expect(result.failures).toBe(0);
    expect(seen.sort()).toEqual(["Alice", "bob"].sort());
    expect(result.detail.get("alice")).toBe("admin");
    expect(result.detail.get("bob")).toBe("admin");
    expect(result.sampleError).toBeUndefined();
  });

  test("is fail-closed and counts per-login failures", async () => {
    const result = await resolvePermissions(
      {
        getCollaboratorPermission: async (_owner, _repo, login) => {
          if (login.toLowerCase() === "alice") return { permission: "write" };
          throw new Error("Gitea API GET /repos/kirmanak/demo/collaborators/bob/permission → 403: forbidden");
        },
      },
      "kirmanak",
      "demo",
      ["alice", "bob"]
    );
    expect(result.lookups).toBe(2);
    expect(result.failures).toBe(1);
    expect(result.detail.get("alice")).toBe("write");
    expect(result.detail.get("bob")).toBe("none");
    expect(result.sampleError).toContain("403");
  });

  test("treats an unavailable permission API as all-failed", async () => {
    const result = await resolvePermissions({}, "kirmanak", "demo", ["alice", "BOB"]);
    expect(result.lookups).toBe(2);
    expect(result.failures).toBe(2);
    expect(result.detail.get("alice")).toBe("none");
    expect(result.detail.get("bob")).toBe("none");
    expect(result.sampleError).toContain("unavailable");
  });
});

describe("mapReviewComment", () => {
  function makeForgeComment(author: string) {
    return {
      id: 10,
      body: "hello",
      user: { login: author },
      created_at: "2026-05-23T00:00:00Z",
      updated_at: "2026-05-23T00:00:00Z",
    };
  }

  test("tags writers as product and non-writers as discussion", () => {
    const permissions = new Map([
      ["alice", true],
      ["bob", false],
    ]);
    const detail = new Map([
      ["alice", "write"],
      ["bob", "read"],
    ]);

    const product = mapReviewComment(makeForgeComment("Alice"), permissions, detail);
    expect(product.permission).toBe("write");
    expect(product.intent).toBe("product");

    const discussion = mapReviewComment(makeForgeComment("bob"), permissions, detail);
    expect(discussion.permission).toBe("read");
    expect(discussion.intent).toBe("discussion");
  });

  test("omits tags when permissions are unknown", () => {
    const untagged = mapReviewComment(makeForgeComment("alice"));
    expect(untagged.permission).toBeUndefined();
    expect(untagged.intent).toBeUndefined();
  });
});
