import { describe, expect, test } from "bun:test";
import { ReviewQueue } from "../src/queue.ts";
import { makeJob } from "./fixtures.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ReviewQueue", () => {
  test("dedupes jobs while queued or active", async () => {
    const gate = deferred();
    const seen: string[] = [];
    const queue = new ReviewQueue(async (job) => {
      seen.push(job.headSha);
      await gate.promise;
    });
    const job = makeJob();

    expect(queue.enqueue(job)).toEqual({ key: "kirmanak/demo#7:headsha", queued: true });
    expect(queue.enqueue(job)).toEqual({ key: "kirmanak/demo#7:headsha", queued: false });

    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(seen).toEqual(["headsha"]);
  });

  test("continues processing after handler failures", async () => {
    const seen: string[] = [];
    const done = deferred();
    const queue = new ReviewQueue(async (job) => {
      seen.push(job.headSha);
      if (job.headSha === "first") throw new Error("boom");
      done.resolve();
    });

    queue.enqueue(makeJob({ headSha: "first" }));
    queue.enqueue(makeJob({ headSha: "second" }));

    await done.promise;
    expect(seen).toEqual(["first", "second"]);
  });

  test("honors configured concurrency", async () => {
    const firstGate = deferred();
    const secondGate = deferred();
    let active = 0;
    let maxActive = 0;
    const queue = new ReviewQueue(async (job) => {
      active++;
      maxActive = Math.max(maxActive, active);
      if (job.headSha === "one") await firstGate.promise;
      if (job.headSha === "two") await secondGate.promise;
      active--;
    }, 2);

    queue.enqueue(makeJob({ headSha: "one" }));
    queue.enqueue(makeJob({ headSha: "two" }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(maxActive).toBe(2);
    firstGate.resolve();
    secondGate.resolve();
  });
});
