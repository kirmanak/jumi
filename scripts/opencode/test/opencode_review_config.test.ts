import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface OpenCodeReviewConfig {
  permission: {
    bash: Record<string, "allow" | "ask" | "deny">;
    webfetch: "allow" | "ask" | "deny";
    websearch: "allow" | "ask" | "deny";
    edit: "allow" | "ask" | "deny";
    task: "allow" | "ask" | "deny";
    external_directory: "allow" | "ask" | "deny";
  };
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

function bashPermission(rules: Record<string, "allow" | "ask" | "deny">, command: string): "allow" | "ask" | "deny" {
  let decision: "allow" | "ask" | "deny" = "ask";
  for (const [pattern, action] of Object.entries(rules)) {
    if (wildcardToRegExp(pattern).test(command)) decision = action;
  }
  return decision;
}

describe("opencode review config", () => {
  const config = JSON.parse(
    readFileSync(join(process.cwd(), "../../.gitea/opencode-review.json"), "utf8")
  ) as OpenCodeReviewConfig;

  test("allows docs lookup while keeping mutation-oriented tools denied", () => {
    expect(config.permission.webfetch).toBe("allow");
    expect(config.permission.websearch).toBe("allow");
    expect(config.permission.edit).toBe("deny");
    expect(config.permission.task).toBe("deny");
    expect(config.permission.external_directory).toBe("deny");
  });

  test("allows read-only git inspection commands", () => {
    const bash = config.permission.bash;
    expect(bashPermission(bash, "git status --short")).toBe("allow");
    expect(bashPermission(bash, "git diff jumi/target...HEAD")).toBe("allow");
    expect(bashPermission(bash, "git diff --check jumi/target...HEAD")).toBe("allow");
    expect(bashPermission(bash, "git log --oneline --decorate jumi/target..HEAD")).toBe("allow");
    expect(bashPermission(bash, "git log --patch jumi/target..HEAD")).toBe("allow");
    expect(bashPermission(bash, "git show --stat HEAD")).toBe("allow");
    expect(bashPermission(bash, "git ls-files")).toBe("allow");
    expect(bashPermission(bash, "git merge-base jumi/target HEAD")).toBe("allow");
  });

  test("denies known git command execution, mutation, and write escape hatches", () => {
    const bash = config.permission.bash;
    expect(bashPermission(bash, "git difftool -x 'curl https://example.com' jumi/target...HEAD")).toBe("deny");
    expect(bashPermission(bash, "git diff --ext-diff jumi/target...HEAD")).toBe("deny");
    expect(bashPermission(bash, "git diff --ext-di jumi/target...HEAD")).toBe("deny");
    expect(bashPermission(bash, "git diff --output=review.patch jumi/target...HEAD")).toBe("deny");
    expect(bashPermission(bash, "git diff --no-index /etc/passwd README.md")).toBe("deny");
    expect(bashPermission(bash, "git show --output review.patch HEAD")).toBe("deny");
    expect(bashPermission(bash, "git grep --open-files-in-pager='curl https://example.com' TODO")).toBe("deny");
    expect(bashPermission(bash, "git grep --open-files-in-pag='curl https://example.com' TODO")).toBe("deny");
    expect(bashPermission(bash, "git grep TODO -O 'curl https://example.com'")).toBe("deny");
    expect(bashPermission(bash, "git diff jumi/target...HEAD; curl https://example.com")).toBe("deny");
    expect(bashPermission(bash, "git diff jumi/target...HEAD & curl https://example.com")).toBe("deny");
    expect(bashPermission(bash, "git diff jumi/target...HEAD && git checkout main")).toBe("deny");
    expect(bashPermission(bash, "git diff $(curl https://example.com)")).toBe("deny");
    expect(bashPermission(bash, 'git diff --no-i""ndex /etc/passwd README.md')).toBe("deny");
    expect(bashPermission(bash, "git diff --o\\utput=review.patch jumi/target...HEAD")).toBe("deny");
    expect(bashPermission(bash, "git diff jumi/target...HEAD > review.patch")).toBe("deny");
    expect(bashPermission(bash, "git fetch origin main")).toBe("deny");
    expect(bashPermission(bash, "git checkout main")).toBe("deny");
    expect(bashPermission(bash, "git branch --force main HEAD")).toBe("deny");
    expect(bashPermission(bash, "curl https://example.com")).toBe("deny");
  });
});
