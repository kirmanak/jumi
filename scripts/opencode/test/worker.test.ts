import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimFilePath, readClaim, writeClaim } from "../src/claim.ts";
import type { IssueApi } from "../src/gitea_issues.ts";
import { handleIssueCancel } from "../src/worker.ts";
import { makeComment, makeIssue, makePR, makeRepo, makeWorkerConfig } from "./fixtures.ts";

function makeApi(overrides: Partial<IssueApi> = {}): IssueApi & { comments: string[] } {
  const comments: string[] = [];
  const defaults: IssueApi = {
    getRepo: async () => makeRepo(),
    getIssue: async () => makeIssue(),
    listOpenPulls: async () => [],
    createPullRequest: async (_owner, _repo, pull) => makePR({ title: pull.title, body: pull.body }),
    searchAssignedIssues: async () => [],
    findStickyIssueComment: async () => ({ id: 9 }),
    createIssueComment: async (_owner, _repo, _index, body) => {
      comments.push(body);
      return makeComment({ body });
    },
    updateIssueComment: async (_owner, _repo, _id, body) => {
      comments.push(body);
      return makeComment({ body });
    },
  };
  return { ...defaults, ...overrides, comments };
}

describe("handleIssueCancel", () => {
  test("does not overwrite a leftover sticky after finished work", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-cancel-"));
    try {
      const api = makeApi();
      const result = await handleIssueCancel(makeWorkerConfig({ home }), api, "kirmanak", "demo", 12);
      expect(result).toEqual({ key: "kirmanak/demo#12", cancelled: true });
      expect(api.comments).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("deletes a terminal claim without posting stopped", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-cancel-"));
    try {
      const path = claimFilePath(home, "kirmanak", "demo", 12);
      await writeClaim(path, {
        pid: 0,
        startedAt: "2026-05-23T00:00:00Z",
        heartbeatAt: "2026-05-23T00:00:00Z",
        worktree: "/work/12",
        branch: "jumi/issue-12-fix-the-thing",
        issueUpdatedAt: "2026-05-23T00:00:00Z",
        headShaAtStart: "abc",
        terminal: true,
      });
      const api = makeApi();
      await handleIssueCancel(makeWorkerConfig({ home }), api, "kirmanak", "demo", 12);
      expect(await readClaim(path)).toBeUndefined();
      expect(api.comments).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("posts stopped when a non-terminal claim exists", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-cancel-"));
    try {
      await writeClaim(claimFilePath(home, "kirmanak", "demo", 12), {
        pid: 0,
        startedAt: "2026-05-23T00:00:00Z",
        heartbeatAt: "2026-05-23T00:00:00Z",
        worktree: "/work/12",
        branch: "jumi/issue-12-fix-the-thing",
        issueUpdatedAt: "2026-05-23T00:00:00Z",
        headShaAtStart: "",
        terminal: false,
      });
      const api = makeApi();
      await handleIssueCancel(makeWorkerConfig({ home }), api, "kirmanak", "demo", 12);
      expect(api.comments.at(-1)).toContain("stopped");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
