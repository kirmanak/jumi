// Gitea webhook payload types and API response types

// ── Shared primitives ────────────────────────────────────────────────────────

export interface GiteaUser {
  id: number;
  login: string;
  full_name: string;
  email: string;
  avatar_url: string;
}

export interface GiteaRepo {
  id: number;
  name: string;
  full_name: string; // "owner/repo"
  private: boolean;
  owner: GiteaUser;
  html_url: string;
  clone_url: string;
  default_branch: string;
}

export interface GiteaLabel {
  id: number;
  name: string;
  color: string;
}

export interface GiteaPermission {
  permission: string;
  role_name: string;
  user: GiteaUser;
}

// ── Issue / Comment ──────────────────────────────────────────────────────────

export interface GiteaIssue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  user: GiteaUser;
  labels: GiteaLabel[];
  created_at: string;
  updated_at: string;
  pull_request?: {
    merged: boolean;
    merged_at: string | null;
  };
}

export interface GiteaComment {
  id: number;
  body: string;
  user: GiteaUser;
  created_at: string;
  updated_at: string;
}

// ── Pull Request ─────────────────────────────────────────────────────────────

export interface GiteaPRBranch {
  label: string;
  ref: string;
  sha: string;
  repo: GiteaRepo;
  repo_id: number;
}

export interface GiteaPR {
  id: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  user: GiteaUser;
  head: GiteaPRBranch;
  base: GiteaPRBranch;
  merged: boolean;
  created_at: string;
  updated_at: string;
  html_url: string;
}

export interface GiteaPRFile {
  filename: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface GiteaReviewComment {
  id: number;
  body: string;
  user: GiteaUser;
  path: string;
  line: number;
  created_at: string;
}

export interface GiteaReview {
  id: number;
  body: string;
  state: "APPROVED" | "REQUEST_CHANGES" | "COMMENT" | "PENDING";
  user: GiteaUser;
  submitted_at: string;
  comments: GiteaReviewComment[];
}

// ── Webhook payloads ─────────────────────────────────────────────────────────

export interface GiteaIssueCommentPayload {
  action: "created" | "edited" | "deleted";
  issue: GiteaIssue;
  comment: GiteaComment;
  repository: GiteaRepo;
  sender: GiteaUser;
  /** true when the issue is actually a pull request */
  is_pull: boolean;
}

export interface GiteaPRPayload {
  action: "opened" | "closed" | "reopened" | "synchronized" | "edited";
  number: number;
  pull_request: GiteaPR;
  repository: GiteaRepo;
  sender: GiteaUser;
}

// ── Trigger context (derived, passed around internally) ───────────────────────

export type TriggerKind = "issue_comment" | "pr_comment" | "pr_opened";

export interface TriggerContext {
  kind: TriggerKind;
  repo: GiteaRepo;
  sender: GiteaUser;
  /** body of the triggering comment or PR description */
  triggerBody: string;
  /** issue number (for issues) or PR number */
  number: number;
  /** only set when kind === "pr_comment" or "pr_opened" */
  pr?: GiteaPR;
}
