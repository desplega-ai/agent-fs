import { describe, test, expect } from "bun:test";
import { HTML_LINK_HANDLER, injectHtmlLinkHandler, isFrameRequest } from "../share/html-link-handler.js";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const SHARE = "/site/abc_DEF-123/";
const SCRIPT = `<script>${HTML_LINK_HANDLER}("/site/abc_DEF-123/");</script>`;

describe("html link handler", () => {
  test("is a script that parses and cannot close its own tag", () => {
    expect(() => new Function(`${HTML_LINK_HANDLER}("/site/t/");`)).not.toThrow();
    expect(HTML_LINK_HANDLER.toLowerCase()).not.toContain("</script");
    expect(HTML_LINK_HANDLER).not.toContain("<!--");
  });

  test("is appended after the page with its share path, leaving the page's bytes intact", () => {
    for (const page of ["<body><p>a</p></body></html>\n", "<p>Ünïcødé 日本語</p>", ""]) {
      const out = injectHtmlLinkHandler(enc(page), SHARE);
      expect(out.subarray(0, enc(page).length)).toEqual(enc(page));
      expect(dec(out)).toBe(`${page}${SCRIPT}`);
    }
  });

  test("is for frame loads only", () => {
    const req = (dest?: string) => new Headers(dest ? { "Sec-Fetch-Dest": dest } : {});
    expect(isFrameRequest(req("iframe"))).toBe(true);
    expect(isFrameRequest(req("frame"))).toBe(true);
    for (const dest of ["document", "empty", "script", "object", "embed", undefined]) {
      expect(isFrameRequest(req(dest)), String(dest)).toBe(false);
    }
  });
});
