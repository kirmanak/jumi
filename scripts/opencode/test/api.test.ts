import { afterEach, describe, expect, test } from "bun:test";
import { GiteaAPI } from "../src/api.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("GiteaAPI", () => {
  test("sends auth headers, encodes repo paths, and paginates", async () => {
    const urls: string[] = [];
    const methods: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(url));
      methods.push(init?.method ?? "GET");
      expect((init?.headers as Record<string, string>).Authorization).toBe("token token-1");
      if (String(url).includes("page=1"))
        return Response.json(Array.from({ length: 50 }, () => ({ filename: "a.ts" })));
      if (String(url).includes("page=2")) return Response.json([]);
      return Response.json({ id: 1 });
    }) as unknown as typeof fetch;

    const api = new GiteaAPI("https://gitea.example.test/", "token-1");
    await api.getPRFiles("owner name", "repo/name", 7);

    expect(methods).toEqual(["GET", "GET"]);
    expect(urls[0]).toContain("/repos/owner%20name/repo%2Fname/pulls/7/files?limit=50&page=1");
    expect(urls[1]).toContain("&page=2");
  });

  test("creates and updates issue comments", async () => {
    const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body as string | undefined });
      return Response.json({ id: 9, body: "ok", user: { login: "jumi" } });
    }) as unknown as typeof fetch;

    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    await api.createIssueComment("owner", "repo", 7, "new body");
    await api.updateIssueComment("owner", "repo", 9, "updated body");
    await api.createCommitStatus("owner", "repo", "sha/1", {
      state: "pending",
      context: "jumi/opencode-review",
      description: "running",
    });

    expect(requests[0]).toEqual({
      url: "https://gitea.example.test/api/v1/repos/owner/repo/issues/7/comments",
      method: "POST",
      body: JSON.stringify({ body: "new body" }),
    });
    expect(requests[1]).toEqual({
      url: "https://gitea.example.test/api/v1/repos/owner/repo/issues/comments/9",
      method: "PATCH",
      body: JSON.stringify({ body: "updated body" }),
    });
    expect(requests[2]).toEqual({
      url: "https://gitea.example.test/api/v1/repos/owner/repo/statuses/sha%2F1",
      method: "POST",
      body: JSON.stringify({ state: "pending", context: "jumi/opencode-review", description: "running" }),
    });
  });

  test("findStickyIssueComment returns only the matching id", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return Response.json([
        { id: 1, body: "noise", user: { login: "tapio" } },
        { id: 2, body: "<!-- jumi-review:owner/repo#7 -->\nold", user: { login: "jumi" } },
        { id: 3, body: "more", user: { login: "someone" } },
      ]);
    }) as unknown as typeof fetch;

    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    await expect(
      api.findStickyIssueComment("owner", "repo", 7, "jumi", "<!-- jumi-review:owner/repo#7 -->")
    ).resolves.toEqual({ id: 2 });
    expect(urls[0]).toContain("/issues/7/comments?limit=50&page=1");
  });

  test("findStickyIssueComment returns undefined when sticky is missing", async () => {
    globalThis.fetch = (async () =>
      Response.json([{ id: 1, body: "noise", user: { login: "tapio" } }])) as unknown as typeof fetch;
    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    await expect(
      api.findStickyIssueComment("owner", "repo", 7, "jumi", "<!-- jumi-review:owner/repo#7 -->")
    ).resolves.toBeUndefined();
  });

  test("lists issue comments with exact-50 paging", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      if (String(url).includes("page=1")) {
        return Response.json(Array.from({ length: 50 }, (_, i) => ({ id: i, body: "c" })));
      }
      return Response.json([]);
    }) as unknown as typeof fetch;

    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    await api.listIssueComments("owner", "repo", 7);

    expect(urls[0]).toContain("/issues/7/comments?limit=50&page=1");
    expect(urls[1]).toContain("/issues/7/comments?limit=50&page=2");
  });

  test("lists pull reviews with exact-50 paging", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      if (String(url).includes("page=1")) {
        return Response.json(Array.from({ length: 50 }, (_, i) => ({ id: i })));
      }
      return Response.json([]);
    }) as unknown as typeof fetch;

    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    await api.listPullReviews("owner", "repo", 7);

    expect(urls[0]).toContain("/pulls/7/reviews?limit=50&page=1");
    expect(urls[1]).toContain("/pulls/7/reviews?limit=50&page=2");
  });

  test("listPullReviewComments does not request /pulls/{index}/comments", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return Response.json([]);
    }) as unknown as typeof fetch;

    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    await expect(api.listPullReviewComments("owner", "repo", 7)).resolves.toEqual([]);
    expect(urls.some((url) => /\/pulls\/7\/comments(?:\?|$)/.test(url))).toBe(false);
  });

  test("listPullReviewComments fetches comments per review id", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const href = String(url);
      urls.push(href);
      if (href.includes("/pulls/7/reviews?") && href.includes("page=1")) {
        return Response.json([{ id: 9 }, { id: 10 }]);
      }
      if (href.includes("/pulls/7/reviews/9/comments")) {
        return Response.json([{ id: 101, body: "a" }]);
      }
      if (href.includes("/pulls/7/reviews/10/comments")) {
        return Response.json([{ id: 102, body: "b" }]);
      }
      return Response.json([]);
    }) as unknown as typeof fetch;

    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    const comments = await api.listPullReviewComments("owner", "repo", 7);
    expect(comments.map((comment) => comment.id)).toEqual([101, 102]);
    expect(urls.some((url) => url.includes("/pulls/7/reviews/9/comments?limit=50&page=1"))).toBe(true);
    expect(urls.some((url) => url.includes("/pulls/7/reviews/10/comments?limit=50&page=1"))).toBe(true);
    expect(urls.some((url) => /\/pulls\/7\/comments(?:\?|$)/.test(url))).toBe(false);
  });

  test("listPullReviewComments makes no nested GETs when reviews are empty", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return Response.json([]);
    }) as unknown as typeof fetch;

    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    await expect(api.listPullReviewComments("owner", "repo", 7)).resolves.toEqual([]);
    expect(urls).toEqual(["https://gitea.example.test/api/v1/repos/owner/repo/pulls/7/reviews?limit=50&page=1"]);
  });

  test("listPullReviewComments skips a review whose nested comments 404", async () => {
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const href = String(url);
      if (href.includes("/pulls/7/reviews?") && href.includes("page=1")) {
        return Response.json([{ id: 9 }, { id: 10 }]);
      }
      if (href.includes("/pulls/7/reviews/9/comments")) {
        return new Response("not found", { status: 404 });
      }
      if (href.includes("/pulls/7/reviews/10/comments")) {
        return Response.json([{ id: 102, body: "kept" }]);
      }
      return Response.json([]);
    }) as unknown as typeof fetch;

    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    const comments = await api.listPullReviewComments("owner", "repo", 7);
    expect(comments.map((comment) => comment.id)).toEqual([102]);
    expect(comments.map((comment) => comment.body)).toEqual(["kept"]);
  });

  test("lists commit statuses and action job logs", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const href = String(url);
      urls.push(href);
      if (href.includes("/actions/jobs/9/logs")) return new Response("##[error]boom\n", { status: 200 });
      if (href.includes("/actions/jobs")) return Response.json({ jobs: [{ id: 9, name: "build" }], total_count: 1 });
      if (href.includes("/commits/") && href.includes("/statuses")) {
        return Response.json([{ id: 1, context: "build", status: "failure" }]);
      }
      return Response.json({ id: 1 });
    }) as unknown as typeof fetch;

    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    await expect(api.listCommitStatuses("owner", "repo", "sha/1")).resolves.toEqual([
      { id: 1, context: "build", status: "failure" },
    ]);
    await expect(api.listActionJobs("owner", "repo", { status: "failure" })).resolves.toEqual([
      { id: 9, name: "build" },
    ]);
    await expect(api.getActionJobLogs("owner", "repo", 9)).resolves.toBe("##[error]boom\n");
    expect(urls[0]).toContain("/commits/sha%2F1/statuses");
    expect(urls[1]).toContain("/actions/jobs?limit=50&page=1&status=failure");
    expect(urls[2]).toContain("/actions/jobs/9/logs");
  });

  test("throws useful errors for non-2xx responses", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;

    await expect(new GiteaAPI("https://gitea.example.test", "token-1").getPR("owner", "repo", 1)).rejects.toThrow(
      "500: nope"
    );
  });

  test("maps Gitea JSON to host-agnostic Task and Pull refs", async () => {
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      if (String(url).includes("/issues/12")) {
        return Response.json({
          id: 200,
          number: 12,
          title: "Fix the thing",
          body: "Please implement this.",
          state: "open",
          html_url: "https://gitea.example.test/owner/repo/issues/12",
          user: { id: 1, login: "alice", full_name: "Alice", email: "a@b.c", avatar_url: "https://x" },
          assignee: { login: "jumi" },
          assignees: [{ login: "jumi" }],
          updated_at: "2026-05-23T00:00:00Z",
          created_at: "2026-05-23T00:00:00Z",
        });
      }
      return Response.json({
        id: 100,
        number: 7,
        title: "Add feature",
        body: "PR body",
        state: "open",
        html_url: "https://gitea.example.test/owner/repo/pulls/7",
        user: { login: "alice" },
        head: {
          label: "alice:feature",
          ref: "feature",
          sha: "abc123",
          repo: { full_name: "owner/repo", clone_url: "https://gitea.example.test/owner/repo.git" },
          repo_id: 10,
        },
        base: { ref: "main", sha: "def456" },
        merged: false,
        created_at: "2026-05-23T00:00:00Z",
        updated_at: "2026-05-23T00:00:00Z",
      });
    }) as unknown as typeof fetch;

    const api = new GiteaAPI("https://gitea.example.test", "token-1");
    const task = await api.getIssue("owner", "repo", 12);
    expect(task).toEqual({
      trackerRef: "12",
      number: 12,
      title: "Fix the thing",
      body: "Please implement this.",
      state: "open",
      html_url: "https://gitea.example.test/owner/repo/issues/12",
      user: { login: "alice" },
      assignee: { login: "jumi" },
      assignees: [{ login: "jumi" }],
      updated_at: "2026-05-23T00:00:00Z",
      created_at: "2026-05-23T00:00:00Z",
    });
    expect("avatar_url" in task.user).toBe(false);

    const pull = await api.getPR("owner", "repo", 7);
    expect(pull.forgeRef).toBe("7");
    expect(pull.number).toBe(7);
    expect(pull.head).toEqual({
      ref: "feature",
      sha: "abc123",
      repo: { full_name: "owner/repo", clone_url: "https://gitea.example.test/owner/repo.git" },
    });
    expect("label" in pull.head).toBe(false);
  });
});
