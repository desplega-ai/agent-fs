/**
 * Inline comments on a site page. With `?__afs_comments=1`, `/site` adds this
 * script to an HTML page so the live UI, which frames the page in an opaque
 * origin and cannot read its DOM, can comment on its text over `postMessage`.
 *
 * The script is a text-and-paint layer only: it reports the page's rendered
 * text and the reader's selection as offsets into that text, paints the
 * ranges the parent sends with the CSS Custom Highlight API, and reports
 * clicks and hovers on them by id. Anchoring, the comment form and every API
 * call stay in the parent. It never receives comment bodies or authors, and
 * does nothing until `window.parent` answers its `hello` with `host`.
 *
 * Kept as a string: no backticks or `${` in the body.
 */
export const HTML_COMMENTS_PARAM = "__afs_comments"

export const HTML_COMMENT_OVERLAY = String.raw`(function () {
  "use strict";
  if (window.parent === window || window.__afsComments) return;
  window.__afsComments = true;
  var P = "agent-fs-comments:";
  var MAX_TEXT = 2 * 1024 * 1024;
  var BLOCK = /^(P|H[1-6]|LI|BLOCKQUOTE|PRE|TR|TD|TH|DIV|DT|DD|UL|OL|TABLE|HR|BR|SECTION|ARTICLE|HEADER|FOOTER|MAIN|NAV|ASIDE|FIGURE|FIGCAPTION|DETAILS|SUMMARY)$/;
  var SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|svg|IFRAME|OBJECT|TEXTAREA|SELECT)$/;
  var PICK = "p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,tr";
  var NAMES = { anchored: "afs-comment", moved: "afs-comment-moved", active: "afs-comment-active" };
  var hosted = false, text = "", segs = [], ranges = [], live = [], sent = null, hoverId = null;
  var canPaint = typeof CSS !== "undefined" && CSS.highlights && typeof Highlight !== "undefined";

  function post(type, data) {
    data = data || {};
    data.type = P + type;
    data.v = 1;
    window.parent.postMessage(data, "*");
  }

  // Same rules as the live UI's markdown text space: blocks are separated by
  // one newline, so a selection across paragraphs reads like Selection.toString().
  function build() {
    var t = "", s = [];
    function walk(node) {
      if (node.nodeType === 3) {
        if (node.data) { s.push({ node: node, start: t.length }); t += node.data; }
        return;
      }
      if (node.nodeType !== 1 || SKIP.test(node.tagName) || node.getAttribute("aria-hidden") === "true") return;
      var block = BLOCK.test(node.tagName);
      if (block && t && t.charAt(t.length - 1) !== "\n") t += "\n";
      for (var c = node.firstChild; c; c = c.nextSibling) walk(c);
      if (block && t && t.charAt(t.length - 1) !== "\n") t += "\n";
    }
    if (document.body) walk(document.body);
    text = t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) : t;
    segs = s;
    // The DOM may have changed even when its text did not: repaint on new nodes.
    paint();
  }

  function sendText() {
    var before = text;
    build();
    if (text !== before || sent === null) { sent = text; post("text", { text: text }); }
  }

  function segAt(offset) {
    var lo = 0, hi = segs.length - 1;
    if (hi < 0 || segs[0].start > offset) return -1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (segs[mid].start <= offset) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  function point(offset, isEnd) {
    var i = segAt(offset);
    if (i < 0) return segs.length ? [segs[0].node, 0] : null;
    var seg = segs[i], within = offset - seg.start;
    if (within <= seg.node.data.length) {
      if (isEnd && within === 0 && i > 0) return [segs[i - 1].node, segs[i - 1].node.data.length];
      return [seg.node, within];
    }
    if (isEnd) return [seg.node, seg.node.data.length];
    return segs[i + 1] ? [segs[i + 1].node, 0] : [seg.node, seg.node.data.length];
  }

  function toRange(start, end) {
    var a = point(start, false), b = point(end, true);
    if (!a || !b) return null;
    try {
      var r = document.createRange();
      r.setStart(a[0], a[1]);
      r.setEnd(b[0], b[1]);
      return r;
    } catch (e) { return null; }
  }

  function toOffset(node, offset) {
    for (var i = 0; i < segs.length; i++) {
      if (segs[i].node === node) return segs[i].start + Math.min(offset, node.data.length);
    }
    var probe = document.createRange();
    try { probe.setStart(node, offset); } catch (e) { return null; }
    probe.collapse(true);
    for (var j = 0; j < segs.length; j++) {
      if (probe.comparePoint(segs[j].node, 0) >= 0) return segs[j].start;
    }
    return text.length;
  }

  function paint() {
    live = [];
    var groups = { anchored: [], moved: [], active: [] };
    for (var i = 0; i < ranges.length; i++) {
      var r = ranges[i], range = toRange(r.start, r.end);
      if (!range) continue;
      live.push({ id: r.id, range: range, len: r.end - r.start });
      groups[r.state].push(range);
    }
    if (!canPaint) return;
    for (var k in NAMES) {
      var hl = new Highlight();
      for (var n = 0; n < groups[k].length; n++) hl.add(groups[k][n]);
      if (k === "active") hl.priority = 1;
      CSS.highlights.set(NAMES[k], hl);
    }
  }

  function hit(x, y) {
    var best = null, bestLen = Infinity;
    for (var i = 0; i < live.length; i++) {
      if (live[i].len >= bestLen) continue;
      var rects = live[i].range.getClientRects();
      for (var j = 0; j < rects.length; j++) {
        var b = rects[j];
        if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) { best = live[i].id; bestLen = live[i].len; break; }
      }
    }
    return best;
  }

  var selShown = false;
  function clearProposal() {
    if (selShown) { selShown = false; post("selection", { cleared: true }); }
  }

  // Propose [start, end) of the page text for a comment; text before offsets.
  function propose(start, end, box) {
    if (start === null || end === null || end <= start || !text.slice(start, end).trim()) return false;
    if (text !== sent) { sent = text; post("text", { text: text }); }
    var b = box.getBoundingClientRect();
    selShown = true;
    post("selection", { start: start, end: end, rect: { left: b.left, top: b.top, width: b.width, height: b.height } });
    return true;
  }

  function reportSelection() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return clearProposal();
    build();
    var range = sel.getRangeAt(0);
    propose(toOffset(range.startContainer, range.startOffset), toOffset(range.endContainer, range.endOffset), range);
  }

  function onMessage(e) {
    if (e.source !== window.parent || !e.data || typeof e.data.type !== "string" || e.data.v !== 1) return;
    var d = e.data, type = d.type.slice(P.length);
    if (d.type.indexOf(P) !== 0) return;
    if (type === "host") {
      // Again after a back/forward cache restore: the parent dropped the text.
      if (hosted) { sent = null; return sendText(); }
      hosted = true;
      start();
    } else if (!hosted) {
      return;
    } else if (type === "highlights" && d.ranges && d.ranges.length !== undefined) {
      ranges = [];
      for (var i = 0; i < d.ranges.length && i < 5000; i++) {
        var r = d.ranges[i];
        if (r && typeof r.id === "string" && r.start >= 0 && r.end > r.start && NAMES[r.state]) {
          ranges.push({ id: r.id, start: r.start, end: r.end, state: r.state });
        }
      }
      paint();
    } else if (type === "clear") {
      // The parent closed its comment UI: drop the selection it was for, as the markdown preview does.
      selShown = false;
      var sel = window.getSelection();
      if (sel) sel.removeAllRanges();
    } else if (type === "reveal" && typeof d.id === "string") {
      for (var j = 0; j < live.length; j++) {
        if (live[j].id !== d.id) continue;
        var el = live[j].range.startContainer.parentElement;
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
    }
  }

  var textTimer = 0, selTimer = 0, moveFrame = 0;
  function start() {
    var css = "::highlight(afs-comment){background-color:rgba(234,179,8,.3)}" +
      "::highlight(afs-comment-moved){background-color:rgba(249,115,22,.22);text-decoration:underline wavy rgba(234,88,12,.7)}" +
      "::highlight(afs-comment-active){background-color:rgba(234,179,8,.6)}";
    try {
      var sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = document.adoptedStyleSheets.concat([sheet]);
    } catch (e) { /* no constructable stylesheets: highlights stay unstyled */ }
    sendText();
    new MutationObserver(function () {
      clearTimeout(textTimer);
      textTimer = setTimeout(sendText, 300);
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    function later() { clearTimeout(selTimer); selTimer = setTimeout(reportSelection, 50); }
    document.addEventListener("mouseup", later, true);
    document.addEventListener("keyup", later, true);
    document.addEventListener("selectionchange", function () {
      var sel = window.getSelection();
      if (selShown && (!sel || sel.isCollapsed)) later();
    });
    window.addEventListener("scroll", function () { if (selShown) later(); }, true);
    document.addEventListener("mousemove", function (e) {
      if (moveFrame) return;
      var x = e.clientX, y = e.clientY;
      moveFrame = requestAnimationFrame(function () {
        moveFrame = 0;
        var id = hit(x, y);
        if (id !== hoverId) { hoverId = id; post("hover", { id: id }); }
      });
    }, true);
    document.addEventListener("click", function (e) {
      var sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      var id = hit(e.clientX, e.clientY);
      if (id) return post("activate", { id: id });
      // A click on a block of text selects the whole block, which marks it and
      // proposes it like any selection; textless blocks and controls get nothing.
      var el = e.target && e.target.closest ? e.target.closest(PICK) : null;
      if (!sel || !el || !el.textContent.trim() || e.target.closest("a,button,input,select,textarea,label")) return;
      var range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      clearTimeout(selTimer);
      reportSelection();
    }, true);
    window.addEventListener("pagehide", function () { post("bye"); });
    window.addEventListener("pageshow", function (e) { if (e.persisted) post("hello", { path: location.pathname }); });
  }

  window.addEventListener("message", onMessage);
  post("hello", { path: location.pathname });
})();`

/** Whether a site request asks for the comment overlay. */
export function isHtmlCommentsRequested(url: URL): boolean {
  return url.searchParams.get(HTML_COMMENTS_PARAM) === "1"
}

/**
 * The page with the overlay appended. The HTML parser moves content after
 * `</body>` or `</html>` back into the body, so appending needs no search for
 * the real closing tag (one in a script string or comment would fool it). The
 * page's own bytes are untouched.
 */
export function injectHtmlCommentOverlay(body: Uint8Array): Uint8Array {
  const script = new TextEncoder().encode(`<script>${HTML_COMMENT_OVERLAY}</script>`)
  const out = new Uint8Array(body.length + script.length)
  out.set(body, 0)
  out.set(script, body.length)
  return out
}
