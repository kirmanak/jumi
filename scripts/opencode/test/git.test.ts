import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOpenCode } from "../src/git.ts";
import { renderTokenMetrics, resetTokenMetricsForTests } from "../src/token_metrics.ts";

const originalPath = process.env.PATH;
const originalSecret = process.env.GITEA_BOT_TOKEN;

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalSecret === undefined) delete process.env.GITEA_BOT_TOKEN;
  else process.env.GITEA_BOT_TOKEN = originalSecret;
  resetTokenMetricsForTests();
});

async function withFakeOpenCode(script: string, run: (binDir: string, workdir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "fake-opencode-"));
  const workdir = await mkdtemp(join(tmpdir(), "fake-opencode-work-"));
  try {
    const bin = join(dir, "opencode");
    await writeFile(bin, script);
    await chmod(bin, 0o755);
    process.env.PATH = `${dir}:${originalPath ?? ""}`;
    await run(dir, workdir);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
  }
}

describe("runOpenCode", () => {
  test("passes a sanitized environment and strips ANSI output", async () => {
    process.env.GITEA_BOT_TOKEN = "secret-token";
    await withFakeOpenCode(
      `#!/bin/sh
printf '\\033[31mHOME=%s MODEL=%s CONFIG=%s DISABLE=%s XDG_CONFIG=%s SECRET=%s ARGS=%s\\033[0m\n' "$HOME" "$OPENCODE_MODEL" "$OPENCODE_CONFIG" "$OPENCODE_DISABLE_PROJECT_CONFIG" "$XDG_CONFIG_HOME" "$GITEA_BOT_TOKEN" "$*"
`,
      async (_binDir, workdir) => {
        const output = await runOpenCode("prompt", {
          model: "openai/gpt-5.5",
          workdir,
          configPath: "/config.json",
          home: "/data",
          sanitizeEnv: true,
        });

        expect(output).toContain("HOME=/data");
        expect(output).toContain("MODEL=openai/gpt-5.5");
        expect(output).toContain("CONFIG=/config.json");
        expect(output).toContain("DISABLE=1");
        expect(output).toContain(`XDG_CONFIG=${workdir}/.jumi-tmp/xdg-config`);
        expect(output).toContain("SECRET=");
        expect(output).toContain(`run --dir ${workdir} -m openai/gpt-5.5`);
        expect(output).not.toContain("--print-logs");
        expect(output).not.toContain("\u001b[");
      }
    );
  });

  test("truncates output", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
printf 'abcdefghijklmnopqrstuvwxyz'
`,
      async (_binDir, workdir) => {
        const output = await runOpenCode("prompt", {
          model: "model",
          workdir,
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
      async (_binDir, workdir) => {
        await expect(runOpenCode("prompt", { model: "model", workdir, sanitizeEnv: true })).rejects.toThrow(
          "opencode exited with code 7:\nbad things"
        );
      }
    );
  });

  test("records token totals from OPENCODE_DB even when OpenCode exits non-zero", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
python3 - <<'PY'
import os, sqlite3
path = os.environ["OPENCODE_DB"]
con = sqlite3.connect(path)
con.execute("""
  CREATE TABLE session (
    model TEXT,
    tokens_input INTEGER,
    tokens_cache_read INTEGER,
    tokens_output INTEGER,
    tokens_cache_write INTEGER,
    tokens_reasoning INTEGER
  )
""")
con.execute(
  "INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)",
  ("xai/grok-4.6", 42, 7, 9, 0, 1),
)
con.commit()
PY
exit 7
`,
      async (_binDir, workdir) => {
        await expect(runOpenCode("prompt", { model: "model", workdir, sanitizeEnv: true })).rejects.toThrow(
          "opencode exited with code 7"
        );
        const text = renderTokenMetrics();
        expect(text).toContain(
          'ai_tokens_total{agent_instance="jumi",source="opencode",profile="default",model="xai/grok-4.6",token_type="input"} 42'
        );
        expect(text).toContain(
          'ai_tokens_total{agent_instance="jumi",source="opencode",profile="default",model="xai/grok-4.6",token_type="output"} 9'
        );
      }
    );
  });

  test("caps stderr captured from failed opencode runs", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
python3 - <<'PY' >&2
print('x' * 100000)
PY
exit 7
`,
      async (_binDir, workdir) => {
        await expect(runOpenCode("prompt", { model: "model", workdir, sanitizeEnv: true })).rejects.toThrow(
          "[opencode stderr truncated at"
        );
      }
    );
  });
});
