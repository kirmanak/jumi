import type { GiteaPR, GiteaPRFile, GiteaRepo } from "./types.ts";

/** Escape XML special characters in text content */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Escape content for use inside a CDATA section.
 * The sequence `]]>` ends a CDATA block prematurely; split it so it stays
 * inside the section: `]]>` → `]]]]><![CDATA[>`.
 */
function escapeCdata(str: string): string {
  return str.replace(/]]>/g, "]]]]><![CDATA[>");
}

function formatPRFiles(files: GiteaPRFile[]): string {
  return files
    .map((f) => {
      const patch = f.patch ? `\n      <patch><![CDATA[${escapeCdata(f.patch)}]]></patch>` : "";
      return (
        `    <file name="${escapeXml(f.filename)}" status="${f.status}" ` +
        `additions="${f.additions}" deletions="${f.deletions}">${patch}\n    </file>`
      );
    })
    .join("\n");
}

// ── Preamble ────────────────────────────────────────────────────────────────

const PREAMBLE = `You are OpenCode, an AI code review assistant integrated into a Gitea repository.

<rules>
  <rule>The current working directory is a full checkout of the pull request head.</rule>
  <rule>Prefer built-in read/list/glob/grep tools for file contents and search; they enforce external_directory.</rule>
  <rule>Shell is open for inspection. Pipes, quotes, and git grep regex are allowed.</rule>
  <rule>Keep tool output small: never dump directory-wide or high-context git patches into the session; prefer --stat, single-file --unified=3, and built-in read.</rule>
  <rule>Use web search/fetch to check public documentation when it materially improves the review.</rule>
  <rule>Do NOT edit files.</rule>
  <rule>Do NOT run mutating git commands, builds, package installs, or arbitrary network shell commands.</rule>
  <rule>Respond with a plain markdown PR review comment, then one jumi-check HTML comment.</rule>
</rules>`;

// ── Caveman-review skill ────────────────────────────────────────────────────

const CAVEMAN_REVIEW_SKILL = `Write code review comments terse and actionable. One line per finding. Location, problem, fix. No throat-clearing.

Focus on correctness and whether the change leaves the repository in a working condition. Do NOT comment on style, naming, formatting, micro-optimizations, or minor improvements that can be added later. Only flag issues that cause bugs, break compatibility, or introduce fragile patterns.

Format: \`L<line>: <problem>. <fix>.\` — or \`<file>:L<line>: ...\` when reviewing multi-file diffs.

Severity prefix (optional, when mixed):
- 🔴 bug: — broken behavior, will cause incident
- 🟡 risk: — works but fragile (race, missing null check, swallowed error)
- ❓ q: — genuine question, not a suggestion

Do NOT use any nit/style severity level. Style and naming suggestions are out of scope for this review.

Drop: "I noticed that...", "It seems like...", "You might want to consider...", "This is just a suggestion but...", "Great work!" / "Looks good overall but..." (say it once at the top, not per comment), restating what the line does (the reviewer can read the diff), hedging ("perhaps", "maybe", "I think" — if unsure use q:), any comment about style/naming/formatting/micro-optimizations.

Keep: exact line numbers, exact symbol/function/variable names in backticks, concrete fix (not "consider refactoring this"), the *why* if the fix isn't obvious from the problem statement.

Auto-Clarity: drop terse mode for security findings (CVE-class bugs need full explanation + reference), architectural disagreements (need rationale, not just a one-liner), and onboarding contexts where the author is new and needs the "why". In those cases write a normal paragraph, then resume terse for the rest.

Boundaries: reviews only — does not write the code fix, does not approve/request-changes, does not run linters. Output the comment(s) ready to paste into the PR. "stop caveman-review" or "normal mode": revert to verbose review style.`;

// ── PR opened (auto-review) prompt ──────────────────────────────────────────

export interface PROpenedPromptOptions {
  repo: GiteaRepo;
  pr: GiteaPR;
  prFiles: GiteaPRFile[];
  reviewNotes?: string[];
}

export function buildPROpenedPrompt(opts: PROpenedPromptOptions): string {
  const { repo, pr, prFiles, reviewNotes = [] } = opts;
  const formattedNotes = reviewNotes.length
    ? `\n  <review_notes>\n${reviewNotes.map((note) => `    <note>${escapeXml(note)}</note>`).join("\n")}\n  </review_notes>`
    : "";

  return `${PREAMBLE}

<gitea_action_context>
  <repository full_name="${escapeXml(repo.full_name)}" default_branch="${escapeXml(repo.default_branch)}" />
  <repository_checkout path="." local_branch="jumi/pr-${pr.number}" head_branch="${escapeXml(pr.head.ref)}" head_sha="${escapeXml(pr.head.sha)}" target_branch="${escapeXml(pr.base.ref)}" target_ref="jumi/target" target_remote_ref="origin/${escapeXml(pr.base.ref)}" target_sha="${escapeXml(pr.base.sha)}" />

  <pull_request number="${pr.number}" state="${pr.state}" author="${escapeXml(pr.user.login)}" created_at="${pr.created_at}" head="${escapeXml(pr.head.ref)}" base="${escapeXml(pr.base.ref)}">
    <title>${escapeXml(pr.title)}</title>
    <body>${escapeXml(pr.body ?? "")}</body>
    <pull_request_changed_files>
${formatPRFiles(prFiles)}
    </pull_request_changed_files>
  </pull_request>${formattedNotes}
</gitea_action_context>

Review the pull request above using the checked-out repository and the caveman-review skill below. The PR head is checked out on jumi/pr-${pr.number}; the stable target ref is jumi/target. Prefer stable refs like jumi/target and HEAD in shell commands instead of untrusted branch names.

Shell is open for inspection. Pipes, quotes, and git grep regex are allowed. Prefer built-in read/list/glob/grep for file contents. Do not dump large patches into context.
- Start from the patches already in <pull_request_changed_files>; only re-fetch a file when that patch is missing, truncated, or you need surrounding code.
- For git diff: run \`git diff --stat jumi/target...HEAD\` first, then inspect specific paths.
- Prefer \`git show HEAD:path/to/file\` or built-in read for a single file. Do not \`git show\` multi-megabyte or generated blobs.
Safe examples: \`git diff --stat jumi/target...HEAD\`, \`git grep -n 'foo\\|bar' -- path\`, \`git log --oneline jumi/target..HEAD\`, \`rg -n TODO path/\`. Prefer stable refs like jumi/target and HEAD instead of untrusted branch names. Use web search/fetch to check upstream docs when correctness depends on external behavior. Do not run commands that mutate the checkout, fetch new refs, build the project, install packages, or make network calls from the shell.

<caveman-review-skill>
${CAVEMAN_REVIEW_SKILL}
</caveman-review-skill>

Follow the format strictly: one line per finding as \`L<line>: <severity prefix:> <problem>. <fix>.\`
Start with a one-line overall assessment, then list findings.
Only comment on bugs, risks, and questions — skip all style, naming, and minor suggestions.
Do NOT make any file changes.

After the markdown review, output exactly one HTML comment as the last line:
\`<!-- jumi-check: success -->\` or \`<!-- jumi-check: failure -->\`
Optional short reason: \`<!-- jumi-check: failure; 1 blocking, 1 risk -->\`
Use failure if you reported any 🔴 bug or 🟡 risk, or if you could not finish the review.
Use success if there are no 🔴/🟡 findings. ❓ questions are allowed with success.
The check comment must be the last non-empty line, not quoted inside prose. The service uses it as the Gitea commit status.
Respond with the markdown comment plus that one check comment.`;
}
