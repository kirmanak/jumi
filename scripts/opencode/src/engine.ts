export type TraceKind = "review" | "implement" | "follow-up" | "conflict";

export interface TraceContext {
  kind: TraceKind;
  owner: string;
  repo: string;
  sha?: string;
  jobId?: string;
}

export interface EngineRunOptions {
  prompt: string;
  model: string;
  workdir: string;
  configPath?: string;
  home?: string;
  sanitizeEnv?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  reviewLabel?: string;
  memorySampleIntervalMs?: number;
  extraEnv?: Record<string, string>;
  abortSignal?: AbortSignal;
  onPid?: (pid: number) => void | Promise<void>;
  logger?: (message: string) => void;
  trace?: TraceContext;
}

export type EngineStatus = "ok" | "timeout" | "exit" | "stuck";

export interface EngineResult {
  status: EngineStatus;
  exitCode?: number | null;
  stdout?: string;
  message?: string;
}

export type Engine = (opts: EngineRunOptions) => Promise<EngineResult>;

export function resolveEngine(opts: { engine?: Engine; openCodeRunner?: Engine }, fallback: Engine): Engine {
  return opts.engine ?? opts.openCodeRunner ?? fallback;
}

export function throwIfEngineFailed(result: EngineResult): void {
  if (result.status === "ok") return;
  throw new Error(result.message ?? `engine ${result.status}`);
}
