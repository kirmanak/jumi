import { runClaude } from "./claude.ts";
import { type Engine, EngineFailedError, type EngineResult, type EngineRunOptions } from "./engine.ts";
import { runOpenCode } from "./git.ts";
import { CLAUDE_RUNNER_TYPE, OPENCODE_RUNNER_TYPE } from "./runners.ts";

export async function runRegisteredEngine(opts: EngineRunOptions): Promise<EngineResult> {
  const type = opts.type ?? OPENCODE_RUNNER_TYPE;
  if (type === CLAUDE_RUNNER_TYPE) return runClaude(opts);
  if (type === OPENCODE_RUNNER_TYPE) return runOpenCode(opts);
  throw new EngineFailedError(`Unknown runner type: ${type}`, false);
}

export const registeredEngine: Engine = runRegisteredEngine;
