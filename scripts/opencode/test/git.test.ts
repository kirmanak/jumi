import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOpenCode } from "../src/git.ts";

const originalPath = process.env.PATH;
const originalSecret = process.env.GITEA_BOT_TOKEN;

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalSecret === undefined) delete process.env.GITEA_BOT_TOKEN;
  else process.env.GITEA_BOT_TOKEN = originalSecret;
});

async function withFakeOpenCode(script: string, run: (binDir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "fake-opencode-"));
  try {
    const bin = join(dir, "opencode");
    await writeFile(bin, script);
    await chmod(bin, 0o755);
    process.env.PATH = `${dir}:${originalPath ?? ""}`;
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("runOpenCode", () => {
  test("passes a sanitized environment and strips ANSI output", async () => {
    process.env.GITEA_BOT_TOKEN = "secret-token";
    await withFakeOpenCode(
      `#!/bin/sh
printf '\\033[31mHOME=%s MODEL=%s CONFIG=%s DISABLE=%s SECRET=%s ARGS=%s\\033[0m\n' "$HOME" "$OPENCODE_MODEL" "$OPENCODE_CONFIG" "$OPENCODE_DISABLE_PROJECT_CONFIG" "$GITEA_BOT_TOKEN" "$*"
`,
      async () => {
        const output = await runOpenCode("prompt", {
          model: "openai/gpt-5.5",
          workdir: "/work",
          configPath: "/config.json",
          home: "/data",
          sanitizeEnv: true,
        });

        expect(output).toContain("HOME=/data");
        expect(output).toContain("MODEL=openai/gpt-5.5");
        expect(output).toContain("CONFIG=/config.json");
        expect(output).toContain("DISABLE=1");
        expect(output).toContain("SECRET=");
        expect(output).toContain("--dir /work -m openai/gpt-5.5");
        expect(output).not.toContain("\u001b[");
      }
    );
  });

  test("truncates output", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
printf 'abcdefghijklmnopqrstuvwxyz'
`,
      async () => {
        const output = await runOpenCode("prompt", {
          model: "model",
          workdir: "/work",
          maxOutputBytes: 5,
          sanitizeEnv: true,
        });

        expect(output).toBe("abcde\n\n[opencode output truncated at 5 bytes]");
      }
    );
  });

  test("surfaces non-zero exits with stderr", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
printf 'bad things' >&2
exit 7
`,
      async () => {
        await expect(runOpenCode("prompt", { model: "model", workdir: "/work", sanitizeEnv: true })).rejects.toThrow(
          "opencode exited with code 7:\nbad things"
        );
      }
    );
  });
});
