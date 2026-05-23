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
  });

  test("throws useful errors for non-2xx responses", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;

    await expect(new GiteaAPI("https://gitea.example.test", "token-1").getPR("owner", "repo", 1)).rejects.toThrow(
      "500: nope"
    );
  });
});
