import type {
  GiteaComment,
  GiteaIssue,
  GiteaPermission,
  GiteaPR,
  GiteaPRFile,
  GiteaReview,
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
    this.base = serverUrl.replace(/\/$/, "") + "/api/v1";
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

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
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
  private delete<T = void>(path: string, body?: unknown) {
    return this.request<T>("DELETE", path, body);
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

  // ── Permissions ──────────────────────────────────────────────────────────────

  async getCollaboratorPermission(
    owner: string,
    repo: string,
    username: string
  ): Promise<GiteaPermission> {
    return this.get<GiteaPermission>(
      `/repos/${owner}/${repo}/collaborators/${username}/permission`
    );
  }

  /** Returns true if the user has at least "write" access */
  async hasWriteAccess(
    owner: string,
    repo: string,
    username: string
  ): Promise<boolean> {
    if (username === owner) return true;
    try {
      const perm = await this.getCollaboratorPermission(owner, repo, username);
      return ["owner", "admin", "write"].includes(perm.role);
    } catch {
      return false;
    }
  }

  // ── Reactions ────────────────────────────────────────────────────────────────

  async addCommentReaction(
    owner: string,
    repo: string,
    commentId: number,
    content: string // e.g. "eyes", "+1", "rocket"
  ): Promise<void> {
    await this.post<unknown>(
      `/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`,
      { content }
    );
  }

  async deleteCommentReaction(
    owner: string,
    repo: string,
    commentId: number,
    content: string
  ): Promise<void> {
    await this.delete(
      `/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`,
      { content }
    );
  }

  // ── Issues ────────────────────────────────────────────────────────────────────

  async getIssue(
    owner: string,
    repo: string,
    index: number
  ): Promise<GiteaIssue> {
    return this.get<GiteaIssue>(`/repos/${owner}/${repo}/issues/${index}`);
  }

  async getIssueComments(
    owner: string,
    repo: string,
    index: number
  ): Promise<GiteaComment[]> {
    return this.getAll<GiteaComment>(
      `/repos/${owner}/${repo}/issues/${index}/comments`
    );
  }

  async createIssueComment(
    owner: string,
    repo: string,
    index: number,
    body: string
  ): Promise<GiteaComment> {
    return this.post<GiteaComment>(
      `/repos/${owner}/${repo}/issues/${index}/comments`,
      { body }
    );
  }

  async updateComment(
    owner: string,
    repo: string,
    commentId: number,
    body: string
  ): Promise<GiteaComment> {
    return this.patch<GiteaComment>(
      `/repos/${owner}/${repo}/issues/comments/${commentId}`,
      { body }
    );
  }

  // ── Pull Requests ─────────────────────────────────────────────────────────────

  async getPR(owner: string, repo: string, index: number): Promise<GiteaPR> {
    return this.get<GiteaPR>(`/repos/${owner}/${repo}/pulls/${index}`);
  }

  async getPRFiles(
    owner: string,
    repo: string,
    index: number
  ): Promise<GiteaPRFile[]> {
    return this.getAll<GiteaPRFile>(
      `/repos/${owner}/${repo}/pulls/${index}/files`
    );
  }

  async getPRReviews(
    owner: string,
    repo: string,
    index: number
  ): Promise<GiteaReview[]> {
    // Gitea returns reviews with empty comments array; we enrich them below
    const reviews = await this.getAll<GiteaReview>(
      `/repos/${owner}/${repo}/pulls/${index}/reviews`
    );
    // Fetch inline comments for each review in parallel
    const enriched = await Promise.all(
      reviews.map(async (r) => {
        try {
          const comments = await this.getAll<
            import("./types.ts").GiteaReviewComment
          >(`/repos/${owner}/${repo}/pulls/${index}/reviews/${r.id}/comments`);
          return { ...r, comments };
        } catch {
          return r;
        }
      })
    );
    return enriched;
  }

  async createPR(
    owner: string,
    repo: string,
    opts: {
      title: string;
      body: string;
      head: string;
      base: string;
    }
  ): Promise<GiteaPR> {
    return this.post<GiteaPR>(`/repos/${owner}/${repo}/pulls`, opts);
  }
}
