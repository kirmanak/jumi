import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SECRET_ENV_KEYS } from "../src/config.ts";

const entrypoint = join(import.meta.dir, "../entrypoint.sh");

describe("entrypoint secret scrub", () => {
  test("copies the same secret keys as SECRET_ENV_KEYS", () => {
    const src = readFileSync(entrypoint, "utf8");
    const match = src.match(/const keys = \[([^\]]+)\]/);
    expect(match).toBeTruthy();
    const keys = [...(match?.[1].matchAll(/"([^"]+)"/g) ?? [])].map((part) => part[1]);
    expect(keys).toEqual([...SECRET_ENV_KEYS]);
    for (const key of SECRET_ENV_KEYS) {
      expect(src).toContain(key);
    }
  });

  test("execs the child with forge secrets absent from /proc/self/environ", () => {
    chmodSync(entrypoint, 0o755);
    const token = `jumi-reexec-token-${crypto.randomUUID()}`;
    const keysJson = JSON.stringify(SECRET_ENV_KEYS);
    const probe = `
      const environ = await Bun.file("/proc/self/environ").text();
      const keys = ${keysJson};
      const leaked = keys.filter((key) => environ.includes(key) || environ.includes(process.env[key] ?? "${token}"));
      const fileGone = !(await Bun.file(process.env.JUMI_SECRETS_FILE ?? "").exists());
      process.stdout.write(JSON.stringify({
        leaked,
        fileGone,
        hasBot: Boolean(process.env.GITEA_BOT_TOKEN),
        hasSecret: Boolean(process.env.GITEA_WEBHOOK_SECRET),
        hasGithubKey: Boolean(process.env.GITHUB_APP_PRIVATE_KEY),
        hasGithubWebhook: Boolean(process.env.GITHUB_WEBHOOK_SECRET),
        scrubbed: process.env.JUMI_ENV_SCRUBBED,
      }));
    `;
    const result = spawnSync(entrypoint, [process.execPath, "-e", probe], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        GITEA_BOT_TOKEN: token,
        GITEA_WEBHOOK_SECRET: "jumi-reexec-webhook",
        GITEA_WEBHOOK_AUTH_TOKEN: "jumi-reexec-auth",
        GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nMII\\n-----END PRIVATE KEY-----",
        GITHUB_WEBHOOK_SECRET: "jumi-reexec-gh-webhook",
      },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as {
      leaked: string[];
      fileGone: boolean;
      hasBot: boolean;
      hasSecret: boolean;
      hasGithubKey: boolean;
      hasGithubWebhook: boolean;
      scrubbed: string | undefined;
    };
    expect(payload.leaked).toEqual([]);
    expect(payload.hasBot).toBe(false);
    expect(payload.hasSecret).toBe(false);
    expect(payload.hasGithubKey).toBe(false);
    expect(payload.hasGithubWebhook).toBe(false);
    expect(payload.scrubbed).toBe("1");
    expect(payload.fileGone).toBe(false);
  });
});
