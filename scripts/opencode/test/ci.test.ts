import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCiMarkdown,
  capFailedJobLog,
  dropUnpackNoise,
  hashText,
  infraFlakeReason,
  inspectCi,
  isCheckHandled,
  jobMatchesCheck,
  latestStatuses,
  needsCiFollowUp,
  recordCiHandled,
} from "../src/ci.ts";
import { followUpStatePath } from "../src/claim.ts";
import { writeFollowUpState } from "../src/followup.ts";
import type { IssueApi } from "../src/gitea_issues.ts";
import { emptyCiMethods, makeComment, makeIssue, makePR, makeRepo } from "./fixtures.ts";

function makeApi(overrides: Partial<IssueApi> = {}): IssueApi {
  const defaults: IssueApi = {
    getRepo: async () => makeRepo(),
    getIssue: async () => makeIssue(),
    listOpenPulls: async () => [],
    createPullRequest: async (_owner, _repo, pull) => makePR({ title: pull.title, body: pull.body }),
    searchAssignedIssues: async () => [],
    findStickyIssueComment: async () => undefined,
    createIssueComment: async (_owner, _repo, _index, body) => makeComment({ body }),
    updateIssueComment: async (_owner, _repo, _id, body) => makeComment({ body }),
    listIssueComments: async () => [],
    listPullReviewComments: async () => [],
    listPullReviews: async () => [],
    ...emptyCiMethods(),
  };
  return { ...defaults, ...overrides };
}

describe("latestStatuses", () => {
  test("keeps the highest id per context and ignores jumi review when classifying later", () => {
    const latest = latestStatuses([
      { id: 1, context: "build", status: "pending" },
      { id: 3, context: "build", status: "failure" },
      { id: 2, context: "jumi/opencode-review", state: "success" },
    ]);
    expect(latest.find((s) => s.context === "build")?.status).toBe("failure");
    expect(latest.find((s) => s.context === "jumi/opencode-review")?.state).toBe("success");
  });
});

describe("capFailedJobLog", () => {
  test("keeps the last ##[error] plus nearby lines and drops unpack noise", () => {
    const lines = [
      "Unpacking foo (1.0)",
      "  inflating: bar",
      ...Array.from({ length: 40 }, (_, i) => `before ${i}`),
      "##[error]Failed to find package 'platforms;android-37'",
      ...Array.from({ length: 40 }, (_, i) => `after ${i}`),
    ];
    const capped = capFailedJobLog(lines.join("\n"));
    expect(capped).toContain("##[error]Failed to find package 'platforms;android-37'");
    expect(capped).toContain("before 39");
    expect(capped).toContain("after 0");
    expect(capped).not.toContain("Unpacking foo");
    expect(capped).not.toContain("inflating: bar");
  });

  test("dropUnpackNoise removes package-unpack lines only", () => {
    const cleaned = dropUnpackNoise("Unpacking a\nreal error\nExtracting b");
    expect(cleaned).toBe("real error");
  });
});

describe("infraFlakeReason", () => {
  test("detects GitHub 140.82 checkout timeout", () => {
    expect(infraFlakeReason("Failed to connect to 140.82.112.4 port 443: Connection timed out")).toContain("140.82");
  });

  test("detects Helm remote-schema 429", () => {
    expect(infraFlakeReason("helm: values.schema.json remote schema 429 Too Many Requests")).toContain("Helm");
  });

  test("helm install/test timed out waiting is not a flake", () => {
    expect(
      infraFlakeReason("helm install my-release --timeout 5m\nError: timed out waiting for the condition")
    ).toBeUndefined();
  });

  test("detects GARM dpkg cross-device link", () => {
    expect(infraFlakeReason("dpkg: error processing archive: Invalid cross-device link")).toContain("GARM");
  });

  test("detects tofu S3 state lock", () => {
    expect(infraFlakeReason("tofu Error acquiring the state lock on s3")).toContain("S3");
  });

  test("unknown red is not a flake", () => {
    expect(infraFlakeReason("##[error]Failed to find package 'platforms;android-37'")).toBeUndefined();
  });
});

describe("jobMatchesCheck", () => {
  test("matches workflow / job context", () => {
    expect(jobMatchesCheck({ id: 1, name: "build", head_sha: "abc" }, "ci.yml / build", "abc")).toBe(true);
    expect(jobMatchesCheck({ id: 1, name: "build", head_sha: "abc" }, "build", "abc")).toBe(true);
    expect(jobMatchesCheck({ id: 1, name: "build", head_sha: "zzz" }, "build", "abc")).toBe(false);
  });

  test("matches Gitea 1.27 context with event suffix", () => {
    expect(jobMatchesCheck({ id: 1, name: "build", head_sha: "abc" }, "ci.yml / build (pull_request)", "abc")).toBe(
      true
    );
    expect(jobMatchesCheck({ id: 1, name: "build", head_sha: "abc" }, "Build image / build (push)", "abc")).toBe(true);
    expect(
      jobMatchesCheck({ id: 1, name: "build", head_sha: "abc" }, "ci.yml / build-android (pull_request)", "abc")
    ).toBe(false);
  });
});

describe("inspectCi", () => {
  test("ignores jumi/opencode-review, skips when another context is pending", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-ci-"));
    try {
      const inspection = await inspectCi({
        api: makeApi({
          listCommitStatuses: async () => [
            { id: 1, context: "jumi/opencode-review", status: "failure" },
            { id: 2, context: "build", status: "failure" },
            { id: 3, context: "test", status: "pending" },
          ],
        }),
        owner: "kirmanak",
        repo: "demo",
        sha: "headsha",
        home,
        issueNumber: 12,
      });
      expect(inspection.pending).toBe(true);
      expect(inspection.failed.map((c) => c.name)).toEqual(["build"]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("prefers job id from target_url over listActionJobs match", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-ci-"));
    try {
      const requested: number[] = [];
      const inspection = await inspectCi({
        api: makeApi({
          listCommitStatuses: async () => [
            {
              id: 1,
              context: "ci.yml / build (pull_request)",
              status: "failure",
              target_url: "https://gitea.example/owner/repo/actions/runs/3/jobs/42",
            },
          ],
          listActionJobs: async () => [{ id: 9, name: "build", head_sha: "headsha", conclusion: "failure" }],
          getActionJobLogs: async (_owner, _repo, jobId) => {
            requested.push(jobId);
            return jobId === 42 ? "##[error]latest attempt\n" : "##[error]stale attempt\n";
          },
        }),
        owner: "kirmanak",
        repo: "demo",
        sha: "headsha",
        home,
        issueNumber: 12,
      });
      expect(requested).toEqual([42]);
      expect(inspection.unhandled[0]?.capped).toContain("latest attempt");
      expect(inspection.unhandled[0]?.jobId).toBe(42);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("matches Gitea 1.27 context via listActionJobs when target_url is missing", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-ci-"));
    try {
      const inspection = await inspectCi({
        api: makeApi({
          listCommitStatuses: async () => [{ id: 1, context: "ci.yml / build (pull_request)", status: "failure" }],
          listActionJobs: async () => [{ id: 9, name: "build", head_sha: "headsha", conclusion: "failure" }],
          getActionJobLogs: async () => "##[error]from jobs list\n",
        }),
        owner: "kirmanak",
        repo: "demo",
        sha: "headsha",
        home,
        issueNumber: 12,
      });
      expect(inspection.unhandled[0]?.capped).toContain("from jobs list");
      expect(inspection.unhandled[0]?.jobId).toBe(9);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("fetches logs, caps, and treats unknown red as unhandled", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-ci-"));
    try {
      const inspection = await inspectCi({
        api: makeApi({
          listCommitStatuses: async () => [{ id: 1, context: "build", status: "failure", target_url: "/jobs/9" }],
          listActionJobs: async () => [{ id: 9, name: "build", head_sha: "headsha", conclusion: "failure" }],
          getActionJobLogs: async () => "##[error]Failed to find package 'platforms;android-37'\n",
        }),
        owner: "kirmanak",
        repo: "demo",
        sha: "headsha",
        home,
        issueNumber: 12,
      });
      expect(inspection.pending).toBe(false);
      expect(inspection.unhandled).toHaveLength(1);
      expect(inspection.unhandled[0]?.capped).toContain("platforms;android-37");
      expect(inspection.unhandled[0]?.flake).toBeUndefined();
      expect(
        await needsCiFollowUp({
          api: makeApi({
            listCommitStatuses: async () => [{ id: 1, context: "build", status: "failure" }],
            getActionJobLogs: async () => "##[error]boom\n",
          }),
          owner: "kirmanak",
          repo: "demo",
          sha: "headsha",
          home,
          issueNumber: 12,
        })
      ).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("same sha+check+hash is handled; log hash change is not", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-ci-"));
    try {
      const check = {
        name: "build",
        state: "failure" as const,
        description: "",
        capped: "##[error]a",
        logHash: hashText("##[error]a"),
      };
      await recordCiHandled({
        home,
        owner: "kirmanak",
        repo: "demo",
        issueNumber: 12,
        prNumber: 127,
        sha: "headsha",
        checks: [check],
      });
      expect(
        isCheckHandled(
          { prNumber: 127, handled: [{ sha: "headsha", checkName: "build", logHash: check.logHash }], updatedAt: "" },
          "headsha",
          "build",
          check.logHash
        )
      ).toBe(true);
      expect(
        isCheckHandled(
          { prNumber: 127, handled: [{ sha: "headsha", checkName: "build", logHash: check.logHash }], updatedAt: "" },
          "headsha",
          "build",
          hashText("##[error]b")
        )
      ).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("does not share budget with follow-up comment rounds", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-ci-"));
    try {
      await writeFollowUpState(followUpStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 127,
        round: 3,
        lastHeadSha: "old",
        handledCommentIds: [55],
        handledReviewIds: [],
        handledReviewFindings: [],
        updatedAt: "2026-05-23T00:00:00Z",
      });
      expect(
        await needsCiFollowUp({
          api: makeApi({
            listCommitStatuses: async () => [{ id: 1, context: "build", status: "failure" }],
            getActionJobLogs: async () => "##[error]boom\n",
          }),
          owner: "kirmanak",
          repo: "demo",
          sha: "headsha",
          home,
          issueNumber: 12,
        })
      ).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("buildCiMarkdown", () => {
  test("includes head sha and capped logs", () => {
    const md = buildCiMarkdown({
      sha: "abc",
      checks: [
        {
          name: "build",
          state: "failure",
          description: "",
          capped: "##[error]nope",
          logHash: "x",
        },
      ],
    });
    expect(md).toContain("Head SHA: abc");
    expect(md).toContain("## build");
    expect(md).toContain("##[error]nope");
    expect(md).toContain("Do not call tea");
  });
});
