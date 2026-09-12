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
    JUMI_ROLE: "router",
    DATABASE_URL: "postgres://jumi",
  };

  test("loads defaults and normalizes values", () => {
    const config = loadConfig(required);

    expect(config.forge).toBe("gitea");
    expect(config.giteaUrl).toBe("https://gitea.kirmanak.stream");
    expect(config.allowedOrgs).toEqual(["kirmanak"]);
    expect(config.allowedRepos).toEqual([]);
    expect(config.botUsername).toBe("jumi");
    expect(config.model).toBe("openai/gpt-5.5");
    expect(config.opencodeWellKnownUrl).toBe("https://kirmanak.stream");
    expect(config.opencodeWellKnownKey).toBe("OPENCODE_WELLKNOWN_TOKEN");
    expect(config.opencodeWellKnownToken).toBe("unused");
    expect(config.queueConcurrency).toBe(1);
    expect(config.role).toBe("router");
    expect(config.databaseUrl).toBe("postgres://jumi");
    expect(config.leaseMs).toBe(900_000 + 10 * 60 * 1000);
    expect(config.maxJobAttempts).toBe(2);
    expect(config.maxFollowupRounds).toBe(3);
    expect(config.maxIncompleteRetries).toBe(2);
    expect(config.phoenixOtlpEndpoint).toBeUndefined();
  });

  test("MAX_FOLLOWUP_ROUNDS unset or empty is 3; invalid fail-closed", () => {
    expect(loadConfig({ ...required, MAX_FOLLOWUP_ROUNDS: "" }).maxFollowupRounds).toBe(3);
    expect(loadConfig({ ...required, MAX_FOLLOWUP_ROUNDS: "5" }).maxFollowupRounds).toBe(5);
    expect(() => loadConfig({ ...required, MAX_FOLLOWUP_ROUNDS: "0" })).toThrow("Invalid positive integer");
    expect(() => loadConfig({ ...required, MAX_FOLLOWUP_ROUNDS: "abc" })).toThrow("Invalid positive integer");
  });

  test("MAX_INCOMPLETE_RETRIES unset or empty is 2; invalid fail-closed", () => {
    expect(loadConfig({ ...required, MAX_INCOMPLETE_RETRIES: "" }).maxIncompleteRetries).toBe(2);
    expect(loadConfig({ ...required, MAX_INCOMPLETE_RETRIES: "1" }).maxIncompleteRetries).toBe(1);
    expect(() => loadConfig({ ...required, MAX_INCOMPLETE_RETRIES: "0" })).toThrow("Invalid positive integer");
    expect(() => loadConfig({ ...required, MAX_INCOMPLETE_RETRIES: "abc" })).toThrow("Invalid positive integer");
  });

  test("parses optional PHOENIX_OTLP_ENDPOINT", () => {
    const config = loadConfig({
      ...required,
      PHOENIX_OTLP_ENDPOINT: "http://phoenix.phoenix.svc:6006",
    });
    expect(config.phoenixOtlpEndpoint).toBe("http://phoenix.phoenix.svc:6006");
  });

  test("requires DATABASE_URL for router and engine", () => {
    expect(() => loadConfig({ ...required, JUMI_ROLE: "router", DATABASE_URL: "" })).toThrow("DATABASE_URL");
    expect(() => loadConfig({ ...required, JUMI_ROLE: "engine", DATABASE_URL: "" })).toThrow("DATABASE_URL");
    expect(loadConfig({ ...required, JUMI_ROLE: "router" }).role).toBe("router");
    expect(loadConfig({ ...required, JUMI_ROLE: "engine" }).databaseUrl).toBe("postgres://jumi");
  });

  test("parses LEASE_MS and MAX_JOB_ATTEMPTS", () => {
    const config = loadConfig({
      ...required,
      JUMI_ROLE: "engine",
      DATABASE_URL: "postgres://jumi",
      LEASE_MS: "1000",
      MAX_JOB_ATTEMPTS: "3",
    });
    expect(config.leaseMs).toBe(1000);
    expect(config.maxJobAttempts).toBe(3);
  });

  test("rejects missing, empty, and unknown JUMI_ROLE", () => {
    expect(() => loadConfig({ ...required, JUMI_ROLE: undefined })).toThrow("JUMI_ROLE");
    expect(() => loadConfig({ ...required, JUMI_ROLE: "" })).toThrow("JUMI_ROLE");
    expect(() => loadConfig({ ...required, JUMI_ROLE: "worker" })).toThrow("Invalid JUMI_ROLE");
    expect(() => loadConfig({ ...required, JUMI_ROLE: "monolith" })).toThrow("Invalid JUMI_ROLE");
    expect(() => loadConfig({ ...required, JUMI_ROLE: "garbage" })).toThrow("Invalid JUMI_ROLE");
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

  test("parses FOLLOWUP_IGNORE_LOGINS CSV and treats empty as no extra skips", () => {
    expect(loadConfig(required).followupIgnoreLogins).toEqual([]);
    expect(loadConfig({ ...required, FOLLOWUP_IGNORE_LOGINS: "" }).followupIgnoreLogins).toEqual([]);
    expect(loadConfig({ ...required, FOLLOWUP_IGNORE_LOGINS: " , " }).followupIgnoreLogins).toEqual([]);
    expect(loadConfig({ ...required, FOLLOWUP_IGNORE_LOGINS: "tapio, renovate-bot, " }).followupIgnoreLogins).toEqual([
      "tapio",
      "renovate-bot",
    ]);
  });

  test("parses wildcard owner allowlist", () => {
    const config = loadConfig({
      ...required,
      GITEA_ALLOWED_ORGS: "*",
    });

    expect(config.allowedOrgs).toEqual(["*"]);
  });

  test("requires secrets and rejects invalid positive integers", () => {
    expect(() =>
      loadConfig({
        GITEA_URL: "https://gitea.kirmanak.stream",
        GITEA_BOT_TOKEN: "token",
        JUMI_ROLE: "router",
        DATABASE_URL: "postgres://jumi",
      })
    ).toThrow("GITEA_WEBHOOK_SECRET");
    expect(() => loadConfig({ ...required, MAX_FILES: "0" })).toThrow("Invalid positive integer");
    expect(() => loadConfig({ ...required, PORT: "abc" })).toThrow("Invalid positive integer");
  });

  test("engine does not require GITEA_WEBHOOK_SECRET; router still does", () => {
    const config = loadConfig({
      JUMI_ROLE: "engine",
      DATABASE_URL: "postgres://jumi",
      GITEA_URL: "https://gitea.kirmanak.stream",
      GITEA_BOT_TOKEN: "token",
    });
    expect(config.role).toBe("engine");
    expect(config.webhookSecret).toBe("");
    expect(config.giteaToken).toBe("token");
    expect(() =>
      loadConfig({
        JUMI_ROLE: "router",
        DATABASE_URL: "postgres://jumi",
        GITEA_URL: "https://gitea.kirmanak.stream",
        GITEA_BOT_TOKEN: "token",
      })
    ).toThrow("GITEA_WEBHOOK_SECRET");
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

      process.env.GITHUB_APP_PRIVATE_KEY = "live-github-pem";
      process.env.GITHUB_WEBHOOK_SECRET = "live-gh-webhook";
      scrubSecretEnv();
      expect(process.env.GITEA_BOT_TOKEN).toBeUndefined();
      expect(process.env.GITEA_WEBHOOK_SECRET).toBeUndefined();
      expect(process.env.GITEA_WEBHOOK_AUTH_TOKEN).toBeUndefined();
      expect(process.env.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
      expect(process.env.GITHUB_WEBHOOK_SECRET).toBeUndefined();
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
      JUMI_ROLE: "router",
      DATABASE_URL: "postgres://jumi",
      [SECRETS_FILE_ENV]: file,
    });

    expect(config.giteaToken).toBe("file-bot-token");
    expect(config.webhookSecret).toBe("file-webhook-secret");
    expect(config.webhookAuthToken).toBe("file-auth-token");
    expect(() => readFileSync(file)).toThrow();
  });

  const githubPem = "-----BEGIN PRIVATE KEY-----\nMII\n-----END PRIVATE KEY-----";
  const githubRequired = {
    FORGE: "github",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: githubPem,
    GITHUB_APP_INSTALLATION_ID: "456",
    GITHUB_WEBHOOK_SECRET: "gh-secret",
    FORGE_URL: "https://github.com/",
    GITHUB_ALLOWED_ORGS: "acme",
    JUMI_ROLE: "router",
    DATABASE_URL: "postgres://jumi",
  };

  test("FORGE unset or empty or gitea keeps GITEA_* requirements", () => {
    expect(loadConfig(required).forge).toBe("gitea");
    expect(loadConfig({ ...required, FORGE: "" }).forge).toBe("gitea");
    expect(loadConfig({ ...required, FORGE: "gitea" }).forge).toBe("gitea");
    expect(() => loadConfig({ ...required, FORGE: "gitea", GITEA_URL: "" })).toThrow("GITEA_URL");
    expect(() => loadConfig({ ...required, FORGE: "gitea", GITEA_BOT_TOKEN: "" })).toThrow("GITEA_BOT_TOKEN");
  });

  test("invalid FORGE fails closed", () => {
    expect(() => loadConfig({ ...required, FORGE: "gitlab" })).toThrow("Invalid FORGE");
  });

  test("FORGE=github without GitHub env fails closed", () => {
    expect(() => loadConfig({ ...required, FORGE: "github" })).toThrow("GITHUB_APP_ID");
    expect(() => loadConfig({ FORGE: "github", JUMI_ROLE: "router", DATABASE_URL: "postgres://jumi" })).toThrow(
      "GITHUB_APP_ID"
    );
    expect(() => loadConfig({ ...githubRequired, GITHUB_APP_PRIVATE_KEY: "" })).toThrow("GITHUB_APP_PRIVATE_KEY");
    expect(() => loadConfig({ ...githubRequired, GITHUB_APP_INSTALLATION_ID: "" })).toThrow(
      "GITHUB_APP_INSTALLATION_ID"
    );
    expect(() => loadConfig({ ...githubRequired, FORGE_URL: "" })).toThrow("FORGE_URL");
    expect(() => loadConfig({ ...githubRequired, GITHUB_ALLOWED_ORGS: "" })).toThrow("GITHUB_ALLOWED_ORGS");
  });

  test("FORGE=github dual-binds URL/orgs/webhook and requires GitHub App env", () => {
    const config = loadConfig(githubRequired);
    expect(config.forge).toBe("github");
    expect(config.giteaUrl).toBe("https://github.com");
    expect(config.giteaToken).toBe("");
    expect(config.webhookSecret).toBe("gh-secret");
    expect(config.allowedOrgs).toEqual(["acme"]);
    expect(config.allowedRepos).toEqual([]);
    expect(config.githubAppId).toBe("123");
    expect(config.githubAppPrivateKey).toBe(githubPem);
    expect(config.githubAppInstallationId).toBe("456");
  });

  test("FORGE=github optional GITHUB_ALLOWED_REPOS and escaped PEM", () => {
    const config = loadConfig({
      ...githubRequired,
      GITHUB_ALLOWED_REPOS: "acme/a, acme/b",
      GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nMII\\n-----END PRIVATE KEY-----",
    });
    expect(config.allowedRepos).toEqual(["acme/a", "acme/b"]);
    expect(config.githubAppPrivateKey).toBe(githubPem);
  });

  test("FORGE=github engine still requires GITHUB_WEBHOOK_SECRET; invalid PEM fails", () => {
    expect(loadConfig({ ...githubRequired, JUMI_ROLE: "engine" }).webhookSecret).toBe("gh-secret");
    expect(() => loadConfig({ ...githubRequired, JUMI_ROLE: "engine", GITHUB_WEBHOOK_SECRET: "" })).toThrow(
      "GITHUB_WEBHOOK_SECRET"
    );
    expect(() => loadConfig({ ...githubRequired, GITHUB_APP_PRIVATE_KEY: "not-a-key" })).toThrow("Invalid PEM");
  });

  test("loadConfig reads GitHub secrets from JUMI_SECRETS_FILE and unlinks it", () => {
    const dir = mkdtempSync(join(tmpdir(), "jumi-gh-secrets-"));
    const file = join(dir, "secrets.json");
    writeFileSync(
      file,
      JSON.stringify({
        GITHUB_APP_PRIVATE_KEY: githubPem,
        GITHUB_WEBHOOK_SECRET: "file-gh-secret",
      }),
      { mode: 0o600 }
    );

    const config = loadConfig({
      FORGE: "github",
      GITHUB_APP_ID: "123",
      GITHUB_APP_INSTALLATION_ID: "456",
      FORGE_URL: "https://github.com/",
      GITHUB_ALLOWED_ORGS: "acme",
      JUMI_ROLE: "router",
      DATABASE_URL: "postgres://jumi",
      [SECRETS_FILE_ENV]: file,
    });

    expect(config.githubAppPrivateKey).toBe(githubPem);
    expect(config.webhookSecret).toBe("file-gh-secret");
    expect(() => readFileSync(file)).toThrow();
  });
});
