---
date: 2026-10-17T23:01:13+02:00
researcher: Claude
git_commit: ce28b3747c8cb1c7e2a717754a5936174a9d0646
branch: main
repository: agent-fs
topic: "Presence in the live/ UI (who is viewing a doc, cursors, comment presence), backward compatible"
tags: [research, live-ui, presence, sse, change-stream, comments, server]
status: complete
autonomy: critical
last_updated: 2026-10-18
last_updated_by: Claude
---

# Research: Presence in the live/ UI

**Date**: 2026-10-17 23:01 BCN
**Researcher**: Claude
**Git Commit**: ce28b37
**Branch**: main

## Research Question

Add a Google Drive / Docs style presence feature to the `live/` UI. A user sees which other users are on a doc, where their cursor or selection is, and which comment they are on. It must be backward compatible. Include a recommended approach.

## Summary

The server already has a push channel. `GET /orgs/:orgId/drives/:driveId/events` is an SSE change-stream (Hono `streamSSE`) with a 5 s heartbeat that re-checks auth, clean abort handling, and a cap of 8 streams per user. It fans out an in-process, per-drive event bus (`file.changed`, `comment.changed`). The only runtime consumer is `agent-fs watch`. The live UI does not use it. The live UI has no push channel at all and polls comments every 10 s.

The deployment is one Fly machine with SQLite on a volume, so in-memory state is shared by all clients. Auth is Bearer-only, so a browser cannot use `EventSource`. It must read the stream with `fetch`. Doc positions already have a version-tolerant model: comment anchors use a quote (`exact`, `prefix`, `suffix`) plus a line range, and `live/src/lib/comment-anchor.ts` maps them to and from both the rendered Markdown DOM and Monaco.

Recommendation: ephemeral, in-memory presence on the server. It is UI-only. The browser sends updates with a small `PUT` route. The server pushes them on the existing SSE stream, but only to streams that opt in with `?presence=1`. Text carets, selections, and Figma-style mouse pointers all reuse the comment-anchor quote model. Two global toggles (**See cursors**, **See selections**) live in a popover on the avatar stack. The UI gates on a new `presence` entry in `/health.features`. This needs no DB migration, no new MCP tool, and no change for `agent-fs watch` or older UIs.

## Detailed Findings

### 1. Push transport: the SSE change-stream

- Route: `packages/server/src/routes/events.ts:14-91`, mounted in `packages/server/src/app.ts:19`. The server is Hono on raw `Bun.serve` (`packages/server/src/index.ts:102-107`). There is no WebSocket handler anywhere in `packages/`.
- Frames: first `event: ready` (`events.ts:64-67`), then one frame per bus event with `event: <type>` and `data: JSON.stringify(event)` (`events.ts:68-72`). Heartbeat is a raw `: ping` comment every 5 s (`events.ts:8,74-84`). There is no `id:` field and no replay. The route reads no query params.
- Each heartbeat re-runs `getUserByApiKey` and `resolveContext`. A revoked key or removed member ends the stream (`events.ts:75-78`).
- Cleanup is idempotent (`events.ts:43-51`) and runs on `stream.onAbort`, on the request abort signal, and in `finally`. This is a reliable "client left" signal.
- Cap: `MAX_STREAMS_PER_USER = 8`, in-memory, returns 429 `RATE_LIMITED` (`events.ts:7,22-35`).
- Bus: `packages/core/src/events/bus.ts`. `DriveEvent` is a TS union of `file.changed` and `comment.changed` (`bus.ts:1-20`). Listeners are a module-level `Map<driveId, Set<fn>>` (`bus.ts:22`). Publishers are `ops/comment.ts:69`, `ops/rm.ts:65`, `ops/versioning.ts:263`. There is no runtime schema for event types.
- Docs: `x-sse-events` in `packages/core/src/openapi.ts:372-390+` (documentation only), emitted to `docs/openapi.json:568-605`. `skills/agent-fs/SKILL.md:147` lists the `watch` event types.

### 2. Consumers of the stream (backward-compat surface)

- `agent-fs watch` (`packages/cli/src/commands/watch.ts`) splits frames on `\n\n`, skips `: ping`, and does **not** skip unknown types. In text mode it prints `${at} ${type} ${path} ${action ?? operation} ${actor}` for every non-`ready` type (`watch.ts:58`). A presence frame would print `undefined` fields. With `--json` it prints the event as-is (`watch.ts:56`). Liveness timeout is 15 s (`watch.ts:4`).
  - Presence is UI-only (decision 2026-10-18). The CLI gets no change. This item only shows why presence frames must be opt-in on the stream: `watch` shares the route and must not see them.
- `scripts/e2e.ts:1013-1050` asserts that the frame after `ready` is `file.changed`. An interleaved presence frame would break this ordering.
- MCP, the FUSE helper, and the live UI do not use the route.
- The `change-stream` feature flag (`packages/server/src/features.ts:6`) is not checked by any client.

### 3. Write path, ops, and capability discovery

- Almost all writes go through `POST /orgs/:orgId/ops` (`packages/server/src/routes/ops.ts:10-43`) and `dispatchOp` (`packages/core/src/ops/index.ts:392-427`): registry lookup, RBAC via `getRequiredRole`, zod parse, handler.
- An unknown op throws a plain `Error`, so an older server answers 500 `INTERNAL_ERROR` (`ops/index.ts:400`, `packages/server/src/middleware/error.ts:12-40`).
- MCP builds its tool list from **every** registered op (`packages/mcp/src/tools.ts:3,12`). A new op becomes a new MCP tool automatically.
- No write route today touches only in-memory state.
- `GET /health` returns `{ ok, version, maxUploadBytes, features }` (`app.ts:79`). Features are in `packages/server/src/features.ts:1-9`. The live UI already gates features on it: `live/src/lib/favorites.ts:9`, `live/src/lib/html-view.ts:20-21`, `live/src/lib/share-link.ts:24`.
- Rate limit is per Bearer token per minute (`packages/server/src/middleware/rate-limit.ts:7`). Fly sets `AGENT_FS_RATE_LIMIT=12000`.

### 4. Auth and identity

- Server: `Authorization: Bearer <api_key>` only (`packages/server/src/middleware/auth.ts:8-44`). No cookie, query-param, or WebSocket subprotocol path. Middleware stores only `{ id, email }` (`packages/core/src/identity/users.ts:121-134`). `users.display_name` exists (`packages/core/src/db/schema.ts:11-17`).
- Drive access: `resolveContext` (`packages/core/src/identity/context.ts:14-110`) returns `NotFoundError` for non-members. Roles are `viewer < editor < admin` (`identity/rbac.ts:88-153`).
- Live UI: credentials `{id, name, endpoint, apiKey}` in localStorage (`live/src/stores/credentials.ts:8-51`). `AuthProvider` builds `AgentFsClient` and loads `GET /auth/me` as `MeResponse {userId, email, displayName?, ...}` (`live/src/contexts/auth.tsx:54-64`, `live/src/api/types.ts:328-334`). Other users resolve via `useUserResolver` (`live/src/hooks/use-org-members.ts`). There is no avatar URL.
- The browser calls the user-typed endpoint directly. There is no proxy in `live/vercel.json` or `live/nginx.conf`. CORS defaults to `*` (`app.ts:30-34`, `packages/core/src/config.ts:97-98`).

### 5. Live UI data flow

- `AgentFsClient.request` sends Bearer + JSON (`live/src/api/client.ts:101-123`). `callOp` posts to `/orgs/:orgId/ops` (`client.ts:138-148`).
- No `EventSource`, `WebSocket`, or `setInterval` in `live/src`. Periodic work is TanStack Query `refetchInterval`: health 30 s (`use-health.ts:10`), comments 10 s while the sidebar is open (`use-comments.ts:25,261`), notifications 10 s (`use-comment-notifications.ts:37-47`).
- Current file identity is `(orgId, driveId, path)`. The path is the route splat (`live/src/pages/FileDetail.tsx:33`). Version comes from `useFileStat(path).currentVersion` (`live/src/hooks/use-comment-anchors.ts:36-37`).
- Routes: `/file/~/:orgId/:driveId/*` (browser) and `/detail/~/:orgId/:driveId/*` (doc page) in `live/src/App.tsx:195-205`.

### 6. Doc surfaces and the position model

- `live/src/components/viewers/FileViewer.tsx:497-558` picks the surface:
  - Markdown preview (`MarkdownViewer`): rendered HTML, read-only, native text selection only. No caret.
  - Raw / code / text (`TextViewer`, Monaco): read-only or editable. Real caret and selection.
  - Markdown edit (`isEditing`, `FileViewer.tsx:168`): MDXEditor rich mode (`live/src/components/viewers/RichMarkdownEditor.tsx`), split, or source.
- Markdown scroll container: `live/src/components/viewers/MarkdownViewer.tsx:645-650` (`data-markdown-scroll`). Selection capture: `handleMouseUp` (`MarkdownViewer.tsx:501-524`) and `targetFromDom` (`:742-750`) produce `{ text, quote, lineStart, lineEnd }` via `captureQuote` and a DOM text space.
- Anchor model: `lineStart`, `lineEnd`, legacy `quotedContent`, `quote { exact, prefix?, suffix? }`, plus `fileVersionId` / `fileVersion` (`live/src/api/types.ts:115-141`). `live/src/lib/comment-anchor.ts` resolves anchors to offsets (`resolveAnchor`, `resolveAnchorInView`, `captureQuote`, `QUOTE_CONTEXT_CHARS = 32`) with statuses `anchored | moved | lost` (`:56`). Monaco does the same in `live/src/components/viewers/TextViewer.tsx:213-250`.
- In-doc highlights use the CSS Custom Highlight API with names `comment-anchor`, `comment-anchor-moved`, `comment-anchor-active` (`MarkdownViewer.tsx:342-386`), with a `comment-indicator` class fallback.

### 7. Comments UI state

- Right rail: `live/src/components/layout/MainWithComments.tsx` (desktop `lg:` rail, mobile `Sheet`). Sidebar: `live/src/components/comments/CommentSidebar.tsx`. Card: `CommentThread.tsx` (card div `:102-112`).
- Store: `live/src/stores/comment-anchors.ts`, a module singleton used via `useSyncExternalStore`. It holds `anchors`, `hovered {id, source}`, and `focused` (a one-shot "reveal this card" request). `revealComment(id)` is at `:100-104`. There is no persistent "selected comment" state.
- Only avatar: a local, un-exported `Avatar` in `live/src/components/comments/CommentThread.tsx:29-47` (first letter, `oklch(0.65 0.15 hue)` from a userId hash). No `ui/avatar` component.
- Header slots: `live/src/components/layout/TopBar.tsx:17-37` (global), `FileDetail.tsx:67-154` (doc sub-header, right side holds icon buttons).

### 8. Deployment topology

- `fly.toml`: one app, region `ams`, `min_machines_running=1`, one volume `agent_fs_data` at `/data`. SQLite on a single-machine volume means one server process. The bus, the stream counter, and the rate limiter are all per-process in memory today.
- The local daemon (`packages/server/src/daemon.ts`) runs the same server code.

## Recommended approach (requested)

### Shape

```
 browser tab A                     server (one process)                 browser tab B
 ─────────────                     ────────────────────                 ─────────────
 GET /events?presence=1&session=A  ─► stream A registered               ◄─ GET /events?presence=1&session=B
  PUT /drives/:d/presence/A {...}   ─► presence registry (Map, TTL)  ─►  event: presence.updated  ─► tab B
 tab closes / stream aborts        ─► remove A                     ─►  event: presence.left     ─► tab B
```

### Server

1. **Registry** (new, in-memory, e.g. `packages/core/src/presence/registry.ts`): `Map<driveId, Map<sessionId, PresenceSession>>`. The server stamps `userId` and `displayName` from auth. It never trusts these from the client. TTL 45 s since the last update, swept on a timer.
2. **Separate channel.** Add `subscribePresence(driveId, cb)` next to `subscribeDrive`. Do not extend the `DriveEvent` union. Existing listeners and `watch` then never see presence.
3. **Write route** (not an op): `PUT /orgs/:orgId/drives/:driveId/presence/:sessionId` with `{ path | null, mode: "view" | "edit", selection?, commentId?, commentState? }`, and `DELETE` on the same URL. Use `resolveContext` for access (viewer role is enough). A route keeps the MCP tool list unchanged (`mcp/src/tools.ts:12` exposes every op). Zod-validate and cap sizes (for example `quote.exact` ≤ 256 chars).
4. **Opt-in on the stream**: in `events.ts`, when `?presence=1` is set, also subscribe to the presence channel. Send `presence.snapshot` right after `ready`. On cleanup, remove sessions bound to that stream and emit `presence.left`. That gives an instant "left" when a tab closes.
5. **Snapshot route**: `GET /orgs/:orgId/drives/:driveId/presence`. It is the fallback when the stream is unavailable (429 cap) and feeds the file-browser view.
6. **Feature flag**: add `presence` to `packages/server/src/features.ts`.

Wire format (all opt-in):

```
event: presence.snapshot   data: {"driveId","sessions":[PresenceSession],"at"}
event: presence.updated    data: {"driveId","session":PresenceSession,"at"}
event: presence.left       data: {"driveId","sessionId","userId","at"}

TextPos = { quote: {exact, prefix?, suffix?}, charOffset: number, lineStart, fileVersion }

PresenceSession = {
  sessionId, userId, displayName?, path: string | null, mode: "view" | "edit",
  selection?: { quote: {exact, prefix?, suffix?}, lineStart, lineEnd, fileVersion, collapsed: boolean },
  pointer?: TextPos | null,
  commentId?: string, commentState?: "viewing" | "replying",
  updatedAt
}
```

- `selection` carries the text caret (`collapsed: true`) or a text range.
- `pointer` is the mouse pointer (Figma-style). The client anchors it to the text under the mouse, not to pixels, because each viewer has a different width and scroll position. `quote.exact` is the word under the pointer. `charOffset` is the position inside that word.
  - Markdown preview: `document.caretPositionFromPoint` (with a `caretRangeFromPoint` fallback), then the existing DOM text space and `captureQuote`.
  - Monaco: `editor.onMouseMove` gives `{lineNumber, column}`, then the model offset.
  - `pointer: null` when the mouse leaves the doc, is over no text, or is idle for 5 s.
- Throttles: `pointer` one update per 100 ms, only while the mouse moves and the tab is visible. Everything else one per 300 ms. A moving pointer is about 600 requests per minute per tab.
- Rate limit: the default is 3000 requests per minute per API key (`packages/server/src/app.ts:65-70`). Fly sets 12000. All tabs of one user share one key. So the presence route gets its own limiter (for example 1200 per minute per key) and skips the general `/orgs/*` limiter. Presence traffic then cannot starve normal API calls. Over its limit, the client drops pointer updates and keeps the 15 s heartbeat.

### Live UI

1. **Stream hook** `useDriveStream(orgId, driveId)`: `fetch` with the Bearer header, a `ReadableStream` reader, the same `\n\n` frame parser as `watch.ts`, a 15 s liveness timeout, and reconnect with backoff. One stream per tab. On 429, fall back to polling the snapshot route every 10 s.
2. **Presence store**: a module singleton with `useSyncExternalStore`, the same pattern as `stores/comment-anchors.ts`. `sessionId = crypto.randomUUID()` per tab. Exclude the own user (all own tabs). Group by `userId`: one avatar per user, and only the session with the newest `updatedAt` on this path draws a caret, pointer, or selection. The server stays per-session.
3. **Publisher**: send on path change, selection change, pointer move, comment focus, and edit-mode toggle (throttles above). Send a heartbeat every 15 s. Send `DELETE` with `keepalive: true` on `pagehide`. Stop pointer updates on `visibilitychange` hidden.
4. **View settings**: two global toggles, **See cursors** (remote pointers and carets) and **See selections** (remote selection highlights). Both default on. Store them in localStorage (for example `liveui:presence`), the same way `liveui:comments` stores the rail state. They only change what this tab draws. The tab still publishes its own presence (no "hide me" option in v1).
5. **Gate**: `features.includes("presence")`, the same pattern as `lib/favorites.ts:9`.

### UI surfaces (Drive / Docs parity)

| Surface | Where | How |
|---|---|---|
| Who is on this doc | `FileDetail.tsx` sub-header, left of the icon buttons | Avatar stack (max 3 + "+N"). Tooltip: name, "viewing" or "editing". |
| Presence popover | Click on the avatar stack (`ui/popover.tsx` exists) | List of users on this doc: avatar, name, "viewing" or "editing". Click a row to scroll to their pointer or selection. Below the list: the **See cursors** and **See selections** toggles. There is no switch or checkbox in `live/src/components/ui/` today, so add one (shadcn `switch`). |
| Who is where in the drive | File browser rows | Small avatar dots on files with sessions (from the snapshot). |
| Remote selection, Markdown preview | `MarkdownViewer.tsx` | Resolve `selection.quote` with `resolveAnchorInView`. Paint with the CSS Custom Highlight API, as the comment highlights do. Use a fixed palette of 8 named highlights `presence-0..7` (static `::highlight()` CSS rules). Slot = hash(userId) % 8. Hidden when **See selections** is off. |
| Remote caret, Markdown preview | `MarkdownViewer.tsx` | Thin caret bar plus a name label at the selection end, positioned from `Range.getBoundingClientRect()` in the scroll container. Hidden when **See cursors** is off. |
| Remote pointer, Markdown preview | `MarkdownViewer.tsx` | Resolve `pointer` to a collapsed range, then draw an arrow icon plus a name tag in an overlay layer inside the scroll container. Animate between positions (CSS transform transition, about 100 ms). Hidden when **See cursors** is off. |
| Remote caret / selection / pointer, Monaco | `TextViewer.tsx` | `deltaDecorations` with a per-slot class name for the selection and an `afterContentClassName` caret. A content widget for the pointer. Same two toggles. |
| MDXEditor rich edit | `RichMarkdownEditor.tsx` | v1: avatars only, no remote carets, pointers, or selections. |
| Comment presence | `CommentThread.tsx` | Small avatars on the card for users with `commentId` = this thread. "Taras is replying…" when `commentState = "replying"` (reply composer focused). |

Extract the `live/src/components/comments/CommentThread.tsx:29-47` `Avatar` into a shared `UserAvatar` and reuse its hue hash, so presence colors match comment avatars.

Positions use the comment-anchor model, so a selection made on version N still resolves on version N+1. When the anchor is `lost`, show the avatar only.

### Backward compatibility

| Combination | Result |
|---|---|
| New UI + old server | `features` has no `presence`. Presence code does not run. |
| Old UI + new server | No change. It never opens the stream or calls the presence routes. |
| `agent-fs watch` (any version) + new server | No change. Presence frames go only to `?presence=1` streams. |
| `scripts/e2e.ts` frame-order test | No change, for the same reason. |
| MCP clients | No new tools (routes, not ops). |
| Database | No schema change, no migration. Presence is never persisted. |

### Alternatives considered

| Option | For | Against | Verdict |
|---|---|---|---|
| A. SSE opt-in + small PUT route (above) | Reuses stream, auth re-check, abort cleanup, cap. No new infra. No migration. | Up and down use different channels. Each tab uses one of the 8 streams per user. | **Recommended** |
| B. WebSocket (`Bun.serve` `websocket`) | One bidirectional channel. Lower cost per cursor update. | No WS handler today. A browser WS cannot send the Bearer header, so it needs a new auth path (ticket or subprotocol). New test harness. | Not worth it for presence only |
| C. Yjs awareness (`y-protocols`) + y-websocket / Hocuspocus | Standard cursor protocol with Monaco and ProseMirror bindings. | Needs a WS server and Yjs docs. There is no co-editing today. Large dependency. | Only if real-time co-editing comes later |
| D. Poll a presence endpoint every few seconds | Trivial. | 5-10 s lag. No live cursors. | Fallback only (inside A) |

### Phases

1. Server registry, routes, presence rate limiter, opt-in stream, `presence` flag, tests. UI stream hook, store, publisher, doc avatar stack, popover with the two toggles.
2. Remote selections, carets, and pointers in the Markdown preview and Monaco.
3. Comment presence (card avatars, "replying").
4. Optional: file-browser dots, viewport ticks in a scroll gutter.

A natural follow-up after phase 1: the UI has a stream, so `comment.changed` can invalidate the comment queries and replace the 10 s poll. That is out of scope here.

### Release checklist (per CLAUDE.md)

- **Skill update**: `skills/agent-fs/SKILL.md` needs no change. Presence is UI-only, and `watch` and MCP are unchanged.
- **Docs**: add the presence events under the opt-in param to `x-sse-events` in `packages/core/src/openapi.ts`, and the new routes to the OpenAPI doc.
- **E2E**: in `scripts/e2e.ts`, open a stream with `?presence=1`, `PUT` a session, expect `presence.updated`. Close it, expect `presence.left` on a second stream. Also assert that a stream without the param gets no presence frames.
- **Version bump**: `./scripts/release.sh <next patch>` (new non-breaking feature).

## Code References

Permalink base: `https://github.com/desplega-ai/agent-fs/blob/ce28b3747c8cb1c7e2a717754a5936174a9d0646/`

| File | Line | Description |
|---|---|---|
| [`packages/server/src/routes/events.ts`](https://github.com/desplega-ai/agent-fs/blob/ce28b3747c8cb1c7e2a717754a5936174a9d0646/packages/server/src/routes/events.ts#L14-L91) | 14-91 | SSE change-stream: ready, events, 5 s ping, auth re-check, cleanup, cap |
| [`packages/core/src/events/bus.ts`](https://github.com/desplega-ai/agent-fs/blob/ce28b3747c8cb1c7e2a717754a5936174a9d0646/packages/core/src/events/bus.ts#L1-L43) | 1-43 | `DriveEvent` union, in-process per-drive bus |
| [`packages/cli/src/commands/watch.ts`](https://github.com/desplega-ai/agent-fs/blob/ce28b3747c8cb1c7e2a717754a5936174a9d0646/packages/cli/src/commands/watch.ts#L43-L72) | 43-72 | Only stream consumer. Prints unknown types with `undefined` fields |
| [`scripts/e2e.ts`](https://github.com/desplega-ai/agent-fs/blob/ce28b3747c8cb1c7e2a717754a5936174a9d0646/scripts/e2e.ts#L1013-L1050) | 1013-1050 | E2E asserts frame order `ready` then `file.changed` |
| [`packages/server/src/features.ts`](https://github.com/desplega-ai/agent-fs/blob/ce28b3747c8cb1c7e2a717754a5936174a9d0646/packages/server/src/features.ts#L1-L9) | 1-9 | `/health` feature flags |
| [`packages/mcp/src/tools.ts`](https://github.com/desplega-ai/agent-fs/blob/ce28b3747c8cb1c7e2a717754a5936174a9d0646/packages/mcp/src/tools.ts#L12) | 12 | MCP exposes every registered op as a tool |
| [`packages/core/src/ops/index.ts`](https://github.com/desplega-ai/agent-fs/blob/ce28b3747c8cb1c7e2a717754a5936174a9d0646/packages/core/src/ops/index.ts#L392-L427) | 392-427 | `dispatchOp`: lookup, RBAC, zod, handler |
| [`packages/server/src/middleware/auth.ts`](https://github.com/desplega-ai/agent-fs/blob/ce28b3747c8cb1c7e2a717754a5936174a9d0646/packages/server/src/middleware/auth.ts#L8-L44) | 8-44 | Bearer-only auth |
| [`packages/core/src/identity/context.ts`](https://github.com/desplega-ai/agent-fs/blob/ce28b3747c8cb1c7e2a717754a5936174a9d0646/packages/core/src/identity/context.ts#L14-L110) | 14-110 | `resolveContext`: drive membership check |
| [`live/src/api/client.ts`](https://github.com/desplega-ai/agent-fs/blob/ce28b3747c8cb1c7e2a717754a5936174a9d0646/live/src/api/client.ts#L101-L148) | 101-148 | UI request wrapper and `callOp` |
| [`live/src/lib/favorites.ts`](https://github.com/desplega-ai/agent-fs/blob/ce28b3747c8cb1c7e2a717754a5936174a9d0646/live/src/lib/favorites.ts#L9) | 9 | Feature-gate pattern on `/health.features` |
| [`live/src/lib/comment-anchor.ts`](https://github.com/desplega-ai/agent-fs/blob/ce28b3747c8cb1c7e2a717754a5936174a9d0646/live/src/lib/comment-anchor.ts#L56) | 56 | Quote anchor resolve and capture (reused for positions) |
| [`live/src/components/viewers/MarkdownViewer.tsx`](https://github.com/desplega-ai/agent-fs/blob/ce28b3747c8cb1c7e2a717754a5936174a9d0646/live/src/components/viewers/MarkdownViewer.tsx#L342-L386) | 342-386 | CSS Custom Highlight API for comment highlights |
| [`live/src/components/viewers/MarkdownViewer.tsx`](https://github.com/desplega-ai/agent-fs/blob/ce28b3747c8cb1c7e2a717754a5936174a9d0646/live/src/components/viewers/MarkdownViewer.tsx#L501-L524) | 501-524 | Selection capture to `{quote, lineStart, lineEnd}` |
| [`live/src/stores/comment-anchors.ts`](https://github.com/desplega-ai/agent-fs/blob/ce28b3747c8cb1c7e2a717754a5936174a9d0646/live/src/stores/comment-anchors.ts#L100-L104) | 100-104 | Comment hover / focus store, `revealComment` |
| [`live/src/components/comments/CommentThread.tsx`](https://github.com/desplega-ai/agent-fs/blob/ce28b3747c8cb1c7e2a717754a5936174a9d0646/live/src/components/comments/CommentThread.tsx#L29-L47) | 29-47 | Only avatar (local, userId hue hash) |
| [`live/src/pages/FileDetail.tsx`](https://github.com/desplega-ai/agent-fs/blob/ce28b3747c8cb1c7e2a717754a5936174a9d0646/live/src/pages/FileDetail.tsx#L67-L154) | 67-154 | Doc sub-header (avatar stack slot) |
| [`fly.toml`](https://github.com/desplega-ai/agent-fs/blob/ce28b3747c8cb1c7e2a717754a5936174a9d0646/fly.toml#L26-L47) | 26-47 | One machine, one volume |


## Decisions (Taras, 2026-10-18)

| Topic | Decision |
|---|---|
| Cursor type | Both: the text caret / selection (Docs-style) and the mouse pointer (Figma-style), anchored to text. |
| View toggles | **See cursors** and **See selections**, global, default on, in the avatar-stack popover. |
| Scope | UI-only. Only browser tabs publish presence. No CLI, MCP, or `watch` change. |
| Privacy | No "hide my presence" in v1. Presence is visible to drive members only. |
| Same user, many tabs | One avatar and one cursor per user. The most recently active tab wins. |
| Stream cap | Keep 8 streams per user. Over the cap, poll the snapshot route every 10 s (avatars only, no live cursors). |
| Share links | Anonymous `/share` viewers are out of scope for v1. |

## Open Questions

- **Scale-out (accepted constraint).** A second Fly machine would split the in-memory registry and bus. Today there is one machine with one volume. Scale-out would need a shared pub/sub (for example Redis or NATS) for both the bus and presence.

## Appendix

- **Architecture notes**: single-process Hono on `Bun.serve`. SQLite via `bun:sqlite` + Drizzle with additive, idempotent migrations (`packages/core/src/db/migrate.ts`). All cross-client real-time state is in process memory. Feature discovery is through `/health.features`.
- **Historical context (from thoughts/)**:
  - `thoughts/taras/plans/2026-03-16-document-comments.md:65` put WebSocket / SSE for live comments out of scope.
  - `thoughts/taras/brainstorms/2026-03-17-agent-fs-web-ui.md:126` chose TanStack Query polling for v1 comments.
  - `thoughts/taras/brainstorms/2026-04-27-live-ui-improvements.md:43-46` lists team collaboration with comments as a priority.
  - `thoughts/taras/brainstorms/2026-05-15-agent-fs-as-linux-filesystem.md:155-156,275` proposed a server-pushed change channel (now shipped as the change-stream).
  - No prior doc covers presence, live cursors, or Yjs.
- **Related research**:
  - `thoughts/taras/research/2026-03-15-document-comments.md`: comments storage, threading, API.
  - `thoughts/taras/research/2026-04-27-live-ui-improvements.md`: live UI codebase research.
