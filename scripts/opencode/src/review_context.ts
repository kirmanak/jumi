import { byteLength } from "./diagnostics.ts";
import type { GiteaComment, GiteaIssue } from "./types.ts";

export const DEFAULT_MAX_THREAD_BYTES = 200_000;
export const MAX_COMMENT_BODY_BYTES = 32_768;
export const MAX_LINKED_ISSUE_BODY_BYTES = 8_192;
const OMITTED_BODY = "[omitted; thread budget]";
const encoder = new TextEncoder();

export interface ReviewComment {
  id: number;
  author: string;
  created_at: string;
  body: string;
}

export interface ReviewLinkedIssue {
  number: number;
  state: string;
  author: string;
  html_url: string;
  title: string;
  body: string;
  comments: ReviewComment[];
}

export interface ReviewThread {
  comments: ReviewComment[];
  linkedIssues: ReviewLinkedIssue[];
}

export interface FitReviewThreadResult {
  thread: ReviewThread;
  truncated: boolean;
  droppedCommentBodies: number;
  threadBytes: number;
}

export function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function mapReviewComment(comment: GiteaComment): ReviewComment {
  return {
    id: comment.id,
    author: comment.user?.login ?? "",
    created_at: comment.created_at,
    body: comment.body ?? "",
  };
}

export function mapReviewThread(opts: {
  prComments: GiteaComment[];
  linkedIssues: Array<{ issue: GiteaIssue; comments: GiteaComment[] }>;
}): ReviewThread {
  return {
    comments: opts.prComments.map(mapReviewComment),
    linkedIssues: opts.linkedIssues.map(({ issue, comments }) => ({
      number: issue.number,
      state: issue.state,
      author: issue.user?.login ?? "",
      html_url: issue.html_url,
      title: issue.title,
      body: issue.body ?? "",
      comments: comments.map(mapReviewComment),
    })),
  };
}

function formatCommentXml(comment: ReviewComment, indent: string): string {
  return `${indent}<comment id="${comment.id}" author="${escapeXml(comment.author)}" created_at="${escapeXml(comment.created_at)}">${escapeXml(comment.body)}</comment>`;
}

function formatCommentsXml(comments: ReviewComment[], indent: string): string {
  if (comments.length === 0) return "";
  const inner = `${indent}  `;
  const items = comments.map((comment) => formatCommentXml(comment, inner)).join("\n");
  return `${indent}<comments>\n${items}\n${indent}</comments>`;
}

export function formatPrCommentsXml(comments: ReviewComment[]): string {
  return formatCommentsXml(comments, "    ");
}

function formatLinkedIssueXml(issue: ReviewLinkedIssue): string {
  const commentsXml = formatCommentsXml(issue.comments, "      ");
  const commentsBlock = commentsXml ? `\n${commentsXml}` : "";
  return `    <issue number="${issue.number}" state="${escapeXml(issue.state)}" author="${escapeXml(issue.author)}" html_url="${escapeXml(issue.html_url)}">
      <title>${escapeXml(issue.title)}</title>
      <body>${escapeXml(issue.body)}</body>${commentsBlock}
    </issue>`;
}

export function formatLinkedIssuesXml(issues: ReviewLinkedIssue[]): string {
  if (issues.length === 0) return "";
  const items = issues.map(formatLinkedIssueXml).join("\n");
  return `  <linked_issues>\n${items}\n  </linked_issues>`;
}

export function serializeReviewThread(thread: ReviewThread): string {
  const parts = [formatPrCommentsXml(thread.comments), formatLinkedIssuesXml(thread.linkedIssues)].filter(
    (part) => part.length > 0
  );
  return parts.join("\n");
}

function cloneComment(comment: ReviewComment): ReviewComment {
  return { ...comment };
}

function cloneThread(thread: ReviewThread): ReviewThread {
  return {
    comments: thread.comments.map(cloneComment),
    linkedIssues: thread.linkedIssues.map((issue) => ({
      ...issue,
      comments: issue.comments.map(cloneComment),
    })),
  };
}

function allComments(thread: ReviewThread): ReviewComment[] {
  return [...thread.comments, ...thread.linkedIssues.flatMap((issue) => issue.comments)];
}

function omissionOrder(thread: ReviewThread): ReviewComment[] {
  const lists = [thread.comments, ...thread.linkedIssues.map((issue) => issue.comments)].map((list) =>
    [...list].sort((a, b) => {
      const byDate = a.created_at.localeCompare(b.created_at);
      if (byDate !== 0) return byDate;
      return a.id - b.id;
    })
  );
  const order: ReviewComment[] = [];
  let index = 0;
  let added = true;
  while (added) {
    added = false;
    for (const list of lists) {
      const item = list[index];
      if (item) {
        order.push(item);
        added = true;
      }
    }
    index += 1;
  }
  return order;
}

function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  return new TextDecoder().decode(bytes.slice(0, maxBytes));
}

function threadByteLength(thread: ReviewThread): number {
  return byteLength(serializeReviewThread(thread));
}

export function fitReviewThread(thread: ReviewThread, maxBytes: number): FitReviewThreadResult {
  const fitted = cloneThread(thread);
  const underCap = () => threadByteLength(fitted) <= maxBytes;

  if (underCap()) {
    return {
      thread: fitted,
      truncated: false,
      droppedCommentBodies: 0,
      threadBytes: threadByteLength(fitted),
    };
  }

  let truncated = false;
  let droppedCommentBodies = 0;

  for (const comment of allComments(fitted)) {
    if (byteLength(comment.body) > MAX_COMMENT_BODY_BYTES) {
      comment.body = `${truncateUtf8(comment.body, MAX_COMMENT_BODY_BYTES)}\n[truncated]`;
      truncated = true;
    }
  }

  if (!underCap()) {
    for (const comment of omissionOrder(fitted)) {
      if (underCap()) break;
      if (comment.body === OMITTED_BODY) continue;
      comment.body = OMITTED_BODY;
      droppedCommentBodies += 1;
      truncated = true;
    }
  }

  if (!underCap()) {
    for (const issue of fitted.linkedIssues) {
      if (byteLength(issue.body) > MAX_LINKED_ISSUE_BODY_BYTES) {
        issue.body = truncateUtf8(issue.body, MAX_LINKED_ISSUE_BODY_BYTES);
        truncated = true;
      }
    }
  }

  return {
    thread: fitted,
    truncated,
    droppedCommentBodies,
    threadBytes: threadByteLength(fitted),
  };
}
