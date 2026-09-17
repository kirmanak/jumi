import { afterEach, describe, expect, test } from "bun:test";
import {
  classifyOpenCodeExit,
  meterWebhook,
  recordJobCompleted,
  recordOpenCodeRun,
  renderProcessMetrics,
  renderRunMetrics,
  renderWebhookMetrics,
  resetControlMetricsForTests,
} from "../src/control_metrics.ts";
import { MemoryReviewJobStore, renderQueueMetrics } from "../src/review_jobs.ts";
import { makeIssueJob, makeJob } from "./fixtures.ts";

afterEach(() => {
  resetControlMetricsForTests();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("classifyOpenCodeExit", () => {
  test("maps timeout, infra, 143, ok, auth, quota hop, and the rest to incomplete", () => {
    expect(classifyOpenCodeExit({ status: "timeout", exitCode: 143 })).toBe("timeout");
    expect(classifyOpenCodeExit({ status: "exit", exitCode: 7, infra: true })).toBe("infra");
    expect(classifyOpenCodeExit({ status: "exit", exitCode: 143 })).toBe("143");
    expect(classifyOpenCodeExit({ status: "ok", exitCode: 0 })).toBe("ok");
    expect(classifyOpenCodeExit({ status: "exit", exitCode: 1, auth: true })).toBe("auth");
    expect(classifyOpenCodeExit({ status: "timeout", auth: true })).toBe("timeout");
    expect(classifyOpenCodeExit({ status: "exit", exitCode: 143, auth: true })).toBe("143");
    expect(classifyOpenCodeExit({ status: "stuck", auth: true, quota: "resetting" })).toBe("incomplete");
    expect(classifyOpenCodeExit({ status: "stuck", exitCode: 143, quota: "resetting" })).toBe("143");
    expect(classifyOpenCodeExit({ status: "stuck", exitCode: 143, quota: "resetting", hopped: true })).toBe("quota");
    expect(classifyOpenCodeExit({ status: "timeout", exitCode: 143, quota: "resetting", hopped: true })).toBe(
      "timeout"
    );
    expect(
      classifyOpenCodeExit({ status: "stuck", exitCode: 143, quota: "resetting", infra: true, hopped: true })
    ).toBe("infra");
    expect(classifyOpenCodeExit({ status: "exit", exitCode: 143, hopped: true })).toBe("143");
    expect(classifyOpenCodeExit({ status: "stuck" })).toBe("incomplete");
    expect(classifyOpenCodeExit({ status: "exit", exitCode: 1 })).toBe("incomplete");
  });
});

describe("webhook metrics", () => {
  test("classifies accepted, skipped, hmac, too large, unavailable, and ping", async () => {
    await meterWebhook("pull_request", jsonResponse(202, { queued: true }));
    await meterWebhook("push", jsonResponse(202, { skipped: "unsupported event push" }));
    await meterWebhook("issues", jsonResponse(401, { error: "invalid signature" }));
    await meterWebhook("pull_request", jsonResponse(401, { error: "invalid authorization header" }));
    await meterWebhook("workflow_job", jsonResponse(413, { error: "webhook payload too large" }));
    await meterWebhook("issues", jsonResponse(503, { error: "queue unavailable" }));
    await meterWebhook("ping", jsonResponse(200, { ok: true }));
    await meterWebhook("pull_request", jsonResponse(400, { error: "invalid webhook payload" }));

    const text = renderWebhookMetrics();
    expect(text).toContain('jumi_webhooks_total{event="pull_request",result="accepted"} 1');
    expect(text).toContain('jumi_webhooks_total{event="push",result="skipped"} 1');
    expect(text).toContain('jumi_webhooks_total{event="issues",result="hmac"} 1');
    expect(text).toContain('jumi_webhooks_total{event="workflow_job",result="too large"} 1');
    expect(text).toContain('jumi_webhooks_total{event="issues",result="unavailable"} 1');
    expect(text).toContain('jumi_webhooks_total{event="ping",result="ping"} 1');
    expect(text).not.toContain("invalid webhook payload");
    expect(text).not.toContain('result="hmac"} 2');
  });

  test("maps unknown forge event names to unknown", async () => {
    await meterWebhook("evil-event", jsonResponse(401, { error: "invalid signature" }));
    await meterWebhook(`${"x".repeat(80)}\nlabel="owned"`, jsonResponse(413, { error: "webhook payload too large" }));
    await meterWebhook("status", jsonResponse(202, { skipped: "unsupported event status" }));

    const text = renderWebhookMetrics();
    expect(text).toContain('jumi_webhooks_total{event="unknown",result="hmac"} 1');
    expect(text).toContain('jumi_webhooks_total{event="unknown",result="too large"} 1');
    expect(text).toContain('jumi_webhooks_total{event="status",result="skipped"} 1');
    expect(text).not.toContain("evil-event");
    expect(text).not.toContain("owned");
  });
});

describe("run metrics", () => {
  test("emits zero completion and exit series before any run", () => {
    const text = renderRunMetrics();
    expect(text).toContain('jumi_jobs_completed_total{kind="review",result="succeeded"} 0');
    expect(text).toContain('jumi_jobs_completed_total{kind="conflict",result="failed"} 0');
    expect(text).toContain('jumi_opencode_exits_total{kind="review",class="ok"} 0');
    expect(text).toContain('jumi_opencode_exits_total{kind="implement",class="143"} 0');
    expect(text).toContain('jumi_opencode_exits_total{kind="review",class="auth"} 0');
    expect(text).toContain('jumi_opencode_exits_total{kind="review",class="quota"} 0');
    expect(text).not.toContain("jumi_job_duration_seconds_bucket");
    expect(text).not.toContain("owner=");
    expect(text).not.toContain("repo=");
  });

  test("histograms OpenCode duration by exit class and counts completions", () => {
    recordOpenCodeRun("review", { status: "ok", exitCode: 0, durationMs: 90_000 });
    recordOpenCodeRun("review", { status: "timeout", exitCode: 143, durationMs: 1_200_000 });
    recordOpenCodeRun("follow-up", { status: "exit", exitCode: 1, infra: true, durationMs: 400 });
    recordOpenCodeRun("review", { status: "exit", exitCode: 1, auth: true, durationMs: 8_000 });
    recordOpenCodeRun("implement", {
      status: "stuck",
      exitCode: 143,
      quota: "resetting",
      hopped: true,
      durationMs: 5_000,
    });
    recordJobCompleted("review", "succeeded");
    recordJobCompleted("implement", "skipped");

    const text = renderRunMetrics();
    expect(text).toContain('jumi_jobs_completed_total{kind="review",result="succeeded"} 1');
    expect(text).toContain('jumi_jobs_completed_total{kind="implement",result="skipped"} 1');
    expect(text).toContain('jumi_opencode_exits_total{kind="review",class="ok"} 1');
    expect(text).toContain('jumi_opencode_exits_total{kind="review",class="timeout"} 1');
    expect(text).toContain('jumi_opencode_exits_total{kind="follow-up",class="infra"} 1');
    expect(text).toContain('jumi_opencode_exits_total{kind="review",class="auth"} 1');
    expect(text).toContain('jumi_opencode_exits_total{kind="implement",class="quota"} 1');
    expect(text).not.toContain('jumi_opencode_exits_total{kind="implement",class="143"} 1');
    expect(text).not.toContain("hostname=");
    expect(text).not.toContain("invalid_grant");
    expect(text).toContain('jumi_job_duration_seconds_bucket{kind="review",result="ok",le="60"} 0');
    expect(text).toContain('jumi_job_duration_seconds_bucket{kind="review",result="ok",le="120"} 1');
    expect(text).toContain('jumi_job_duration_seconds_count{kind="review",result="ok"} 1');
    expect(text).toContain('jumi_job_duration_seconds_sum{kind="review",result="ok"} 90');
    expect(text).toContain('jumi_job_duration_seconds_bucket{kind="review",result="timeout",le="1200"} 1');
    expect(text).toContain('jumi_job_duration_seconds_bucket{kind="follow-up",result="infra",le="15"} 1');
    expect(text).toContain('jumi_job_duration_seconds_count{kind="implement",result="quota"} 1');
  });

  test("records hop-yes quota SIGTERM as quota without publishing 143", () => {
    recordOpenCodeRun("review", {
      status: "stuck",
      exitCode: 143,
      quota: "resetting",
      hopped: true,
      durationMs: 5_000,
    });
    const text = renderRunMetrics();
    expect(text).toContain('jumi_opencode_exits_total{kind="review",class="quota"} 1');
    expect(text).toContain('jumi_opencode_exits_total{kind="review",class="143"} 0');
    expect(text).toContain('jumi_job_duration_seconds_count{kind="review",result="quota"} 1');
    expect(text).not.toContain('jumi_job_duration_seconds_count{kind="review",result="143"}');
  });

  test("process metrics keep token series and omit ledger gauges", () => {
    const text = renderProcessMetrics();
    expect(text).toContain("ai_token_exporter_up");
    expect(text).toContain("jumi_jobs_completed_total");
    expect(text).not.toContain("jumi_review_jobs");
    expect(text).not.toContain("jumi_webhooks_total");
  });
});

describe("renderQueueMetrics", () => {
  test("breaks gauges out by kind and exports oldest queued age", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    await store.enqueueIssue(makeIssueJob({ action: "assigned" }));
    store.rows[0]!.createdAt = 1_000_000;
    const text = await renderQueueMetrics(store, new Date(1_090_000));
    expect(text).toContain('jumi_review_jobs{state="queued",kind="review"} 1');
    expect(text).toContain('jumi_review_jobs{state="queued",kind="implement"} 1');
    expect(text).toContain('jumi_review_jobs{state="queued",kind="follow-up"} 0');
    expect(text).toContain('jumi_review_jobs{state="queued",kind="conflict"} 0');
    expect(text).toContain('jumi_review_jobs_oldest_queued_age_seconds{kind="review"} 90');
    expect(text).toContain('jumi_review_jobs_oldest_queued_age_seconds{kind="follow-up"} 0');
    expect(text).not.toContain('jumi_review_jobs{state="queued"} 1');
    expect(text).not.toContain("ai_tokens");
  });
});
