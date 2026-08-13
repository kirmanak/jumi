import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface OpenCodeReviewConfig {
  model?: unknown;
  small_model?: unknown;
  enabled_providers?: unknown;
  provider?: {
    xai?: {
      models?: Record<string, { options?: { reasoningEffort?: unknown } }>;
    };
    openai?: {
      models?: Record<string, { options?: { reasoningEffort?: unknown } }>;
    };
  };
  permission: {
    bash: Record<string, "allow" | "ask" | "deny">;
    webfetch: "allow" | "ask" | "deny";
    websearch: "allow" | "ask" | "deny";
    edit: "allow" | "ask" | "deny";
    task: "allow" | "ask" | "deny";
    external_directory: "allow" | "ask" | "deny";
    lsp: "allow" | "ask" | "deny";
    skill: "allow" | "ask" | "deny";
  };
}

function bashPermission(rules: Record<string, "allow" | "ask" | "deny">, command: string): "allow" | "ask" | "deny" {
  // Mirror OpenCode's Wildcard.match semantics (packages/*/util/wildcard.ts):
  // normalize backslashes, convert globs, treat trailing " .*" as optional args,
  // and use the dotAll flag so "." matches newlines.
  const normalized = command.replaceAll("\\", "/");
  let decision: "allow" | "ask" | "deny" = "ask";
  for (const [pattern, action] of Object.entries(rules)) {
    let escaped = pattern
      .replaceAll("\\", "/")
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
    if (new RegExp(`^${escaped}$`, "s").test(normalized)) decision = action;
  }
  return decision;
}

describe("opencode review config", () => {
  const config = JSON.parse(
    readFileSync(join(process.cwd(), "../../.gitea/opencode-review.json"), "utf8")
  ) as OpenCodeReviewConfig;

  test("keeps model selection remote while pinning reviewer reasoning high", () => {
    expect(config.model).toBeUndefined();
    expect(config.small_model).toBeUndefined();
    expect(config.enabled_providers).toBeUndefined();
    expect(config.provider?.xai?.models?.["grok-4.5"]?.options?.reasoningEffort).toBe("high");
    expect(config.provider?.xai?.models?.["grok-4.6"]?.options?.reasoningEffort).toBe("high");
    expect(config.provider?.openai?.models?.["gpt-5.5"]?.options?.reasoningEffort).toBe("high");
  });

  test("allows docs lookup while keeping mutation-oriented tools denied", () => {
    expect(config.permission.webfetch).toBe("allow");
    expect(config.permission.websearch).toBe("allow");
    expect(config.permission.lsp).toBe("deny");
    expect(config.permission.edit).toBe("deny");
    expect(config.permission.task).toBe("deny");
    expect(config.permission.external_directory).toBe("deny");
    expect(config.permission.skill).toBe("deny");
  });

  test("defaults bash to allow, including pipes, quotes, and previously sealed searches", () => {
    const bash = config.permission.bash;
    expect(bash["*"]).toBe("allow");
    expect(Object.keys(bash)).toEqual(["*"]);
    expect(bashPermission(bash, "git grep -n foo|bar path")).toBe("allow");
    expect(bashPermission(bash, `git grep -n "RefuseManualStart\\|pve-guests" jumi/target -- "*.yml"`)).toBe("allow");
    expect(bashPermission(bash, "git grep -n 'TODO' -- path")).toBe("allow");
    expect(bashPermission(bash, "git log --patch jumi/target..HEAD")).toBe("allow");
    expect(bashPermission(bash, "git diff --unified=80 jumi/target...HEAD -- path/to/file")).toBe("allow");
    expect(bashPermission(bash, "rg -n checksum values.yaml | head")).toBe("allow");
    expect(bashPermission(bash, "cat src/data/config.json")).toBe("allow");
    expect(bashPermission(bash, "git status --short && git diff --stat jumi/target...HEAD")).toBe("allow");
  });
});

describe("reviewer image permissions", () => {
  const dockerfile = readFileSync(join(process.cwd(), "../../Dockerfile"), "utf8");

  test("does not chown /app to the reviewer uid", () => {
    expect(dockerfile).not.toMatch(/chown\s+-R\s+jumi:jumi\s+\/app/);
    expect(dockerfile).toMatch(/chown\s+-R\s+jumi:jumi\s+\/data\s+\/work/);
  });
});
