import { reviewJobKey } from "./review.ts";
import type { ReviewJob } from "./types.ts";

export interface EnqueueResult {
  key: string;
  queued: boolean;
}

export class ReviewQueue {
  private readonly pending: ReviewJob[] = [];
  private readonly queuedKeys = new Set<string>();
  private readonly activeKeys = new Set<string>();
  private active = 0;

  constructor(
    private readonly handler: (job: ReviewJob) => Promise<void>,
    private readonly concurrency = 1,
    private readonly logger: (message: string) => void = console.log
  ) {}

  enqueue(job: ReviewJob): EnqueueResult {
    const key = reviewJobKey(job);
    if (this.queuedKeys.has(key) || this.activeKeys.has(key)) {
      return { key, queued: false };
    }

    this.pending.push(job);
    this.queuedKeys.add(key);
    this.drain();
    return { key, queued: true };
  }

  private drain() {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift();
      if (!job) return;
      void this.run(job);
    }
  }

  private async run(job: ReviewJob) {
    const key = reviewJobKey(job);
    this.queuedKeys.delete(key);
    this.activeKeys.add(key);
    this.active++;

    try {
      await this.handler(job);
      this.logger(`[queue] completed ${key}`);
    } catch (err) {
      this.logger(`[queue] failed ${key}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.active--;
      this.activeKeys.delete(key);
      this.drain();
    }
  }
}
