import { createHash } from "node:crypto";
import { PAGE_MAX_IN_FLIGHT, PAGE_MAX_MESSAGE_BYTES, PAGE_MESSAGE_PREFIX } from "./html-page-protocol.js";
import { escapeHtml, HTML_SANDBOX } from "./render.js";

/**
 * The host page of a writable share (`/page/<token>/…`): it frames the
 * folder's page from `/site/<token>/…?__afs_page=1` and serves the page
 * protocol the way the live app's host does (`live/src/lib/html-page-bridge.ts`;
 * keep the two in step). The guest's identity is an HttpOnly cookie the shell
 * never sees: it asks `me`, shows the name and email dialog when there is
 * none, and forwards `read`, `stat` and `write` to `ops`, where the server
 * checks the cookie, the paths and the limits. Every URL is relative to the
 * shell's own `/page/<token>/`, so the script holds no token and is static.
 *
 * Kept as a string: no backticks or `${` in the body, other than the shared
 * protocol constants.
 */
export const HTML_PAGE_SHELL = String.raw`(function () {
  "use strict";
  var P = ${JSON.stringify(PAGE_MESSAGE_PREFIX)};
  var MAX_IN_FLIGHT = ${PAGE_MAX_IN_FLIGHT}, MAX_BYTES = ${PAGE_MAX_MESSAGE_BYTES};
  var $ = function (id) { return document.getElementById(id); };
  var frame = $("page"), dialog = $("guest"), form = $("guest-form"), nameInput = $("guest-name"), emailInput = $("guest-email");
  var note = $("guest-note"), ok = $("guest-ok"), cancel = $("guest-cancel"), who = $("who");
  var port = null, answered = false, loaded = false, asking = null;

  function failure(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  function api(method, path, body) {
    var init = { method: method, credentials: "same-origin", headers: { "X-Agent-FS-Page": "1" } };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return fetch(path, init).then(function (res) {
      if (res.status === 204) return null;
      return res.json().catch(function () { return null; }).then(function (data) {
        if (res.ok) return data;
        var code = data && typeof data.error === "string" ? data.error : "UNKNOWN";
        throw failure(code, data && typeof data.message === "string" ? data.message : "Request failed (" + res.status + ")");
      });
    });
  }

  function guest(g) {
    $("who-name").textContent = g.name;
    who.hidden = false;
    return { name: g.name, email: g.email, kind: "guest" };
  }

  function ask() {
    return new Promise(function (resolve) {
      note.textContent = "";
      ok.hidden = false;
      ok.disabled = false;
      cancel.textContent = "Cancel";
      dialog.hidden = false;
      nameInput.focus();
      function done(v) {
        dialog.hidden = true;
        form.onsubmit = null;
        cancel.onclick = null;
        resolve(v);
      }
      cancel.onclick = function () { done(null); };
      form.onsubmit = function (e) {
        e.preventDefault();
        ok.disabled = true;
        note.textContent = "";
        api("POST", "guest", { name: nameInput.value, email: emailInput.value })
          .then(function () { return api("POST", "me", {}); })
          .then(function (g) {
            if (g) return done(guest(g));
            note.textContent = "Your browser blocks cookies for this page, so it cannot remember you. The page stays read-only.";
            ok.hidden = true;
            cancel.textContent = "Close";
          }, function (err) {
            note.textContent = err.message;
            ok.disabled = false;
          });
      };
    });
  }

  function identity() {
    if (!asking) {
      asking = api("POST", "me", {})
        .then(function (g) { return g ? guest(g) : ask(); })
        .finally(function () { asking = null; });
    }
    return asking;
  }

  function handle(d) {
    if (d.op === "identity") return identity();
    return api("POST", "ops", { op: d.op, path: d.path, content: d.content, expectedVersion: d.expectedVersion, message: d.message });
  }

  function size(d) {
    try { return new TextEncoder().encode(JSON.stringify(d)).length; } catch (e) { return Infinity; }
  }

  function close() {
    if (!port) return;
    port.onmessage = null;
    port.close();
    port = null;
  }

  function serve(own, nonce) {
    var acked = false, inFlight = 0;
    return function (e) {
      var d = e.data;
      if (!acked) {
        if (d && d.type === P + "ack" && d.nonce === nonce) acked = true;
        else close();
        return;
      }
      if (d && d.type === P + "bye") return close();
      if (!d || typeof d !== "object" || !Number.isSafeInteger(d.id) || d.id < 1) return;
      var id = d.id;
      function reply(msg) {
        msg.id = id;
        if (port === own) own.postMessage(msg);
      }
      function fail(err) {
        reply({ error: { code: String(err && err.code || "UNKNOWN"), message: String(err && err.message || "Request failed") } });
      }
      if (inFlight >= MAX_IN_FLIGHT) return fail(failure("NOT_ALLOWED", "At most " + MAX_IN_FLIGHT + " requests in flight"));
      if (size(d) > MAX_BYTES) return fail(failure("NOT_ALLOWED", "Request is larger than 2 MB"));
      inFlight++;
      handle(d)
        .then(function (result) { reply({ result: result }); }, fail)
        .finally(function () { inFlight--; });
    };
  }

  // Only the frame's first document gets a port, once, before its first load.
  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!frame.contentWindow || e.source !== frame.contentWindow || answered || loaded) return;
    if (!d || d.type !== P + "hello" || d.v !== 1 || typeof d.nonce !== "string" || !/^[0-9a-f]{32}$/.test(d.nonce)) return;
    answered = true;
    var channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = serve(channel.port1, d.nonce);
    frame.contentWindow.postMessage({ type: P + "host", v: 1 }, "*", [channel.port2]);
  });

  frame.addEventListener("load", function () {
    if (loaded) close();
    loaded = true;
  });

  // The page already holds the old identity (agentfs.me()) and its port is
  // bound to this frame's first document, so only a new document starts clean.
  // Until the cookie is gone a reload would bring the same guest back.
  $("not-you").addEventListener("click", function () {
    var error = $("who-error");
    error.textContent = "";
    api("DELETE", "guest").then(function () { location.reload(); }, function () {
      error.textContent = "Could not forget you. Try again.";
    });
  });
})();`;

// The live app's colours (live/src/index.css), light by default and dark with
// the system, so the dialog looks like the app. The app's own font, Space
// Grotesk, is a bundled web font this CSP cannot load: its fallbacks stand in.
const HTML_PAGE_SHELL_STYLE = `:root{color-scheme:light;--background:oklch(0.99 0.002 95);--foreground:oklch(0.18 0.005 250);--card:oklch(1 0 0);--muted-foreground:oklch(0.52 0.005 250);--primary:oklch(0.55 0.13 255);--primary-foreground:oklch(0.99 0 0);--border:oklch(0.92 0.003 250);--input:oklch(0.92 0.003 250);--ring:oklch(0.65 0.12 255);--destructive:oklch(0.577 0.245 27.325)}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--background:oklch(0.16 0.004 60);--foreground:oklch(0.96 0.003 250);--card:oklch(0.18 0.004 60);--muted-foreground:oklch(0.68 0.005 250);--primary:oklch(0.7 0.13 255);--primary-foreground:oklch(0.18 0.004 60);--border:oklch(0.27 0.004 60);--input:oklch(0.27 0.004 60);--ring:oklch(0.6 0.12 255);--destructive:oklch(0.577 0.245 27.325)}}
[hidden]{display:none!important}
*{box-sizing:border-box}
html,body{margin:0;height:100%;overflow:hidden;background:var(--background);color:var(--foreground);font:15px/1.5 system-ui,sans-serif;-webkit-font-smoothing:antialiased}
#page{position:fixed;inset:0;width:100%;height:100%;border:0;background:#fff}
#guest{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.45)}
form{width:100%;max-width:380px;padding:24px;border:1px solid var(--border);border-radius:12px;background:var(--card);color:var(--foreground);box-shadow:0 10px 40px rgba(0,0,0,.25)}
h2{margin:0 0 8px;font-size:18px;font-weight:600}
p{margin:0 0 16px;color:var(--muted-foreground);font-size:14px}
label{display:block;margin:0 0 12px;color:var(--foreground);font-size:14px;font-weight:500}
input{display:block;width:100%;height:36px;margin-top:6px;padding:0 10px;border:1px solid color-mix(in oklab,var(--muted-foreground) 50%,var(--border));border-radius:8px;background:var(--background);color:var(--foreground);font:14px system-ui,sans-serif}
input:focus-visible{outline:2px solid var(--ring);outline-offset:0;border-color:var(--ring)}
.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
#guest-ok,#guest-cancel{height:32px;padding:0 10px;border:1px solid transparent;border-radius:8px;font:500 14px system-ui,sans-serif;cursor:pointer}
#guest-ok:focus-visible,#guest-cancel:focus-visible,#who button:focus-visible{outline:3px solid color-mix(in oklab,var(--ring) 50%,transparent);border-color:var(--ring)}
#guest-ok{background:var(--primary);color:var(--primary-foreground)}
#guest-ok:hover{background:color-mix(in oklab,var(--primary) 88%,black)}
#guest-ok:disabled{opacity:.5;cursor:default}
#guest-cancel{background:var(--background);border-color:var(--border);color:var(--foreground)}
#guest-cancel:hover{background:color-mix(in oklab,var(--foreground) 6%,var(--background))}
#guest-note{color:var(--destructive);font-weight:500}
#guest-note:empty{display:none}
#who{position:fixed;right:12px;bottom:12px;padding:4px 12px;border:1px solid var(--border);border-radius:999px;background:var(--card);color:var(--foreground);font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,.12)}
#who-name{font-weight:600}
#who button{padding:0;border:0;background:none;color:var(--primary);font:inherit;text-decoration:underline;cursor:pointer}
#who-error{color:var(--destructive);font-weight:500}
#who-error:empty{display:none}`;

function sha256(source: string): string {
  return `'sha256-${createHash("sha256").update(source).digest("base64")}'`;
}

/** The shell's own policy: its one script and style by hash, the page in a same-origin frame, fetches to itself only. */
export const PAGE_SHELL_CSP = [
  "default-src 'none'",
  `script-src ${sha256(HTML_PAGE_SHELL)}`,
  `style-src ${sha256(HTML_PAGE_SHELL_STYLE)}`,
  "frame-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * The shell for one page of the share. `name` is the page's file name inside
 * the share's folder; the frame loads it from `/site/`, relative to the
 * shell's `/page/<token>/` so a path prefix in front of the API is kept.
 */
export function renderPageShell(token: string, name: string): string {
  const src = `../../site/${encodeURIComponent(token)}/${encodeURIComponent(name)}?__afs_page=1`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(name)}</title>
<style>${HTML_PAGE_SHELL_STYLE}</style>
</head><body>
<iframe id="page" title="${escapeHtml(name)}" src="${escapeHtml(src)}" sandbox="${HTML_SANDBOX}" referrerpolicy="no-referrer"></iframe>
<div id="guest" role="dialog" aria-modal="true" aria-labelledby="guest-title" hidden>
<form id="guest-form">
<h2 id="guest-title">Who is viewing?</h2>
<p>This page can save your changes. Your name and email are saved with them so others can see who made them. Anyone can type any name: they are not verified.</p>
<label>Name<input id="guest-name" maxlength="80" required autocomplete="name"></label>
<label>Email<input id="guest-email" type="email" maxlength="254" required autocomplete="email"></label>
<p id="guest-note" role="alert"></p>
<div class="actions"><button type="button" id="guest-cancel">Cancel</button><button type="submit" id="guest-ok">Continue</button></div>
</form>
</div>
<div id="who" hidden>Saving as <span id="who-name"></span> · <button type="button" id="not-you">Not you?</button> <span id="who-error" role="alert"></span></div>
<script>${HTML_PAGE_SHELL}</script>
</body></html>`;
}
