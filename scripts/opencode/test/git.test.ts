import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFLICT_PROMPT, FOLLOWUP_PROMPT, IMPLEMENT_PROMPT, resolveOpenCodePrompt, runOpenCode } from "../src/git.ts";
import { setTraceFetchForTests, traceExportErrors } from "../src/phoenix.ts";
import { renderTokenMetrics, resetTokenMetricsForTests } from "../src/token_metrics.ts";

const originalPath = process.env.PATH;
const originalSecret = process.env.GITEA_BOT_TOKEN;
const originalPhoenix = process.env.PHOENIX_OTLP_ENDPOINT;

beforeEach(() => {
  delete process.env.PHOENIX_OTLP_ENDPOINT;
});

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalSecret === undefined) delete process.env.GITEA_BOT_TOKEN;
  else process.env.GITEA_BOT_TOKEN = originalSecret;
  if (originalPhoenix === undefined) delete process.env.PHOENIX_OTLP_ENDPOINT;
  else process.env.PHOENIX_OTLP_ENDPOINT = originalPhoenix;
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

  test("forwards extraEnv toolchain vars into the sanitized child", async () => {
    process.env.GITEA_BOT_TOKEN = "secret-token";
    await withFakeOpenCode(
      `#!/bin/sh
printf 'JAVA_HOME=%s TMPOPT=%s GRADLE_HOME=%s DAEMON=%s SECRET=%s\\n' "$JAVA_HOME" "$JAVA_TOOL_OPTIONS" "$GRADLE_USER_HOME" "$GRADLE_OPTS" "$GITEA_BOT_TOKEN"
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({
          prompt: "prompt",
          model: "model",
          workdir,
          sanitizeEnv: true,
          extraEnv: {
            JAVA_HOME: "/opt/java/openjdk",
            JAVA_TOOL_OPTIONS: `-Djava.io.tmpdir=${workdir}/.jumi-tmp`,
            GRADLE_USER_HOME: "/work/.gradle",
            GRADLE_OPTS: "-Dorg.gradle.daemon=false",
            GITEA_BOT_TOKEN: "should-not-pass",
          },
        });
        expect(result.status).toBe("ok");
        expect(result.stdout).toContain("JAVA_HOME=/opt/java/openjdk");
        expect(result.stdout).toContain(`TMPOPT=-Djava.io.tmpdir=${workdir}/.jumi-tmp`);
        expect(result.stdout).toContain("GRADLE_HOME=/work/.gradle");
        expect(result.stdout).toContain("DAEMON=-Dorg.gradle.daemon=false");
        expect(result.stdout).toContain("SECRET=");
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

  test("exports a Phoenix trace after OpenCode exits and ignores export failures", async () => {
    process.env.PHOENIX_OTLP_ENDPOINT = "http://phoenix.internal:6006";
    const posts: Uint8Array[] = [];
    setTraceFetchForTests(async (_url, init) => {
      posts.push(new Uint8Array(init?.body as Uint8Array));
      return new Response("no", { status: 500 });
    });
    await withFakeOpenCode(
      `#!/bin/sh
python3 - <<'PY'
import json, os, sqlite3
path = os.environ["OPENCODE_DB"]
con = sqlite3.connect(path)
con.execute("CREATE TABLE session (id TEXT, time_created INTEGER, time_updated INTEGER)")
con.execute("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)")
con.execute("CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)")
con.execute("INSERT INTO session VALUES (?, ?, ?)", ("ses1", 1, 2))
con.execute(
  "INSERT INTO message VALUES (?, ?, ?, ?, ?)",
  ("msg1", "ses1", 1, 2, json.dumps({"role": "assistant", "modelID": "grok-4.6", "providerID": "xai"})),
)
con.execute(
  "INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)",
  ("p1", "msg1", "ses1", 1, 2, json.dumps({
    "type": "tool",
    "tool": "bash",
    "state": {"status": "error", "input": {"command": "pwd"}, "output": "FULL_STDOUT", "error": "boom", "time": {"start": 1, "end": 2}},
  })),
)
con.commit()
PY
`,
      async (_binDir, workdir) => {
        const result = await runOpenCode({
          prompt: "prompt",
          model: "model",
          workdir,
          sanitizeEnv: true,
          trace: { kind: "review", owner: "personal", repo: "jumi", sha: "abc", jobId: "7" },
        });
        expect(result.status).toBe("ok");
        expect(posts).toHaveLength(1);
        const payload = new TextDecoder().decode(posts[0]);
        expect(payload).toContain("bash");
        expect(payload).toContain("FULL_STDOUT");
        expect(traceExportErrors()).toBe(1);
        expect(renderTokenMetrics()).toContain('ai_trace_exporter_errors{agent_instance="jumi"} 1');
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

  test("synthesizes implement stdin when the kernel omits prompt", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
cat
`,
      async (_binDir, workdir) => {
        await writeFile(join(workdir, "JUMI_TASK.md"), "# Fix the thing\n");
        const result = await runOpenCode({
          model: "model",
          workdir,
          sanitizeEnv: true,
          trace: { kind: "implement", owner: "kirmanak", repo: "demo" },
        });
        expect(result.status).toBe("ok");
        expect(result.stdout).toBe(IMPLEMENT_PROMPT);
      }
    );
  });

  test("feeds the review task file as OpenCode stdin", async () => {
    await withFakeOpenCode(
      `#!/bin/sh
cat
`,
      async (_binDir, workdir) => {
        await writeFile(join(workdir, "JUMI_TASK.md"), "review-context-xml");
        const result = await runOpenCode({
          model: "model",
          workdir,
          sanitizeEnv: true,
          trace: { kind: "review", owner: "kirmanak", repo: "demo" },
        });
        expect(result.status).toBe("ok");
        expect(result.stdout).toBe("review-context-xml");
      }
    );
  });

  test("reads OPENCODE_CONFIG from the environment when configPath is omitted", async () => {
    const previous = process.env.OPENCODE_CONFIG;
    process.env.OPENCODE_CONFIG = "/from-env.json";
    try {
      await withFakeOpenCode(
        `#!/bin/sh
printf 'CONFIG=%s\n' "$OPENCODE_CONFIG"
`,
        async (_binDir, workdir) => {
          const result = await runOpenCode({
            prompt: "prompt",
            model: "model",
            workdir,
            sanitizeEnv: true,
          });
          expect(result.status).toBe("ok");
          expect(result.stdout).toContain("CONFIG=/from-env.json");
        }
      );
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG;
      else process.env.OPENCODE_CONFIG = previous;
    }
  });
});

describe("worker prompts", () => {
  const prompts = [IMPLEMENT_PROMPT, FOLLOWUP_PROMPT, CONFLICT_PROMPT];

  test("keep the child in the worktree on the injected brief", () => {
    for (const prompt of prompts) {
      expect(prompt).toContain("Stay in this clone");
      expect(prompt).toContain("do not glob **/*");
      expect(prompt).toContain("Do not webfetch this Gitea host");
      expect(prompt).toContain("Do not call tea or the forge API");
      expect(prompt).toContain("Public upstream docs are fine");
      expect(prompt).toContain("Grep is ripgrep syntax, not JavaScript");
      expect(prompt).toContain("Ignore .jumi-tmp, including opencode-prompt-*/prompt.txt");
      expect(prompt).toContain("Verify once at the end");
      expect(prompt).toContain("Do not ask questions");
      expect(prompt).not.toContain("denied");
      expect(prompt).not.toContain("Do not run git");
    }
  });

  test("conflict stays on the injected conflicted paths", () => {
    expect(CONFLICT_PROMPT).toContain("Resolve only the conflicted paths listed in JUMI_CONFLICT.md");
    expect(CONFLICT_PROMPT).toContain("One adjacent file is allowed only if the resolution truly requires it");
  });
});

describe("resolveOpenCodePrompt", () => {
  test("prefers an explicit prompt", async () => {
    expect(await resolveOpenCodePrompt({ prompt: "explicit", model: "m", workdir: "/tmp" })).toBe("explicit");
  });

  test("uses workspace files when prompt is omitted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-prompt-"));
    try {
      await writeFile(join(dir, "JUMI_TASK.md"), "task");
      expect(await resolveOpenCodePrompt({ model: "m", workdir: dir })).toBe(IMPLEMENT_PROMPT);
      await writeFile(join(dir, "JUMI_FEEDBACK.md"), "feedback");
      expect(await resolveOpenCodePrompt({ model: "m", workdir: dir })).toBe(FOLLOWUP_PROMPT);
      await writeFile(join(dir, "JUMI_CONFLICT.md"), "conflict");
      expect(await resolveOpenCodePrompt({ model: "m", workdir: dir })).toBe(CONFLICT_PROMPT);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
