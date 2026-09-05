import { GiteaAPI } from "./api.ts";
import { claimFilePath, deleteClaim, readClaim } from "./claim.ts";
import type { IssueApi } from "./gitea_issues.ts";
import { cancelIssueWork, implementIssue, issueJobKey } from "./implement.ts";
import { ReviewQueue } from "./queue.ts";
import { scanAssignedIssues } from "./scan.ts";
import type { IssueJob } from "./types.ts";
import type { WorkerConfig } from "./worker_config.ts";

export { issueJobKey };

export interface WorkerQueueLike {
  enqueue(job: IssueJob): { key: string; queued: boolean };
}

function log(message: string) {
  console.log(`[worker] ${message}`);
}

export function createIssueQueue(
  config: WorkerConfig,
  api: IssueApi = new GiteaAPI(config.giteaUrl, config.giteaToken),
  logger: (message: string) => void = log
): ReviewQueue<IssueJob> {
  const aborts = new Map<string, AbortController>();

  const queue = new ReviewQueue<IssueJob>(
    async (job: IssueJob) => {
      const key = issueJobKey(job);
      const abort = new AbortController();
      aborts.set(key, abort);
      try {
        const result = await implementIssue({
          api,
          job,
          giteaUrl: config.giteaUrl,
          giteaToken: config.giteaToken,
          botUsername: config.botUsername,
          model: config.model,
          home: config.home,
          workdir: config.workdir,
          opencodeConfig: config.opencodeConfig,
          timeoutMs: config.opencodeTimeoutMs,
          maxOutputBytes: config.maxOutputBytes,
          sanitizeOpenCodeEnv: true,
          abortSignal: abort.signal,
          logger: (message) => logger(message),
        });
        logger(`${key} ${result.status}${result.status === "skipped" ? `: ${result.reason}` : ""}`);
      } finally {
        aborts.delete(key);
      }
    },
    config.queueConcurrency,
    logger,
    issueJobKey
  );

  (queue as ReviewQueue<IssueJob> & { aborts: Map<string, AbortController> }).aborts = aborts;
  return queue;
}

export function abortIssueJob(queue: ReviewQueue<IssueJob>, key: string): void {
  const withAborts = queue as ReviewQueue<IssueJob> & { aborts?: Map<string, AbortController> };
  withAborts.aborts?.get(key)?.abort();
}

export async function handleIssueCancel(
  config: WorkerConfig,
  api: IssueApi,
  owner: string,
  repo: string,
  issueNumber: number,
  queue?: ReviewQueue<IssueJob>
): Promise<{ key: string; cancelled: true }> {
  const key = issueJobKey({ owner, repo, issueNumber });
  if (queue) {
    queue.drop(key);
    abortIssueJob(queue, key);
  }
  const claimPath = claimFilePath(config.home, owner, repo, issueNumber);
  const claim = await readClaim(claimPath);
  if (claim?.terminal) {
    await deleteClaim(claimPath);
    return { key, cancelled: true };
  }
  if (!claim) {
    return { key, cancelled: true };
  }
  await cancelIssueWork({
    api,
    owner,
    repo,
    issueNumber,
    botUsername: config.botUsername,
    home: config.home,
  });
  return { key, cancelled: true };
}

export async function runAssignedIssueScan(
  config: WorkerConfig,
  api: IssueApi,
  queue: WorkerQueueLike,
  logger: (message: string) => void = log
): Promise<void> {
  const jobs = await scanAssignedIssues({
    api,
    home: config.home,
    botUsername: config.botUsername,
    policy: {
      giteaUrl: config.giteaUrl,
      allowedOrgs: config.allowedOrgs,
      allowedRepos: config.allowedRepos,
    },
    logger,
  });
  for (const job of jobs) {
    const result = queue.enqueue(job);
    logger(`${result.queued ? "queued" : "deduped"} ${result.key} from scan`);
  }
}
