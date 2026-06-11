import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface OpenCodeWellKnownAuthOptions {
  home: string;
  xdgDataHome?: string;
  url?: string;
  key: string;
  token: string;
  logger?: (message: string) => void;
}

type AuthFile = Record<string, unknown>;

export function opencodeAuthPath(home: string, xdgDataHome?: string): string {
  const dataHome = xdgDataHome || join(home, ".local", "share");
  return join(dataHome, "opencode", "auth.json");
}

async function readAuthFile(path: string): Promise<AuthFile> {
  try {
    const raw = await readFile(path, "utf8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`OpenCode auth file must contain a JSON object: ${path}`);
    }
    return parsed as AuthFile;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return {};
    throw err;
  }
}

async function writeAuthFile(path: string, auth: AuthFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function ensureOpenCodeWellKnownAuth(options: OpenCodeWellKnownAuthOptions): Promise<string | undefined> {
  if (!options.url) return undefined;

  const path = opencodeAuthPath(options.home, options.xdgDataHome);
  const auth = await readAuthFile(path);
  if (auth[options.url] === undefined) {
    auth[options.url] = {
      type: "wellknown",
      key: options.key,
      token: options.token,
    };
    await writeAuthFile(path, auth);
    options.logger?.(`seeded OpenCode well-known auth for ${options.url} at ${path}`);
  } else {
    await chmod(path, 0o600).catch(() => undefined);
    options.logger?.(`OpenCode well-known auth for ${options.url} already present at ${path}`);
  }
  return path;
}
