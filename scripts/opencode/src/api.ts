import type {
  GiteaComment,
  GiteaPR,
  GiteaPRFile,
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

  // ── Issues / Comments ─────────────────────────────────────────────────────────

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
}
