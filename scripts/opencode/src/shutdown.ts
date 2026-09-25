import type { ReviewJobStore } from "./review_jobs.ts";

type InFlightLease = {
  release: () => Promise<void>;
};

const inflight = new Set<InFlightLease>();

export function trackInFlightLease(release: () => Promise<void>): () => void {
  const entry = { release };
  inflight.add(entry);
  return () => {
    inflight.delete(entry);
  };
}

export async function releaseInFlightLeases(): Promise<void> {
  const pending = [...inflight].map((entry) => entry.release());
  const results = await Promise.allSettled(pending);
  const rejected = results.find((result) => result.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
}

export async function releaseLeaseOnShutdown(
  store: ReviewJobStore,
  id: number,
  jobKey: string,
  leasedBy: string,
  logger: (message: string) => void,
  expireLabel: string
): Promise<void> {
  try {
    const current = await store.get(id);
    if (current && current.leasedBy !== leasedBy) return;
    const released = await store.releaseLease(id, leasedBy);
    if (released) {
      logger(`released ${jobKey} on shutdown`);
    } else {
      await store.expireLease(id, leasedBy);
    }
  } catch (err) {
    logger(`${expireLabel} ${jobKey}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function installProcessShutdown(shutdown: AbortController, logger: (message: string) => void): void {
  const onSignal = (signal: string) => {
    logger(`received ${signal}, shutting down`);
    const released = releaseInFlightLeases();
    if (!shutdown.signal.aborted) shutdown.abort();
    void released.catch((err) => {
      logger(`shutdown lease release failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  process.once("SIGTERM", () => onSignal("SIGTERM"));
  process.once("SIGINT", () => onSignal("SIGINT"));
}
