import { readFileSync, unlinkSync } from "node:fs";
import { SECRET_ENV_KEYS, SECRETS_FILE_ENV } from "./config.ts";

export interface WorkerConfig {
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
  opencodeWellKnownUrl?: string;
  opencodeWellKnownKey: string;
  opencodeWellKnownToken: string;
  home: string;
  workdir: string;
  queueConcurrency: number;
  maxOutputBytes: number;
  maxWebhookBytes: number;
  opencodeTimeoutMs: number;
  scanIntervalMs: number;
  databaseUrl?: string;
  leaseMs: number;
  maxJobAttempts: number;
}

type Env = Record<string, string | undefined>;

function overlaySecretsFromFile(env: Env): Env {
  const path = env[SECRETS_FILE_ENV];
  if (!path) return env;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  try {
    unlinkSync(path);
  } catch {
    // Best-effort: the file is 0600 and lives on tmpfs.
  }
  const merged: Env = { ...env };
  for (const key of SECRET_ENV_KEYS) {
    const value = parsed[key];
    if (typeof value === "string" && value) merged[key] = value;
  }
  delete merged[SECRETS_FILE_ENV];
  return merged;
}

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

export function loadWorkerConfig(env: Env = process.env): WorkerConfig {
  const resolved = overlaySecretsFromFile(env);
  const opencodeTimeoutMs = intEnv(resolved, "OPENCODE_TIMEOUT_MS", 4 * 60 * 60 * 1000);
  return {
    host: optionalEnv(resolved, "HOST", "0.0.0.0") ?? "0.0.0.0",
    port: intEnv(resolved, "PORT", 3000),
    giteaUrl: normalizeUrl(requireEnv(resolved, "GITEA_URL")),
    giteaToken: requireEnv(resolved, "GITEA_BOT_TOKEN"),
    webhookSecret: requireEnv(resolved, "GITEA_WEBHOOK_SECRET"),
    webhookAuthToken: optionalEnv(resolved, "GITEA_WEBHOOK_AUTH_TOKEN"),
    allowedOrgs: csvEnv(resolved, "GITEA_ALLOWED_ORGS", ["kirmanak"]),
    allowedRepos: csvEnv(resolved, "GITEA_ALLOWED_REPOS"),
    botUsername: optionalEnv(resolved, "BOT_USERNAME", "jumi") ?? "jumi",
    model: optionalEnv(resolved, "OPENCODE_MODEL", "openai/gpt-5.5") ?? "openai/gpt-5.5",
    opencodeConfig: optionalEnv(resolved, "OPENCODE_CONFIG"),
    opencodeWellKnownUrl: optionalEnv(resolved, "OPENCODE_WELLKNOWN_URL", "https://kirmanak.stream"),
    opencodeWellKnownKey:
      optionalEnv(resolved, "OPENCODE_WELLKNOWN_KEY", "OPENCODE_WELLKNOWN_TOKEN") ?? "OPENCODE_WELLKNOWN_TOKEN",
    opencodeWellKnownToken: optionalEnv(resolved, "OPENCODE_WELLKNOWN_TOKEN", "unused") ?? "unused",
    home: optionalEnv(resolved, "HOME", "/data") ?? "/data",
    workdir: optionalEnv(resolved, "WORKDIR", "/work") ?? "/work",
    queueConcurrency: intEnv(resolved, "QUEUE_CONCURRENCY", 1),
    maxOutputBytes: intEnv(resolved, "MAX_OUTPUT_BYTES", 80_000),
    maxWebhookBytes: intEnv(resolved, "MAX_WEBHOOK_BYTES", 1_048_576),
    opencodeTimeoutMs,
    scanIntervalMs: intEnv(resolved, "WORKER_SCAN_INTERVAL_MS", 5 * 60 * 1000),
    databaseUrl: optionalEnv(resolved, "DATABASE_URL"),
    leaseMs: intEnv(resolved, "LEASE_MS", opencodeTimeoutMs + 10 * 60 * 1000),
    maxJobAttempts: intEnv(resolved, "MAX_JOB_ATTEMPTS", 2),
  };
}
