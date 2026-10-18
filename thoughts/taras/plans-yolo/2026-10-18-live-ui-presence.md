---
date: 2026-10-17T23:27:23Z
topic: "Presence in the live/ UI (avatars, cursors, selections, pointers, comment presence)"
status: done
---

# Presence in the live/ UI

## Goal

Drive members who have the same doc open in the live/ UI see each other. The doc header shows an avatar stack. A popover lists who is here and holds two global toggles, **See cursors** and **See selections**. In the Markdown preview and in Monaco, remote text carets, selections, and Figma-style mouse pointers appear in each user's color. Comment cards show who is looking at a thread and who is replying. The server keeps presence in memory only, pushes it on the existing drive SSE stream to streams that opt in with `?presence=1`, and advertises the `presence` feature in `/health`. Old UIs, `agent-fs watch`, MCP, and the DB are unchanged.

Research and rationale: `thoughts/taras/research/2026-10-17-live-ui-presence.md` (see its Decisions table).

## Decisions

- Scope exception: one-shot covers 2 subsystems (server+core, live/) and phases 1-3. Taras granted this exception explicitly (asked).
- UI-only. No CLI, MCP, or `watch` change (asked).
- Cursor = text caret / selection and mouse pointer, both anchored to text (asked).
- Toggles **See cursors** / **See selections**: global, localStorage, default on, in the avatar-stack popover (asked).
- No "hide my presence" in v1 (asked).
- One avatar and one cursor per user. Newest `updatedAt` tab wins (asked).
- Keep 8 streams per user. Over the cap, poll the snapshot every 10 s (asked).
- `/share` anonymous viewers out of scope (asked).
- Routes, not ops, so MCP gets no new tools (assumed, from research: `packages/mcp/src/tools.ts:12`).
- Presence code lives in `packages/core/src/presence/` next to the event bus, because core already has zod (assumed).
- Ownership conflict returns 409 `EDIT_CONFLICT` (reuses `EditConflictError`) instead of a new `CONFLICT` code (assumed, Codex).
- TTL sweep skips stream-bound sessions: a live stream proves the tab is alive even when a background tab throttles its heartbeat timer (assumed, review).
- Presence routes key by the `resolveContext` drive id, the same id the stream uses (assumed, review).
- UI reads the health query via `healthQueryOptions` instead of a second `useHealth()` poller (assumed, UI agent).
- Caret encoding: `exact` = up to 24 chars before the caret; pointer `exact` = word under the mouse (assumed, UI agent).
- Pre-existing Playwright failures at HEAD ce28b37 (`comments-polling` 2, `mobile-overflow` 6: fixtures throw on `reveal` / `drive-members` ops) left untouched, out of scope (assumed, UI agent verified on a detached HEAD worktree).
- Presence selections: faint tint plus a solid underline in the person's color, so they never look like a comment highlight (asked, Taras feedback after QA).
- Version bump via `bun run scripts/sync-versions.ts 0.18.3`, not `release.sh`, because `release.sh` pushes (assumed).

## Contract (server and UI must match exactly)

### Types (`packages/core/src/presence/types.ts`)

```ts
type PresenceQuote = { exact: string; prefix?: string; suffix?: string };
type PresenceSelection = {
  quote: PresenceQuote; lineStart: number; lineEnd: number;
  fileVersion?: number | null; collapsed: boolean;
};
type PresenceTextPos = {
  quote: PresenceQuote; charOffset: number; lineStart: number; fileVersion?: number | null;
};
type PresenceState = {               // PUT body
  path: string | null;               // null = on the drive, no doc open
  mode: "view" | "edit";
  selection?: PresenceSelection | null;
  pointer?: PresenceTextPos | null;
  commentId?: string | null;
  commentState?: "viewing" | "replying" | null;
};
type PresenceSession = PresenceState & {
  sessionId: string; userId: string; email: string; displayName: string | null;
  updatedAt: string;                 // ISO, last time the state CHANGED
};
type PresenceEvent =
  | { type: "presence.updated"; driveId: string; session: PresenceSession; at: string }
  | { type: "presence.left"; driveId: string; sessionId: string; userId: string; at: string };
```

Limits (zod): `sessionId` matches `^[A-Za-z0-9_-]{8,64}$`. `path` ≤ 4096. `quote.exact` ≤ 256, `prefix` / `suffix` ≤ 64. Line numbers and `charOffset` are non-negative ints. `commentId` ≤ 128. Unknown keys are stripped. Max 32 sessions per user per drive (429 `RATE_LIMITED` above that).

### Routes (all Bearer auth, `resolveContext` membership check, any drive role)

- `GET  /orgs/:orgId/drives/:driveId/presence` → `200 { driveId, sessions: PresenceSession[], at }`
- `PUT  /orgs/:orgId/drives/:driveId/presence/:sessionId` body `PresenceState` → `200 { session: PresenceSession }`. 400 `VALIDATION_ERROR` on bad body or bad sessionId. 409 `CONFLICT` if the sessionId belongs to another user.
- `DELETE /orgs/:orgId/drives/:driveId/presence/:sessionId` → `200 { ok: true }` (also when the session is unknown). Only the owner can delete.
- Non-member: same 404 as other drive routes (`resolveContext` NotFoundError).
- Rate limit: presence routes skip the general `/orgs/*` limiter and use their own `rateLimitMiddleware(presenceRpm)`. `presenceRpm = config.server.presenceRateLimit.requestsPerMinute ?? 1200`, env `AGENT_FS_PRESENCE_RATE_LIMIT` (same pattern as `AGENT_FS_SHARE_RATE_LIMIT`). 0 disables it.

### Stream opt-in (`GET /orgs/:orgId/drives/:driveId/events`)

- New optional query params: `presence=1` and `sessionId=<id>`. Without `presence=1` the stream is byte-for-byte unchanged.
- With `presence=1`: after the `ready` frame, write `event: presence.snapshot` with `data: { driveId, sessions, at }`. Then forward each `PresenceEvent` for this drive as `event: <type>`, `data: JSON.stringify(event)`, through the same `pending` write chain.
- With a valid `sessionId` too: bind the stream to that session. On stream cleanup, unbind. When the last binding of a session goes away, remove the session and emit `presence.left`. A bind counter per session handles reconnect overlap.

### Registry semantics

- `upsert(driveId, sessionId, user, state)`: insert or replace. Stamps `userId`, `email`, `displayName` (from `users.display_name`, looked up on insert) from auth, never from the body. If the state is deep-equal to the stored state, only refresh `lastSeen` and do not broadcast. Otherwise set `updatedAt = now` and broadcast `presence.updated`.
- TTL: a session with `lastSeen` older than 45 s is removed by a sweep (every 15 s, `unref`'d timer) and emits `presence.left`. Clock and timer are injectable for tests.
- Feature flag: `"presence"` in `packages/server/src/features.ts`.

### UI behavior

- Gate: `health.features.includes("presence")`. Otherwise no presence code runs (no stream, no PUTs, no UI).
- One stream per tab for the active `(orgId, driveId)`: `fetch` with Bearer, `ReadableStream` reader, frames split on `\n\n`, `: ping` resets a 15 s liveness timer, reconnect with backoff (1 s doubling to 30 s). On 429, poll `GET /presence` every 10 s and retry the stream every 60 s. In poll mode pointers are hidden.
- `sessionId = crypto.randomUUID()` per page load (not sessionStorage: a duplicated tab copies it, and two tabs on one id overwrite each other; changed after review).
- Publisher: PUT on state change. Pointer throttle 100 ms, other fields 300 ms (trailing edge, latest state wins). Heartbeat PUT every 15 s with the current state. Pointer updates stop while the tab is hidden. Best-effort `DELETE` with `keepalive: true` on `pagehide`. On PUT 429, drop pointer updates for 10 s and keep the heartbeat.
- Grouping: exclude the own `userId` (all own tabs). One entry per `userId` per path: the session with the newest `updatedAt`.
- Colors: 8 hue slots. `slot = Math.round(hash(userId) % 360 / 45) % 8`, `hue = slot * 45`, color `oklch(0.65 0.15 hue)`. Shared `UserAvatar` uses the same function, and the comment avatars switch to it.
- Toggles in localStorage `liveui:presence` = `{ showCursors: boolean, showSelections: boolean }`, both default true. They only change rendering.

## Todo

### Server (Codex)
- [x] `packages/core/src/presence/` types, zod schema, registry; export from `packages/core/src/index.ts`
- [x] `packages/server/src/routes/presence.ts` (GET / PUT / DELETE)
- [x] `events.ts` opt-in (`presence=1`, `sessionId`), snapshot, forwarding, binding
- [x] presence rate limiter in `app.ts`, config + env in `packages/core/src/config.ts`
- [x] `presence` feature flag, update `server.test.ts` features assertion
- [x] openapi: routes + `x-sse-events` + query params in `packages/core/src/openapi.ts`, regenerate `docs/openapi.json` via `bun run scripts/sync-openapi.ts`
- [x] tests: registry unit tests, route tests, stream opt-in tests (plain stream gets no presence frames)
- [x] `scripts/e2e.ts`: presence section (works in `--local-only`)

### UI (Opus agent)
- [x] API client methods + types, `lib/presence.ts` (flag, color, grouping, throttle), `lib/sse.ts` frame parser
- [x] presence store (remote sessions, own state, settings) + connection hook (stream, fallback poll, publisher)
- [x] shared `UserAvatar`, `ui/switch.tsx`, `PresenceAvatars` stack + popover with the 2 toggles in the doc header
- [x] Markdown preview: remote selections (Custom Highlight API, `presence-0..7`), carets, pointers; publish own selection + pointer
- [x] Monaco: decorations, caret, pointer widget; publish own selection + pointer
- [x] comment presence on cards (viewing / replying); publish own comment state
- [x] unit tests for parser, grouping, color; Playwright spec for avatar stack + toggles with mocked stream

### Orchestrator
- [x] review both diffs, run all verification
- [x] two-user browser E2E against a local MinIO daemon (agent-browser): avatars, popover, both toggles (persisted), Markdown selection + caret + pointer, Monaco selection + caret + pointer, comment card avatar + "Bob is replying...", Bob closes tab -> gone within 2 s
- [x] `desplega:code-reviewing`, fix Critical / Important
- [x] version sync 0.18.3, commit (rebased onto origin/main 2d6fe37, one conflict in CommentThread.tsx imports)

## Verification

- `bun run typecheck`
- `bun run test`
- `bun run scripts/sync-openapi.ts && git diff --exit-code docs/openapi.json` (after commit of the regenerated file)
- `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --" --local-only`
- `cd live && pnpm build && pnpm test:e2e`
- `cd live && pnpm lint` (if the script exists)
- `bun run scripts/sync-versions.ts --check`
- Manual: two browser sessions (two users) on the same doc against a local MinIO daemon: avatars, popover toggles, selection, caret, pointer, comment "replying".

## Outcome (2026-10-18)

Verification on the rebased branch:
- `bun run typecheck`: pass
- `bun run test`: 1794 tests, 0 fail
- `docs/openapi.json` regenerated and committed (it embeds the version)
- `bun run scripts/sync-versions.ts --check`: every target at 0.18.3; `bun install --frozen-lockfile` clean
- `scripts/e2e.ts --local-only`: 188/188 (includes "presence stream, snapshot and delete")
- `cd live && pnpm build`: pass
- `pnpm test:e2e`: 22 pass, 8 fail. The same 8 fail on origin/main 2d6fe37 (`comments-polling` 2, `mobile-overflow` 6; fixtures abort ops the app now calls). All 4 presence specs pass.
- Manual two-user QA (agent-browser, MinIO daemon): all surfaces work, before and after the review fixes.

Code review (Opus, two axes). Spec: no Critical / Important. Standards: 2 Important, both fixed:
- `useDocPresence` re-rendered every subscriber on every remote change on the drive. Now a per-path cached snapshot.
- Duplicated tabs shared one sessionId through sessionStorage. Now a fresh id per page load.
Minor fixed: PUTs serialized; clean stream end handled like an error; `PresenceLimitError` mapped centrally; registry unsubscribe guard; unused option removed; one Monaco decorations collection; 409 documented on `/events`; `AGENT_FS_PRESENCE_RATE_LIMIT` in DEPLOYMENT.md; the Playwright fixture keeps the mocked stream open.
Minor, not fixed (noted):
- `events.ts` writes presence frames into the same unbounded `pending` chain (pre-existing pattern; presence raises the frame rate).
- `eventRoutes(db, undefined, presence)` positional optional arg.
- Monaco enums spelled as numbers in `use-monaco-presence.ts`.
- sessionId regex repeated in `openapi.ts`; `onComment` in `lib/sse.ts` only used by tests.
- `scripts/e2e.ts` lacks the "plain stream gets no presence" and "bound stream close emits left" checks (server unit tests cover both).
- No automated test for the UI connection logic (429 poll, backoff, liveness, PUT 429 pause).
- The avatar stack also shows in the file-browser viewer header (small, intended scope addition).
