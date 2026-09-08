import { describe, expect, test } from "bun:test";
import { isAssignedToBot, isPullRequestIssue } from "../src/assignee.ts";
import { makeIssue, makeUser } from "./fixtures.ts";

describe("isAssignedToBot", () => {
  test("matches assignee or assignees for the bot username", () => {
    expect(isAssignedToBot(makeIssue(), "jumi")).toBe(true);
    expect(isAssignedToBot(makeIssue({ assignee: null, assignees: [makeUser({ login: "jumi" })] }), "jumi")).toBe(true);
    expect(isAssignedToBot(makeIssue({ assignee: makeUser({ login: "jumi" }), assignees: [] }), "jumi")).toBe(true);
  });

  test("returns false when the bot is not assigned", () => {
    expect(
      isAssignedToBot(
        makeIssue({ assignee: makeUser({ login: "alice" }), assignees: [makeUser({ login: "alice" })] }),
        "jumi"
      )
    ).toBe(false);
    expect(isAssignedToBot(makeIssue({ assignee: null, assignees: null }), "jumi")).toBe(false);
  });

  test("matches Gitea username compat field and ignores login case", () => {
    expect(isAssignedToBot({ assignee: { username: "jumi" }, assignees: null }, "jumi")).toBe(true);
    expect(isAssignedToBot({ assignee: { login: "Jumi" }, assignees: [] }, "jumi")).toBe(true);
  });
});

describe("isPullRequestIssue", () => {
  test("detects pull request issues", () => {
    expect(isPullRequestIssue(makeIssue())).toBe(false);
    expect(isPullRequestIssue(makeIssue({ pull_request: null }))).toBe(false);
    expect(isPullRequestIssue(makeIssue({ pull_request: { merged_at: null } }))).toBe(true);
    expect(isPullRequestIssue(makeIssue({ is_pull: true }))).toBe(true);
  });
});
