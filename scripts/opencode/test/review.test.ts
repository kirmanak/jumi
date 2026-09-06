import { describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isJumiReviewFinding } from "../src/followup.ts";
import type { PersistReviewResult, ReviewApi } from "../src/review.ts";
import { publishReviewResult, reviewPullRequest } from "../src/review.ts";
import type { GitRunner } from "../src/workspace.ts";
import { makeBranch, makeComment, makeFile, makeIssue, makePR, makeRepo, makeUser } from "./fixtures.ts";

function lastNonEmptyLine(text: string): string {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return "";
}

function makeApi(overrides: Partial<ReviewApi> = {}): ReviewApi {
  const defaults: ReviewApi = {
    getRepo: async () => makeRepo(),
    getPR: async () => makePR(),
    getPRFiles: async () => [makeFile()],
    getIssue: async () => makeIssue(),
    listIssueComments: async () => [],
    findStickyIssueComment: async () => undefined,
    createIssueComment: async (_owner, _repo, _index, body) => makeComment({ id: 1, body }),
    updateIssueComment: async (_owner, _repo, commentId, body) => makeComment({ id: commentId, body }),
    createCommitStatus: async (_owner, _repo, _sha, status) => status,
  };
  return { ...defaults, ...overrides };
}

const skipOptions = {
  owner: "kirmanak",
  repo: "demo",
  prNumber: 7,
  model: "openai/gpt-5.5",
  workspace: "/work",
  giteaUrl: "https://gitea.kirmanak.stream",
  giteaToken: "bot-token",
  botUsername: "jumi",
  workspacePreparer: async () => undefined,
  logger: () => undefined,
};

function frozenGit(opts: { head?: string; porcelain?: string } = {}): GitRunner {
  const head = opts.head ?? "headsha";
  const porcelain = opts.porcelain ?? "?? JUMI_REVIEW.md";
  return async (args) => {
    if (args[0] === "rev-parse") return head;
    if (args[0] === "status") return porcelain;
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

async function withWorkspace(run: (workspace: string) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), "jumi-review-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function writeReview(workspace: string, contents: string) {
  await writeFile(join(workspace, "JUMI_REVIEW.md"), contents);
}

function reviewOptions(workspace: string, gitRunner: GitRunner = frozenGit()) {
  return { ...skipOptions, workspace, gitRunner };
}

const REVIEW_SHA = "d90b7289701097dae3ffa3dc0ccdc348be552697";

function reviewOptionsWithSha(workspace: string, sha = REVIEW_SHA) {
  return {
    ...skipOptions,
    workspace,
    gitRunner: frozenGit({ head: sha }),
  };
}

describe("reviewPullRequest", () => {
  test("skips closed, merged, WIP, and skip-review PRs", async () => {
    const runner = async () => {
      throw new Error("runner should not be called");
    };

    await expect(
      reviewPullRequest({
        ...skipOptions,
        api: makeApi({ getPR: async () => makePR({ state: "closed" }) }),
        openCodeRunner: runner,
      })
    ).resolves.toEqual({ status: "skipped", reason: "PR is closed" });
    await expect(
      reviewPullRequest({
        ...skipOptions,
        api: makeApi({ getPR: async () => makePR({ merged: true }) }),
        openCodeRunner: runner,
      })
    ).resolves.toEqual({ status: "skipped", reason: "PR is already merged" });
    await expect(
      reviewPullRequest({
        ...skipOptions,
        api: makeApi({ getPR: async () => makePR({ title: "WIP: no" }) }),
        openCodeRunner: runner,
      })
    ).resolves.toEqual({ status: "skipped", reason: "PR title disables review" });
    await expect(
      reviewPullRequest({
        ...skipOptions,
        api: makeApi({ getPR: async () => makePR({ title: "Add thing [skip review]" }) }),
        openCodeRunner: runner,
      })
    ).resolves.toEqual({ status: "skipped", reason: "PR title disables review" });
  });

  test("posts the sticky from JUMI_REVIEW.md, not OpenCode stdout", async () => {
    await withWorkspace(async (workspace) => {
      let createdBody = "";
      const statuses: Array<{
        sha: string;
        state: string;
        context?: string;
        description?: string;
        target_url?: string;
      }> = [];
      const persisted: PersistReviewResult[] = [];
      const result = await reviewPullRequest({
        ...reviewOptionsWithSha(workspace),
        api: makeApi({
          getPR: async () => makePR({ head: makeBranch({ sha: REVIEW_SHA }) }),
          createIssueComment: async (_owner, _repo, _index, body) => {
            createdBody = body;
            return makeComment({ id: 123, body });
          },
          createCommitStatus: async (_owner, _repo, sha, status) => {
            statuses.push({ sha, ...status });
            return status;
          },
        }),
        persistResult: async (value) => {
          persisted.push(value);
        },
        openCodeRunner: async () => {
          await writeReview(workspace, "Looks good\n<!-- jumi-check: success -->");
          return "I'll inspect the Valkey bump…";
        },
      });

      expect(result).toEqual({ status: "posted", commentId: 123 });
      expect(createdBody).toContain("<!-- jumi-review:kirmanak/demo#7 -->");
      expect(createdBody).toContain(`Reviewed commit: \`${REVIEW_SHA}\``);
      expect(createdBody).toContain("Looks good");
      expect(createdBody).not.toContain("I'll inspect");
      expect(lastNonEmptyLine(createdBody)).toBe("<!-- jumi-check: success -->");
      expect(isJumiReviewFinding({ body: createdBody }, REVIEW_SHA)).toBe(false);
      expect(persisted).toEqual([{ kind: "markdown", markdown: "Looks good\n<!-- jumi-check: success -->" }]);
      await expect(access(join(workspace, "JUMI_REVIEW.md"))).rejects.toThrow();
      expect(statuses).toEqual([
        {
          sha: REVIEW_SHA,
          state: "pending",
          context: "jumi/opencode-review",
          description: "Jumi review is running",
          target_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/7",
        },
        {
          sha: REVIEW_SHA,
          state: "success",
          context: "jumi/opencode-review",
          description: "No blocking issues",
          target_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/7",
        },
      ]);
    });
  });

  test("updates an existing sticky from JUMI_REVIEW.md", async () => {
    await withWorkspace(async (workspace) => {
      let updatedBody = "";
      const result = await reviewPullRequest({
        ...reviewOptions(workspace),
        api: makeApi({
          findStickyIssueComment: async () => ({ id: 99 }),
          updateIssueComment: async (_owner, _repo, commentId, body) => {
            updatedBody = body;
            return makeComment({ id: commentId, body });
          },
        }),
        openCodeRunner: async () => {
          await writeReview(workspace, "Updated review\n<!-- jumi-check: success -->");
          return "I'll inspect…";
        },
      });

      expect(result).toEqual({ status: "updated", commentId: 99 });
      expect(updatedBody).toContain("Updated review");
      expect(updatedBody).not.toContain("I'll inspect");
      expect(lastNonEmptyLine(updatedBody)).toBe("<!-- jumi-check: success -->");
    });
  });

  test("treats a missing JUMI_REVIEW.md as incomplete and ignores stdout", async () => {
    await withWorkspace(async (workspace) => {
      let created = false;
      const statuses: Array<{ state: string; description?: string }> = [];
      const persisted: PersistReviewResult[] = [];
      await expect(
        reviewPullRequest({
          ...reviewOptions(workspace, frozenGit({ porcelain: "" })),
          api: makeApi({
            createIssueComment: async (_owner, _repo, _index, body) => {
              created = true;
              return makeComment({ id: 1, body });
            },
            createCommitStatus: async (_owner, _repo, _sha, status) => {
              statuses.push(status);
              return status;
            },
          }),
          persistResult: async (value) => {
            persisted.push(value);
          },
          openCodeRunner: async () => "I'll inspect the Valkey bump…",
        })
      ).resolves.toEqual({ status: "skipped", reason: "Incomplete review: no output" });
      expect(created).toBe(false);
      expect(persisted).toEqual([{ kind: "skip", reason: "Incomplete review: no output" }]);
      expect(statuses.map((status) => status.state)).toEqual(["pending", "failure"]);
      expect(statuses[1].description).toBe("Incomplete review: no output");
    });
  });

  test("rejects a planted JUMI_REVIEW.md on a clean tree", async () => {
    await withWorkspace(async (workspace) => {
      await writeReview(workspace, "Planted success review\n<!-- jumi-check: success -->");
      let createdBody = "";
      let created = false;
      const statuses: Array<{ state: string; description?: string }> = [];
      await expect(
        reviewPullRequest({
          ...reviewOptions(workspace, frozenGit({ porcelain: "" })),
          api: makeApi({
            createIssueComment: async (_owner, _repo, _index, body) => {
              created = true;
              createdBody = body;
              return makeComment({ id: 1, body });
            },
            createCommitStatus: async (_owner, _repo, _sha, status) => {
              statuses.push(status);
              return status;
            },
          }),
          openCodeRunner: async () => "I'll inspect…",
        })
      ).resolves.toEqual({ status: "skipped", reason: "Incomplete review: no output" });
      expect(created).toBe(false);
      expect(createdBody).not.toContain("Planted success review");
      expect(createdBody).not.toContain("I'll inspect");
      expect(statuses.map((status) => status.state)).toEqual(["pending", "failure"]);
      expect(statuses[1].description).toBe("Incomplete review: no output");
    });
  });

  test("treats a JUMI_REVIEW.md symlink as missing and does not follow it", async () => {
    await withWorkspace(async (workspace) => {
      let created = false;
      const result = await reviewPullRequest({
        ...reviewOptions(workspace),
        api: makeApi({
          createIssueComment: async (_owner, _repo, _index, body) => {
            created = true;
            return makeComment({ id: 1, body });
          },
        }),
        openCodeRunner: async () => {
          await writeFile(join(workspace, "secret.md"), "Looks good\n<!-- jumi-check: success -->");
          await symlink(join(workspace, "secret.md"), join(workspace, "JUMI_REVIEW.md"));
          return "I'll inspect…";
        },
      });
      expect(result).toEqual({ status: "skipped", reason: "Incomplete review: no output" });
      expect(created).toBe(false);
    });
  });

  test("treats a JUMI_REVIEW.md directory as missing without throwing", async () => {
    await withWorkspace(async (workspace) => {
      let created = false;
      const result = await reviewPullRequest({
        ...reviewOptions(workspace, frozenGit({ porcelain: "?? JUMI_REVIEW.md/" })),
        api: makeApi({
          createIssueComment: async (_owner, _repo, _index, body) => {
            created = true;
            return makeComment({ id: 1, body });
          },
        }),
        openCodeRunner: async () => {
          await mkdir(join(workspace, "JUMI_REVIEW.md"), { recursive: true });
          await writeFile(join(workspace, "JUMI_REVIEW.md", "nested.md"), "Looks good\n<!-- jumi-check: success -->");
          return "I'll inspect…";
        },
      });
      expect(result).toEqual({ status: "skipped", reason: "Incomplete review: no output" });
      expect(created).toBe(false);
      await expect(access(join(workspace, "JUMI_REVIEW.md"))).rejects.toThrow();
    });
  });

  test("rejects a huge JUMI_REVIEW.md without reading or posting it", async () => {
    await withWorkspace(async (workspace) => {
      let created = false;
      const statuses: Array<{ state: string; description?: string }> = [];
      const result = await reviewPullRequest({
        ...reviewOptions(workspace),
        maxOutputBytes: 80_000,
        api: makeApi({
          createIssueComment: async (_owner, _repo, _index, body) => {
            created = true;
            return makeComment({ id: 1, body });
          },
          createCommitStatus: async (_owner, _repo, _sha, status) => {
            statuses.push(status);
            return status;
          },
        }),
        openCodeRunner: async () => {
          await writeReview(workspace, `${"x".repeat(80_001)}\n<!-- jumi-check: success -->`);
          return "I'll inspect…";
        },
      });
      expect(result).toEqual({ status: "skipped", reason: "Incomplete review: output too large" });
      expect(created).toBe(false);
      expect(statuses.map((status) => status.state)).toEqual(["pending", "failure"]);
      expect(statuses[1].description).toBe("Incomplete review: output too large");
    });
  });

  test("treats an empty JUMI_REVIEW.md as incomplete", async () => {
    await withWorkspace(async (workspace) => {
      let created = false;
      const statuses: Array<{ state: string; description?: string }> = [];
      const result = await reviewPullRequest({
        ...reviewOptions(workspace),
        api: makeApi({
          createIssueComment: async (_owner, _repo, _index, body) => {
            created = true;
            return makeComment({ id: 1, body });
          },
          createCommitStatus: async (_owner, _repo, _sha, status) => {
            statuses.push(status);
            return status;
          },
        }),
        openCodeRunner: async () => {
          await writeReview(workspace, "  \n");
          return "I'll inspect…";
        },
      });
      expect(result).toEqual({ status: "skipped", reason: "Incomplete review: no output" });
      expect(created).toBe(false);
      expect(statuses.at(-1)).toMatchObject({ state: "failure", description: "Incomplete review: no output" });
    });
  });

  test("keeps a failure trailer on the sticky for worker follow-up", async () => {
    await withWorkspace(async (workspace) => {
      let createdBody = "";
      const statuses: Array<{ state: string; description?: string }> = [];
      const result = await reviewPullRequest({
        ...reviewOptionsWithSha(workspace),
        api: makeApi({
          getPR: async () => makePR({ head: makeBranch({ sha: REVIEW_SHA }) }),
          createIssueComment: async (_owner, _repo, _index, body) => {
            createdBody = body;
            return makeComment({ id: 44, body });
          },
          createCommitStatus: async (_owner, _repo, _sha, status) => {
            statuses.push(status);
            return status;
          },
        }),
        openCodeRunner: async () => {
          await writeReview(
            workspace,
            "L12: 🔴 bug: null deref. Guard it.\nL40: 🟡 risk: swallowed error. Fail closed.\n<!-- jumi-check: failure; 2 blocking -->"
          );
          return "I'll inspect…";
        },
      });

      expect(result.status).toBe("posted");
      expect(createdBody).toContain("L12: 🔴 bug: null deref");
      expect(createdBody).not.toContain("I'll inspect");
      expect(lastNonEmptyLine(createdBody)).toBe("<!-- jumi-check: failure; 2 blocking -->");
      expect(isJumiReviewFinding({ body: createdBody }, REVIEW_SHA)).toBe(true);
      expect(statuses.map((status) => status.state)).toEqual(["pending", "failure"]);
      expect(statuses[1].description).toBe("2 blocking");
    });
  });

  test("fails closed when JUMI_REVIEW.md omits the check trailer", async () => {
    await withWorkspace(async (workspace) => {
      let createdBody = "";
      const statuses: Array<{ state: string; description?: string }> = [];
      const result = await reviewPullRequest({
        ...reviewOptionsWithSha(workspace),
        api: makeApi({
          getPR: async () => makePR({ head: makeBranch({ sha: REVIEW_SHA }) }),
          createIssueComment: async (_owner, _repo, _index, body) => {
            createdBody = body;
            return makeComment({ id: 44, body });
          },
          createCommitStatus: async (_owner, _repo, _sha, status) => {
            statuses.push(status);
            return status;
          },
        }),
        openCodeRunner: async () => {
          await writeReview(workspace, "No correctness bugs found.");
          return "I'll inspect the PR and check for correctness issues.";
        },
      });

      expect(result).toEqual({ status: "posted", commentId: 44 });
      expect(createdBody).toContain("No correctness bugs found.");
      expect(createdBody).not.toContain("I'll inspect");
      expect(createdBody).not.toContain("jumi-check");
      expect(isJumiReviewFinding({ body: createdBody }, REVIEW_SHA)).toBe(false);
      expect(statuses.map((status) => status.state)).toEqual(["pending", "failure"]);
      expect(statuses[1].description).toBe("Incomplete review: no check verdict");
    });
  });

  test("does not treat a #136-shaped sticky without a trailer as a finding", () => {
    const body = [
      "<!-- jumi-review:personal/jumi#136 -->",
      "### Jumi OpenCode review",
      "",
      "Reviewed commit: `d90b7289701097dae3ffa3dc0ccdc348be552697`",
      "",
      "L12: 🔴 bug: null deref. Guard it.",
      "L40: 🔴 bug: swallowed error. Fail closed.",
    ].join("\n");
    expect(isJumiReviewFinding({ body }, "d90b7289701097dae3ffa3dc0ccdc348be552697")).toBe(false);
  });

  test("keeps a questions-only review green when the artifact reports success", async () => {
    await withWorkspace(async (workspace) => {
      const statuses: Array<{ state: string; description?: string }> = [];
      await reviewPullRequest({
        ...reviewOptions(workspace),
        api: makeApi({
          createCommitStatus: async (_owner, _repo, _sha, status) => {
            statuses.push(status);
            return status;
          },
        }),
        openCodeRunner: async () => {
          await writeReview(
            workspace,
            "No correctness bugs.\n❓ q: is the timeout intentional?\n<!-- jumi-check: success -->"
          );
          return "";
        },
      });
      expect(statuses.at(-1)).toMatchObject({ state: "success", description: "No blocking issues" });
    });
  });

  test("marks the review incomplete when HEAD moved", async () => {
    await withWorkspace(async (workspace) => {
      let created = false;
      const statuses: Array<{ state: string; description?: string }> = [];
      const result = await reviewPullRequest({
        ...reviewOptions(workspace, frozenGit({ head: "other sha" })),
        api: makeApi({
          createIssueComment: async (_owner, _repo, _index, body) => {
            created = true;
            return makeComment({ id: 1, body });
          },
          createCommitStatus: async (_owner, _repo, _sha, status) => {
            statuses.push(status);
            return status;
          },
        }),
        openCodeRunner: async () => {
          await writeReview(workspace, "Looks good\n<!-- jumi-check: success -->");
          return "I'll inspect…";
        },
      });
      expect(result).toEqual({ status: "skipped", reason: "Incomplete review: HEAD moved" });
      expect(created).toBe(false);
      expect(statuses.at(-1)).toMatchObject({ state: "failure", description: "Incomplete review: HEAD moved" });
    });
  });

  test("marks the review incomplete when extra files are dirty", async () => {
    await withWorkspace(async (workspace) => {
      let created = false;
      const statuses: Array<{ state: string; description?: string }> = [];
      const result = await reviewPullRequest({
        ...reviewOptions(workspace, frozenGit({ porcelain: " M src/demo.ts\n?? JUMI_REVIEW.md" })),
        api: makeApi({
          createIssueComment: async (_owner, _repo, _index, body) => {
            created = true;
            return makeComment({ id: 1, body });
          },
          createCommitStatus: async (_owner, _repo, _sha, status) => {
            statuses.push(status);
            return status;
          },
        }),
        openCodeRunner: async () => {
          await writeReview(workspace, "Looks good\n<!-- jumi-check: success -->");
          return "I'll inspect…";
        },
      });
      expect(result).toEqual({ status: "skipped", reason: "Incomplete review: dirty tree" });
      expect(created).toBe(false);
      expect(statuses.at(-1)).toMatchObject({ state: "failure", description: "Incomplete review: dirty tree" });
    });
  });

  test("monolith posts failure status when sticky write fails after a good review", async () => {
    await withWorkspace(async (workspace) => {
      const statuses: Array<{ state: string; description?: string }> = [];
      await expect(
        reviewPullRequest({
          ...reviewOptions(workspace),
          api: makeApi({
            createIssueComment: async () => {
              throw new Error("sticky write failed");
            },
            createCommitStatus: async (_owner, _repo, _sha, status) => {
              statuses.push(status);
              return status;
            },
          }),
          openCodeRunner: async () => {
            await writeReview(workspace, "Looks good\n<!-- jumi-check: success -->");
            return "I'll inspect…";
          },
        })
      ).rejects.toThrow("sticky write failed");
      expect(statuses.map((status) => status.state)).toEqual(["pending", "failure"]);
      expect(statuses[1].description).toBe("Jumi review failed: sticky write failed");
    });
  });

  test("engine does not overwrite pending after persist when publish throws", async () => {
    await withWorkspace(async (workspace) => {
      const statuses: Array<{ state: string; description?: string }> = [];
      const persisted: PersistReviewResult[] = [];
      await expect(
        reviewPullRequest({
          ...reviewOptions(workspace),
          api: makeApi({
            createIssueComment: async () => {
              throw new Error("sticky write failed");
            },
            createCommitStatus: async (_owner, _repo, _sha, status) => {
              statuses.push(status);
              return status;
            },
          }),
          persistResult: async (value) => {
            persisted.push(value);
          },
          openCodeRunner: async () => {
            await writeReview(workspace, "Looks good\n<!-- jumi-check: success -->");
            return "I'll inspect…";
          },
        })
      ).rejects.toThrow("sticky write failed");
      expect(persisted).toEqual([{ kind: "markdown", markdown: "Looks good\n<!-- jumi-check: success -->" }]);
      expect(statuses.map((status) => status.state)).toEqual(["pending"]);
    });
  });

  test("does not persist error or post failure when markdown persist throws", async () => {
    await withWorkspace(async (workspace) => {
      const statuses: Array<{ state: string; description?: string }> = [];
      const persisted: PersistReviewResult[] = [];
      await expect(
        reviewPullRequest({
          ...reviewOptions(workspace),
          api: makeApi({
            createIssueComment: async (_owner, _repo, _index, body) => makeComment({ id: 1, body }),
            createCommitStatus: async (_owner, _repo, _sha, status) => {
              statuses.push(status);
              return status;
            },
          }),
          persistResult: async (value) => {
            persisted.push(value);
            throw new Error("cannot save result");
          },
          openCodeRunner: async () => {
            await writeReview(workspace, "Looks good\n<!-- jumi-check: success -->");
            return "I'll inspect…";
          },
        })
      ).rejects.toThrow("cannot save result");
      expect(persisted).toEqual([{ kind: "markdown", markdown: "Looks good\n<!-- jumi-check: success -->" }]);
      expect(statuses.map((status) => status.state)).toEqual(["pending"]);
    });
  });

  test("does not persist error or post failure when skip persist throws", async () => {
    await withWorkspace(async (workspace) => {
      const statuses: Array<{ state: string; description?: string }> = [];
      const persisted: PersistReviewResult[] = [];
      await expect(
        reviewPullRequest({
          ...reviewOptions(workspace, frozenGit({ porcelain: "" })),
          api: makeApi({
            createCommitStatus: async (_owner, _repo, _sha, status) => {
              statuses.push(status);
              return status;
            },
          }),
          persistResult: async (value) => {
            persisted.push(value);
            throw new Error("cannot save result");
          },
          openCodeRunner: async () => "I'll inspect…",
        })
      ).rejects.toThrow("cannot save result");
      expect(persisted).toEqual([{ kind: "skip", reason: "Incomplete review: no output" }]);
      expect(statuses.map((status) => status.state)).toEqual(["pending"]);
    });
  });

  test("monolith posts failure status when skip status write fails", async () => {
    await withWorkspace(async (workspace) => {
      const statuses: Array<{ state: string; description?: string }> = [];
      await expect(
        reviewPullRequest({
          ...reviewOptions(workspace, frozenGit({ porcelain: "" })),
          api: makeApi({
            createCommitStatus: async (_owner, _repo, _sha, status) => {
              statuses.push(status);
              if (status.state === "failure") throw new Error("status write failed");
              return status;
            },
          }),
          openCodeRunner: async () => "I'll inspect…",
        })
      ).rejects.toThrow("status write failed");
      expect(statuses.map((status) => status.state)).toEqual(["pending", "failure", "failure"]);
      expect(statuses[2].description).toBe("Jumi review failed: status write failed");
    });
  });

  test("marks the commit status failed when the review crashes", async () => {
    const statuses: Array<{ state: string; description?: string }> = [];
    await expect(
      reviewPullRequest({
        ...skipOptions,
        api: makeApi({
          createCommitStatus: async (_owner, _repo, _sha, status) => {
            statuses.push(status);
            return status;
          },
        }),
        openCodeRunner: async () => {
          throw new Error("model unavailable");
        },
      })
    ).rejects.toThrow("model unavailable");

    expect(statuses.map((status) => status.state)).toEqual(["pending", "failure"]);
    expect(statuses[1].description).toBe("Jumi review failed: model unavailable");
  });

  test("truncates long status descriptions without splitting UTF-8 characters", async () => {
    const statuses: Array<{ state: string; description?: string }> = [];
    const message = "€".repeat(200);
    await expect(
      reviewPullRequest({
        ...skipOptions,
        api: makeApi({
          createCommitStatus: async (_owner, _repo, _sha, status) => {
            statuses.push(status);
            return status;
          },
        }),
        openCodeRunner: async () => {
          throw new Error(message);
        },
      })
    ).rejects.toThrow(message);

    expect(statuses.map((status) => status.state)).toEqual(["pending", "failure"]);
    expect(statuses[1].description?.endsWith("…")).toBe(true);
    expect(new TextEncoder().encode(statuses[1].description ?? "").byteLength).toBeLessThanOrEqual(255);
  });

  test("skips stale jobs before OpenCode runs", async () => {
    const runner = async () => {
      throw new Error("runner should not be called");
    };

    await expect(
      reviewPullRequest({
        ...skipOptions,
        api: makeApi({ getPR: async () => makePR({ head: makeBranch({ sha: "newsha" }) }) }),
        expectedHeadSha: "oldsha",
        openCodeRunner: runner,
      })
    ).resolves.toEqual({ status: "skipped", reason: "PR head changed from oldsha to newsha" });
  });

  test("skips posting when the PR head changes during review", async () => {
    let getPRCalls = 0;
    let stickyLookup = false;
    let created = false;
    const result = await reviewPullRequest({
      ...skipOptions,
      api: makeApi({
        getPR: async () => {
          getPRCalls++;
          return makePR({ head: makeBranch({ sha: getPRCalls === 1 ? "oldsha" : "newsha" }) });
        },
        findStickyIssueComment: async () => {
          stickyLookup = true;
          return undefined;
        },
        createIssueComment: async (_owner, _repo, _index, body) => {
          created = true;
          return makeComment({ body });
        },
      }),
      expectedHeadSha: "oldsha",
      openCodeRunner: async () => "stale review",
    });

    expect(result).toEqual({ status: "skipped", reason: "PR head changed from oldsha to newsha" });
    expect(getPRCalls).toBe(2);
    expect(stickyLookup).toBe(false);
    expect(created).toBe(false);
  });

  test("checks out the repository before running OpenCode and tells it the target branch", async () => {
    await withWorkspace(async (workspace) => {
      let checkout: unknown;
      let prompt = "";
      let runnerWorkdir = "";

      await reviewPullRequest({
        ...reviewOptions(workspace),
        api: makeApi({ getPR: async () => makePR({ base: makeBranch({ ref: "main", sha: "basesha" }) }) }),
        workspacePreparer: async (opts) => {
          checkout = {
            workdir: opts.workdir,
            repo: opts.repo.full_name,
            pr: opts.pr.number,
            targetBranch: opts.pr.base.ref,
            headSha: opts.pr.head.sha,
            giteaUrl: opts.giteaUrl,
            username: opts.username,
            token: opts.token,
          };
        },
        openCodeRunner: async (value, opts) => {
          prompt = value;
          runnerWorkdir = opts.workdir;
          await writeReview(workspace, "Review\n<!-- jumi-check: success -->");
          return "I'll inspect…";
        },
      });

      expect(checkout).toEqual({
        workdir: workspace,
        repo: "kirmanak/demo",
        pr: 7,
        targetBranch: "main",
        headSha: "headsha",
        giteaUrl: "https://gitea.kirmanak.stream",
        username: "jumi",
        token: "bot-token",
      });
      expect(runnerWorkdir).toBe(workspace);
      expect(prompt).toContain('target_branch="main"');
      expect(prompt).toContain('target_ref="jumi/target"');
      expect(prompt).toContain('target_remote_ref="origin/main"');
      expect(prompt).toContain("stable refs like jumi/target and HEAD");
      expect(prompt).toContain("git log --oneline jumi/target..HEAD");
      expect(prompt).toContain("web search/fetch");
    });
  });

  test("adds review notes when file and patch limits are hit", async () => {
    await withWorkspace(async (workspace) => {
      let prompt = "";
      await reviewPullRequest({
        ...reviewOptions(workspace),
        api: makeApi({
          getPRFiles: async () => [
            makeFile({ filename: "first.ts", patch: "abcdef" }),
            makeFile({ filename: "second.ts", patch: "ghijkl" }),
          ],
        }),
        maxFiles: 1,
        maxPatchBytes: 3,
        openCodeRunner: async (value) => {
          prompt = value;
          await writeReview(workspace, "Review\n<!-- jumi-check: success -->");
          return "I'll inspect…";
        },
      });

      expect(prompt).toContain("Only the first 1 of 2 changed files are included.");
      expect(prompt).toContain("Patch for first.ts was truncated to fit the patch budget.");
      expect(prompt).toContain("abc\n[patch truncated]");
    });
  });

  test("loads linked issue 12 and PR comments for Fixes #12", async () => {
    const calls: Array<{ method: string; index: number }> = [];
    await withWorkspace(async (workspace) => {
      await reviewPullRequest({
        ...reviewOptions(workspace),
        api: makeApi({
          getPR: async () => makePR({ body: "Fixes #12" }),
          getIssue: async (_owner, _repo, index) => {
            calls.push({ method: "getIssue", index });
            return makeIssue({ number: index });
          },
          listIssueComments: async (_owner, _repo, index) => {
            calls.push({ method: "listIssueComments", index });
            return [];
          },
        }),
        openCodeRunner: async () => {
          await writeReview(workspace, "Review\n<!-- jumi-check: success -->");
          return "I'll inspect…";
        },
      });
    });

    expect(calls).toContainEqual({ method: "getIssue", index: 12 });
    expect(calls).toContainEqual({ method: "listIssueComments", index: 7 });
    expect(calls).toContainEqual({ method: "listIssueComments", index: 12 });
  });

  test("still posts a review when a linked issue 404s", async () => {
    await withWorkspace(async (workspace) => {
      let prompt = "";
      const result = await reviewPullRequest({
        ...reviewOptions(workspace),
        api: makeApi({
          getPR: async () => makePR({ body: "Fixes #12" }),
          getIssue: async () => {
            throw new Error("Gitea API GET https://gitea.example/issues/12 → 404: not found");
          },
        }),
        openCodeRunner: async (value) => {
          prompt = value;
          await writeReview(workspace, "Review\n<!-- jumi-check: success -->");
          return "I'll inspect…";
        },
      });

      expect(result.status).toBe("posted");
      expect(prompt).toContain("Failed to load linked issue #12");
      expect(prompt).toContain("404");
    });
  });

  test("injects Jumi sticky and human comments into the OpenCode prompt", async () => {
    await withWorkspace(async (workspace) => {
      let prompt = "";
      await reviewPullRequest({
        ...reviewOptions(workspace),
        api: makeApi({
          listIssueComments: async () => [
            makeComment({
              id: 10,
              body: "<!-- jumi-review:kirmanak/demo#7 -->\nPrevious findings",
              user: makeUser({ login: "jumi" }),
            }),
            makeComment({
              id: 11,
              body: "please also handle timeouts",
              user: makeUser({ login: "alice" }),
            }),
          ],
        }),
        openCodeRunner: async (value) => {
          prompt = value;
          await writeReview(workspace, "Review\n<!-- jumi-check: success -->");
          return "I'll inspect…";
        },
      });

      expect(prompt).toContain("Previous findings");
      expect(prompt).toContain("please also handle timeouts");
      expect(prompt).toContain('author="jumi"');
      expect(prompt).toContain('author="alice"');
    });
  });
});

describe("publishReviewResult", () => {
  const publishOpts = {
    owner: "kirmanak",
    repo: "demo",
    prNumber: 7,
    expectedHeadSha: "headsha",
    botUsername: "jumi",
    logger: () => undefined,
  };

  test("SHA moved at publish skips and does not overwrite sticky with stale markdown", async () => {
    let created = false;
    let updated = false;
    const result = await publishReviewResult({
      ...publishOpts,
      expectedHeadSha: "oldsha",
      resultMarkdown: "stale review\n<!-- jumi-check: success -->",
      api: makeApi({
        getPR: async () => makePR({ head: makeBranch({ sha: "newsha" }) }),
        createIssueComment: async (_owner, _repo, _index, body) => {
          created = true;
          return makeComment({ body });
        },
        updateIssueComment: async (_owner, _repo, commentId, body) => {
          updated = true;
          return makeComment({ id: commentId, body });
        },
      }),
    });
    expect(result).toEqual({ status: "skipped", reason: "PR head changed from oldsha to newsha" });
    expect(created).toBe(false);
    expect(updated).toBe(false);
  });

  test("finds an existing sticky by marker then updates (crash after Gitea write)", async () => {
    const bodies: string[] = [];
    const first = await publishReviewResult({
      ...publishOpts,
      resultMarkdown: "first\n<!-- jumi-check: success -->",
      api: makeApi({
        createIssueComment: async (_owner, _repo, _index, body) => {
          bodies.push(body);
          return makeComment({ id: 44, body });
        },
      }),
    });
    expect(first).toEqual({ status: "posted", commentId: 44 });

    const second = await publishReviewResult({
      ...publishOpts,
      resultMarkdown: "second\n<!-- jumi-check: success -->",
      api: makeApi({
        findStickyIssueComment: async () => ({ id: 44 }),
        updateIssueComment: async (_owner, _repo, commentId, body) => {
          bodies.push(body);
          return makeComment({ id: commentId, body });
        },
        createIssueComment: async (_owner, _repo, _index, body) => {
          bodies.push(`created:${body}`);
          return makeComment({ id: 99, body });
        },
      }),
    });
    expect(second).toEqual({ status: "updated", commentId: 44 });
    expect(bodies[1]).toContain("second");
    expect(bodies[1]).not.toContain("created:");
  });

  test("publishes an incomplete skip as failure without a sticky", async () => {
    let created = false;
    const statuses: Array<{ state: string; description?: string; context?: string; target_url?: string }> = [];
    const result = await publishReviewResult({
      ...publishOpts,
      resultReason: "Incomplete review: no output",
      api: makeApi({
        createIssueComment: async (_owner, _repo, _index, body) => {
          created = true;
          return makeComment({ body });
        },
        createCommitStatus: async (_owner, _repo, _sha, status) => {
          statuses.push(status);
          return status;
        },
      }),
    });
    expect(result).toEqual({ status: "skipped", reason: "Incomplete review: no output" });
    expect(created).toBe(false);
    expect(statuses).toEqual([
      {
        state: "failure",
        context: "jumi/opencode-review",
        description: "Incomplete review: no output",
        target_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/7",
      },
    ]);
  });
});
