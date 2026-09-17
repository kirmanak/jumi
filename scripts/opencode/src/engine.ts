export type TraceKind = "review" | "implement" | "follow-up" | "conflict";

export interface TraceContext {
  kind: TraceKind;
  owner: string;
  repo: string;
  sha?: string;
  jobId?: string;
}

export interface EngineRunOptions {
  type?: "opencode" | "claude";
  model: string;
  variant?: string;
  effort?: string;
  workdir: string;
  home?: string;
  sanitizeEnv?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  reviewLabel?: string;
  memorySampleIntervalMs?: number;
  /** Interval for the live per-run log-file quota poll. Defaults to QUOTA_POLL_INTERVAL_MS; 0 disables. */
  quotaPollIntervalMs?: number;
  extraEnv?: Record<string, string>;
  abortSignal?: AbortSignal;
  onPid?: (pid: number) => void | Promise<void>;
  logger?: (message: string) => void;
  trace?: TraceContext;
  prompt?: string;
  continueSession?: boolean;
  hop?: boolean;
}

export type EngineStatus = "ok" | "timeout" | "exit" | "stuck";

export type QuotaClass = "resetting" | "hard";

export interface EngineResult {
  status: EngineStatus;
  exitCode?: number | null;
  stdout?: string;
  message?: string;
  infra?: boolean;
  auth?: boolean;
  durationMs?: number;
  quota?: QuotaClass;
  retryAfterMs?: number;
}

export type Engine = (opts: EngineRunOptions) => Promise<EngineResult>;

export class EngineFailedError extends Error {
  readonly infra: boolean;
  readonly auth: boolean;
  readonly quota?: QuotaClass;
  readonly retryAfterMs?: number;

  constructor(message: string, infra = false, extras?: { quota?: QuotaClass; retryAfterMs?: number; auth?: boolean }) {
    super(message);
    this.name = "EngineFailedError";
    this.auth = extras?.auth === true;
    this.infra = this.auth ? false : infra;
    if (extras?.quota) this.quota = extras.quota;
    if (extras?.retryAfterMs != null) this.retryAfterMs = extras.retryAfterMs;
  }
}

export function resolveEngine(opts: { engine?: Engine; openCodeRunner?: Engine }, fallback: Engine): Engine {
  return opts.engine ?? opts.openCodeRunner ?? fallback;
}

export function throwIfEngineFailed(result: EngineResult): void {
  if (result.status === "ok") return;
  throw new EngineFailedError(result.message ?? `engine ${result.status}`, result.infra === true, {
    quota: result.quota,
    retryAfterMs: result.retryAfterMs,
    auth: result.auth === true,
  });
}
