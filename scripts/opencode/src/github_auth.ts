import { createPrivateKey, type KeyObject, sign } from "node:crypto";

const JWT_IAT_SKEW_SEC = 60;
const JWT_LIFETIME_SEC = 10 * 60;
export const GITHUB_API_URL = "https://api.github.com";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type GithubAppAuthOptions = {
  appId: string;
  privateKey: string;
  installationId: string;
  apiUrl?: string;
  now?: () => number;
  fetchImpl?: FetchLike;
};

type CachedToken = {
  token: string;
  expiresAt: number;
};

function requireText(value: string | undefined, message: string): string {
  if (!value?.trim()) throw new Error(message);
  return value;
}

function parsePrivateKey(pem: string): KeyObject {
  requireText(pem, "Missing GitHub App private key");
  try {
    return createPrivateKey(pem);
  } catch {
    throw new Error("Invalid GitHub App private key");
  }
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function createGithubAppJwt(opts: {
  appId: string;
  privateKey: string | KeyObject;
  now?: () => number;
}): string {
  const appId = requireText(typeof opts.appId === "string" ? opts.appId : "", "Missing GitHub App client ID");
  const key = typeof opts.privateKey === "string" ? parsePrivateKey(opts.privateKey) : opts.privateKey;
  const nowSec = Math.floor((opts.now ?? Date.now)() / 1000);
  const unsigned = `${base64UrlJson({ alg: "RS256", typ: "JWT" })}.${base64UrlJson({
    iat: nowSec - JWT_IAT_SKEW_SEC,
    exp: nowSec + JWT_LIFETIME_SEC,
    iss: appId,
  })}`;
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url")}`;
}

function readInstallationToken(body: string): CachedToken {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new Error("GitHub installation token response is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("GitHub installation token response is not JSON");
  }
  const token = (parsed as { token?: unknown }).token;
  const expiresAtRaw = (parsed as { expires_at?: unknown }).expires_at;
  if (typeof token !== "string" || !token) {
    throw new Error("GitHub installation token response is not JSON");
  }
  if (typeof expiresAtRaw !== "string") {
    throw new Error("GitHub installation token response is not JSON");
  }
  const expiresAt = Date.parse(expiresAtRaw);
  if (!Number.isFinite(expiresAt)) {
    throw new Error("GitHub installation token response is not JSON");
  }
  return { token, expiresAt };
}

export class GithubAppAuth {
  private readonly appId: string;
  private readonly key: KeyObject;
  private readonly installationId: string;
  private readonly apiUrl: string;
  private readonly now: () => number;
  private readonly fetchImpl: FetchLike;
  private cached: CachedToken | undefined;

  constructor(opts: GithubAppAuthOptions) {
    this.appId = requireText(opts.appId, "Missing GitHub App client ID");
    this.key = parsePrivateKey(opts.privateKey);
    this.installationId = requireText(opts.installationId, "Missing GitHub App installation ID");
    this.apiUrl = (opts.apiUrl ?? GITHUB_API_URL).replace(/\/+$/, "");
    this.now = opts.now ?? Date.now;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  createJwt(): string {
    return createGithubAppJwt({ appId: this.appId, privateKey: this.key, now: this.now });
  }

  async getInstallationToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt > this.now()) return this.cached.token;
    return this.refreshInstallationToken();
  }

  async refreshInstallationToken(): Promise<string> {
    const url = `${this.apiUrl}/app/installations/${encodeURIComponent(this.installationId)}/access_tokens`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.createJwt()}`,
      },
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      throw new Error(`GitHub API POST ${url} → ${res.status}: ${text}`);
    }
    this.cached = readInstallationToken(text);
    return this.cached.token;
  }
}
