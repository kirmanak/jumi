import { describe, expect, test } from "bun:test";
import { pgTextArrayLiteral, QueueUnavailableError, type SqlClient, wrapClient } from "../src/sql_client.ts";

describe("pgTextArrayLiteral", () => {
  test("formats closed job kinds as a postgres array literal, not a comma-string", () => {
    expect(pgTextArrayLiteral(["review"])).toBe("{review}");
    expect(pgTextArrayLiteral(["implement", "follow-up", "conflict"])).toBe("{implement,follow-up,conflict}");
    expect(pgTextArrayLiteral([])).toBe("{}");
  });

  test("refuses elements that would break the literal", () => {
    expect(() => pgTextArrayLiteral(["review,queued"])).toThrow(/refusing to bind/);
  });
});

describe("wrapClient", () => {
  test("converts JS array binds to text[] literals before unsafe", async () => {
    const captured: { query: string; params?: unknown[] }[] = [];
    const inner: SqlClient = {
      async unsafe(query, params) {
        captured.push({ query, params });
        return [];
      },
      async begin<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
        return fn(inner);
      },
    };
    await wrapClient(inner).unsafe("SELECT kind = ANY($1::text[])", [["review", "implement"]]);
    expect(captured[0]?.params?.[0]).toBe("{review,implement}");
    expect(Array.isArray(captured[0]?.params?.[0])).toBe(false);
  });

  test("wraps unsafe and begin errors as QueueUnavailableError", async () => {
    const inner: SqlClient = {
      async unsafe() {
        throw new Error("connection refused");
      },
      async begin() {
        throw new Error("connection refused");
      },
    };
    const sql = wrapClient(inner);
    await expect(sql.unsafe("SELECT 1")).rejects.toBeInstanceOf(QueueUnavailableError);
    await expect(sql.begin(async () => undefined)).rejects.toBeInstanceOf(QueueUnavailableError);
  });

  test("wraps transaction clients so array binds and errors stay converted", async () => {
    const captured: { query: string; params?: unknown[] }[] = [];
    const inner: SqlClient = {
      async unsafe(query, params) {
        captured.push({ query, params });
        throw Object.assign(new Error("duplicate key"), { code: "23505" });
      },
      async begin<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
        return fn(inner);
      },
    };
    const err = await wrapClient(inner)
      .begin((tx) => tx.unsafe("SELECT kind = ANY($1::text[])", [["review"]]))
      .then(
        () => undefined,
        (caught: unknown) => caught
      );
    expect(err).toBeInstanceOf(QueueUnavailableError);
    expect((err as QueueUnavailableError).cause).toEqual(expect.objectContaining({ code: "23505" }));
    expect(captured[0]?.params?.[0]).toBe("{review}");
  });
});
