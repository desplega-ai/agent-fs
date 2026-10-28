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

  test("is appended after the page, whatever </body> it contains", () => {
    const pages = [
      "<body><p>a</p></body></html>\n", // a normal page: the parser moves it into the body
      "<p>fragment</p>",
      '<p>a</p><script>const tag = "</body>"; go(tag)</script><p>after</p>', // in a script string
      "<p>a</p><!-- old footer </body></html> -->", // in a trailing comment
      '<p>a</p><script>const example = "</body><!--";</script><!-- footer -->',
      "",
    ];
    for (const page of pages) expect(dec(injectHtmlCommentOverlay(enc(page)))).toBe(`${page}${SCRIPT}`);
  });

  test("leaves the page's bytes intact", () => {
    const page = enc("<p>Ünïcødé — 日本語 🎉</p></body>");
    const out = injectHtmlCommentOverlay(page);
    expect(out.subarray(0, page.length)).toEqual(page);
    expect(dec(out.subarray(page.length))).toBe(SCRIPT);
  });

  test("is requested only by __afs_comments=1", () => {
    expect(isHtmlCommentsRequested(new URL("http://x/site/t/a.html?__afs_comments=1"))).toBe(true);
    expect(isHtmlCommentsRequested(new URL("http://x/site/t/a.html?x=1&__afs_comments=1"))).toBe(true);
    expect(isHtmlCommentsRequested(new URL("http://x/site/t/a.html"))).toBe(false);
    expect(isHtmlCommentsRequested(new URL("http://x/site/t/a.html?__afs_comments=0"))).toBe(false);
  });
});
