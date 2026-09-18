import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { providerAuthDeathMessage } from "../src/auth.ts";
import {
  CLAUDE_ALLOWED_TOOLS,
  CLAUDE_PERMISSION_MODE,
  CLAUDE_SETTING_SOURCES,
  claudeArgv,
  inspectClaudeUsageLimit,
  runClaude,
} from "../src/claude.ts";
import { renderRunMetrics, resetControlMetricsForTests } from "../src/control_metrics.ts";
import { runRegisteredEngine } from "../src/engine_dispatch.ts";
import { QUOTA_MESSAGE } from "../src/quota.ts";

const originalPath = process.env.PATH;
const originalSecret = process.env.GITEA_BOT_TOKEN;
const originalOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const originalXdg = process.env.XDG_CONFIG_HOME;

afterEach(() => {
  resetControlMetricsForTests();
  process.env.PATH = originalPath;
  if (originalSecret === undefined) delete process.env.GITEA_BOT_TOKEN;
  else process.env.GITEA_BOT_TOKEN = originalSecret;
  if (originalOauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOauth;
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
});

async function withFakeClaude(script: string, run: (workdir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "fake-claude-"));
  const workdir = await mkdtemp(join(tmpdir(), "fake-claude-work-"));
  try {
    const bin = join(dir, "claude");
    await writeFile(bin, script);
    await chmod(bin, 0o755);
    process.env.PATH = `${dir}:${originalPath ?? ""}`;
    await run(workdir);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
  }
}

describe("inspectClaudeUsageLimit", () => {
  test("classifies Claude session and usage limits as resetting", () => {
    expect(inspectClaudeUsageLimit("You've hit your session limit · resets 12:50am (UTC)")).toBe("resetting");
    expect(inspectClaudeUsageLimit("You've hit your usage limit")).toBe("resetting");
    expect(inspectClaudeUsageLimit("You've hit your Opus limit")).toBe("resetting");
    expect(inspectClaudeUsageLimit("You've hit your Sonnet limit")).toBe("resetting");
    expect(inspectClaudeUsageLimit("You've hit your limit · resets 5pm")).toBe("resetting");
    expect(inspectClaudeUsageLimit("Claude AI usage limit reached")).toBe("resetting");
  });

  test("does not guess from generic rate-limit or bare usage-limit text", () => {
    expect(inspectClaudeUsageLimit("429 rate limit exceeded")).toBeUndefined();
    expect(inspectClaudeUsageLimit("You've hit your spend limit")).toBeUndefined();
    expect(inspectClaudeUsageLimit("Usage limit reached. It will reset in 1 hour")).toBeUndefined();
    expect(inspectClaudeUsageLimit("my-model usage limit reached")).toBeUndefined();
    expect(inspectClaudeUsageLimit("bad things")).toBeUndefined();
    expect(inspectClaudeUsageLimit("")).toBeUndefined();
    expect(inspectClaudeUsageLimit(null)).toBeUndefined();
  });
});

describe("claudeArgv", () => {
  test("uses -p, user setting-sources, allowlist, and never --bare", () => {
    const args = claudeArgv({ model: "opus", effort: "high", workdir: "/work" });
    expect(args).toEqual([
      "claude",
      "-p",
      "--setting-sources",
      CLAUDE_SETTING_SOURCES,
      "--permission-mode",
      CLAUDE_PERMISSION_MODE,
      "--allowedTools",
      CLAUDE_ALLOWED_TOOLS,
      "--model",
      "opus",
      "--effort",
      "high",
    ]);
    expect(args).not.toContain("--bare");
    expect(CLAUDE_SETTING_SOURCES).toBe("user");
  });
});

describe("runClaude", () => {
  test("passes HOME and OAuth token, scrubs forge secrets, and does not use OpenCode XDG_CONFIG_HOME", async () => {
    process.env.GITEA_BOT_TOKEN = "secret-token";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-token";
    process.env.XDG_CONFIG_HOME = "/tmp/opencode-xdg";
    await withFakeClaude(
      `#!/bin/sh
printf 'HOME=%s OAUTH=%s XDG_CONFIG=%s SECRET=%s ARGS=%s CWD=%s\\n' "$HOME" "$CLAUDE_CODE_OAUTH_TOKEN" "$XDG_CONFIG_HOME" "$GITEA_BOT_TOKEN" "$*" "$(pwd)"
`,
      async (workdir) => {
        const result = await runClaude({
          prompt: "prompt",
          model: "opus",
          effort: "high",
          workdir,
          home: "/data",
          sanitizeEnv: true,
        });
        expect(result.status).toBe("ok");
        expect(result.stdout).toContain("HOME=/data");
        expect(result.stdout).toContain("OAUTH=oauth-token");
        expect(result.stdout).toContain("XDG_CONFIG=");
        expect(result.stdout).not.toContain("opencode-xdg");
        expect(result.stdout).not.toContain(`${workdir}/.jumi-tmp/xdg-config`);
        expect(result.stdout).toContain("SECRET=");
        expect(result.stdout).toContain(`-p --setting-sources ${CLAUDE_SETTING_SOURCES}`);
        expect(result.stdout).toContain(`--permission-mode ${CLAUDE_PERMISSION_MODE}`);
        expect(result.stdout).toContain(`--allowedTools ${CLAUDE_ALLOWED_TOOLS}`);
        expect(result.stdout).toContain("--model opus --effort high");
        expect(result.stdout).not.toContain("--bare");
        expect(result.stdout).toContain(`CWD=${workdir}`);
      }
    );
  });

  test("scrubs extraEnv forge tokens", async () => {
    await withFakeClaude(
      `#!/bin/sh
printf 'TOKEN=%s PEM=%s JAVA=%s\\n' "$GITEA_BOT_TOKEN" "$GITHUB_APP_PRIVATE_KEY" "$JAVA_HOME"
`,
      async (workdir) => {
        const result = await runClaude({
          prompt: "prompt",
          model: "opus",
          workdir,
          sanitizeEnv: true,
          extraEnv: {
            JAVA_HOME: "/opt/java/openjdk",
            GITEA_BOT_TOKEN: "should-not-pass",
            GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nMII\\n-----END PRIVATE KEY-----",
          },
        });
        expect(result.status).toBe("ok");
        expect(result.stdout).toContain("JAVA=/opt/java/openjdk");
        expect(result.stdout).toContain("TOKEN=");
        expect(result.stdout).toContain("PEM=");
        expect(result.stdout).not.toContain("BEGIN PRIVATE KEY");
      }
    );
  });

  test("classifies auth death from stdout", async () => {
    await withFakeClaude(
      `#!/bin/sh
printf 'not logged in\\n'
exit 1
`,
      async (workdir) => {
        const result = await runClaude({ prompt: "prompt", model: "opus", workdir, sanitizeEnv: true });
        expect(result.status).toBe("exit");
        expect(result.auth).toBe(true);
        expect(result.infra).toBe(false);
        expect(result.message).toBe(providerAuthDeathMessage());
        expect(result.message).toContain(hostname());
        const text = renderRunMetrics();
        expect(text).toContain('jumi_opencode_exits_total{kind="review",class="auth"} 1');
      }
    );
  });

  test("records ok runs on the existing exit and duration series", async () => {
    await withFakeClaude(
      `#!/bin/sh
printf 'ok\\n'
`,
      async (workdir) => {
        const result = await runClaude({
          prompt: "prompt",
          model: "opus",
          workdir,
          sanitizeEnv: true,
          trace: { kind: "implement", owner: "kirmanak", repo: "demo" },
        });
        expect(result.status).toBe("ok");
        const text = renderRunMetrics();
        expect(text).toContain('jumi_opencode_exits_total{kind="implement",class="ok"} 1');
        expect(text).toContain('jumi_job_duration_seconds_count{kind="implement",result="ok"} 1');
      }
    );
  });

  test("classifies session limit as resetting quota stuck, not a plain exit", async () => {
    await withFakeClaude(
      `#!/bin/sh
printf '%s\\n' "You've hit your session limit · resets 12:50am (UTC)" >&2
exit 1
`,
      async (workdir) => {
        const result = await runClaude({
          prompt: "prompt",
          model: "opus",
          workdir,
          sanitizeEnv: true,
          trace: { kind: "implement", owner: "kirmanak", repo: "demo" },
        });
        expect(result.status).toBe("stuck");
        expect(result.quota).toBe("resetting");
        expect(result.auth).toBeFalsy();
        expect(result.infra).toBe(false);
        expect(result.message).toBe(QUOTA_MESSAGE);
        const text = renderRunMetrics();
        expect(text).toContain('jumi_opencode_exits_total{kind="implement",class="quota"} 1');
        expect(text).toContain('jumi_job_duration_seconds_count{kind="implement",result="quota"} 1');
        expect(text).not.toContain('kind="implement",class="incomplete"} 1');
      }
    );
  });

  test("unknown non-zero stays exit and still records metrics", async () => {
    await withFakeClaude(
      `#!/bin/sh
printf 'Usage limit reached. It will reset in 1 hour\\n' >&2
exit 1
`,
      async (workdir) => {
        const result = await runClaude({ prompt: "prompt", model: "opus", workdir, sanitizeEnv: true });
        expect(result.status).toBe("exit");
        expect(result.quota).toBeUndefined();
        expect(result.message).toContain("claude exited with code 1");
        const text = renderRunMetrics();
        expect(text).toContain('jumi_opencode_exits_total{kind="review",class="incomplete"} 1');
        expect(text).not.toContain('kind="review",class="quota"} 1');
      }
    );
  });
});

describe("runRegisteredEngine", () => {
  test("dispatches type claude to the claude binary", async () => {
    await withFakeClaude(
      `#!/bin/sh
printf 'dispatched %s\\n' "$*"
`,
      async (workdir) => {
        const result = await runRegisteredEngine({
          type: "claude",
          prompt: "prompt",
          model: "opus",
          workdir,
          sanitizeEnv: true,
        });
        expect(result.status).toBe("ok");
        expect(result.stdout).toContain("-p --setting-sources user");
      }
    );
  });
});
