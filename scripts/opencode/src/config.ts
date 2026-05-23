export interface ServiceConfig {
  host: string;
  port: number;
  giteaUrl: string;
  giteaToken: string;
  webhookSecret: string;
  webhookAuthToken?: string;
  allowedOrgs: string[];
  allowedRepos: string[];
  botUsername: string;
  model: string;
  opencodeConfig?: string;
  home: string;
  workdir: string;
  queueConcurrency: number;
  maxFiles: number;
  maxPatchBytes: number;
  maxOutputBytes: number;
  maxWebhookBytes: number;
  opencodeTimeoutMs: number;
}

type Env = Record<string, string | undefined>;

function requireEnv(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optionalEnv(env: Env, name: string, fallback?: string): string | undefined {
  return env[name] || fallback;
}

function intEnv(env: Env, name: string, fallback: number): number {
  const value = env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer for ${name}: ${value}`);
  }
  return parsed;
}

function csvEnv(env: Env, name: string, fallback: string[] = []): string[] {
  const value = env[name];
  if (!value) return fallback;
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export function loadConfig(env: Env = process.env): ServiceConfig {
  return {
    host: optionalEnv(env, "HOST", "0.0.0.0") ?? "0.0.0.0",
    port: intEnv(env, "PORT", 3000),
    giteaUrl: normalizeUrl(requireEnv(env, "GITEA_URL")),
    giteaToken: requireEnv(env, "GITEA_BOT_TOKEN"),
    webhookSecret: requireEnv(env, "GITEA_WEBHOOK_SECRET"),
    webhookAuthToken: optionalEnv(env, "GITEA_WEBHOOK_AUTH_TOKEN"),
    allowedOrgs: csvEnv(env, "GITEA_ALLOWED_ORGS", ["kirmanak"]),
    allowedRepos: csvEnv(env, "GITEA_ALLOWED_REPOS"),
    botUsername: optionalEnv(env, "BOT_USERNAME", "jumi") ?? "jumi",
    model: optionalEnv(env, "OPENCODE_MODEL", "openai/gpt-5.5") ?? "openai/gpt-5.5",
    opencodeConfig: optionalEnv(env, "OPENCODE_CONFIG"),
    home: optionalEnv(env, "HOME", "/data") ?? "/data",
    workdir: optionalEnv(env, "WORKDIR", "/work") ?? "/work",
    queueConcurrency: intEnv(env, "QUEUE_CONCURRENCY", 1),
    maxFiles: intEnv(env, "MAX_FILES", 100),
    maxPatchBytes: intEnv(env, "MAX_PATCH_BYTES", 500_000),
    maxOutputBytes: intEnv(env, "MAX_OUTPUT_BYTES", 80_000),
    maxWebhookBytes: intEnv(env, "MAX_WEBHOOK_BYTES", 1_048_576),
    opencodeTimeoutMs: intEnv(env, "OPENCODE_TIMEOUT_MS", 15 * 60 * 1000),
  };
}
