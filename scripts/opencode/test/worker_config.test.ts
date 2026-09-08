import { describe, expect, test } from "bun:test";
import { ReviewQueue } from "../src/queue.ts";
import type { IssueJob } from "../src/types.ts";
import { loadWorkerConfig } from "../src/worker_config.ts";
import { makeIssueJob } from "./fixtures.ts";

describe("loadWorkerConfig", () => {
  const required = {
    GITEA_URL: "https://gitea.kirmanak.stream/",
    GITEA_BOT_TOKEN: "bot-token",
    GITEA_WEBHOOK_SECRET: "secret",
  };

  test("does not require DATABASE_URL or JUMI_ROLE", () => {
    const config = loadWorkerConfig({
      ...required,
      JUMI_ROLE: "router",
    });
    expect(config.giteaUrl).toBe("https://gitea.kirmanak.stream");
    expect(config.databaseUrl).toBeUndefined();
    expect(config).not.toHaveProperty("role");
  });

  test("has no scan-interval env", () => {
    const config = loadWorkerConfig({ ...required, WORKER_SCAN_INTERVAL_MS: "60000" });
    expect(config).not.toHaveProperty("scanIntervalMs");
  });

  test("loads optional DATABASE_URL when set", () => {
    const config = loadWorkerConfig({
      ...required,
      DATABASE_URL: "postgres://jumi",
    });
    expect(config.databaseUrl).toBe("postgres://jumi");
  });

  test("follow-up and conflict caps fall back when env is unset or empty", () => {
    const unset = loadWorkerConfig(required);
    expect(unset.maxFollowupRounds).toBe(3);
    expect(unset.maxConflictRounds).toBe(3);
    expect(unset.followupTimeoutMs).toBe(3_600_000);
    expect(unset.conflictTimeoutMs).toBe(3_600_000);

    const empty = loadWorkerConfig({
      ...required,
      MAX_FOLLOWUP_ROUNDS: "",
      MAX_CONFLICT_ROUNDS: "",
      FOLLOWUP_TIMEOUT_MS: "",
      CONFLICT_TIMEOUT_MS: "",
    });
    expect(empty.maxFollowupRounds).toBe(3);
    expect(empty.maxConflictRounds).toBe(3);
    expect(empty.followupTimeoutMs).toBe(3_600_000);
    expect(empty.conflictTimeoutMs).toBe(3_600_000);
  });

  test("parses follow-up and conflict cap env", () => {
    const config = loadWorkerConfig({
      ...required,
      MAX_FOLLOWUP_ROUNDS: "5",
      MAX_CONFLICT_ROUNDS: "7",
      FOLLOWUP_TIMEOUT_MS: "1800000",
      CONFLICT_TIMEOUT_MS: "900000",
    });
    expect(config.maxFollowupRounds).toBe(5);
    expect(config.maxConflictRounds).toBe(7);
    expect(config.followupTimeoutMs).toBe(1_800_000);
    expect(config.conflictTimeoutMs).toBe(900_000);
  });

  test("follow-up and conflict timeouts do not inherit OPENCODE_TIMEOUT_MS", () => {
    const config = loadWorkerConfig({
      ...required,
      OPENCODE_TIMEOUT_MS: "14400000",
    });
    expect(config.opencodeTimeoutMs).toBe(14_400_000);
    expect(config.followupTimeoutMs).toBe(3_600_000);
    expect(config.conflictTimeoutMs).toBe(3_600_000);
  });

  test("rejects invalid follow-up and conflict cap env", () => {
    expect(() => loadWorkerConfig({ ...required, MAX_FOLLOWUP_ROUNDS: "0" })).toThrow("Invalid positive integer");
    expect(() => loadWorkerConfig({ ...required, MAX_CONFLICT_ROUNDS: "0" })).toThrow("Invalid positive integer");
    expect(() => loadWorkerConfig({ ...required, FOLLOWUP_TIMEOUT_MS: "abc" })).toThrow("Invalid positive integer");
    expect(() => loadWorkerConfig({ ...required, CONFLICT_TIMEOUT_MS: "-1" })).toThrow("Invalid positive integer");
  });

  test("parses FOLLOWUP_IGNORE_LOGINS CSV and treats empty as no extra skips", () => {
    expect(loadWorkerConfig(required).followupIgnoreLogins).toEqual([]);
    expect(loadWorkerConfig({ ...required, FOLLOWUP_IGNORE_LOGINS: "" }).followupIgnoreLogins).toEqual([]);
    expect(loadWorkerConfig({ ...required, FOLLOWUP_IGNORE_LOGINS: " , " }).followupIgnoreLogins).toEqual([]);
    expect(
      loadWorkerConfig({ ...required, FOLLOWUP_IGNORE_LOGINS: "tapio, renovate-bot, " }).followupIgnoreLogins
    ).toEqual(["tapio", "renovate-bot"]);
  });
});

describe("worker ReviewQueue", () => {
  test("still uses the in-memory queue without DATABASE_URL", async () => {
    const seen: number[] = [];
    const queue = new ReviewQueue<IssueJob>(
      async (job) => {
        seen.push(job.issueNumber);
      },
      1,
      () => undefined,
      (job) => `${job.owner}/${job.repo}#${job.issueNumber}`
    );
    queue.enqueue(makeIssueJob());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual([12]);
  });
});
