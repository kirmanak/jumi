import { describe, expect, test } from "bun:test";
import {
  extractClosingIssueNumber,
  findOpenClosingPullRequest,
  findOpenJumiClosingPullRequest,
  pullRequestClosesIssue,
} from "../src/gitea_issues.ts";
import { makePR, makeRepo, makeUser } from "./fixtures.ts";

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

describe("extractClosingIssueNumber", () => {
  test("prefers close-keywords and skips when branch number differs", () => {
    expect(extractClosingIssueNumber({ title: "x", body: "Fixes #12" })).toBe(12);
    expect(
      extractClosingIssueNumber({
        title: "x",
        body: "Fixes #12",
        head: { ref: "jumi/issue-12-fix-the-thing" },
      })
    ).toBe(12);
    expect(
      extractClosingIssueNumber({
        title: "x",
        body: "Fixes #12",
        head: { ref: "jumi/issue-13-other" },
      })
    ).toBeUndefined();
    expect(
      extractClosingIssueNumber({
        title: "Fix #11 leftover",
        body: "Fixes #12",
        head: { ref: "jumi/issue-12-fix-the-thing" },
      })
    ).toBe(12);
    expect(
      extractClosingIssueNumber({
        title: "Fix #11 leftover",
        body: "see #12",
        head: { ref: "jumi/issue-12-fix-the-thing" },
      })
    ).toBeUndefined();
  });
});

describe("findOpenClosingPullRequest", () => {
  test("botUsername keeps human Fixes PRs from counting as jumi's", async () => {
    const repo = makeRepo();
    const human = makePR({
      user: makeUser({ login: "alice" }),
      body: "Fixes #12",
      head: { label: "kirmanak:feature", ref: "feature", sha: "abc", repo, repo_id: repo.id },
    });
    const jumi = makePR({
      number: 8,
      user: makeUser({ login: "jumi" }),
      body: "Fixes #12",
      head: {
        label: "kirmanak:jumi/issue-12-fix-the-thing",
        ref: "jumi/issue-12-fix-the-thing",
        sha: "def",
        repo,
        repo_id: repo.id,
      },
    });
    const api = { listOpenPulls: async () => [human, jumi] };
    expect((await findOpenClosingPullRequest(api, "kirmanak", "demo", 12))?.user.login).toBe("alice");
    expect((await findOpenClosingPullRequest(api, "kirmanak", "demo", 12, "jumi"))?.number).toBe(8);
  });
});

describe("findOpenJumiClosingPullRequest", () => {
  test("binds to the extracted jumi branch issue when the body mentions two closes", async () => {
    const repo = makeRepo();
    const pr = makePR({
      number: 8,
      title: "Fixes #12 and leftover Fixes #13",
      body: "Fixes #12\nFixes #13",
      user: makeUser({ login: "jumi" }),
      head: {
        label: "kirmanak:jumi/issue-12-fix-the-thing",
        ref: "jumi/issue-12-fix-the-thing",
        sha: "def",
        repo,
        repo_id: repo.id,
      },
    });
    const api = { listOpenPulls: async () => [pr] };
    expect((await findOpenJumiClosingPullRequest(api, "kirmanak", "demo", 12, "jumi"))?.number).toBe(8);
    expect(await findOpenJumiClosingPullRequest(api, "kirmanak", "demo", 13, "jumi")).toBeUndefined();
  });
});
