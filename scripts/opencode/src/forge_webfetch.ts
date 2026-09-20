/**
 * Single source of truth for the forge host no Jumi child may webfetch.
 *
 * Every child that implements, follows up, or resolves conflicts holds a
 * write-capable git token through the credential helper. A child that can also
 * read the forge over HTTP can pull in issue/PR/Actions state the parent never
 * injected, and act on it. Containment is webfetch only: git push via the
 * credential helper stays allowed, and public upstream docs stay reachable.
 *
 * Prompt prose is a hint, not a control. The values below are what the two
 * binaries enforce: OpenCode through `OPENCODE_PERMISSION`, Claude through
 * `--disallowedTools`. Add a host here, not in a third copy of prose.
 */
export const FORGE_DENY_DOMAIN = "kirmanak.stream";

/**
 * OpenCode webfetch matches the whole URL and is last-match, so the star allow
 * comes first and the denies win. GitHub code search is a forge read path too.
 * Key order is load-bearing; JSON.stringify preserves it.
 */
export const FORGE_WEBFETCH_PERMISSION: Record<string, "allow" | "ask" | "deny"> = {
  "*": "allow",
  [`*${FORGE_DENY_DOMAIN}*`]: "deny",
  "*github.com/search*": "deny",
};

/** OpenCode reads this as a JSON overlay on the config `permission` block. */
export const FORGE_OPENCODE_PERMISSION = JSON.stringify({ webfetch: FORGE_WEBFETCH_PERMISSION });

/**
 * Claude WebFetch rules match the hostname, so the apex and the subdomain
 * wildcard are both needed: `domain:*.host` does not cover `host` itself.
 * A deny at any level beats every allow, including `--allowedTools` and the
 * `user` settings source. Wildcards need Claude Code >= 2.1.172 (image: 2.1.274).
 */
export const CLAUDE_FORGE_WEBFETCH_DENY = [
  `WebFetch(domain:${FORGE_DENY_DOMAIN})`,
  `WebFetch(domain:*.${FORGE_DENY_DOMAIN})`,
] as const;

export const CLAUDE_DISALLOWED_TOOLS = CLAUDE_FORGE_WEBFETCH_DENY.join(",");
