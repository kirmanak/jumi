/**
 * Reviewer webfetch permission map, in OpenCode last-match order.
 *
 * Lives in its own module so `src/webfetch_probe.ts` can import the exact map
 * the reviewer ships without dragging in the engine's import graph. `src/git.ts`
 * re-exports both names; production reads them from there.
 */
export const REVIEW_WEBFETCH_PERMISSION: Record<string, "allow" | "ask" | "deny"> = {
  "*": "allow",
  "*kirmanak.stream*": "deny",
  "*github.com/search*": "deny",
};

export const REVIEW_OPENCODE_PERMISSION = JSON.stringify({ webfetch: REVIEW_WEBFETCH_PERMISSION });
