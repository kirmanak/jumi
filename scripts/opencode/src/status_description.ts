import { hostname } from "node:os";

/** GitHub commit-status descriptions: 140 characters, not UTF-8 bytes. */
export const GITHUB_STATUS_DESCRIPTION_MAX_CHARS = 140;
/** Gitea still accepts this; do not lower it. */
export const GITEA_STATUS_DESCRIPTION_MAX_BYTES = 255;

const ELLIPSIS = "…";
const encoder = new TextEncoder();

const OPENCODE_EXIT_STDERR_RE = /^(Jumi review failed: )?opencode exited with code (-?\d+|null):\r?\n[\s\S]+$/;

export function codePointLength(text: string): number {
  return Array.from(text).length;
}

/** Drop OpenCode stderr from a status description. Auth-death text has no stderr and keeps the pod hostname. */
export function omitOpenCodeStderr(description: string, host = hostname()): string {
  const match = OPENCODE_EXIT_STDERR_RE.exec(description);
  if (!match) return description;
  const prefix = match[1] ?? "";
  return `${prefix}${host}: opencode exited with code ${match[2]}`;
}

export function truncateStatusDescription(
  description: string,
  limits: { maxChars?: number; maxBytes?: number }
): string {
  const maxChars = limits.maxChars;
  const maxBytes = limits.maxBytes;
  const withinChars = maxChars == null || codePointLength(description) <= maxChars;
  const withinBytes = maxBytes == null || encoder.encode(description).byteLength <= maxBytes;
  if (withinChars && withinBytes) return description;

  const ellipsisChars = codePointLength(ELLIPSIS);
  const ellipsisBytes = encoder.encode(ELLIPSIS).byteLength;
  const charBudget = maxChars == null ? Number.POSITIVE_INFINITY : maxChars - ellipsisChars;
  const byteBudget = maxBytes == null ? Number.POSITIVE_INFINITY : maxBytes - ellipsisBytes;
  const kept: string[] = [];
  let usedBytes = 0;

  for (const char of description) {
    const charBytes = encoder.encode(char).byteLength;
    if (kept.length >= charBudget || usedBytes + charBytes > byteBudget) break;
    kept.push(char);
    usedBytes += charBytes;
  }

  return `${kept.join("").replace(/\p{Mark}+$/u, "")}${ELLIPSIS}`;
}
