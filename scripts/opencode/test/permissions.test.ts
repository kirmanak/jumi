import { describe, expect, test } from "bun:test";
import { hasWriteAccess, hasWritePermission, trustedWriteLogins } from "../src/permissions.ts";

describe("hasWritePermission", () => {
  test("allows write, admin, owner, and maintain/push role names", () => {
    expect(hasWritePermission("write")).toBe(true);
    expect(hasWritePermission("admin")).toBe(true);
    expect(hasWritePermission("owner")).toBe(true);
    expect(hasWritePermission("WRITE")).toBe(true);
    expect(hasWritePermission("read", "maintain")).toBe(true);
    expect(hasWritePermission("read", "push")).toBe(true);
    expect(hasWritePermission("write", "read")).toBe(true);
  });

  test("denies read, triage, none, and unknown", () => {
    expect(hasWritePermission("read")).toBe(false);
    expect(hasWritePermission("none")).toBe(false);
    expect(hasWritePermission("read", "triage")).toBe(false);
    expect(hasWritePermission("read", "read")).toBe(false);
    expect(hasWritePermission(undefined)).toBe(false);
    expect(hasWritePermission("", "")).toBe(false);
    expect(hasWritePermission("custom", "custom")).toBe(false);
  });
});

describe("hasWriteAccess", () => {
  test("fail-closes when the API is missing or throws", async () => {
    expect(await hasWriteAccess(undefined, "o", "r", "alice")).toBe(false);
    expect(await hasWriteAccess({}, "o", "r", "alice")).toBe(false);
    expect(
      await hasWriteAccess(
        {
          getCollaboratorPermission: async () => {
            throw new Error("forge 500");
          },
        },
        "o",
        "r",
        "alice"
      )
    ).toBe(false);
    expect(
      await hasWriteAccess(
        { getCollaboratorPermission: async () => ({ permission: "write" }) },
        "o",
        "r",
        undefined
      )
    ).toBe(false);
  });

  test("uses collaborator permission, not org membership", async () => {
    const api = {
      getCollaboratorPermission: async (_o: string, _r: string, username: string) =>
        username === "alice" ? { permission: "write" } : { permission: "read" },
    };
    expect(await hasWriteAccess(api, "o", "r", "alice")).toBe(true);
    expect(await hasWriteAccess(api, "o", "r", "mallory")).toBe(false);
  });
});

describe("trustedWriteLogins", () => {
  test("returns only writers, lower-cased and de-duplicated", async () => {
    const api = {
      getCollaboratorPermission: async (_o: string, _r: string, username: string) =>
        username.toLowerCase() === "alice" ? { permission: "write" } : { permission: "read" },
    };
    const trusted = await trustedWriteLogins(api, "o", "r", ["Alice", "ALICE", "mallory", undefined, ""]);
    expect([...trusted].sort()).toEqual(["alice"]);
  });
});
