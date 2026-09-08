import { isAssignedToBot, isPullRequestIssue } from "./assignee.ts";
import { needsCiFollowUp } from "./ci.ts";
import { claimFilePath, isClaimLive, isPidAlive, readClaim } from "./claim.ts";
import { needsConflict } from "./conflict.ts";
import { needsFollowUp } from "./followup.ts";
import type { IssueApi } from "./gitea_issues.ts";
import {
  extractClosingIssueNumber,
  findOpenClosingPullRequest,
  isEligibleWorkerPR,
  isInScopeJumiPR,
} from "./gitea_issues.ts";
import { issueJobFrom } from "./issue_webhook.ts";
import type { GiteaIssue, GiteaPR, GiteaRepo, GiteaRepositoryMeta, IssueJob } from "./types.ts";
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
  maxFollowupRounds?: number;
  maxConflictRounds?: number;
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

function repoKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

async function jobForManagedPr(opts: {
  api: IssueApi;
  owner: string;
  repo: string;
  issue: GiteaIssue;
  repository: GiteaRepo;
  pr: GiteaPR;
  home: string;
  botUsername: string;
  nowMs: number;
  maxFollowupRounds?: number;
  maxConflictRounds?: number;
}): Promise<IssueJob | undefined> {
  const followUp = await needsFollowUp({
    api: opts.api,
    owner: opts.owner,
    repo: opts.repo,
    pr: opts.pr,
    issueNumber: opts.issue.number,
    botUsername: opts.botUsername,
    home: opts.home,
    maxFollowupRounds: opts.maxFollowupRounds,
  });
  const ci = await needsCiFollowUp({
    api: opts.api,
    owner: opts.owner,
    repo: opts.repo,
    sha: opts.pr.head.sha,
    home: opts.home,
    issueNumber: opts.issue.number,
  });
  const conflict = await needsConflict({
    pr: opts.pr,
    owner: opts.owner,
    repo: opts.repo,
    issueNumber: opts.issue.number,
    botUsername: opts.botUsername,
    home: opts.home,
    maxConflictRounds: opts.maxConflictRounds,
  });
  const mode = conflict && !(followUp || ci) ? "conflict" : followUp || ci || conflict ? "follow-up" : undefined;
  if (!mode) return undefined;
  return {
    ...issueJobFrom(opts.owner, opts.repo, opts.issue, opts.repository, "scan"),
    mode,
    prNumber: opts.pr.number,
    headSha: opts.pr.head.sha,
    delivery: `scan-${opts.owner}-${opts.repo}-${opts.issue.number}`,
    receivedAt: new Date(opts.nowMs).toISOString(),
  };
}

export async function scanAssignedIssues(opts: ScanOptions): Promise<IssueJob[]> {
  const log = opts.logger ?? ((message: string) => console.log(`[scan] ${message}`));
  const pidAlive = opts.pidAlive ?? isPidAlive;
  const nowMs = opts.nowMs ?? Date.now();
  const issues = await opts.api.searchAssignedIssues();
  const jobs: IssueJob[] = [];
  const pullsByRepo = new Map<string, GiteaPR[]>();
  const assignedIssueNumbers = new Map<string, Set<number>>();
  const assignedPrRepos = new Set<string>();

  const openPulls = async (owner: string, repo: string): Promise<GiteaPR[]> => {
    const key = repoKey(owner, repo);
    let pulls = pullsByRepo.get(key);
    if (!pulls) {
      pulls = await opts.api.listOpenPulls(owner, repo);
      pullsByRepo.set(key, pulls);
    }
    return pulls;
  };

  type Prepared = {
    issue: GiteaIssue;
    owner: string;
    repo: string;
    repository: GiteaRepo;
  };
  const preparedIssues: Prepared[] = [];
  const preparedPrs: Array<Prepared & { pr: GiteaPR }> = [];

  for (const issue of issues) {
    let skipLabel = `#${issue.number}`;
    try {
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
      skipLabel = `${owner}/${repo}#${issue.number}`;

      const claim = await readClaim(claimFilePath(opts.home, owner, repo, issue.number));
      if (claim && isClaimLive(claim, nowMs, pidAlive)) {
        log(`skipping ${owner}/${repo}#${issue.number}: claim is live`);
        continue;
      }

      const entry = { issue, owner, repo, repository };
      if (isPullRequestIssue(issue)) {
        const pr = (await openPulls(owner, repo)).find((pull) => pull.number === issue.number);
        if (!pr || !isEligibleWorkerPR(pr, owner, repo)) continue;
        preparedPrs.push({ ...entry, pr });
      } else {
        const key = repoKey(owner, repo);
        let numbers = assignedIssueNumbers.get(key);
        if (!numbers) {
          numbers = new Set();
          assignedIssueNumbers.set(key, numbers);
        }
        numbers.add(issue.number);
        preparedIssues.push(entry);
      }
    } catch (err) {
      log(`skipping ${skipLabel}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const entry of preparedPrs) {
    const closer = isInScopeJumiPR(entry.pr, entry.owner, entry.repo, opts.botUsername)
      ? extractClosingIssueNumber(entry.pr)
      : undefined;
    if (closer !== undefined && assignedIssueNumbers.get(repoKey(entry.owner, entry.repo))?.has(closer)) {
      continue;
    }
    assignedPrRepos.add(repoKey(entry.owner, entry.repo));
    try {
      const job = await jobForManagedPr({
        api: opts.api,
        owner: entry.owner,
        repo: entry.repo,
        issue: entry.issue,
        repository: entry.repository,
        pr: entry.pr,
        home: opts.home,
        botUsername: opts.botUsername,
        nowMs,
        maxFollowupRounds: opts.maxFollowupRounds,
        maxConflictRounds: opts.maxConflictRounds,
      });
      if (job) jobs.push(job);
      else log(`skipping ${entry.owner}/${entry.repo}#${entry.issue.number}: assigned PR needs no follow-up`);
    } catch (err) {
      log(
        `skipping ${entry.owner}/${entry.repo}#${entry.issue.number}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  for (const entry of preparedIssues) {
    const skipLabel = `${entry.owner}/${entry.repo}#${entry.issue.number}`;
    try {
      if (assignedPrRepos.has(repoKey(entry.owner, entry.repo))) {
        log(`skipping ${skipLabel}: assigned PR is the job for this repo`);
        continue;
      }

      const jumiPr = (await openPulls(entry.owner, entry.repo)).find(
        (pr) =>
          isInScopeJumiPR(pr, entry.owner, entry.repo, opts.botUsername) &&
          extractClosingIssueNumber(pr) === entry.issue.number
      );
      if (jumiPr) {
        const job = await jobForManagedPr({
          api: opts.api,
          owner: entry.owner,
          repo: entry.repo,
          issue: entry.issue,
          repository: entry.repository,
          pr: jumiPr,
          home: opts.home,
          botUsername: opts.botUsername,
          nowMs,
          maxFollowupRounds: opts.maxFollowupRounds,
          maxConflictRounds: opts.maxConflictRounds,
        });
        if (job) jobs.push(job);
        else log(`skipping ${skipLabel}: open PR already closes issue`);
        continue;
      }

      const closing = await findOpenClosingPullRequest(opts.api, entry.owner, entry.repo, entry.issue.number);
      if (closing) {
        log(`skipping ${skipLabel}: open PR already closes issue`);
        continue;
      }

      const claim = await readClaim(claimFilePath(opts.home, entry.owner, entry.repo, entry.issue.number));
      if (claim?.terminal && claim.issueUpdatedAt === entry.issue.updated_at) {
        log(`skipping ${skipLabel}: terminal claim`);
        continue;
      }

      jobs.push({
        ...issueJobFrom(entry.owner, entry.repo, entry.issue, entry.repository, "scan"),
        delivery: `scan-${entry.owner}-${entry.repo}-${entry.issue.number}`,
        receivedAt: new Date(nowMs).toISOString(),
      });
    } catch (err) {
      log(`skipping ${skipLabel}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return jobs;
}
