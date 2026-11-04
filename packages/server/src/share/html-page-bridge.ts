/**
 * `window.agentfs` for a site page framed by a host (the live UI). With
 * `?__afs_page=1`, `/site` adds this script to an HTML page. The flag
 * authorises nothing: the script only asks `window.parent` for a
 * `MessagePort`, and every request runs on that port in the host, which holds
 * the credential, picks the folder and decides what is allowed. The port
 * lives in this document only: the page proves it is the document that said
 * hello by acking with its nonce, and says bye when it unloads.
 *
 * Kept as a string: no backticks or `${` in the body.
 */
export const HTML_PAGE_PARAM = "__afs_page"

export const HTML_PAGE_BRIDGE = String.raw`(function () {
  "use strict";
  if (window.parent === window || window.agentfs) return;
  var P = "agent-fs-page:";
  var MAX_IN_FLIGHT = 16, MAX_BYTES = 1024 * 1024;
  var port = null, nextId = 1, inFlight = 0, pending = {}, viewer = null, onReady;
  var ready = new Promise(function (resolve) { onReady = resolve; });
  var bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  var nonce = Array.prototype.map.call(bytes, function (b) { return (b + 256).toString(16).slice(1); }).join("");

  function failure(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  function call(op, params) {
    if (!port) return Promise.reject(failure("NOT_ALLOWED", "agentfs is not ready: await agentfs.ready first"));
    if (inFlight >= MAX_IN_FLIGHT) return Promise.reject(failure("NOT_ALLOWED", "Too many agentfs requests in flight"));
    var msg = { id: nextId++, op: op };
    for (var k in params) msg[k] = params[k];
    var size;
    try { size = new TextEncoder().encode(JSON.stringify(msg)).length; } catch (e) { return Promise.reject(failure("VALIDATION_ERROR", "Request is not serializable")); }
    if (size > MAX_BYTES) return Promise.reject(failure("NOT_ALLOWED", "Request is larger than 1 MB"));
    return new Promise(function (resolve, reject) {
      try { port.postMessage(msg); } catch (e) { return reject(failure("VALIDATION_ERROR", "Request is not serializable")); }
      inFlight++;
      pending[msg.id] = { resolve: resolve, reject: reject };
    });
  }

  function onReply(e) {
    var d = e.data;
    if (!d || typeof d !== "object" || !pending[d.id]) return;
    var p = pending[d.id];
    delete pending[d.id];
    inFlight--;
    if (d.error && typeof d.error === "object") p.reject(failure(String(d.error.code), String(d.error.message)));
    else p.resolve(d.result);
  }

  function onHost(e) {
    var d = e.data;
    if (port || e.source !== window.parent || !d || d.type !== P + "host" || d.v !== 1 || !e.ports || e.ports.length !== 1) return;
    port = e.ports[0];
    port.onmessage = onReply;
    port.postMessage({ type: P + "ack", nonce: nonce });
    window.removeEventListener("message", onHost);
    onReady();
  }

  window.addEventListener("pagehide", function () {
    if (!port) return;
    port.postMessage({ type: P + "bye" });
    port.close();
    port = null;
    for (var id in pending) pending[id].reject(failure("NOT_ALLOWED", "The page was unloaded"));
    pending = {};
    inFlight = 0;
  });

  function snapshot(v) {
    return v ? Object.freeze({ name: v.name, email: v.email, kind: v.kind }) : null;
  }

  window.agentfs = Object.freeze({
    ready: ready,
    requestIdentity: function () {
      return call("identity", {}).then(function (v) { viewer = snapshot(v); return viewer; });
    },
    me: function () { return viewer; },
    read: function (path) { return call("read", { path: path }); },
    stat: function (path) { return call("stat", { path: path }); },
    write: function (path, content, options) {
      options = options || {};
      return call("write", { path: path, content: content, expectedVersion: options.expectedVersion, message: options.message });
    }
  });

  window.addEventListener("message", onHost);
  window.parent.postMessage({ type: P + "hello", v: 1, nonce: nonce }, "*");
})();`

/** Whether a site request asks for the page bridge. */
export function isHtmlPageRequested(url: URL): boolean {
  return url.searchParams.get(HTML_PAGE_PARAM) === "1"
}

// Searched in the bytes read as Latin-1, which keeps byte offsets. `head` and
// `html` must be whole tag names (`<header>` is not `<head>`).
const INSERT_AFTER = [/<head(?=[\s/>])[^>]*>/i, /<html(?=[\s/>])[^>]*>/i, /<!doctype[^>]*>/i]

/**
 * The page with the bridge inserted before any of its own scripts: right
 * after `<head …>`, else after `<html …>`, else after the doctype, else at the
 * top. The page's own bytes are otherwise untouched.
 */
export function injectHtmlPageBridge(body: Uint8Array): Uint8Array {
  const text = Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("latin1")
  let at = 0
  for (const tag of INSERT_AFTER) {
    const m = tag.exec(text)
    if (m) {
      at = m.index + m[0].length
      break
    }
  }
  const script = new TextEncoder().encode(`<script>${HTML_PAGE_BRIDGE}</script>`)
  const out = new Uint8Array(body.length + script.length)
  out.set(body.subarray(0, at), 0)
  out.set(script, at)
  out.set(body.subarray(at), at + script.length)
  return out
}
