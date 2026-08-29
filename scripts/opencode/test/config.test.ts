import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, SECRET_ENV_KEYS, SECRETS_FILE_ENV, scrubSecretEnv } from "../src/config.ts";

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

  test("parses wildcard owner allowlist", () => {
    const config = loadConfig({
      ...required,
      GITEA_ALLOWED_ORGS: "*",
    });

    expect(config.allowedOrgs).toEqual(["*"]);
  });

  test("requires secrets and rejects invalid positive integers", () => {
    expect(() => loadConfig({ GITEA_URL: "https://gitea.kirmanak.stream", GITEA_BOT_TOKEN: "token" })).toThrow(
      "GITEA_WEBHOOK_SECRET"
    );
    expect(() => loadConfig({ ...required, MAX_FILES: "0" })).toThrow("Invalid positive integer");
    expect(() => loadConfig({ ...required, PORT: "abc" })).toThrow("Invalid positive integer");
  });

  test("scrubSecretEnv unsets Gitea secrets after they have been copied into config", () => {
    const previous: Record<string, string | undefined> = {};
    for (const key of SECRET_ENV_KEYS) {
      previous[key] = process.env[key];
    }
    process.env.GITEA_BOT_TOKEN = "live-bot-token";
    process.env.GITEA_WEBHOOK_SECRET = "live-webhook-secret";
    process.env.GITEA_WEBHOOK_AUTH_TOKEN = "live-auth-token";
    try {
      const config = loadConfig({
        ...required,
        GITEA_BOT_TOKEN: process.env.GITEA_BOT_TOKEN,
        GITEA_WEBHOOK_SECRET: process.env.GITEA_WEBHOOK_SECRET,
        GITEA_WEBHOOK_AUTH_TOKEN: process.env.GITEA_WEBHOOK_AUTH_TOKEN,
      });
      expect(config.giteaToken).toBe("live-bot-token");
      expect(config.webhookSecret).toBe("live-webhook-secret");
      expect(config.webhookAuthToken).toBe("live-auth-token");

      scrubSecretEnv();
      expect(process.env.GITEA_BOT_TOKEN).toBeUndefined();
      expect(process.env.GITEA_WEBHOOK_SECRET).toBeUndefined();
      expect(process.env.GITEA_WEBHOOK_AUTH_TOKEN).toBeUndefined();
      expect(config.giteaToken).toBe("live-bot-token");
    } finally {
      for (const key of SECRET_ENV_KEYS) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });

  test("loadConfig reads Gitea secrets from JUMI_SECRETS_FILE and unlinks it", () => {
    const dir = mkdtempSync(join(tmpdir(), "jumi-secrets-"));
    const file = join(dir, "secrets.json");
    writeFileSync(
      file,
      JSON.stringify({
        GITEA_BOT_TOKEN: "file-bot-token",
        GITEA_WEBHOOK_SECRET: "file-webhook-secret",
        GITEA_WEBHOOK_AUTH_TOKEN: "file-auth-token",
      }),
      { mode: 0o600 }
    );

    const config = loadConfig({
      GITEA_URL: "https://gitea.kirmanak.stream",
      [SECRETS_FILE_ENV]: file,
    });

    expect(config.giteaToken).toBe("file-bot-token");
    expect(config.webhookSecret).toBe("file-webhook-secret");
    expect(config.webhookAuthToken).toBe("file-auth-token");
    expect(() => readFileSync(file)).toThrow();
  });
});
