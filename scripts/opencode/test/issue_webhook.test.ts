import { describe, expect, test } from "bun:test";
import { parseIssuesPayload, shouldEnqueueIssue } from "../src/issue_webhook.ts";
import { encodeJson, makeIssue, makeIssuePayload, makeRepo, makeUser } from "./fixtures.ts";

const policy = {
  giteaUrl: "https://gitea.kirmanak.stream",
  allowedOrgs: ["kirmanak"],
  allowedRepos: [],
  botUsername: "jumi",
};

describe("parseIssuesPayload", () => {
  test("parses a valid issues payload", () => {
    const payload = parseIssuesPayload(encodeJson(makeIssuePayload()));
    expect(payload.issue.number).toBe(12);
    expect(payload.repository.full_name).toBe("kirmanak/demo");
  });

  test("parses a Gitea 1.27 IssuePayload (null pull_request, no top-level assignee)", () => {
    const raw = makeIssuePayload({
      action: "assigned",
      number: 12,
      issue: makeIssue({ pull_request: null, assignees: [makeUser({ login: "jumi" })] }),
    });
    const payload = parseIssuesPayload(encodeJson({ ...raw, commit_id: "" }));
    expect(payload.issue.pull_request).toBeNull();
    expect(shouldEnqueueIssue(payload, policy).type).toBe("enqueue");
  });

  test("rejects malformed payloads", () => {
    expect(() => parseIssuesPayload(encodeJson({ action: "assigned" }))).toThrow("missing repository");
    expect(() => parseIssuesPayload(new TextEncoder().encode("not-json"))).toThrow();
  });
});

describe("shouldEnqueueIssue", () => {
  test("enqueues assigned, opened, and reopened issues assigned to the bot", () => {
    for (const action of ["assigned", "opened", "reopened"]) {
      const decision = shouldEnqueueIssue(makeIssuePayload({ action }), policy);
      expect(decision.type).toBe("enqueue");
      if (decision.type === "enqueue") {
        expect(decision.job.issueNumber).toBe(12);
        expect(decision.job.owner).toBe("kirmanak");
        expect(decision.job.action).toBe(action);
      }
    }
  });

  test("cancels when the bot is unassigned", () => {
    const decision = shouldEnqueueIssue(
      makeIssuePayload({
        action: "unassigned",
        issue: makeIssue({ assignee: makeUser({ login: "alice" }), assignees: [makeUser({ login: "alice" })] }),
      }),
      policy
    );
    expect(decision).toEqual({ type: "cancel", owner: "kirmanak", repo: "demo", issueNumber: 12 });
  });

  test("does not cancel when another assignee is removed and the bot remains", () => {
    const decision = shouldEnqueueIssue(
      makeIssuePayload({
        action: "unassigned",
        issue: makeIssue({
          assignee: makeUser({ login: "jumi" }),
          assignees: [makeUser({ login: "jumi" }), makeUser({ login: "alice" })],
        }),
      }),
      policy
    );
    expect(decision).toEqual({ type: "skip", reason: "bot still assigned" });
  });

  test("skips pull request issues", () => {
    const decision = shouldEnqueueIssue(
      makeIssuePayload({ issue: makeIssue({ pull_request: { merged_at: null } }) }),
      policy
    );
    expect(decision).toEqual({ type: "skip", reason: "pull request issue" });
  });

  test("skips other actions and issues not assigned to the bot", () => {
    expect(shouldEnqueueIssue(makeIssuePayload({ action: "edited" }), policy)).toEqual({
      type: "skip",
      reason: "unsupported action edited",
    });
    expect(
      shouldEnqueueIssue(
        makeIssuePayload({
          issue: makeIssue({ assignee: makeUser({ login: "alice" }), assignees: [makeUser({ login: "alice" })] }),
        }),
        policy
      )
    ).toEqual({ type: "skip", reason: "not assigned to bot" });
  });

  test("rejects disallowed orgs and origins", () => {
    expect(() =>
      shouldEnqueueIssue(makeIssuePayload({ repository: makeRepo({ full_name: "evil/demo" }) }), policy)
    ).toThrow("not allowed");
    expect(() =>
      shouldEnqueueIssue(
        makeIssuePayload({
          repository: makeRepo({
            html_url: "https://evil.test/kirmanak/demo",
            clone_url: "https://evil.test/kirmanak/demo.git",
          }),
        }),
        policy
      )
    ).toThrow("does not match configured Gitea origin");
  });
});
