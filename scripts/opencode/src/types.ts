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

// ── Issue / Comment ──────────────────────────────────────────────────────────

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
  /** null when the source repo (e.g. fork) has been deleted */
  repo: GiteaRepo | null;
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
  draft?: boolean;
  mergeable?: boolean | null;
}

export interface GiteaPRFile {
  filename: string;
  status: "added" | "modified" | "changed" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

// ── Webhook payloads ─────────────────────────────────────────────────────────

export interface GiteaPullReview {
  id: number;
  body?: string | null;
  content?: string;
  user?: GiteaUser;
  state?: string;
  type?: string;
  submitted_at?: string;
  updated_at?: string;
  created_at?: string;
}

export interface GiteaPullReviewComment extends GiteaComment {
  path?: string;
  pull_request_review_id?: number;
  html_url?: string;
}

export interface GiteaPRReviewRef {
  id?: number;
  body?: string | null;
  content?: string;
  type?: string;
}

export interface GiteaPRPayload {
  action: string;
  number: number;
  pull_request: GiteaPR;
  repository: GiteaRepo;
  sender: GiteaUser;
  review?: GiteaPRReviewRef;
}

export interface GiteaIssueCommentPayload {
  action: string;
  comment: GiteaComment;
  issue: GiteaIssue;
  pull_request?: GiteaPR;
  repository: GiteaRepo;
  sender: GiteaUser;
}

export interface ReviewJob {
  delivery: string;
  owner: string;
  repo: string;
  prNumber: number;
  action: string;
  headSha: string;
  receivedAt: string;
}

export interface GiteaIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  html_url: string;
  user: GiteaUser;
  assignee: GiteaUser | null;
  assignees: GiteaUser[] | null;
  pull_request?: {
    url?: string;
    merged?: boolean;
    merged_at?: string | null;
    draft?: boolean;
    html_url?: string;
  } | null;
  is_pull?: boolean;
  updated_at: string;
  created_at: string;
  /** Webhook payloads embed a full repo; REST issue search only sends RepositoryMeta. */
  repository?: GiteaRepo | GiteaRepositoryMeta;
}

export interface GiteaRepositoryMeta {
  id?: number;
  name?: string;
  owner?: string | GiteaUser;
  full_name: string;
  html_url?: string;
  clone_url?: string;
  default_branch?: string;
}

export interface GiteaIssuePayload {
  action: string;
  number: number;
  issue: GiteaIssue;
  repository: GiteaRepo;
  sender: GiteaUser;
}

export interface IssueJobTrigger {
  event: string;
  commentId?: number;
  reviewId?: number;
  sender: string;
  body?: string;
}

export interface IssueJob {
  delivery: string;
  owner: string;
  repo: string;
  issueNumber: number;
  action: string;
  title: string;
  body: string;
  htmlUrl: string;
  issueUpdatedAt: string;
  defaultBranch: string;
  cloneUrl: string;
  receivedAt: string;
  mode?: "implement" | "follow-up" | "conflict";
  prNumber?: number;
  trigger?: IssueJobTrigger;
}

export interface GiteaPushPayload {
  ref: string;
  before?: string;
  after?: string;
  repository: GiteaRepo;
  pusher?: GiteaUser;
  sender?: GiteaUser;
  commits?: unknown[];
}

export type GiteaCommitStatusState = "pending" | "success" | "error" | "failure" | "warning";

export interface GiteaCommitStatusPayload {
  state: GiteaCommitStatusState;
  target_url?: string;
  description?: string;
  context?: string;
}
