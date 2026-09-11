import { GiteaAPI } from "./api.ts";
import type { Forge, Tracker } from "./ports.ts";

export type { Forge, Tracker } from "./ports.ts";

export const FORGE_COMMITTER_NAME = "jumi";
export const FORGE_COMMITTER_EMAIL = "jumi@kirmanak.stream";

export function createGiteaForge(serverUrl: string, token: string): Tracker & Forge {
  return new GiteaAPI(serverUrl, token);
}
