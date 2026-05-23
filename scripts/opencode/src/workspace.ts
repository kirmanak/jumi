import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewJob } from "./types.ts";

export async function createReviewWorkspace(root: string, job: ReviewJob): Promise<string> {
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, `jumi-${job.owner}-${job.repo}-${job.prNumber}-`));
  await writeFile(
    join(dir, "README.md"),
    "# Jumi review workspace\n\nThis workspace intentionally does not contain PR-head code. Review context is passed through the prompt.\n"
  );
  return dir;
}

export async function removeReviewWorkspace(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
