export interface EngineRunOptions {
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
  onPid?: (pid: number) => void | Promise<void>;
  logger?: (message: string) => void;
}

export type Engine = (prompt: string, opts: EngineRunOptions) => Promise<string>;

export function resolveEngine(opts: { engine?: Engine; openCodeRunner?: Engine }, fallback: Engine): Engine {
  return opts.engine ?? opts.openCodeRunner ?? fallback;
}
