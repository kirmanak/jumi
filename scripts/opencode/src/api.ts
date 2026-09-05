import type {
  GiteaComment,
  GiteaCommitStatusPayload,
  GiteaIssue,
  GiteaPR,
  GiteaPRFile,
  GiteaPullReview,
  GiteaPullReviewComment,
  GiteaRepo,
} from "./types.ts";

/**
 * Minimal Gitea REST API client.
 * All methods throw on non-2xx responses.
 */
export class GiteaAPI {
  private readonly base: string;
  private readonly token: string;

  constructor(serverUrl: string, token: string) {
    // Ensure no trailing slash
    this.base = `${serverUrl.replace(/\/$/, "")}/api/v1`;
    this.token = token;
  }

  // ── HTTP helpers ────────────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    return {
      Authorization: `token ${this.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.base}${path}`;
    const res = await fetch(url, {
      method,
      headers: this.headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Gitea API ${method} ${url} → ${res.status}: ${text}`);
    }
    // 204 No Content
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  private get<T>(path: string) {
    return this.request<T>("GET", path);
  }
  private post<T>(path: string, body: unknown) {
    return this.request<T>("POST", path, body);
  }
  private patch<T>(path: string, body: unknown) {
    return this.request<T>("PATCH", path, body);
  }

  private repoPath(owner: string, repo: string): string {
    return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  // Paginated GET — collects all pages (page size 50)
  private async getAll<T>(path: string): Promise<T[]> {
    const results: T[] = [];
    let page = 1;
    while (true) {
      const sep = path.includes("?") ? "&" : "?";
      const batch = await this.get<T[]>(`${path}${sep}limit=50&page=${page}`);
      results.push(...batch);
      if (batch.length < 50) break;
      page++;
    }
    return results;
  }

  private async getPages<T>(path: string): Promise<T[]> {
    const results: T[] = [];
    let page = 1;
    while (page <= 40) {
      const sep = path.includes("?") ? "&" : "?";
      const batch = await this.get<T[]>(`${path}${sep}limit=50&page=${page}`);
      results.push(...batch);
      if (batch.length !== 50) break;
      page += 1;
    }
    return results;
  }

  // ── Repositories ───────────────────────────────────────────────────────────

  async getRepo(owner: string, repo: string): Promise<GiteaRepo> {
    return this.get<GiteaRepo>(`/repos/${this.repoPath(owner, repo)}`);
  }

  // ── Pull Requests ─────────────────────────────────────────────────────────────

  async getPR(owner: string, repo: string, index: number): Promise<GiteaPR> {
    return this.get<GiteaPR>(`/repos/${this.repoPath(owner, repo)}/pulls/${index}`);
  }

  async listOpenPulls(owner: string, repo: string): Promise<GiteaPR[]> {
    return this.getAll<GiteaPR>(`/repos/${this.repoPath(owner, repo)}/pulls?state=open`);
  }

  async createPullRequest(
    owner: string,
    repo: string,
    pull: { title: string; body: string; head: string; base: string }
  ): Promise<GiteaPR> {
    return this.post<GiteaPR>(`/repos/${this.repoPath(owner, repo)}/pulls`, pull);
  }

  async getIssue(owner: string, repo: string, index: number): Promise<GiteaIssue> {
    return this.get<GiteaIssue>(`/repos/${this.repoPath(owner, repo)}/issues/${index}`);
  }

  async searchAssignedIssues(): Promise<GiteaIssue[]> {
    return this.getAll<GiteaIssue>("/repos/issues/search?type=issues&state=open&assigned=true");
  }

  async getPRFiles(owner: string, repo: string, index: number): Promise<GiteaPRFile[]> {
    return this.getAll<GiteaPRFile>(`/repos/${this.repoPath(owner, repo)}/pulls/${index}/files`);
  }

  // ── Issues / Comments ─────────────────────────────────────────────────────────

  async createIssueComment(owner: string, repo: string, index: number, body: string): Promise<GiteaComment> {
    return this.post<GiteaComment>(`/repos/${this.repoPath(owner, repo)}/issues/${index}/comments`, { body });
  }

  /**
   * Find the sticky review comment without retaining the full issue timeline.
   * Gitea may ignore page size and return the whole thread in one response; we
   * still scan once, keep only a minimal match (id), and drop the rest so
   * multi‑MB Tapio/PR-summary histories are not held for the rest of the job.
   */
  async findStickyIssueComment(
    owner: string,
    repo: string,
    index: number,
    botUsername: string,
    marker: string
  ): Promise<{ id: number } | undefined> {
    const path = `/repos/${this.repoPath(owner, repo)}/issues/${index}/comments`;
    let page = 1;
    while (page <= 40) {
      const batch = await this.get<GiteaComment[]>(`${path}?limit=50&page=${page}`);
      for (const comment of batch) {
        if (comment.user?.login === botUsername && typeof comment.body === "string" && comment.body.includes(marker)) {
          return { id: comment.id };
        }
      }
      // Gitea may ignore limit and return the full thread (length !== 50).
      // Only advance pages when we got a full page of exactly 50.
      if (batch.length !== 50) break;
      page += 1;
    }
    return undefined;
  }

  async updateIssueComment(owner: string, repo: string, commentId: number, body: string): Promise<GiteaComment> {
    return this.patch<GiteaComment>(`/repos/${this.repoPath(owner, repo)}/issues/comments/${commentId}`, { body });
  }

  async listIssueComments(owner: string, repo: string, index: number): Promise<GiteaComment[]> {
    return this.getPages<GiteaComment>(`/repos/${this.repoPath(owner, repo)}/issues/${index}/comments`);
  }

  async listPullReviewComments(owner: string, repo: string, index: number): Promise<GiteaPullReviewComment[]> {
    return this.getPages<GiteaPullReviewComment>(`/repos/${this.repoPath(owner, repo)}/pulls/${index}/comments`);
  }

  async listPullReviews(owner: string, repo: string, index: number): Promise<GiteaPullReview[]> {
    return this.getPages<GiteaPullReview>(`/repos/${this.repoPath(owner, repo)}/pulls/${index}/reviews`);
  }

  // ── Commit statuses ───────────────────────────────────────────────────────────

  async createCommitStatus(
    owner: string,
    repo: string,
    sha: string,
    status: GiteaCommitStatusPayload
  ): Promise<GiteaCommitStatusPayload> {
    return this.post<GiteaCommitStatusPayload>(
      `/repos/${this.repoPath(owner, repo)}/statuses/${encodeURIComponent(sha)}`,
      status
    );
  }
}
