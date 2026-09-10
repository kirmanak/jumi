import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface OpenCodeReviewConfig {
  model?: unknown;
  small_model?: unknown;
  enabled_providers?: unknown;
  skills?: { paths?: string[] };
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
    write: "allow" | "ask" | "deny";
    task: "allow" | "ask" | "deny";
    external_directory: "allow" | "ask" | "deny" | { [pattern: string]: "allow" | "ask" | "deny" };
    lsp: "allow" | "ask" | "deny";
    skill: "allow" | "ask" | "deny" | { [pattern: string]: "allow" | "ask" | "deny" };
    question: "allow" | "ask" | "deny";
    doom_loop: "allow" | "ask" | "deny";
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

  test("allows edit/write for JUMI_REVIEW.md while keeping other mutation-oriented tools denied", () => {
    expect(config.permission.webfetch).toBe("allow");
    expect(config.permission.websearch).toBe("allow");
    expect(config.permission.edit).toBe("allow");
    expect(config.permission.write).toBe("allow");
    expect(config.permission.skill).toEqual({ "*": "deny", "gitops-apply-review": "allow" });
    expect(config.permission.lsp).toBe("deny");
    expect(config.permission.task).toBe("deny");
    expect(config.permission.question).toBe("deny");
    expect(config.permission.doom_loop).toBe("deny");
    expect(config.skills?.paths).toEqual(["/app/review-skills"]);
  });

  test("allows Read of baked review-skills after star deny (last-match)", () => {
    const rules = config.permission.external_directory;
    expect(rules).toEqual({ "*": "deny", "/app/review-skills/**": "allow" });
    if (typeof rules === "string") throw new Error("expected last-match object, not scalar deny");
    expect(Object.keys(rules)).toEqual(["*", "/app/review-skills/**"]);

    expect(bashPermission(rules, "/app/review-skills/gitops-apply-review/*")).toBe("allow");
    expect(bashPermission(rules, "/app/review-skills/gitops-apply-review/references/*")).toBe("allow");
    expect(bashPermission(rules, "/app/review-skills/*")).toBe("allow");
    expect(bashPermission(rules, "/app/*")).toBe("deny");
    expect(bashPermission(rules, "/app/.gitea/*")).toBe("deny");
    expect(bashPermission(rules, "/app/scripts/*")).toBe("deny");
    expect(bashPermission(rules, "/etc/*")).toBe("deny");
    expect(bashPermission(rules, "/data/*")).toBe("deny");
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
    expect(bashPermission(bash, "git commit -m wip")).toBe("allow");
    expect(bashPermission(bash, "git push -u origin HEAD")).toBe("allow");
    expect(Object.keys(bash).some((pattern) => /git commit|git push/i.test(pattern))).toBe(false);
    expect(Object.keys(bash).some((pattern) => pattern.includes("git commit"))).toBe(false);
  });
});

describe("reviewer image permissions", () => {
  const repoRoot = join(process.cwd(), "../..");
  const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
  const skillPath = join(repoRoot, "review-skills/gitops-apply-review/SKILL.md");

  test("does not chown /app to the reviewer uid", () => {
    expect(dockerfile).not.toMatch(/chown\s+-R\s+jumi:jumi\s+\/app/);
    expect(dockerfile).toMatch(/chown\s+-R\s+jumi:jumi\s+\/data\s+\/work/);
  });

  test("copies gitops-apply-review into the image layout the config points at", () => {
    expect(existsSync(skillPath)).toBe(true);
    expect(readFileSync(skillPath, "utf8")).toContain("name: gitops-apply-review");
    expect(dockerfile).toContain("COPY review-skills /app/review-skills");
  });

  test("installs python3 and helm in the runtime image", () => {
    expect(dockerfile).toMatch(/python3/);
    expect(dockerfile).toMatch(/python3 --version/);
    expect(dockerfile).toMatch(/helm version --short/);
    expect(dockerfile).toMatch(/get\.helm\.sh\/helm-v\$\{HELM_VERSION\}/);
    expect(dockerfile).not.toMatch(/kubectl/);
  });
});

describe("worker image JDK", () => {
  const repoRoot = join(process.cwd(), "../..");
  const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
  const workerStage = dockerfile.slice(dockerfile.indexOf("FROM runtime AS worker"));
  const beforeWorker = dockerfile.slice(0, dockerfile.indexOf("FROM runtime AS worker"));

  test("copies pinned Temurin 21 into the worker target only", () => {
    expect(dockerfile).toContain("ARG TEMURIN_TAG=21.0.12_8-jdk");
    expect(dockerfile).toMatch(/FROM eclipse-temurin:\$\{TEMURIN_TAG\} AS jdk/);
    expect(workerStage).toContain("COPY --from=jdk /opt/java/openjdk /opt/java/openjdk");
    expect(workerStage).toContain("JAVA_HOME=/opt/java/openjdk");
    expect(beforeWorker).not.toContain("COPY --from=jdk");
    expect(beforeWorker).not.toContain("JAVA_HOME=");
  });
});
