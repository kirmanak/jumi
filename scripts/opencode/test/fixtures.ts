import type { ServiceConfig } from "../src/config.ts";
import type {
  GiteaComment,
  GiteaPR,
  GiteaPRBranch,
  GiteaPRFile,
  GiteaPRPayload,
  GiteaRepo,
  GiteaUser,
  ReviewJob,
} from "../src/types.ts";

export function makeUser(overrides: Partial<GiteaUser> = {}): GiteaUser {
  return {
    id: 1,
    login: "alice",
    full_name: "Alice",
    email: "alice@example.com",
    avatar_url: "https://gitea.kirmanak.stream/avatars/alice",
    ...overrides,
  };
}

export function makeRepo(overrides: Partial<GiteaRepo> = {}): GiteaRepo {
  const owner = overrides.owner ?? makeUser({ login: "kirmanak" });
  const name = overrides.name ?? "demo";
  const fullName = overrides.full_name ?? `${owner.login}/${name}`;
  return {
    id: 10,
    name,
    full_name: fullName,
    private: true,
    owner,
    html_url: `https://gitea.kirmanak.stream/${fullName}`,
    clone_url: `https://gitea.kirmanak.stream/${fullName}.git`,
    default_branch: "main",
    ...overrides,
  };
}

export function makeBranch(overrides: Partial<GiteaPRBranch> = {}): GiteaPRBranch {
  const repo = overrides.repo === undefined ? makeRepo() : overrides.repo;
  return {
    label: "kirmanak:feature",
    ref: "feature",
    sha: "abc123",
    repo,
    repo_id: repo?.id ?? 10,
    ...overrides,
  };
}

export function makePR(overrides: Partial<GiteaPR> = {}): GiteaPR {
  return {
    id: 100,
    number: 7,
    title: "Add feature",
    body: "PR body",
    state: "open",
    user: makeUser(),
    head: makeBranch({ sha: "headsha" }),
    base: makeBranch({ label: "kirmanak:main", ref: "main", sha: "basesha" }),
    merged: false,
    created_at: "2026-05-23T00:00:00Z",
    updated_at: "2026-05-23T00:00:00Z",
    html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/7",
    ...overrides,
  };
}

export function makeFile(overrides: Partial<GiteaPRFile> = {}): GiteaPRFile {
  return {
    filename: "src/demo.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    changes: 2,
    patch: "@@ -1 +1 @@\n-old\n+new",
    ...overrides,
  };
}

export function makeComment(overrides: Partial<GiteaComment> = {}): GiteaComment {
  return {
    id: 55,
    body: "comment",
    user: makeUser({ login: "jumi" }),
    created_at: "2026-05-23T00:00:00Z",
    updated_at: "2026-05-23T00:00:00Z",
    ...overrides,
  };
}

export function makePayload(overrides: Partial<GiteaPRPayload> = {}): GiteaPRPayload {
  const repository = overrides.repository ?? makeRepo();
  const pr = overrides.pull_request ?? makePR({ number: 7 });
  return {
    action: "opened",
    number: pr.number,
    pull_request: pr,
    repository,
    sender: makeUser({ login: "alice" }),
    ...overrides,
  };
}

export function makeJob(overrides: Partial<ReviewJob> = {}): ReviewJob {
  return {
    delivery: "delivery-1",
    owner: "kirmanak",
    repo: "demo",
    prNumber: 7,
    action: "opened",
    headSha: "headsha",
    receivedAt: "2026-05-23T00:00:00Z",
    ...overrides,
  };
}

export function makeConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    host: "127.0.0.1",
    port: 3000,
    giteaUrl: "https://gitea.kirmanak.stream",
    giteaToken: "bot-token",
    webhookSecret: "webhook-secret",
    allowedOrgs: ["kirmanak"],
    allowedRepos: [],
    botUsername: "jumi",
    model: "openai/gpt-5.5",
    home: "/data",
    workdir: "/work",
    queueConcurrency: 1,
    maxFiles: 100,
    maxPatchBytes: 500_000,
    maxOutputBytes: 80_000,
    maxWebhookBytes: 1_048_576,
    opencodeTimeoutMs: 900_000,
    ...overrides,
  };
}

export function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export async function signBody(rawBody: Uint8Array, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const body = rawBody.buffer.slice(rawBody.byteOffset, rawBody.byteOffset + rawBody.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.sign("HMAC", key, body);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json();
}
