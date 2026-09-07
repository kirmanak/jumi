import { GiteaAPI } from "./api.ts";
import type { IssueApi } from "./gitea_issues.ts";
import type { ReviewApi } from "./review.ts";

export type Forge = ReviewApi & IssueApi;

export const FORGE_COMMITTER_NAME = "jumi";
export const FORGE_COMMITTER_EMAIL = "jumi@kirmanak.stream";

export function createGiteaForge(serverUrl: string, token: string): Forge {
  return new GiteaAPI(serverUrl, token);
}
