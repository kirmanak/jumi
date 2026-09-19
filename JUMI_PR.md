Refresh jumi-owned closer PR bodies after a follow-up that actually pushes.

First-run still opens from `JUMI_PR.md`, now wrapped in `<!-- jumi-pr-body:start/end -->`. Before follow-up OpenCode, the parent seeds that fenced region into worktree `JUMI_PR.md`. Worker prompts list `JUMI_PR.md` with the other injected Jumi files so the child can read that seed and update it. After a push, the parent PATCHes only that region (Gitea and GitHub). Unfenced bodies, missing/empty artifacts, no-changes, and conflict-only merges are left alone. Body cap, `Fixes`/`Closes`, and skipped `pull_request` `edited` are unchanged. Reviewer does not PATCH. `JUMI_PR.md` is a sentinel, not source: the parent strips it before commit so it never lands in the tree.

Verified: `bun run ci` in `scripts/opencode`.
