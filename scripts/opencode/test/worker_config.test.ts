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

  test("loads optional DATABASE_URL when set", () => {
    const config = loadWorkerConfig({
      ...required,
      DATABASE_URL: "postgres://jumi",
    });
    expect(config.databaseUrl).toBe("postgres://jumi");
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
