/**
 * OpenCode Gitea Action — main entry point
 *
 * Environment variables (set by the workflow):
 *   GITEA_URL          — e.g. https://gitea.kirmanak.stream
 *   GITEA_TOKEN        — PAT for the bot user
 *   BOT_USERNAME       — bot account login
 *   BOT_EMAIL          — bot commit email
 *   OPENCODE_MODEL     — model identifier passed to `opencode run -m`
 *   GITHUB_EVENT_NAME  — "pull_request"
 *   GITHUB_EVENT_PATH  — path to the JSON event payload file
 *   GITHUB_REPOSITORY  — "owner/repo"
 *   GITHUB_WORKSPACE   — path to the checked-out repo
 */

import { GiteaAPI } from "./api.ts";
import { runOpenCode } from "./git.ts";
import { buildPROpenedPrompt } from "./prompt.ts";
import type { GiteaPRPayload } from "./types.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function log(msg: string) {
  console.log(`[opencode] ${msg}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const giteaUrl = requireEnv("GITEA_URL");
  const token = requireEnv("GITEA_TOKEN");
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

  if (eventName === "pull_request") {
    await handlePROpened(event as GiteaPRPayload, { api, owner, repo, model, workspace });
  } else {
    log(`Unsupported event type: ${eventName} — nothing to do.`);
  }
}

// ── pull_request opened handler ──────────────────────────────────────────────

interface HandlerDeps {
  api: GiteaAPI;
  owner: string;
  repo: string;
  model: string;
  workspace: string;
}

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
