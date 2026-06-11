import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  const required = {
    GITEA_URL: "https://gitea.kirmanak.stream/",
    GITEA_BOT_TOKEN: "bot-token",
    GITEA_WEBHOOK_SECRET: "secret",
  };

  test("loads defaults and normalizes values", () => {
    const config = loadConfig(required);

    expect(config.giteaUrl).toBe("https://gitea.kirmanak.stream");
    expect(config.allowedOrgs).toEqual(["kirmanak"]);
    expect(config.allowedRepos).toEqual([]);
    expect(config.botUsername).toBe("jumi");
    expect(config.model).toBe("openai/gpt-5.5");
    expect(config.opencodeWellKnownUrl).toBe("https://kirmanak.stream");
    expect(config.opencodeWellKnownKey).toBe("OPENCODE_WELLKNOWN_TOKEN");
    expect(config.opencodeWellKnownToken).toBe("unused");
    expect(config.queueConcurrency).toBe(1);
  });

  test("parses CSV and integer options", () => {
    const config = loadConfig({
      ...required,
      GITEA_ALLOWED_ORGS: "kirmanak,personal",
      GITEA_ALLOWED_REPOS: "kirmanak/a, kirmanak/b",
      QUEUE_CONCURRENCY: "2",
      MAX_FILES: "3",
    });

    expect(config.allowedOrgs).toEqual(["kirmanak", "personal"]);
    expect(config.allowedRepos).toEqual(["kirmanak/a", "kirmanak/b"]);
    expect(config.queueConcurrency).toBe(2);
    expect(config.maxFiles).toBe(3);
  });

  test("requires secrets and rejects invalid positive integers", () => {
    expect(() => loadConfig({ GITEA_URL: "https://gitea.kirmanak.stream", GITEA_BOT_TOKEN: "token" })).toThrow(
      "GITEA_WEBHOOK_SECRET"
    );
    expect(() => loadConfig({ ...required, MAX_FILES: "0" })).toThrow("Invalid positive integer");
    expect(() => loadConfig({ ...required, PORT: "abc" })).toThrow("Invalid positive integer");
  });
});
