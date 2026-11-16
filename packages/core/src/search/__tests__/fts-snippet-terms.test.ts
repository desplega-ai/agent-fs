import { describe, test, expect } from "bun:test";
import { plainSnippet } from "../fts.js";

// A document over the FTS5 snippet threshold whose words never equal a query term.
function document(words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(`w${i.toString(36)}x`);
  return out.join(" ");
}

function orQuery(terms: number, last: string): string {
  const out: string[] = [];
  for (let i = 0; i < terms; i++) out.push(`wq${i.toString(36)}z`);
  out.push(last);
  return out.join(" OR ");
}

describe("plainSnippet with long term lists", () => {
  const content = document(40_000) + " needle";

  test("a short query finds the match at the end of a large document", () => {
    const started = performance.now();
    const s = plainSnippet(content, orQuery(4, "needle"));
    expect(performance.now() - started).toBeLessThan(250);
    expect(s).toContain("<b>needle</b>");
  });

  test("a query with thousands of terms stays bounded in time", () => {
    const started = performance.now();
    plainSnippet(content, orQuery(20_000, "needle"));
    expect(performance.now() - started).toBeLessThan(250);
  });

  test("repeated terms do not grow the work", () => {
    const pattern = Array.from({ length: 20_000 }, () => "wqz").join(" OR ") + " OR needle";
    const started = performance.now();
    const s = plainSnippet(content, pattern);
    expect(performance.now() - started).toBeLessThan(250);
    expect(s).toContain("<b>needle</b>");
  });
});
