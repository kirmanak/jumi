/**
 * OpenCode Gitea Action — main entry point
 *
 * Environment variables (set by the workflow):
 *   GITEA_URL          — e.g. https://gitea.kirmanak.stream
 *   GITEA_TOKEN        — PAT for the bot user
 *   BOT_USERNAME       — bot account login
 *   BOT_EMAIL          — bot commit email
 *   OPENCODE_MODEL     — model identifier passed to `opencode run -m`
 *   GITHUB_EVENT_NAME  — "issue_comment" | "pull_request"
 *   GITHUB_EVENT_PATH  — path to the JSON event payload file
 *   GITHUB_REPOSITORY  — "owner/repo"
 *   GITHUB_WORKSPACE   — path to the checked-out repo
 */

import { GiteaAPI } from "./api.ts";
import {
  commitAndPush,
  configureGit,
  checkoutPRBranch,
  createIssueBranch,
  generateCommitMessage,
  isDirty,
  runOpenCode,
} from "./git.ts";
import {
  buildIssuePrompt,
  buildPRCommentPrompt,
  buildPROpenedPrompt,
} from "./prompt.ts";
import type {
  GiteaIssueCommentPayload,
  GiteaPRPayload,
} from "./types.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function log(msg: string) {
  console.log(`[opencode] ${msg}`);
}

/** Trigger keywords — the comment must start with one of these (case-insensitive) */
const TRIGGER_PREFIXES = ["/oc", "/opencode"];

function isTriggerComment(body: string): boolean {
  const trimmed = body.trim().toLowerCase();
  return TRIGGER_PREFIXES.some((p) => trimmed.startsWith(p));
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const giteaUrl = requireEnv("GITEA_URL");
  const token = requireEnv("GITEA_TOKEN");
  const botUsername = requireEnv("BOT_USERNAME");
  // BOT_EMAIL is optional — default to a no-reply address derived from the
  // server URL with the protocol prefix stripped (e.g. "https://gitea.example.com"
  // → "opencode-bot@gitea.example.com").
  const botEmail =
    process.env.BOT_EMAIL ??
    `opencode-bot@${giteaUrl.replace(/^https?:\/\//, "")}`;
  const model = requireEnv("OPENCODE_MODEL");
  const eventName = requireEnv("GITHUB_EVENT_NAME");
  const eventPath = requireEnv("GITHUB_EVENT_PATH");
  const repository = requireEnv("GITHUB_REPOSITORY");
  const workspace = requireEnv("GITHUB_WORKSPACE");

  const [owner, repo] = repository.split("/");
  if (!owner || !repo) throw new Error(`Invalid GITHUB_REPOSITORY: ${repository}`);

  const api = new GiteaAPI(giteaUrl, token);

  const rawEvent = await Bun.file(eventPath).text();
  const event = JSON.parse(rawEvent);

  log(`Event: ${eventName}, repo: ${repository}`);

  await configureGit({
    serverUrl: giteaUrl,
    token,
    botUsername,
    botEmail,
    owner,
    repo,
    workdir: workspace,
  });

  if (eventName === "issue_comment") {
    await handleIssueComment(event as GiteaIssueCommentPayload, {
      api,
      owner,
      repo,
      model,
      workspace,
    });
  } else if (eventName === "pull_request") {
    await handlePROpened(event as GiteaPRPayload, {
      api,
      owner,
      repo,
      model,
      workspace,
    });
  } else {
    log(`Unsupported event type: ${eventName} — nothing to do.`);
  }
}

// ── issue_comment handler ────────────────────────────────────────────────────

interface HandlerDeps {
  api: GiteaAPI;
  owner: string;
  repo: string;
  model: string;
  workspace: string;
}

async function handleIssueComment(
  payload: GiteaIssueCommentPayload,
  deps: HandlerDeps
) {
  const { api, owner, repo, model, workspace } = deps;
  const { comment, issue, sender, is_pull: isPR } = payload;

  if (payload.action !== "created") {
    log("Not a created comment — skipping.");
    return;
  }

  if (!isTriggerComment(comment.body)) {
    log("Comment does not start with a trigger prefix — skipping.");
    return;
  }

  log(`Trigger detected from ${sender.login} on ${isPR ? "PR" : "issue"} #${issue.number}`);

  // Check write access
  const hasAccess = await api.hasWriteAccess(owner, repo, sender.login);
  if (!hasAccess) {
    log(`${sender.login} does not have write access — ignoring.`);
    return;
  }

  // React with "eyes" to acknowledge
  await api.addCommentReaction(owner, repo, comment.id, "eyes").catch(() => {});

  // Post a "thinking…" placeholder comment
  const placeholder = await api.createIssueComment(
    owner,
    repo,
    issue.number,
    "_OpenCode is working on it…_"
  );

  try {
    let agentOutput: string;

    if (isPR) {
      // ── PR comment ──────────────────────────────────────────────────────
      const [pr, issueComments, prFiles, reviews] = await Promise.all([
        api.getPR(owner, repo, issue.number),
        api.getIssueComments(owner, repo, issue.number),
        api.getPRFiles(owner, repo, issue.number),
        api.getPRReviews(owner, repo, issue.number),
      ]);

      if (!pr.head.repo || pr.head.repo.full_name !== payload.repository.full_name) {
        await api.updateComment(
          owner,
          repo,
          placeholder.id,
          pr.head.repo
            ? "Cross-repository pull requests are not supported."
            : "The source repository for this pull request is no longer available."
        );
        return;
      }

      const prompt = buildPRCommentPrompt({
        repo: payload.repository,
        sender,
        pr,
        issueComments,
        prFiles,
        reviews,
        triggerCommentId: comment.id,
        triggerBody: comment.body,
      });

      await checkoutPRBranch(workspace, pr.head.ref);

      log("Running opencode agent…");
      agentOutput = await runOpenCode(prompt, model, workspace);

      if (await isDirty(workspace)) {
        log("Working tree is dirty — committing and pushing…");
        const commitMsg = await generateCommitMessage(workspace);
        await commitAndPush(workspace, pr.head.ref, commitMsg);
        agentOutput =
          agentOutput ||
          `Applied changes and pushed to \`${pr.head.ref}\`. Commit message: _${commitMsg}_`;
      }
    } else {
      // ── Issue comment ────────────────────────────────────────────────────
      const [fullIssue, issueComments] = await Promise.all([
        api.getIssue(owner, repo, issue.number),
        api.getIssueComments(owner, repo, issue.number),
      ]);

      const prompt = buildIssuePrompt({
        repo: payload.repository,
        sender,
        issue: fullIssue,
        comments: issueComments,
        triggerCommentId: comment.id,
        triggerBody: comment.body,
      });

      log("Running opencode agent…");
      agentOutput = await runOpenCode(prompt, model, workspace);

      if (await isDirty(workspace)) {
        log("Working tree is dirty — creating branch, committing, and opening PR…");
        const branch = await createIssueBranch(workspace, issue.number);
        const commitMsg = await generateCommitMessage(workspace);
        await commitAndPush(workspace, branch, commitMsg);

        const newPR = await api.createPR(owner, repo, {
          title: `opencode: ${fullIssue.title}`,
          body: `Resolves #${issue.number}\n\nCreated by OpenCode in response to a comment by @${sender.login}.`,
          head: branch,
          base: payload.repository.default_branch,
        });

        agentOutput = `Created pull request: ${newPR.html_url}`;
      }
    }

    // Update the placeholder with the actual response
    const finalBody =
      agentOutput?.trim() ||
      "_OpenCode ran but produced no output. Check the workflow logs for details._";

    await api.updateComment(owner, repo, placeholder.id, finalBody);

    // Replace "eyes" with "rocket" to signal completion
    await api
      .deleteCommentReaction(owner, repo, comment.id, "eyes")
      .catch(() => {});
    await api
      .addCommentReaction(owner, repo, comment.id, "rocket")
      .catch(() => {});
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Error: ${errMsg}`);
    await api.updateComment(
      owner,
      repo,
      placeholder.id,
      `OpenCode encountered an error:\n\`\`\`\n${errMsg}\n\`\`\``
    );
    process.exit(1);
  }
}

// ── pull_request opened handler ──────────────────────────────────────────────

async function handlePROpened(
  payload: GiteaPRPayload,
  deps: HandlerDeps
) {
  const { api, owner, repo, model, workspace } = deps;
  const { pull_request: pr } = payload;

  log(`Auto-reviewing PR #${pr.number} opened by ${pr.user.login}`);

  const prFiles = await api.getPRFiles(owner, repo, pr.number);

  const prompt = buildPROpenedPrompt({
    repo: payload.repository,
    pr,
    prFiles,
  });

  log("Running opencode agent for PR review…");
  const agentOutput = await runOpenCode(prompt, model, workspace);

  if (agentOutput?.trim()) {
    await api.createIssueComment(owner, repo, pr.number, agentOutput.trim());
  } else {
    log("Agent produced no output — not posting a review comment.");
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error("[opencode] Fatal error:", err);
  process.exit(1);
});
