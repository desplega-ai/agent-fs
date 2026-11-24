import { appendScript } from "./html-comment-overlay.js"

/**
 * Links on a site page that the live UI shows in a frame. The frame's sandbox
 * has no `allow-top-navigation`, so a plain link that leaves the shared folder
 * loads inside the frame: the live UI itself, which cannot start without
 * storage, or a site that refuses to be framed. `/site` adds this script to an
 * HTML page that may load in a frame. Once `window.parent` answers its `hello`
 * with `host`, a plain left click on such a link is cancelled and its address
 * is posted to the parent, which opens it in the app or in a new tab. A page
 * outside a frame, or under a parent that never answers (such as another site
 * framing a public link), keeps its links as they were.
 *
 * Links inside the folder, links with any target (`_self` and empty ones too,
 * also from `<base target>`), downloads, clicks with a modifier key and clicks
 * the page already handled are left to the browser.
 *
 * Kept as a string: no backticks or `${` in the body. Called with the share's
 * path, `/site/<token>/`.
 */
export const HTML_LINK_HANDLER = String.raw`(function (root) {
  "use strict";
  if (window.parent === window || window.__afsLinks) return;
  var at = location.pathname.indexOf(root);
  if (at < 0) return;
  window.__afsLinks = true;
  var P = "agent-fs-links:", hosted = false;
  var sharePrefix = location.origin + location.pathname.slice(0, at + root.length);

  window.addEventListener("message", function (e) {
    if (e.source === window.parent && e.data && e.data.v === 1 && e.data.type === P + "host") hosted = true;
  });

  window.addEventListener("click", function (e) {
    if (!hosted || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest("a[href],area[href]") : null;
    if (!a || a.hasAttribute("download")) return;
    if (a.hasAttribute("target") || document.querySelector("base[target]")) return;
    var url;
    try { url = new URL(a.getAttribute("href"), document.baseURI); } catch (err) { return; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    if ((url.origin + url.pathname).indexOf(sharePrefix) === 0) return;
    e.preventDefault();
    window.parent.postMessage({ type: P + "navigate", v: 1, href: url.href }, "*");
  });

  window.parent.postMessage({ type: P + "hello", v: 1 }, "*");
})`

/**
 * Whether a request may load the page into a frame: every request whose
 * `Sec-Fetch-Dest` header names no other destination. Browsers send that
 * header only to HTTPS and localhost, so a frame on a plain-HTTP server
 * elsewhere arrives without it.
 */
export function mayLoadInFrame(headers: Headers): boolean {
  const dest = headers.get("sec-fetch-dest")
  return dest === null || dest === "iframe" || dest === "frame"
}

/** The page with the link handler for the share at `sharePath` (`/site/<token>/`) appended. */
export function injectHtmlLinkHandler(body: Uint8Array, sharePath: string): Uint8Array {
  return appendScript(body, `${HTML_LINK_HANDLER}(${JSON.stringify(sharePath)});`)
}
