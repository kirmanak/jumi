import { describe, expect, test } from "bun:test";
import { byteLength, formatBytes, logDiagnostic } from "../src/diagnostics.ts";

describe("diagnostics helpers", () => {
  test("byteLength counts UTF-8 bytes", () => {
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("й")).toBe(2);
  });

  test("formatBytes is human-readable", () => {
    expect(formatBytes(null)).toBe("n/a");
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(2048)).toBe("2.0KiB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.00MiB");
  });

  test("logDiagnostic emits flat secret-free lines", () => {
    const lines: string[] = [];
    logDiagnostic((m) => lines.push(m), "opencode_sample", {
      review: "personal/jumi#1",
      child_rss_bytes: 123,
      missing: undefined,
      empty: null,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[diag] event=opencode_sample");
    expect(lines[0]).toContain("review=personal/jumi#1");
    expect(lines[0]).toContain("child_rss_bytes=123");
    expect(lines[0]).toContain("empty=null");
    expect(lines[0]).not.toContain("missing=");
  });
});
