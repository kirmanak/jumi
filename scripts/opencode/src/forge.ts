import { GiteaAPI } from "./api.ts";
import type { Forge, Tracker } from "./ports.ts";

export type { Forge, Tracker } from "./ports.ts";

export type ForgeKind = "gitea" | "github";

export const FORGE_COMMITTER_NAME = "jumi";
export const FORGE_COMMITTER_EMAIL = "jumi@kirmanak.stream";

export function parseForge(value: string | undefined): ForgeKind {
  if (!value || value === "gitea") return "gitea";
  if (value === "github") return "github";
  throw new Error(`Invalid FORGE: ${value}`);
}

export function createGiteaForge(serverUrl: string, token: string): Tracker & Forge {
  return new GiteaAPI(serverUrl, token);
}

export function createForge(config: { forge?: ForgeKind; giteaUrl: string; giteaToken: string }): Tracker & Forge {
  const forge = config.forge ?? "gitea";
  switch (forge) {
    case "gitea":
      return createGiteaForge(config.giteaUrl, config.giteaToken);
    case "github":
      throw new Error("GitHub forge is not implemented");
    default: {
      const _exhaustive: never = forge;
      throw new Error(`Invalid FORGE: ${_exhaustive}`);
    }
  }
}
