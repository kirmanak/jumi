import { describe, expect, test } from "bun:test";
import { parseWorkflowJobPayload, shouldEnqueueWorkflowJobFollowUp } from "../src/ci_webhook.ts";
import type { IssueApi } from "../src/gitea_issues.ts";
import type { IssueJob } from "../src/types.ts";
import type { WorkerQueueLike } from "../src/worker.ts";
import { createWorkerFetchHandler } from "../src/worker_server.ts";
import {
  encodeJson,
  makeIssue,
  makePR,
  makeRepo,
  makeUser,
  makeWorkerConfig,
  makeWorkflowJobPayload,
  responseJson,
  signBody,
} from "./fixtures.ts";

const policy = {
  giteaUrl: "https://gitea.kirmanak.stream",
  allowedOrgs: ["kirmanak"],
  allowedRepos: [] as string[],
  botUsername: "jumi",
};

const repo = makeRepo();

function jumiPr() {
  return makePR({
    number: 127,
    title: "Fix the thing",
    body: "Fixes #12",
    user: makeUser({ login: "jumi" }),
    html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/127",
    head: {
      label: "kirmanak:jumi/issue-12-fix-the-thing",
      ref: "jumi/issue-12-fix-the-thing",
      sha: "headsha",
      repo,
      repo_id: repo.id,
    },
  });
}

function makeApi(overrides: Partial<Pick<IssueApi, "listOpenPulls" | "getIssue">> = {}) {
  return {
    listOpenPulls: async () => [jumiPr()],
    getIssue: async () => makeIssue(),
    ...overrides,
  };
}

function makeQueue(): WorkerQueueLike & { jobs: IssueJob[] } {
  const jobs: IssueJob[] = [];
  return {
    jobs,
    enqueue(job) {
      jobs.push(job);
      return { key: `${job.owner}/${job.repo}#${job.issueNumber}`, queued: true };
    },
  };
}

async function signedRequest(
  body: unknown,
  overrides: RequestInit & { event?: string; eventType?: string; secret?: string; raw?: Uint8Array } = {}
): Promise<Request> {
  const raw = overrides.raw ?? encodeJson(body);
  const secret = overrides.secret ?? "webhook-secret";
  const signature = await signBody(raw, secret);
  const headers = new Headers(overrides.headers);
  headers.set("content-type", "application/json");
  headers.set("x-gitea-signature", signature);
  if (overrides.event !== undefined) headers.set("x-gitea-event", overrides.event);
  else if (!overrides.eventType) headers.set("x-gitea-event", "workflow_job");
  if (overrides.eventType) headers.set("x-gitea-event-type", overrides.eventType);
  headers.set("x-gitea-delivery", "delivery-1");
  return new Request("https://worker.test/webhooks/gitea", {
    method: overrides.method ?? "POST",
    body: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
    headers,
  });
}

describe("shouldEnqueueWorkflowJobFollowUp", () => {
  test("enqueues follow-up for an in-scope jumi closer matching head sha", async () => {
    const decision = await shouldEnqueueWorkflowJobFollowUp(makeWorkflowJobPayload(), policy, makeApi());
    expect(decision.type).toBe("enqueue");
    if (decision.type !== "enqueue") return;
    expect(decision.jobs).toHaveLength(1);
    expect(decision.jobs[0]?.mode).toBe("follow-up");
    expect(decision.jobs[0]?.issueNumber).toBe(12);
    expect(decision.jobs[0]?.prNumber).toBe(127);
    expect(decision.jobs[0]?.headSha).toBe("headsha");
    expect(decision.jobs[0]?.trigger).toEqual({ event: "workflow_job", sender: "alice" });
  });

  test("matches head branch when sha differs from live PR head", async () => {
    const decision = await shouldEnqueueWorkflowJobFollowUp(
      makeWorkflowJobPayload({
        workflow_job: {
          id: 99,
          name: "build",
          head_sha: "oldsha",
          head_branch: "jumi/issue-12-fix-the-thing",
        },
      }),
      policy,
      makeApi()
    );
    expect(decision.type).toBe("enqueue");
    if (decision.type !== "enqueue") return;
    expect(decision.jobs[0]?.headSha).toBe("headsha");
  });

  test("skips when sender is jumi but still enqueues (Actions may appear as the bot)", async () => {
    const decision = await shouldEnqueueWorkflowJobFollowUp(
      makeWorkflowJobPayload({ sender: makeUser({ login: "jumi" }) }),
      policy,
      makeApi()
    );
    expect(decision.type).toBe("enqueue");
  });

  test("skips human-only closer", async () => {
    const decision = await shouldEnqueueWorkflowJobFollowUp(
      makeWorkflowJobPayload(),
      policy,
      makeApi({
        listOpenPulls: async () => [makePR({ title: "Fix", body: "Fixes #12", user: makeUser({ login: "alice" }) })],
      })
    );
    expect(decision).toEqual({ type: "skip", reason: "not an in-scope jumi pull request" });
  });

  test("skips when closing issue is unassigned", async () => {
    const decision = await shouldEnqueueWorkflowJobFollowUp(
      makeWorkflowJobPayload(),
      policy,
      makeApi({
        getIssue: async () =>
          makeIssue({ assignee: makeUser({ login: "alice" }), assignees: [makeUser({ login: "alice" })] }),
      })
    );
    expect(decision).toEqual({ type: "skip", reason: "not an in-scope jumi pull request" });
  });

  test("skips when head does not match any open PR", async () => {
    const decision = await shouldEnqueueWorkflowJobFollowUp(
      makeWorkflowJobPayload({
        workflow_job: { id: 1, name: "build", head_sha: "other", head_branch: "main" },
      }),
      policy,
      makeApi()
    );
    expect(decision).toEqual({ type: "skip", reason: "not an in-scope jumi pull request" });
  });
});

describe("createWorkerFetchHandler workflow_job", () => {
  test("enqueues on X-Gitea-Event workflow_job", async () => {
    const queue = makeQueue();
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue, api: makeApi() });
    const response = await handler(await signedRequest(makeWorkflowJobPayload()));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ queued: true, keys: ["kirmanak/demo#12"] });
    expect(queue.jobs[0]?.mode).toBe("follow-up");
    expect(queue.jobs[0]?.trigger?.event).toBe("workflow_job");
  });

  test("malformed payload is 202 skip never 400", async () => {
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue: makeQueue(), api: makeApi() });
    const response = await handler(await signedRequest({ zen: "nope" }));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "malformed workflow_job payload" });
  });

  test("status event stays skipped", async () => {
    const handler = createWorkerFetchHandler(makeWorkerConfig(), { queue: makeQueue(), api: makeApi() });
    const response = await handler(await signedRequest(makeWorkflowJobPayload(), { event: "status" }));
    expect(response.status).toBe(202);
    expect(await responseJson(response)).toEqual({ skipped: "unsupported event status" });
  });

  test("does not call listOpenPulls on malformed body", async () => {
    let listed = 0;
    const handler = createWorkerFetchHandler(makeWorkerConfig(), {
      queue: makeQueue(),
      api: {
        listOpenPulls: async () => {
          listed++;
          return [];
        },
        getIssue: async () => makeIssue(),
      },
    });
    await handler(await signedRequest({ not: "a job" }));
    expect(listed).toBe(0);
  });
});

describe("parseWorkflowJobPayload", () => {
  test("accepts a Gitea workflow_job body", () => {
    const parsed = parseWorkflowJobPayload(encodeJson(makeWorkflowJobPayload()));
    expect(parsed.workflow_job?.head_sha).toBe("headsha");
    expect(parsed.repository.full_name).toBe("kirmanak/demo");
  });
});
