import { describe, expect, test } from "bun:test";
import { stripBase64 } from "../strip-base64.js";

const payload = "Ab09+/_-".repeat(125);

describe("stripBase64", () => {
  test.each([
    ['<img src="data:image/png;base64,', '">caption'],
    ["body { background: url(data:image/png;base64,", "); }"],
    ['<image href="data:image/svg+xml;base64,', '"/>'],
    ["![caption](data:image/png;base64,", ")"],
    ["data:text/plain;charset=utf-8;base64,", ""],
  ])("strips data URI payloads in %s", (before, after) => {
    expect(stripBase64(before + payload + after)).toBe(before + "[omitted]" + after);
  });

  test("includes the 100-character data URI boundary and preserves shorter payloads", () => {
    const short = `data:image/png;base64,${"A".repeat(99)}`;
    const boundary = `data:image/png;base64,${"A".repeat(100)}`;
    expect(stripBase64(`${short} ${boundary} ${boundary}`))
      .toBe(`${short} data:image/png;base64,[omitted] data:image/png;base64,[omitted]`);
  });

  test("strips bare runs at 1000 characters with either base64 alphabet and padding", () => {
    for (const run of [payload + "==", "A".repeat(1000), "ab09-_".repeat(200)]) {
      expect(stripBase64(`before: ${run} after.`)).toBe("before: [base64 omitted] after.");
    }
  });

  test("preserves a 900-character run, hashes and normal long words", () => {
    const text = [
      payload.slice(0, 900),
      "a7d9f03c".repeat(8),
      "pneumonoultramicroscopicsilicovolcanoconiosis",
      "antidisestablishmentarianism",
    ].join(" ");
    expect(stripBase64(text)).toBe(text);
  });

  test("preserves multiline PEM blocks", () => {
    const pem = `-----BEGIN CERTIFICATE-----\n${(payload.slice(0, 64) + "\n").repeat(30)}-----END CERTIFICATE-----`;
    expect(stripBase64(pem)).toBe(pem);
  });

  // Both inputs take a few milliseconds in linear time and seconds in quadratic time.
  test("scans many runs just under the limit in linear time", () => {
    const text = `${"A".repeat(999)} `.repeat(2000);
    const started = performance.now();
    expect(stripBase64(text)).toBe(text);
    expect(performance.now() - started).toBeLessThan(200);
  });

  test("scans many data URI prefixes without a payload in linear time", () => {
    const text = "data:".repeat(100000);
    const started = performance.now();
    expect(stripBase64(text)).toBe(text);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
