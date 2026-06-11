import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureOpenCodeWellKnownAuth, opencodeAuthPath } from "../src/opencode_auth.ts";

const tempDirs: string[] = [];

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jumi-opencode-auth-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("OpenCode well-known auth seeding", () => {
  test("uses OpenCode's default HOME data path", () => {
    expect(opencodeAuthPath("/data")).toBe("/data/.local/share/opencode/auth.json");
  });

  test("uses XDG_DATA_HOME when provided", () => {
    expect(opencodeAuthPath("/data", "/xdg-data")).toBe("/xdg-data/opencode/auth.json");
  });

  test("creates a missing auth file with the well-known entry", async () => {
    const home = await tempHome();
    const path = await ensureOpenCodeWellKnownAuth({
      home,
      url: "https://kirmanak.stream",
      key: "OPENCODE_WELLKNOWN_TOKEN",
      token: "unused",
    });

    const auth = JSON.parse(await readFile(path!, "utf8"));
    expect(auth["https://kirmanak.stream"]).toEqual({
      type: "wellknown",
      key: "OPENCODE_WELLKNOWN_TOKEN",
      token: "unused",
    });
    expect((await stat(path!)).mode & 0o777).toBe(0o600);
  });

  test("preserves existing auth providers while adding the remote config entry", async () => {
    const home = await tempHome();
    const path = opencodeAuthPath(home);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify({ openai: { type: "oauth", refresh: "keep-me" } }));

    await ensureOpenCodeWellKnownAuth({
      home,
      url: "https://kirmanak.stream",
      key: "OPENCODE_WELLKNOWN_TOKEN",
      token: "unused",
    });

    const auth = JSON.parse(await readFile(path, "utf8"));
    expect(auth.openai).toEqual({ type: "oauth", refresh: "keep-me" });
    expect(auth["https://kirmanak.stream"].type).toBe("wellknown");
  });

  test("does not overwrite an existing well-known entry", async () => {
    const home = await tempHome();
    const path = opencodeAuthPath(home);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        "https://kirmanak.stream": { type: "wellknown", key: "CUSTOM_TOKEN", token: "custom" },
      })
    );

    await ensureOpenCodeWellKnownAuth({
      home,
      url: "https://kirmanak.stream",
      key: "OPENCODE_WELLKNOWN_TOKEN",
      token: "unused",
    });

    const auth = JSON.parse(await readFile(path, "utf8"));
    expect(auth["https://kirmanak.stream"]).toEqual({ type: "wellknown", key: "CUSTOM_TOKEN", token: "custom" });
  });
});
