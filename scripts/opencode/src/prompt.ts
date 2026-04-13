import type {
  GiteaComment,
  GiteaIssue,
  GiteaPR,
  GiteaPRFile,
  GiteaReview,
  GiteaRepo,
  GiteaUser,
} from "./types.ts";

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

function formatComments(comments: GiteaComment[]): string {
  if (comments.length === 0) return "";
  return comments
    .map(
      (c) =>
        `    <comment id="${c.id}" author="${escapeXml(c.user.login)}" created_at="${c.created_at}">\n` +
        `      ${escapeXml(c.body)}\n` +
        `    </comment>`
    )
    .join("\n");
}

function formatPRFiles(files: GiteaPRFile[]): string {
  return files
    .map((f) => {
      const patch = f.patch
        ? `\n      <patch><![CDATA[${escapeCdata(f.patch)}]]></patch>`
        : "";
      return (
        `    <file name="${escapeXml(f.filename)}" status="${f.status}" ` +
        `additions="${f.additions}" deletions="${f.deletions}">${patch}\n    </file>`
      );
    })
    .join("\n");
}

function formatReviews(reviews: GiteaReview[]): string {
  return reviews
    .map((r) => {
      const inlineComments =
        r.comments.length > 0
          ? r.comments
              .map(
                (c) =>
                  `      <inline_comment path="${escapeXml(c.path)}" line="${c.line}" author="${escapeXml(c.user.login)}">\n` +
                  `        ${escapeXml(c.body)}\n` +
                  `      </inline_comment>`
              )
              .join("\n")
          : "";
      return (
        `    <review id="${r.id}" state="${r.state}" author="${escapeXml(r.user.login)}" submitted_at="${r.submitted_at}">\n` +
        `      ${escapeXml(r.body)}\n` +
        (inlineComments ? `\n${inlineComments}\n` : "") +
        `    </review>`
      );
    })
    .join("\n");
}

// ── Preamble ────────────────────────────────────────────────────────────────

const PREAMBLE = `You are OpenCode, an AI coding assistant integrated into a Gitea repository.
You have been invoked by a comment in a Gitea issue or pull request.

<rules>
  <rule>Do NOT manually run git commit or git push — the workflow will handle that.</rule>
  <rule>Do NOT add any text outside of file edits unless you are responding conversationally (i.e. if no code changes are needed, reply with a plain markdown comment).</rule>
  <rule>When asked to make code changes, apply them directly to the files in the working directory.</rule>
  <rule>Always write clear, idiomatic code that matches the style of the existing codebase.</rule>
  <rule>If you cannot fulfill a request, explain why in plain text.</rule>
</rules>`;

// ── Issue comment prompt ─────────────────────────────────────────────────────

export interface IssuePromptOptions {
  repo: GiteaRepo;
  sender: GiteaUser;
  issue: GiteaIssue;
  comments: GiteaComment[];
  triggerCommentId: number;
  triggerBody: string;
}

export function buildIssuePrompt(opts: IssuePromptOptions): string {
  const { repo, sender, issue, comments, triggerCommentId, triggerBody } = opts;

  const issueComments = comments
    .filter((c) => c.id !== triggerCommentId)
    .slice(-20); // cap at last 20 comments for context

  return `${PREAMBLE}

<gitea_action_context>
  <repository full_name="${escapeXml(repo.full_name)}" default_branch="${escapeXml(repo.default_branch)}" />
  <trigger_comment id="${triggerCommentId}" author="${escapeXml(sender.login)}">
    ${escapeXml(triggerBody)}
  </trigger_comment>

  <issue number="${issue.number}" state="${issue.state}" author="${escapeXml(issue.user.login)}" created_at="${issue.created_at}">
    <title>${escapeXml(issue.title)}</title>
    <body>${escapeXml(issue.body ?? "")}</body>
    <issue_comments>
${formatComments(issueComments)}
    </issue_comments>
  </issue>
</gitea_action_context>

Please address the request in the trigger comment above.`;
}

// ── PR comment prompt ────────────────────────────────────────────────────────

export interface PRCommentPromptOptions {
  repo: GiteaRepo;
  sender: GiteaUser;
  pr: GiteaPR;
  issueComments: GiteaComment[];
  prFiles: GiteaPRFile[];
  reviews: GiteaReview[];
  triggerCommentId: number;
  triggerBody: string;
}

export function buildPRCommentPrompt(opts: PRCommentPromptOptions): string {
  const {
    repo,
    sender,
    pr,
    issueComments,
    prFiles,
    reviews,
    triggerCommentId,
    triggerBody,
  } = opts;

  const recentComments = issueComments
    .filter((c) => c.id !== triggerCommentId)
    .slice(-20);

  return `${PREAMBLE}

<gitea_action_context>
  <repository full_name="${escapeXml(repo.full_name)}" default_branch="${escapeXml(repo.default_branch)}" />
  <trigger_comment id="${triggerCommentId}" author="${escapeXml(sender.login)}">
    ${escapeXml(triggerBody)}
  </trigger_comment>

  <pull_request number="${pr.number}" state="${pr.state}" author="${escapeXml(pr.user.login)}" created_at="${pr.created_at}" head="${escapeXml(pr.head.ref)}" base="${escapeXml(pr.base.ref)}">
    <title>${escapeXml(pr.title)}</title>
    <body>${escapeXml(pr.body ?? "")}</body>
    <pull_request_comments>
${formatComments(recentComments)}
    </pull_request_comments>
    <pull_request_changed_files>
${formatPRFiles(prFiles)}
    </pull_request_changed_files>
    <pull_request_reviews>
${formatReviews(reviews)}
    </pull_request_reviews>
  </pull_request>
</gitea_action_context>

Please address the request in the trigger comment above.`;
}

// ── PR opened (auto-review) prompt ──────────────────────────────────────────

export interface PROpenedPromptOptions {
  repo: GiteaRepo;
  pr: GiteaPR;
  prFiles: GiteaPRFile[];
}

export function buildPROpenedPrompt(opts: PROpenedPromptOptions): string {
  const { repo, pr, prFiles } = opts;

  return `${PREAMBLE}

<gitea_action_context>
  <repository full_name="${escapeXml(repo.full_name)}" default_branch="${escapeXml(repo.default_branch)}" />

  <pull_request number="${pr.number}" state="${pr.state}" author="${escapeXml(pr.user.login)}" created_at="${pr.created_at}" head="${escapeXml(pr.head.ref)}" base="${escapeXml(pr.base.ref)}">
    <title>${escapeXml(pr.title)}</title>
    <body>${escapeXml(pr.body ?? "")}</body>
    <pull_request_changed_files>
${formatPRFiles(prFiles)}
    </pull_request_changed_files>
  </pull_request>
</gitea_action_context>

Please review the pull request above. Provide a concise review comment covering:
- Overall assessment
- Any bugs, security issues, or correctness concerns
- Style or best-practice suggestions (if significant)

Do NOT make any file changes. Respond with a plain markdown comment only.`;
}
