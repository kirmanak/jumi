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
        const result = await runOpenCode({
          prompt: "prompt",
          model: "openai/gpt-5.5",
          workdir,
          configPath: "/config.json",
          home: "/data",
          sanitizeEnv: true,
        });

        expect(result.status).toBe("ok");
        expect(result.stdout).toContain("HOME=/data");
        expect(result.stdout).toContain("MODEL=openai/gpt-5.5");
        expect(result.stdout).toContain("CONFIG=/config.json");
        expect(result.stdout).toContain("DISABLE=1");
        expect(result.stdout).toContain(`XDG_CONFIG=${workdir}/.jumi-tmp/xdg-config`);
        expect(result.stdout).toContain("SECRET=");
        expect(result.stdout).toContain(`run --dir ${workdir} -m openai/gpt-5.5`);
        expect(result.stdout).not.toContain("--print-logs");
        expect(result.stdout).not.toContain("\u001b[");
      }
    );
  });

  test("truncates output", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
printf 'abcdefghijklmnopqrstuvwxyz'
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({
          prompt: "prompt",
          model: "model",
          workdir,
          maxOutputBytes: 5,
          sanitizeEnv: true,
        });

        expect(result.status).toBe("ok");
        expect(result.stdout).toBe("abcde\n\n[opencode output truncated at 5 bytes]");
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
        const result = await runOpenCode({ prompt: "prompt", model: "model", workdir, sanitizeEnv: true });
        expect(result.status).toBe("exit");
        expect(result.exitCode).toBe(7);
        expect(result.message).toContain("opencode exited with code 7:\nbad things");
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
        const result = await runOpenCode({ prompt: "prompt", model: "model", workdir, sanitizeEnv: true });
        expect(result.status).toBe("exit");
        expect(result.message).toContain("opencode exited with code 7");
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

  test("kills the child when aborted", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
exec sleep 30
`,
      async (_binDir, workdir) => {
        const abort = new AbortController();
        const run = runOpenCode({
          prompt: "prompt",
          model: "model",
          workdir,
          sanitizeEnv: true,
          abortSignal: abort.signal,
        });
        await Bun.sleep(50);
        abort.abort();
        await expect(run).rejects.toMatchObject({ name: "AbortError", message: "cancelled" });
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
        const result = await runOpenCode({ prompt: "prompt", model: "model", workdir, sanitizeEnv: true });
        expect(result.status).toBe("exit");
        expect(result.message).toContain("[opencode stderr truncated at");
        expect(result.message).toContain("kept last");
      }
    );
  });

  test("keeps the tail of oversized stderr on failed runs", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
python3 - <<'PY' >&2
import sys
sys.stdout.write("HEADMARKER\\n")
sys.stdout.write("x" * 100000)
sys.stdout.write("\\nTAILMARKER\\n")
PY
exit 7
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({ prompt: "prompt", model: "model", workdir, sanitizeEnv: true });
        expect(result.status).toBe("exit");
        expect(result.message).toContain("[opencode stderr truncated at");
        expect(result.message).toContain("kept last");
        expect(result.message).toContain("TAILMARKER");
        expect(result.message).not.toContain("HEADMARKER");
      }
    );
  });

  test("logs the captured stderr on success instead of a 2 KiB head", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
python3 - <<'PY' >&2
print("HEADMARKER")
print("y" * 5000)
print("TAILMARKER")
PY
`,
      async (_binDir, workdir) => {
        const logs: string[] = [];
        const result = await runOpenCode({
          prompt: "prompt",
          model: "model",
          workdir,
          sanitizeEnv: true,
          logger: (message) => logs.push(message),
        });
        expect(result.status).toBe("ok");
        const stderrLog = logs.find((line) => line.includes("[opencode stderr]"));
        expect(stderrLog).toBeDefined();
        expect(stderrLog).toContain("HEADMARKER");
        expect(stderrLog).toContain("TAILMARKER");
        expect(stderrLog!.length).toBeGreaterThan(2000);
        expect(stderrLog).not.toContain("stderr log capped at 2000");
      }
    );
  });

  test("logs the last 64 KiB of stderr when the child writes more", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
python3 - <<'PY' >&2
import sys
sys.stdout.write("HEADMARKER\\n")
sys.stdout.write("z" * 100000)
sys.stdout.write("\\nTAILMARKER\\n")
PY
`,
      async (_binDir, workdir) => {
        const logs: string[] = [];
        const result = await runOpenCode({
          prompt: "prompt",
          model: "model",
          workdir,
          sanitizeEnv: true,
          logger: (message) => logs.push(message),
        });
        expect(result.status).toBe("ok");
        const stderrLog = logs.find((line) => line.includes("[opencode stderr]"));
        expect(stderrLog).toBeDefined();
        expect(stderrLog).toContain("TAILMARKER");
        expect(stderrLog).toContain("kept last");
        expect(stderrLog).not.toContain("HEADMARKER");
      }
    );
  });

  test("returns timeout when the child is killed by timeoutMs", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
exec sleep 30
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({
          prompt: "prompt",
          model: "model",
          workdir,
          sanitizeEnv: true,
          timeoutMs: 100,
        });
        expect(result.status).toBe("timeout");
        expect(result.message).toContain("opencode exited with code");
      }
    );
  });

  test("returns timeout when the child traps TERM and exits 0", async () => {
    await withFakeOpenCode(
      `#!/usr/bin/env python3
import signal
import sys
import time
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
time.sleep(30)
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({
          prompt: "prompt",
          model: "model",
          workdir,
          sanitizeEnv: true,
          timeoutMs: 100,
        });
        expect(result.status).toBe("timeout");
        expect(result.exitCode).toBe(0);
        expect(result.message).toContain("opencode exited with code");
      }
    );
  });
});
