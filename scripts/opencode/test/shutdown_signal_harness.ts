import { appendFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IssueApi } from "../src/gitea_issues.ts";
import type { ReviewApi } from "../src/review.ts";
import { MemoryReviewJobStore, WORKER_JOB_KINDS } from "../src/review_jobs.ts";
import { processEngineTick } from "../src/server.ts";
import { installProcessShutdown } from "../src/shutdown.ts";
import { processWorkerTick } from "../src/worker.ts";
import type { GitRunner } from "../src/workspace.ts";
import {
  emptyCiMethods,
  makeComment,
  makeConfig,
  makeFile,
  makeIssue,
  makeIssueJob,
  makeJob,
  makePR,
  makeRepo,
  makeWorkerConfig,
} from "./fixtures.ts";

const role = process.argv[2];
const statusPath = process.argv[3];
if ((role !== "worker" && role !== "engine") || !statusPath) {
  console.error("usage: shutdown_signal_harness.ts worker|engine <status>");
  process.exit(2);
}

function report(line: string) {
  appendFileSync(statusPath, `${line}\n`);
}

function spawnStubbornChild() {
  return Bun.spawn(["bash", "-c", "trap '' TERM INT; sleep 300"], {
    stdout: "ignore",
    stderr: "ignore",
  });
}

function hangForever(): Promise<never> {
  return new Promise(() => undefined);
}

type ProbeApi = {
  comments: string[];
  statuses: Array<{ state: string }>;
};

function makeReviewApi(): ReviewApi & ProbeApi {
  const comments: string[] = [];
  const statuses: Array<{ state: string }> = [];
  return {
    comments,
    statuses,
    getRepo: async () => makeRepo(),
    getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
    getPR: async () => makePR(),
    getPRFiles: async () => [makeFile()],
    getIssue: async () => makeIssue(),
    listIssueComments: async () => [],
    findStickyIssueComment: async () => undefined,
    createIssueComment: async (_owner, _repo, _index, body) => {
      comments.push(body);
      return makeComment({ id: comments.length, body });
    },
    updateIssueComment: async (_owner, _repo, commentId, body) => {
      comments.push(body);
      return makeComment({ id: commentId, body });
    },
    listPullReviewComments: async () => [],
    listPullReviews: async () => [],
    createPullReview: async () => ({ id: 1 }),
    submitPullReview: async () => ({ id: 1 }),
    resolvePullComment: async () => undefined,
    unresolvePullComment: async () => undefined,
    dismissPullReview: async () => ({ id: 1 }),
    createCommitStatus: async (_owner, _repo, _sha, status) => {
      statuses.push({ state: status.state });
      return status;
    },
    ...emptyCiMethods(),
    listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" }],
  };
}

function frozenGit(): GitRunner {
  return async (args) => {
    if (args[0] === "rev-parse") return "headsha";
    if (args[0] === "status") return "?? JUMI_REVIEW.md";
    if (args[0] === "ls-files") return "";
    if (args[0] === "checkout") return "";
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

const store = new MemoryReviewJobStore();
const holder = role === "worker" ? "worker-1" : "engine-1";
const kinds = role === "worker" ? WORKER_JOB_KINDS : undefined;
let reported = false;
const originalRelease = store.releaseLease.bind(store);
const workerApi = { comments: [], statuses: [] } as unknown as IssueApi & ProbeApi;
const reviewApi = makeReviewApi();
const api: ProbeApi = role === "worker" ? workerApi : reviewApi;
store.releaseLease = async (id, leasedBy) => {
  const ok = await originalRelease(id, leasedBy);
  if (ok && leasedBy === holder && !reported) {
    reported = true;
    const row = store.rows.find((item) => item.id === id);
    const sibling = await store.lease("sibling", 60_000, undefined, kinds);
    const failures = api.statuses.filter((status) => status.state === "failure").length;
    report(
      `FREED attempt=${row?.attempt ?? -1} sibling=${sibling?.leasedBy ?? "none"} comments=${api.comments.length} failures=${failures}`
    );
  }
  return ok;
};

const shutdown = new AbortController();
installProcessShutdown(shutdown, (message) => {
  console.log(message);
  report(message);
});

const child = spawnStubbornChild();

async function run(): Promise<void> {
  if (role === "worker") {
    await store.enqueueIssue(makeIssueJob());
    await processWorkerTick(
      store,
      makeWorkerConfig(),
      workerApi,
      holder,
      {
        abortSignal: shutdown.signal,
        implement: async (opts) => {
          await opts.onPid?.(child.pid);
          report(`READY ${child.pid}`);
          return hangForever();
        },
      },
      (message) => {
        console.log(message);
        report(message);
      }
    );
    return;
  }
  const workspace = await mkdtemp(join(tmpdir(), "jumi-shutdown-engine-"));
  await store.enqueue(makeJob());
  await processEngineTick(
    store,
    makeConfig({ role: "engine", workdir: workspace, home: workspace }),
    reviewApi,
    holder,
    {
      abortSignal: shutdown.signal,
      ciRelistDelayMs: 0,
      gitRunner: frozenGit(),
      workspacePreparer: async () => undefined,
      openCodeRunner: async () => {
        report(`READY ${child.pid}`);
        return hangForever();
      },
    },
    (message) => {
      console.log(message);
      report(message);
    }
  );
}

run().then(
  () => {
    report("JOB_RETURNED");
  },
  (err) => {
    const message = err instanceof Error ? err.message : String(err);
    report(`JOB_FAILED ${message}`);
    console.error(err);
    process.exit(1);
  }
);
