import { describe, test, expect } from "bun:test";
import { resolveSinceDuration } from "../commands/ops.js";

/**
 * `agent-fs recent --since <duration>` advertises a relative shorthand (1h, 24h,
 * 7d). The server coerces `since` to a Date, so `new Date("1h")` is invalid and
 * the request 400s. resolveSinceDuration() translates the shorthand to an
 * absolute ISO timestamp client-side while leaving real dates untouched.
 */
describe("resolveSinceDuration", () => {
  test("translates hour shorthand to an ISO timestamp ~that long ago", () => {
    const before = Date.now();
    const iso = resolveSinceDuration("1h");
    const after = Date.now();
    const t = Date.parse(iso);
    expect(Number.isNaN(t)).toBe(false);
    // Should be roughly one hour before now (allow slop for the two Date.now calls).
    expect(after - 3_600_000 - t).toBeGreaterThanOrEqual(-5);
    expect(before - 3_600_000 - t).toBeLessThanOrEqual(5);
  });

  test("supports s/m/h/d/w units and a multi-digit amount", () => {
    const now = Date.now();
    const cases: Array<[string, number]> = [
      ["30s", 30_000],
      ["15m", 15 * 60_000],
      ["24h", 24 * 3_600_000],
      ["7d", 7 * 86_400_000],
      ["2w", 2 * 604_800_000],
    ];
    for (const [input, ms] of cases) {
      const t = Date.parse(resolveSinceDuration(input));
      expect(Math.abs(now - ms - t)).toBeLessThanOrEqual(1000);
    }
  });

  test("is case-insensitive and tolerates inner whitespace", () => {
    const a = Date.parse(resolveSinceDuration("1H"));
    const b = Date.parse(resolveSinceDuration("1 h"));
    expect(Number.isNaN(a)).toBe(false);
    expect(Number.isNaN(b)).toBe(false);
  });

  test("passes ISO timestamps through unchanged", () => {
    const iso = "2026-06-10T18:19:06.068Z";
    expect(resolveSinceDuration(iso)).toBe(iso);
  });

  test("passes non-duration / unknown-unit tokens through unchanged", () => {
    // Unknown unit, bare number, and date-like strings must not be rewritten —
    // the server's z.coerce.date() still gets the original value.
    expect(resolveSinceDuration("1y")).toBe("1y");
    expect(resolveSinceDuration("1700000000000")).toBe("1700000000000");
    expect(resolveSinceDuration("2026-06-10")).toBe("2026-06-10");
    expect(resolveSinceDuration("yesterday")).toBe("yesterday");
  });
});
