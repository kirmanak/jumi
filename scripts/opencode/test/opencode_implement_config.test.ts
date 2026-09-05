import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IMPLEMENT_PROMPT } from "../src/implement.ts";

interface OpenCodeImplementConfig {
  skills?: unknown;
  permission: {
    bash: Record<string, "allow" | "ask" | "deny">;
    edit: "allow" | "ask" | "deny";
    write: "allow" | "ask" | "deny";
    task: "allow" | "ask" | "deny";
    skill: "allow" | "ask" | "deny";
    todowrite: "allow" | "ask" | "deny";
    question: "allow" | "ask" | "deny";
    external_directory: "allow" | "ask" | "deny";
    webfetch: "allow" | "ask" | "deny";
    lsp: "allow" | "ask" | "deny";
  };
}

function bashPermission(rules: Record<string, "allow" | "ask" | "deny">, command: string): "allow" | "ask" | "deny" {
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

describe("opencode implement config", () => {
  const config = JSON.parse(
    readFileSync(join(process.cwd(), "../../.gitea/opencode-implement.json"), "utf8")
  ) as OpenCodeImplementConfig;

  test("allows skills, tasks, and edits for the implement worker", () => {
    expect(config.skills).toBeUndefined();
    expect(config.permission.skill).toBe("allow");
    expect(config.permission.task).toBe("allow");
    expect(config.permission.todowrite).toBe("allow");
    expect(config.permission.edit).toBe("allow");
    expect(config.permission.write).toBe("allow");
    expect(config.permission.webfetch).toBe("allow");
    expect(config.permission.lsp).toBe("allow");
    expect(config.permission.question).toBe("deny");
    expect(config.permission.external_directory).toBe("deny");
  });

  test("defaults bash to allow instead of a git-only cathedral", () => {
    const bash = config.permission.bash;
    expect(bash["*"]).toBe("allow");
    expect(Object.keys(bash)).toEqual(["*"]);
    expect(bashPermission(bash, "git commit -m wip")).toBe("allow");
    expect(bashPermission(bash, "git push -u origin HEAD")).toBe("allow");
    expect(bashPermission(bash, "bun test")).toBe("allow");
    expect(bashPermission(bash, "rg -n foo | head")).toBe("allow");
  });
});

describe("implement prompt", () => {
  test("allows incremental git commit and push, forbids force-push and questions", () => {
    expect(IMPLEMENT_PROMPT).toContain("commit");
    expect(IMPLEMENT_PROMPT).toContain("push");
    expect(IMPLEMENT_PROMPT).toContain("Do not force-push");
    expect(IMPLEMENT_PROMPT).toContain("Do not ask questions");
    expect(IMPLEMENT_PROMPT).not.toContain("Do not run git");
    expect(IMPLEMENT_PROMPT).toContain("JUMI_PR.md");
    expect(IMPLEMENT_PROMPT).toContain("Do not open the pull request");
  });
});
