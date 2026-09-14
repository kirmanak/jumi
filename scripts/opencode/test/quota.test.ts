import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasQuotaRetryInDb, isQuotaError, isQuotaText, QUOTA_STUCK_TEXT } from "../src/quota.ts";
import { isQuotaStuck, markQuotaStuck, readStuckState } from "../src/stuck.ts";

describe("isQuotaText", () => {
  test("matches Free/Go quota class", () => {
    expect(isQuotaText("FreeUsageLimitError")).toBe(true);
    expect(isQuotaText("GoUsageLimitError")).toBe(true);
    expect(isQuotaText("Free usage exceeded, subscribe to Go")).toBe(true);
    expect(isQuotaText("Free limit reached")).toBe(true);
    expect(isQuotaText("Go limit reached")).toBe(true);
    expect(isQuotaText("Usage limit reached. It will reset in 1 hour")).toBe(true);
    expect(isQuotaText("my-model usage limit reached")).toBe(true);
    expect(isQuotaText('{"reason":"free_tier_limit"}')).toBe(true);
    expect(isQuotaText('{"reason":"account_rate_limit"}')).toBe(true);
    expect(isQuotaText(QUOTA_STUCK_TEXT)).toBe(true);
  });

  test("ignores ordinary short-window 429s", () => {
    expect(isQuotaText("429 Too Many Requests")).toBe(false);
    expect(isQuotaText("Provider is overloaded")).toBe(false);
    expect(isQuotaText("")).toBe(false);
    expect(isQuotaText(null)).toBe(false);
    expect(isQuotaText(undefined)).toBe(false);
  });

  test("isQuotaError checks messages", () => {
    expect(isQuotaError(new Error("opencode stuck: usage limit exceeded"))).toBe(true);
    expect(isQuotaError(new Error("429 Too Many Requests"))).toBe(false);
  });
});

describe("hasQuotaRetryInDb", () => {
  test("returns false for missing DB", () => {
    expect(hasQuotaRetryInDb("/nonexistent/opencode-session.db")).toBe(false);
    expect(hasQuotaRetryInDb(null)).toBe(false);
    expect(hasQuotaRetryInDb(undefined)).toBe(false);
  });

  test("detects quota in part retry payload without loading transcripts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-quota-"));
    try {
      const dbPath = join(dir, "opencode-session.db");
      const db = new Database(dbPath);
      db.exec(
        "CREATE TABLE session (id TEXT); CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT); CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)"
      );
      db.query("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
        "msg1",
        "ses1",
        1,
        2,
        JSON.stringify({ role: "assistant", modelID: "m", providerID: "opencode" })
      );
      db.query("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
        "p1",
        "msg1",
        "ses1",
        1,
        2,
        JSON.stringify({
          type: "retry",
          attempt: 3,
          message: "Free usage exceeded, subscribe to Go",
          action: { reason: "free_tier_limit", provider: "opencode" },
        })
      );
      db.close();
      expect(hasQuotaRetryInDb(dbPath)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ignores ordinary retries and empty DB", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-quota-"));
    try {
      const dbPath = join(dir, "opencode-session.db");
      const db = new Database(dbPath);
      db.exec(
        "CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT); CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)"
      );
      db.query("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
        "p1",
        "msg1",
        "ses1",
        1,
        2,
        JSON.stringify({ type: "retry", attempt: 1, message: "429 Too Many Requests" })
      );
      db.close();
      expect(hasQuotaRetryInDb(dbPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("quota stuck state", () => {
  test("blocks until kill-switch deletes the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-quota-stuck-"));
    try {
      const path = join(dir, "12.stuck.json");
      expect(isQuotaStuck(await readStuckState(path))).toBe(false);
      await markQuotaStuck(path, QUOTA_STUCK_TEXT);
      const state = await readStuckState(path);
      expect(isQuotaStuck(state)).toBe(true);
      expect(state.quota?.reason).toBe(QUOTA_STUCK_TEXT);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
