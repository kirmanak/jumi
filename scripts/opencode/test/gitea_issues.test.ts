import { describe, expect, test } from "bun:test";
import { pullRequestClosesIssue } from "../src/gitea_issues.ts";

describe("pullRequestClosesIssue", () => {
  test("matches Gitea default close keywords and optional colon", () => {
    const cases = [
      "Fixes #12",
      "fix #12",
      "Fixed: #12",
      "Closes #12",
      "close #12",
      "closed #12",
      "Resolves #12",
      "resolved: #12",
      "Please resolve #12 thanks",
    ];
    for (const body of cases) {
      expect(pullRequestClosesIssue({ title: "x", body }, 12), body).toBe(true);
    }
    expect(pullRequestClosesIssue({ title: "Fixes #12", body: "" }, 12)).toBe(true);
  });

  test("does not match other issues or non-keywords", () => {
    expect(pullRequestClosesIssue({ title: "x", body: "Fixes #13" }, 12)).toBe(false);
    expect(pullRequestClosesIssue({ title: "x", body: "unfixed #12" }, 12)).toBe(false);
    expect(pullRequestClosesIssue({ title: "x", body: "see issue 12" }, 12)).toBe(false);
    expect(pullRequestClosesIssue({ title: "x", body: "Fixes #12", state: "closed" }, 12)).toBe(false);
  });
});
