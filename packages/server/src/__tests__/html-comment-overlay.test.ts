import { describe, test, expect } from "bun:test";
import {
  HTML_COMMENT_OVERLAY,
  injectHtmlCommentOverlay,
  isHtmlCommentsRequested,
} from "../share/html-comment-overlay.js";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const SCRIPT = `<script>${HTML_COMMENT_OVERLAY}</script>`;

describe("html comment overlay", () => {
  test("is a script that parses and cannot close its own tag", () => {
    expect(() => new Function(HTML_COMMENT_OVERLAY)).not.toThrow();
    expect(HTML_COMMENT_OVERLAY.toLowerCase()).not.toContain("</script");
    expect(HTML_COMMENT_OVERLAY).not.toContain("<!--");
  });

  test("goes before the last </body>, matched case-insensitively", () => {
    const out = dec(injectHtmlCommentOverlay(enc("<body><p>a</p><!-- </body> --></BODY ></html>")));
    expect(out).toBe(`<body><p>a</p><!-- </body> -->${SCRIPT}</BODY ></html>`);
  });

  test("is appended when the page has no </body>", () => {
    expect(dec(injectHtmlCommentOverlay(enc("<p>fragment</p>")))).toBe(`<p>fragment</p>${SCRIPT}`);
    expect(dec(injectHtmlCommentOverlay(new Uint8Array()))).toBe(SCRIPT);
  });

  test("leaves non-ASCII bytes around it intact", () => {
    const page = enc("<p>Ünïcødé — 日本語 🎉</p></body>");
    const out = injectHtmlCommentOverlay(page);
    const cut = page.length - "</body>".length;
    expect(out.subarray(0, cut)).toEqual(page.subarray(0, cut));
    expect(out.subarray(out.length - 7)).toEqual(enc("</body>"));
    expect(dec(out)).toBe(`<p>Ünïcødé — 日本語 🎉</p>${SCRIPT}</body>`);
  });

  test("is requested only by __afs_comments=1", () => {
    expect(isHtmlCommentsRequested(new URL("http://x/site/t/a.html?__afs_comments=1"))).toBe(true);
    expect(isHtmlCommentsRequested(new URL("http://x/site/t/a.html?x=1&__afs_comments=1"))).toBe(true);
    expect(isHtmlCommentsRequested(new URL("http://x/site/t/a.html"))).toBe(false);
    expect(isHtmlCommentsRequested(new URL("http://x/site/t/a.html?__afs_comments=0"))).toBe(false);
  });
});
