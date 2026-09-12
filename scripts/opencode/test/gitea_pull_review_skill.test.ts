import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const skill = readFileSync(join(process.cwd(), "../../review-skills/gitea-pull-review/SKILL.md"), "utf8");

describe("gitea-pull-review skill", () => {
  test("pins Gitea 1.27 create/list/submit and forbids go-gitea/main safari", () => {
    expect(skill).toContain("name: gitea-pull-review");
    expect(skill).toContain("Load this skill via the skill tool.");
    expect(skill).toContain("Gitea 1.27");
    expect(skill).toContain("1.27.3");
    expect(skill).toContain("/pulls/{index}/reviews");
    expect(skill).toContain("PENDING");
    expect(skill).toContain("commit_id");
    expect(skill).toContain("head.sha");
    expect(skill).toContain("new_position");
    expect(skill).toContain("old_position");
    expect(skill).toContain("POST .../pulls/{index}/reviews/{id}");
    expect(skill).toContain("GET .../pulls/{index}/reviews/{id}/comments");
    expect(skill).toContain("no nested `comments` array");
    expect(skill).toContain("stale: false");
    expect(skill).toContain("422");
    expect(skill).toContain("`PENDING` requires a non-empty `body`");
    expect(skill).not.toMatch(/[Bb]ad positions/);
    expect(skill).toContain("rewrites `commit_id` to current head");
    expect(skill).not.toMatch(/not the current head is a `422`/);
    expect(skill).toContain("Webfetch `go-gitea/gitea` main");
    expect(skill).toContain("**no** `POST .../reviews/{id}/comments`");
    expect(skill).toContain("**no** `GET .../pulls/{index}/comments`");
    expect(skill).not.toContain("/app/review-skills");
    expect(skill).not.toMatch(/raw\.githubusercontent\.com\/go-gitea\/gitea\/main\/.+\.go/);
  });

  test("separates submit, issue comments, and GitHub-only paths", () => {
    expect(skill).toContain("POST .../issues/{index}/comments");
    expect(skill).toContain("POST .../pulls/{index}/comments/{id}/replies");
    expect(skill).toContain("Not GitHub `.../reviews/{id}/events`");
    expect(skill).toContain("REQUEST_CHANGES");
    expect(skill).toContain("APPROVED");
    expect(skill).toContain("create/list/submit pending and `COMMENT` only");
  });
});
