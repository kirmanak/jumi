import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaimRecord } from "../src/claim.ts";
import {
  acquireClaim,
  CLAIM_STALE_MS,
  claimFilePath,
  deleteClaim,
  isClaimLive,
  isPidAlive,
  readClaim,
  writeClaim,
} from "../src/claim.ts";

function makeClaim(overrides: Partial<ClaimRecord> = {}): ClaimRecord {
  return {
    pid: process.pid,
    startedAt: "2026-05-23T00:00:00Z",
    heartbeatAt: "2026-05-23T00:00:00Z",
    worktree: "/work/kirmanak/demo/12",
    branch: "jumi/issue-12-fix-the-thing",
    issueUpdatedAt: "2026-05-23T00:00:00Z",
    headShaAtStart: "abc",
    ...overrides,
  };
}

describe("claim liveness", () => {
  test("is live when the pid is alive and heartbeat is fresh", () => {
    const now = Date.parse("2026-05-23T00:01:00Z");
    expect(isClaimLive(makeClaim(), now, () => true)).toBe(true);
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test("is not live when the pid is dead", () => {
    const now = Date.parse("2026-05-23T00:01:00Z");
    expect(isClaimLive(makeClaim({ pid: 1_000_000_000 }), now, () => false)).toBe(false);
    expect(isClaimLive(makeClaim({ pid: 0 }), now, () => true)).toBe(false);
  });

  test("is not live when heartbeat is stale", () => {
    const heartbeatAt = "2026-05-23T00:00:00Z";
    const now = Date.parse(heartbeatAt) + CLAIM_STALE_MS;
    expect(isClaimLive(makeClaim({ heartbeatAt }), now, () => true)).toBe(false);
  });
});

describe("claim files", () => {
  test("writes, reads, acquires, and deletes claim files", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-claim-"));
    try {
      const path = claimFilePath(home, "kirmanak", "demo", 12);
      expect(path).toBe(join(home, "worker/jobs/kirmanak/demo/12.json"));
      expect(await readClaim(path)).toBeUndefined();

      const live = makeClaim({ pid: 42, heartbeatAt: new Date().toISOString() });
      expect(await acquireClaim(path, live, { pidAlive: () => true })).toBe(true);
      expect(await readClaim(path)).toEqual(live);
      expect(await acquireClaim(path, makeClaim({ pid: 99 }), { pidAlive: () => true })).toBe(false);

      expect(await acquireClaim(path, makeClaim({ pid: 99 }), { pidAlive: () => false })).toBe(true);
      expect(await readClaim(path)).toEqual(makeClaim({ pid: 99 }));

      const terminal = makeClaim({ pid: 0, terminal: true, issueUpdatedAt: "2026-05-23T00:00:00Z" });
      await writeClaim(path, terminal);
      expect(
        await acquireClaim(path, makeClaim({ pid: 7, issueUpdatedAt: "2026-05-23T00:00:00Z" }), {
          pidAlive: () => false,
        })
      ).toBe(false);
      expect(
        await acquireClaim(path, makeClaim({ pid: 7, issueUpdatedAt: "2026-05-23T01:00:00Z" }), {
          pidAlive: () => false,
        })
      ).toBe(true);

      await deleteClaim(path);
      expect(await readClaim(path)).toBeUndefined();
      await deleteClaim(path);
      await writeClaim(path, live);
      expect((await readClaim(path))?.pid).toBe(42);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
