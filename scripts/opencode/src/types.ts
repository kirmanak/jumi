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

export interface GiteaPRPayload {
  action: string;
  number: number;
  pull_request: GiteaPR;
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

export type GiteaCommitStatusState = "pending" | "success" | "error" | "failure" | "warning";

export interface GiteaCommitStatusPayload {
  state: GiteaCommitStatusState;
  target_url?: string;
  description?: string;
  context?: string;
}
