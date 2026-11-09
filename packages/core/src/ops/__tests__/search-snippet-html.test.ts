import { describe, expect, test } from "bun:test";
import { createUser } from "../../identity/users.js";
import { setDriveMember } from "../../identity/drives.js";
import { PermissionDeniedError } from "../../errors.js";
import { createTestContext } from "../../test-utils.js";
import { dispatchOp } from "../index.js";
import type { OpContext } from "../types.js";

// Snippets are HTML fragments: document text is escaped and the only markup is
// the <b></b> highlight, so clients can render them as HTML.

const MARKUP = `<img src=x onerror="document.title='marker'">`;

function setup() {
  const base = createTestContext();
  const editor = createUser(base.db, { email: "editor@example.test" });
  const viewer = createUser(base.db, { email: "viewer@example.test" });
  setDriveMember(base.db, { driveId: base.driveId, userId: editor.user.id, role: "editor" });
  setDriveMember(base.db, { driveId: base.driveId, userId: viewer.user.id, role: "viewer" });
  const asEditor: OpContext = { ...base.ctx, userId: editor.user.id };
  const asViewer: OpContext = { ...base.ctx, userId: viewer.user.id };
  return { asEditor, asViewer };
}

/** Markup left after removing the highlight tags. */
function nonHighlightMarkup(snippet: string): boolean {
  return /</.test(snippet.replace(/<\/?b>/g, ""));
}

type FtsOut = { matches: { path: string; snippet: string }[] };
type SearchOut = { results: { path: string; snippet: string }[] };

describe("search snippets are HTML-escaped", () => {
  test("plain text keeps only the <b> highlight", async () => {
    const { asEditor, asViewer } = setup();
    await dispatchOp(asEditor, "write", { path: "/plain.md", content: "alpha beta canary gamma delta" });
    const r = (await dispatchOp(asViewer, "fts", { pattern: "canary" })) as FtsOut;
    expect(r.matches.length).toBe(1);
    expect(r.matches[0].snippet).toBe("alpha beta <b>canary</b> gamma delta");
  });

  test("viewer cannot write", async () => {
    const { asViewer } = setup();
    await expect(dispatchOp(asViewer, "write", { path: "/x.md", content: "x" })).rejects.toThrow(
      PermissionDeniedError
    );
  });

  test("fts snippet of a small document (FTS5 snippet())", async () => {
    const { asEditor, asViewer } = setup();
    await dispatchOp(asEditor, "write", {
      path: "/canary.md",
      content: `alpha beta canary ${MARKUP} gamma & delta`,
    });
    const r = (await dispatchOp(asViewer, "fts", { pattern: "canary" })) as FtsOut;
    expect(r.matches.length).toBe(1);
    const snippet = r.matches[0].snippet;
    expect(nonHighlightMarkup(snippet)).toBe(false);
    expect(snippet).toContain("<b>canary</b>");
    expect(snippet).toContain("&lt;img src=x onerror=&quot;document.title=&#39;marker&#39;&quot;&gt;");
    expect(snippet).toContain("gamma &amp; delta");
  });

  test("fts snippet of a document over 32 KiB (plainSnippet)", async () => {
    const { asEditor, asViewer } = setup();
    const filler = "lorem ipsum dolor sit amet ".repeat(1400);
    await dispatchOp(asEditor, "write", {
      path: "/big.md",
      content: `${filler}canary ${MARKUP} tail words ${filler}`,
    });
    const r = (await dispatchOp(asViewer, "fts", { pattern: "canary" })) as FtsOut;
    expect(r.matches.length).toBe(1);
    const snippet = r.matches[0].snippet;
    expect(nonHighlightMarkup(snippet)).toBe(false);
    expect(snippet).toContain("<b>canary</b> &lt;img");
  });

  test("hybrid search snippet", async () => {
    const { asEditor, asViewer } = setup();
    await dispatchOp(asEditor, "write", {
      path: "/canary.md",
      content: `alpha beta canary ${MARKUP} gamma delta`,
    });
    const r = (await dispatchOp(asViewer, "search", { query: "canary" })) as SearchOut;
    expect(r.results.length).toBe(1);
    const snippet = r.results[0].snippet;
    expect(nonHighlightMarkup(snippet)).toBe(false);
    expect(snippet).toContain("&lt;img");
  });
});
