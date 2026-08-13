import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { join } from "node:path";

const entrypoint = join(import.meta.dir, "../entrypoint.sh");

describe("entrypoint secret scrub", () => {
  test("execs the child with Gitea secrets absent from /proc/self/environ", () => {
    chmodSync(entrypoint, 0o755);
    const token = `jumi-reexec-token-${crypto.randomUUID()}`;
    const probe = `
      const environ = await Bun.file("/proc/self/environ").text();
      const keys = ["GITEA_BOT_TOKEN", "GITEA_WEBHOOK_SECRET", "GITEA_WEBHOOK_AUTH_TOKEN"];
      const leaked = keys.filter((key) => environ.includes(key) || environ.includes(process.env[key] ?? "${token}"));
      const fileGone = !(await Bun.file(process.env.JUMI_SECRETS_FILE ?? "").exists());
      process.stdout.write(JSON.stringify({
        leaked,
        fileGone,
        hasBot: Boolean(process.env.GITEA_BOT_TOKEN),
        hasSecret: Boolean(process.env.GITEA_WEBHOOK_SECRET),
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
      },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as {
      leaked: string[];
      fileGone: boolean;
      hasBot: boolean;
      hasSecret: boolean;
      scrubbed: string | undefined;
    };
    expect(payload.leaked).toEqual([]);
    expect(payload.hasBot).toBe(false);
    expect(payload.hasSecret).toBe(false);
    expect(payload.scrubbed).toBe("1");
    expect(payload.fileGone).toBe(false);
  });
});
