import { isAssignedToBot, isPullRequestIssue } from "./assignee.ts";
import { claimFilePath, isClaimLive, isPidAlive, readClaim } from "./claim.ts";
import { needsFollowUp } from "./followup.ts";
import type { IssueApi } from "./gitea_issues.ts";
import { findOpenClosingPullRequest, findOpenJumiClosingPullRequest } from "./gitea_issues.ts";
import { issueJobFrom } from "./issue_webhook.ts";
import type { GiteaIssue, GiteaRepo, GiteaRepositoryMeta, IssueJob } from "./types.ts";
import type { WebhookPolicy } from "./webhook.ts";
import { assertRepositoryPolicy } from "./webhook.ts";

export interface ScanOptions {
  api: IssueApi;
  home: string;
  botUsername: string;
  policy: WebhookPolicy;
  nowMs?: number;
  pidAlive?: (pid: number) => boolean;
  logger?: (message: string) => void;
}

function hasCloneInfo(repository: GiteaRepo | GiteaRepositoryMeta | undefined): repository is GiteaRepo {
  return Boolean(repository && (repository.html_url || repository.clone_url) && repository.default_branch);
}

async function resolveRepository(issue: GiteaIssue, api: IssueApi): Promise<GiteaRepo | undefined> {
  const meta = issue.repository;
  if (hasCloneInfo(meta)) return meta;
  const fullName = meta?.full_name;
  if (!fullName) return undefined;
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) return undefined;
  return api.getRepo(owner, repo);
}

export async function scanAssignedIssues(opts: ScanOptions): Promise<IssueJob[]> {
  const log = opts.logger ?? ((message: string) => console.log(`[scan] ${message}`));
  const pidAlive = opts.pidAlive ?? isPidAlive;
  const nowMs = opts.nowMs ?? Date.now();
  const issues = await opts.api.searchAssignedIssues();
  const jobs: IssueJob[] = [];

  for (const issue of issues) {
    try {
      if (isPullRequestIssue(issue)) continue;
      if (!isAssignedToBot(issue, opts.botUsername)) continue;
      if (issue.state !== "open") continue;

      const repository = await resolveRepository(issue, opts.api);
      if (!repository) {
        log(`skipping #${issue.number}: missing repository`);
        continue;
      }

      let owner: string;
      let repo: string;
      try {
        ({ owner, repo } = assertRepositoryPolicy(repository, opts.policy));
      } catch (err) {
        log(`skipping ${repository.full_name}#${issue.number}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      const claim = await readClaim(claimFilePath(opts.home, owner, repo, issue.number));
      if (claim && isClaimLive(claim, nowMs, pidAlive)) {
        log(`skipping ${owner}/${repo}#${issue.number}: claim is live`);
        continue;
      }

      const jumiPr = await findOpenJumiClosingPullRequest(opts.api, owner, repo, issue.number, opts.botUsername);
      if (jumiPr) {
        if (
          await needsFollowUp({
            api: opts.api,
            owner,
            repo,
            pr: jumiPr,
            issueNumber: issue.number,
            botUsername: opts.botUsername,
            home: opts.home,
          })
        ) {
          jobs.push({
            ...issueJobFrom(owner, repo, issue, repository, "scan"),
            mode: "follow-up",
            prNumber: jumiPr.number,
            delivery: `scan-${owner}-${repo}-${issue.number}`,
            receivedAt: new Date(nowMs).toISOString(),
          });
        } else {
          log(`skipping ${owner}/${repo}#${issue.number}: open PR already closes issue`);
        }
        continue;
      }

      const closing = await findOpenClosingPullRequest(opts.api, owner, repo, issue.number);
      if (closing) {
        log(`skipping ${owner}/${repo}#${issue.number}: open PR already closes issue`);
        continue;
      }

      if (claim?.terminal && claim.issueUpdatedAt === issue.updated_at) {
        log(`skipping ${owner}/${repo}#${issue.number}: terminal claim`);
        continue;
      }

      jobs.push({
        ...issueJobFrom(owner, repo, issue, repository, "scan"),
        delivery: `scan-${owner}-${repo}-${issue.number}`,
        receivedAt: new Date(nowMs).toISOString(),
      });
    } catch (err) {
      log(`skipping #${issue.number}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return jobs;
}
