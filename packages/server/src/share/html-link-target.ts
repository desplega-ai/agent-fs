import { appendScript } from "./html-comment-overlay.js"

/**
 * Links on a site page shown in a frame, such as the live UI's HTML viewer.
 * The site's sandbox has no `allow-top-navigation`, so a plain link that
 * leaves the shared folder loads inside the frame: the live UI, which cannot
 * start there without storage, or a site that refuses to be framed. The
 * sandbox already lets popups escape it, so when such a link is clicked this
 * script gives it `target="_blank"` and the browser opens it in a new tab.
 * The page gains nothing it could not already do itself.
 *
 * Links inside the shared folder, links that already have a target (also from
 * `<base target>`), downloads, clicks the page cancels and pages outside a
 * frame are left as they are.
 *
 * Kept as a string: no backticks or `${` in the body. Called with the share's
 * path, `/site/<token>/`.
 */
export const HTML_LINK_TARGET = String.raw`(function (root) {
  "use strict";
  if (window.parent === window) return;
  var at = location.pathname.indexOf(root);
  if (at < 0) return;
  var folder = location.origin + location.pathname.slice(0, at + root.length);
  // In the bubble phase, after the page's own handlers, so the link is judged as they left it.
  window.addEventListener("click", function (e) {
    if (e.defaultPrevented) return;
    var a = e.target && e.target.closest ? e.target.closest("a[href],area[href]") : null;
    if (!a || a.hasAttribute("target") || a.hasAttribute("download") || document.querySelector("base[target]")) return;
    var url;
    try { url = new URL(a.href); } catch (err) { return; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    if ((url.origin + url.pathname).indexOf(folder) === 0) return;
    // The browser follows the link right after this event; then the link is as it was.
    a.target = "_blank";
    setTimeout(function () { if (a.getAttribute("target") === "_blank") a.removeAttribute("target"); });
  });
})`

/**
 * Whether the browser loads the page into a frame. Browsers send
 * `Sec-Fetch-Dest` only to HTTPS and localhost; any other request, a page
 * opened on its own included, gets the stored bytes.
 */
export function isFrameRequest(headers: Headers): boolean {
  const dest = headers.get("sec-fetch-dest")
  return dest === "iframe" || dest === "frame"
}

/** The page with the link script for the share at `sharePath` (`/site/<token>/`) appended. */
export function injectHtmlLinkTarget(body: Uint8Array, sharePath: string): Uint8Array {
  return appendScript(body, `${HTML_LINK_TARGET}(${JSON.stringify(sharePath)});`)
}
