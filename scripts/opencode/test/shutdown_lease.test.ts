import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPidAlive } from "../src/claim.ts";

async function readStatus(path: string): Promise<string> {
  return readFile(path, "utf8").catch(() => "");
}

async function waitForLine(path: string, needle: string, proc: Bun.Subprocess, stderr: () => string): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const text = await readStatus(path);
    if (text.includes("JOB_FAILED") || text.includes("JOB_RETURNED")) {
      throw new Error(`${text}\n${stderr()}`);
    }
    const line = text.split("\n").find((item) => item.includes(needle));
    if (line) return line;
    if (proc.exitCode != null) throw new Error(`harness exited ${proc.exitCode}\n${text}\n${stderr()}`);
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${needle}\n${await readStatus(path)}\n${stderr()}`);
}

describe("shutdown signal frees an in-flight lease", () => {
  test.each(["worker", "engine"])(
    "%s SIGTERM frees the lease while the child is still running",
    async (role) => {
      const dir = await mkdtemp(join(tmpdir(), "jumi-shutdown-"));
      const statusPath = join(dir, "status");
      let stderrText = "";
      const proc = Bun.spawn(["bun", "test/shutdown_signal_harness.ts", role, statusPath], {
        cwd: join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      });
      void (async () => {
        stderrText = await new Response(proc.stderr).text();
      })();
      let childPid = 0;
      try {
        const ready = await waitForLine(statusPath, "READY ", proc, () => stderrText);
        childPid = Number(ready.slice("READY ".length));
        expect(isPidAlive(childPid)).toBe(true);
        proc.kill("SIGTERM");
        const freed = await waitForLine(statusPath, "FREED ", proc, () => stderrText);
        const text = await readStatus(statusPath);
        expect(text).toContain("received SIGTERM, shutting down");
        expect(text).toContain("released ");
        expect(text).toContain("on shutdown");
        expect(text).not.toContain("JOB_RETURNED");
        expect(freed).toContain("attempt=0");
        expect(freed).toContain("sibling=sibling");
        expect(freed).toContain("comments=0");
        expect(freed).toContain("failures=0");
        expect(proc.exitCode).toBeNull();
        expect(isPidAlive(childPid)).toBe(true);
      } finally {
        proc.kill("SIGKILL");
        if (childPid > 0) {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {
            // already gone
          }
        }
        await proc.exited.catch(() => undefined);
        await rm(dir, { recursive: true, force: true });
      }
    },
    20_000
  );
});
