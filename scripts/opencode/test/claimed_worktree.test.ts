import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimFilePath, readClaim, writeClaim } from "../src/claim.ts";
import {
  beginClaimedWorktree,
  isAbortError,
  isClaimedEarlyResult,
  recheckAssignedAndOpen,
  throwIfAborted,
} from "../src/claimed_worktree.ts";
import type { Engine } from "../src/engine.ts";
import { makeIssue, makeIssueJob, makeUser } from "./fixtures.ts";

const fallbackEngine: Engine = async () => ({ status: "ok" });

async function withDirs(run: (home: string, workdir: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "jumi-claimed-home-"));
  const workdir = await mkdtemp(join(tmpdir(), "jumi-claimed-work-"));
  try {
    await run(home, workdir);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
  }
}

describe("beginClaimedWorktree", () => {
  test("lays out worktree and bare paths and resolves engine", async () => {
    await withDirs(async (home, workdir) => {
      let used = "";
      const engine: Engine = async () => {
        used = "engine";
        return { status: "ok" };
      };
      const openCodeRunner: Engine = async () => {
        used = "openCode";
        return { status: "ok" };
      };
      const claimed = await beginClaimedWorktree({
        job: makeIssueJob(),
        home,
        workdir,
        engine,
        openCodeRunner,
        fallbackEngine,
        useClaim: false,
        now: () => new Date("2026-05-23T00:00:00Z"),
      });
      if (isClaimedEarlyResult(claimed)) throw new Error("expected session");
      expect(claimed.owner).toBe("kirmanak");
      expect(claimed.repo).toBe("demo");
      expect(claimed.issueNumber).toBe(12);
      expect(claimed.worktree).toBe(join(workdir, "kirmanak", "demo", "12"));
      expect(claimed.barePath).toBe(join(workdir, "_cache", "kirmanak", "demo.git"));
      expect(claimed.claimPath).toBe(claimFilePath(home, "kirmanak", "demo", 12));
      expect(claimed.claim.branch).toBe("");
      await claimed.engine({ model: "openai/gpt-5.5", workdir: claimed.worktree });
      expect(used).toBe("engine");
    });
  });

  test("prefers openCodeRunner over fallback when engine is unset", async () => {
    await withDirs(async (home, workdir) => {
      let used = "";
      const claimed = await beginClaimedWorktree({
        job: makeIssueJob(),
        home,
        workdir,
        openCodeRunner: async () => {
          used = "openCode";
          return { status: "ok" };
        },
        fallbackEngine: async () => {
          used = "fallback";
          return { status: "ok" };
        },
        useClaim: false,
      });
      if (isClaimedEarlyResult(claimed)) throw new Error("expected session");
      await claimed.engine({ model: "openai/gpt-5.5", workdir: claimed.worktree });
      expect(used).toBe("openCode");
    });
  });

  test("skips when a live claim exists", async () => {
    await withDirs(async (home, workdir) => {
      const path = claimFilePath(home, "kirmanak", "demo", 12);
      await writeClaim(path, {
        pid: 42,
        startedAt: "2026-05-23T00:00:00Z",
        heartbeatAt: new Date().toISOString(),
        worktree: "/work/12",
        branch: "jumi/issue-12-fix-the-thing",
        issueUpdatedAt: "2026-05-23T00:00:00Z",
        headShaAtStart: "abc",
      });
      const claimed = await beginClaimedWorktree({
        job: makeIssueJob(),
        home,
        workdir,
        fallbackEngine,
        pidAlive: () => true,
      });
      expect(claimed).toEqual({ status: "skipped", reason: "claim is live" });
    });
  });

  test("forgets a terminal claim before acquire when forgetTerminal is set", async () => {
    await withDirs(async (home, workdir) => {
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
      const claimed = await beginClaimedWorktree({
        job: makeIssueJob(),
        home,
        workdir,
        fallbackEngine,
        forgetTerminal: true,
        branch: "jumi/issue-12-fix-the-thing",
        now: () => new Date("2026-05-23T01:00:00Z"),
      });
      if (isClaimedEarlyResult(claimed)) throw new Error("expected session");
      expect(claimed.claim.branch).toBe("jumi/issue-12-fix-the-thing");
      expect(await readClaim(path)).toMatchObject({ pid: 0, terminal: false });
    });
  });

  test("does not forget a terminal claim when forgetTerminal is unset", async () => {
    await withDirs(async (home, workdir) => {
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
      const claimed = await beginClaimedWorktree({
        job: makeIssueJob(),
        home,
        workdir,
        fallbackEngine,
      });
      expect(claimed).toEqual({ status: "skipped", reason: "claim is live" });
      expect((await readClaim(path))?.terminal).toBe(true);
    });
  });

  test("throws on abort before acquire", async () => {
    await withDirs(async (home, workdir) => {
      const abort = new AbortController();
      abort.abort();
      await expect(
        beginClaimedWorktree({
          job: makeIssueJob(),
          home,
          workdir,
          fallbackEngine,
          abortSignal: abort.signal,
        })
      ).rejects.toThrow("cancelled");
      expect(await readClaim(claimFilePath(home, "kirmanak", "demo", 12))).toBeUndefined();
    });
  });

  test("rejects unsafe owner segments", async () => {
    await withDirs(async (home, workdir) => {
      await expect(
        beginClaimedWorktree({
          job: makeIssueJob({ owner: "../escape" }),
          home,
          workdir,
          fallbackEngine,
          useClaim: false,
        })
      ).rejects.toThrow("Invalid owner");
    });
  });
});

describe("recheckAssignedAndOpen", () => {
  test("cancels when the issue is not assigned to the bot", async () => {
    await withDirs(async (home, workdir) => {
      const claimed = await beginClaimedWorktree({
        job: makeIssueJob(),
        home,
        workdir,
        fallbackEngine,
        now: () => new Date("2026-05-23T00:00:00Z"),
      });
      if (isClaimedEarlyResult(claimed)) throw new Error("expected session");
      const result = await recheckAssignedAndOpen(claimed, {
        api: { getIssue: async () => makeIssue({ assignee: makeUser({ login: "alice" }), assignees: [] }) },
        botUsername: "jumi",
      });
      expect(result).toEqual({ status: "cancelled" });
      expect(await readClaim(claimed.claimPath)).toBeUndefined();
    });
  });

  test("cancels when the issue is closed", async () => {
    let forgot = false;
    const result = await recheckAssignedAndOpen(
      {
        owner: "kirmanak",
        repo: "demo",
        issueNumber: 12,
        worktree: "/work",
        barePath: "/bare",
        claimPath: "/claim",
        claim: {
          pid: 0,
          startedAt: "",
          heartbeatAt: "",
          worktree: "/work",
          branch: "",
          issueUpdatedAt: "",
          headShaAtStart: "",
        },
        useClaim: true,
        sanitizeEnv: true,
        engine: fallbackEngine,
        git: async () => "",
        now: () => new Date(),
        forgetClaim: async () => {
          forgot = true;
        },
      },
      { api: { getIssue: async () => makeIssue({ state: "closed" }) }, botUsername: "jumi" }
    );
    expect(result).toEqual({ status: "cancelled" });
    expect(forgot).toBe(true);
  });

  test("skips when getIssue fails", async () => {
    let forgot = false;
    const result = await recheckAssignedAndOpen(
      {
        owner: "kirmanak",
        repo: "demo",
        issueNumber: 12,
        worktree: "/work",
        barePath: "/bare",
        claimPath: "/claim",
        claim: {
          pid: 0,
          startedAt: "",
          heartbeatAt: "",
          worktree: "/work",
          branch: "",
          issueUpdatedAt: "",
          headShaAtStart: "",
        },
        useClaim: true,
        sanitizeEnv: true,
        engine: fallbackEngine,
        git: async () => "",
        now: () => new Date(),
        forgetClaim: async () => {
          forgot = true;
        },
      },
      {
        api: {
          getIssue: async () => {
            throw new Error("gitea 502");
          },
        },
        botUsername: "jumi",
      }
    );
    expect(result).toEqual({ status: "skipped", reason: "failed to load issue: gitea 502" });
    expect(forgot).toBe(true);
  });

  test("returns undefined when assigned and open", async () => {
    const result = await recheckAssignedAndOpen(
      {
        owner: "kirmanak",
        repo: "demo",
        issueNumber: 12,
        worktree: "/work",
        barePath: "/bare",
        claimPath: "/claim",
        claim: {
          pid: 0,
          startedAt: "",
          heartbeatAt: "",
          worktree: "/work",
          branch: "",
          issueUpdatedAt: "",
          headShaAtStart: "",
        },
        useClaim: true,
        sanitizeEnv: true,
        engine: fallbackEngine,
        git: async () => "",
        now: () => new Date(),
        forgetClaim: async () => {
          throw new Error("should not forget");
        },
      },
      { api: { getIssue: async () => makeIssue() }, botUsername: "jumi" }
    );
    expect(result).toBeUndefined();
  });
});

describe("throwIfAborted", () => {
  test("throws AbortError when the signal is aborted", () => {
    const abort = new AbortController();
    abort.abort();
    expect(() => throwIfAborted(abort.signal)).toThrow("cancelled");
    try {
      throwIfAborted(abort.signal);
    } catch (err) {
      expect(isAbortError(err)).toBe(true);
    }
  });
});
