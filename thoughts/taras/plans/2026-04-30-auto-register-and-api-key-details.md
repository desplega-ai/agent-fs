---
date: 2026-04-30
author: taras
topic: "Auto-register on /credentials + API key details modal for stored backends (live/)"
status: completed
autonomy: critical
last_updated: 2026-05-04
last_updated_by: claude (both phases + qa-use verification)
related:
  - thoughts/taras/qa/2026-05-04-auto-register-and-api-key-details.md
---

# Auto-Register + API Key Details Implementation Plan

## Overview

Two improvements to the agent-fs `live/` SPA's `/credentials` page (the *only* page a user sees when no API key is configured):

1. **Auto-register inline** — instead of forcing the user to first run a `curl` against `/auth/register` to obtain a key, let them sign up directly from `/credentials` by entering an endpoint URL + email. Use the existing `POST /auth/register` route (already public, already returns `{apiKey, userId, orgId}`).
2. **API key details modal** — for each saved-account card on `/credentials`, surface a "Details" affordance that opens a modal showing locally-stored fields (name, endpoint, masked key, id) plus server-side identity (email, default org/drive) and org/drive counts. The modal also exposes **Copy key** and **Replace key** actions on the locally-stored credential.

- **Motivation**: Today, the `/credentials` page assumes the user already has a key. Onboarding requires reading `DEPLOYMENT.md:110-116` and running a curl. We can collapse this into one flow. Users with multiple stored backends also have no way to inspect or rotate keys without deleting + re-adding.
- **Related**:
  - `live/src/pages/Credentials.tsx` (current connect form)
  - `live/src/stores/credentials.ts` (multi-credential localStorage)
  - `live/src/contexts/auth.tsx` (redirects to `/credentials` when no active credential)
  - `live/src/api/client.ts` (`AgentFsClient`)
  - `packages/server/src/routes/auth.ts:9-37` (`POST /auth/register`)
  - `packages/server/src/middleware/auth.ts:6` (register is in `PUBLIC_PATHS`)

## Current State Analysis

### Live SPA — `/credentials` is the entry point (no API key → here)

- `live/src/App.tsx:137` mounts `/credentials` **outside** `AuthProvider`. All other routes are inside `AuthenticatedLayout` (`App.tsx:138-144`), so `useAuth()` is **not** available on `/credentials` — any data fetching there must build its own `AgentFsClient` per credential.
- `live/src/contexts/auth.tsx:48-52` redirects to `/credentials` whenever no active credential is in localStorage. `auth.tsx:132-136` also redirects there on `meError`. So `/credentials` is the de-facto initial page for unconfigured users.
- `live/src/pages/Credentials.tsx:30-54` — the existing **Connect** form takes `endpoint`, `apiKey`, `name`, validates with `client.getMe()`, then calls `saveCredential` + `setActiveCredential` and navigates to `/files`.
- `live/src/pages/Credentials.tsx:153-196` — saved-accounts list. Each card shows `name` + `endpoint` and exposes "Connect" (switch active) + "Remove" buttons. **No details affordance, no copy, no edit.**

### Multi-credential storage — already exists

- `live/src/stores/credentials.ts:1-52` defines `Credential { id, name, endpoint, apiKey }` and a localStorage-backed list under `agent-fs-credentials` with a separate active pointer at `agent-fs-active-credential`. CRUD helpers: `getCredentials`, `saveCredential` (upsert by `id`), `removeCredential`, `getActiveCredential`, `setActiveCredential`.
- `saveCredential` is upsert-by-id, so editing a credential's `apiKey` in place is supported just by re-saving with the same `id`.

### Server — registration already public, key metadata is sparse

- `packages/server/src/routes/auth.ts:9-37` — `POST /auth/register` accepts `{ email }` and returns `{ apiKey, userId, orgId }` (`orgs[0]?.id`). Throws 409 on `UNIQUE` constraint conflict (duplicate email).
- `packages/server/src/middleware/auth.ts:6` — `/auth/register` is whitelisted in `PUBLIC_PATHS` (no auth header needed).
- `packages/core/src/identity/users.ts:28-49` — `createUser` mints an `af_<64hex>` key, stores only `apiKeyHash` in `users` table, auto-creates a personal org with default drive.
- `packages/core/src/db/schema.ts:9-14` — `users` columns: `id`, `email`, `apiKeyHash`, `createdAt`. **No** `keyPrefix`, `keyLabel`, `lastUsedAt`. Server cannot return key-prefix metadata without a schema migration. Out of scope here per Taras: details view will lean on **locally stored fields** + `/auth/me` + org/drive counts (no schema changes).
- `packages/server/src/routes/auth.ts:39-59` — `GET /auth/me` returns `{ userId, email, defaultOrgId, defaultDriveId }`. Already in `live/src/api/types.ts:202-207` as `MeResponse`.
- `live/src/api/client.ts:62-72` already has `getMe()`, `getOrgs()`, `getDrives(orgId)` — enough to compute org/drive counts client-side.

### No email infrastructure

- No Resend / Nodemailer / SMTP / Mailgun / Sendgrid dependencies in any `package.json`. No `sendEmail` / `sendMail` helpers anywhere.
- Decision: **inline registration** (Taras's pick). The existing `/auth/register` is already an unverified email-gated signup — exposing it from the SPA is a UX enhancement, not a security regression. Magic-link / verification can land in a future plan with proper email infra.

### UI primitives available

- `live/components.json` confirms shadcn `base-nova` style + lucide icons.
- `live/src/components/ui/` already includes `dialog.tsx`, `popover.tsx`, `tooltip.tsx`, `button.tsx`, `input.tsx`, `spinner.tsx`. **No new primitive installs needed.**

## Desired End State

Verifiable outcomes:

1. From a fresh browser (cleared localStorage), opening the live SPA against a running daemon redirects to `/credentials`. The page offers **two modes**: "Connect existing key" (today's form) and "Register new account". Selecting Register, entering endpoint + email, and submitting yields a saved + active credential in localStorage, navigates to `/files`, and `/files` loads successfully without further config.
2. On `/credentials` with ≥1 saved account, each card shows a **Details** button. Clicking it opens a modal with:
   - Locally-stored: `name`, `endpoint`, masked key (e.g. `af_a1b2…f3a2`) with show/hide + copy buttons, internal `id`.
   - Server-side (via temporary `AgentFsClient`): `email`, `userId`, `defaultOrgId`, `defaultDriveId`, org count, drive count for the default org. Reachability errors render gracefully.
   - **Replace key** action: input field for a new key; on submit, validate via `getMe()` against the same endpoint, then upsert the credential in localStorage with the new key.
   - **Copy key** action: writes plaintext key to clipboard.
3. `bun run typecheck` passes. The live dev server (`pnpm --dir live dev`) renders both flows without console errors.

## What We're NOT Doing

- No email verification, magic link, or 6-digit-code flow (separate future plan).
- No CLI changes — `agent-fs auth register <email>` already exists (`packages/cli/src/commands/auth.ts:13-45`); leave it alone.
- No server schema migration to add `keyPrefix` / `lastUsedAt` to `users`.
- No new server endpoints. No `GET /api-keys`, no rotate endpoint.
- No "switch account" affordance from inside the file browser shell — keep that to `/credentials` for now.
- No CLI/MCP/core changes → CLAUDE.md's release checklist (skill update, plugin bump, package version bump, e2e additions) does **not** apply.

## Implementation Approach

- Two phases, each with a single concrete deliverable. Phase 2 depends on Phase 1 (it touches the same `Credentials.tsx`).
- All work is `live/`-only (pnpm package manager — see CLAUDE.md gotcha).
- Server, core, CLI, MCP packages are untouched.
- Keep changes small and shadcn-native: extend `Credentials.tsx`, add one new `register()` method to `AgentFsClient`, and one new `CredentialDetailsDialog` component using the existing `dialog.tsx` primitive.

## Quick Verification Reference

- `bun run typecheck` (root — runs `tsc --build` across packages including `live/`)
- `cd live && pnpm dev` (start local Vite dev server on http://localhost:5173)
- `cd live && pnpm build` (production build)
- For an end-to-end check, start the daemon: `bun run packages/cli/src/index.ts serve --port 8787` (separate terminal), then point the SPA at `http://localhost:8787`.

---

## Phase 1: Inline auto-register on `/credentials`

### Overview

Add a "Register new account" mode to `live/src/pages/Credentials.tsx` that posts `{ email }` to `POST /auth/register` and stores the returned `apiKey` as a new active `Credential`, replacing the curl step in `DEPLOYMENT.md:110-116` for SPA users.

### Changes Required:

#### 1. Add `register()` to API client
**File**: `live/src/api/client.ts`
**Changes**:
- Add `static async register(opts: { endpoint: string; email: string }): Promise<{ apiKey: string; userId: string; orgId: string }>` (or instance method that bypasses Authorization).
- Normalize endpoint: `endpoint.replace(/\/+$/, "")` before composing the URL (mirrors `client.ts:17` and `Credentials.tsx:43`).
- Implement as a plain `fetch` to `${endpoint}/auth/register` with `Content-Type: application/json` and **no** Authorization header (route is public per `packages/server/src/middleware/auth.ts:6`).
- Mirror the existing error-shape handling from `request<T>()` (`client.ts:32-40`) so 409 / network errors raise readable messages. The thrown error has `.error` (e.g. `"CONFLICT"`, `"VALIDATION_ERROR"`) and `.message` properties — Phase 1 form code MUST detect duplicate-email by `error.error === "CONFLICT"`, not by message-string matching.

#### 2. Extend `Credentials.tsx` with mode toggle + register form
**File**: `live/src/pages/Credentials.tsx`
**Changes**:
- Add a `mode: "connect" | "register"` `useState`. Render a small segmented control (two `Button`s or `ToggleGroup` from `live/src/components/ui/toggle-group.tsx`) above the form.
- When `mode === "register"`: render `endpoint`, `email` (use `<Input type="email" required />` for native browser validation), optional `name` fields (no API key field, no show/hide toggle).
- New handler `handleRegister`: calls `AgentFsClient.register({ endpoint, email })`, then constructs a `Credential` with the returned `apiKey`, calls `saveCredential` + `setActiveCredential`, navigates to `/files`. Detect 409 via `error.error === "CONFLICT"` and show actionable copy: "Account exists — switch to Connect and paste your key, or use a different email."
- Reuse existing `connecting`/`error` state.
- Heading text adapts: "Connect to agent-fs" vs. "Create your agent-fs account".
- Keep the saved-accounts list rendering visible in **both** modes (Phase 2 adds the Details affordance there). Returning users with stored creds should always see them regardless of which mode is active.

#### 3. Type updates
**File**: `live/src/api/types.ts`
**Changes**: Add `RegisterResponse { apiKey: string; userId: string; orgId: string }` near the other auth types (around `live/src/api/types.ts:202-207`).

### Success Criteria:

#### Automated Verification:
- [x] Type-check passes: `bun run typecheck`
- [x] Live build succeeds: `cd live && pnpm build`
- [ ] No new lint errors: `cd live && pnpm lint` (if configured; otherwise rely on tsc)

#### Automated QA:
- [x] Browser-use agent: with the daemon running on `http://localhost:8787`, open `http://localhost:5173/credentials`, click "Register new account", enter endpoint=`http://localhost:8787`, email=`new-user-<rand>@test.local`, submit. Verify navigation to `/files` and that the file browser renders the personal drive. — qa-use P1-1, evidence at `thoughts/taras/qa/evidence/2026-05-04/P1-1.png`
- [x] Browser-use agent (duplicate-email path): repeat with the same email. Verify the form stays on `/credentials` and shows an error matching "already exists". — qa-use P1-2, "Account exists — switch to Connect..." rendered, evidence at `P1-2.png`
- [x] Browser-use agent (unreachable endpoint): qa-use P1-3, "Failed to fetch" rendered, no crash, evidence at `P1-3.png`
- [x] Browser-use agent (mode toggle): qa-use P1-4, fields swap (Email ↔ API Key), heading flips, saved-accounts list stays visible in both modes, evidence at `P1-4.png`
- [ ] DOM check: `localStorage.getItem("agent-fs-credentials")` contains the new credential with a key matching `^af_[0-9a-f]{64}$` and `localStorage.getItem("agent-fs-active-credential")` matches the new id. — indirect: post-register UI showed correct user/org and multi-account correctness held in P2-7; qa-use lacks JS eval so not directly inspected.

#### Manual Verification:
- [ ] Visual: the segmented control / mode toggle reads cleanly, doesn't break the centered card layout from `Credentials.tsx:67-74`, dark-mode looks right.

### QA Spec:

Phase 1 scenarios (P1-1 … P1-5) — happy path register, duplicate email, unreachable endpoint, mode toggle, post-register drive readability — are documented in [`thoughts/taras/qa/2026-05-04-auto-register-and-api-key-details.md`](../qa/2026-05-04-auto-register-and-api-key-details.md). Run against a local daemon (`bun run packages/cli/src/index.ts serve --port 8787`) + local `pnpm --dir live dev`.

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was enabled, commit as `[phase 1] inline auto-register on /credentials`.

---

## Phase 2: Credential details modal with copy + replace key

### Overview

Add a "Details" button to each saved-account card on `/credentials` that opens a modal showing locally-stored fields, fetched server-side identity (`/auth/me`, `/orgs`, `/orgs/:id/drives`), and exposes Copy/Replace-key actions on the locally stored `Credential`.

### Changes Required:

#### 1. New component `CredentialDetailsDialog`
**File**: `live/src/components/credentials/CredentialDetailsDialog.tsx` *(new)*
**Changes**:
- Uses `Dialog` from `live/src/components/ui/dialog.tsx`.
- Props: `{ credential: Credential | null; open: boolean; onOpenChange: (open: boolean) => void; onCredentialUpdated: () => void }`.
- Renders three sections:
  1. **Local** — `name` (editable inline?), `endpoint`, masked key (`af_xxxx…<last4>`) with `Eye`/`EyeOff` show/hide and `Copy` button. Use `navigator.clipboard.writeText` with a try/catch fallback (clipboard API requires a secure context — HTTPS or `localhost`; on a plain-HTTP self-hosted endpoint it throws); on failure, surface a small "Copy unavailable on insecure origin" hint. Show internal `id`.
  2. **Server** — fetched via TanStack Query keyed on `["credential-details", credential.id]`. Uses a temporary `new AgentFsClient({ endpoint, apiKey })` to call `getMe()` + `getOrgs()` + (only if `defaultOrgId` is non-null per `MeResponse` shape in `live/src/api/types.ts:202-207`) `getDrives(defaultOrgId)`. Displays `email`, `userId`, `defaultOrgId`, `defaultDriveId`, `Orgs: <count>`, `Drives in default org: <count or "—" if defaultOrgId is null>`. Renders a friendly error if the server is unreachable or the key is invalid.
  3. **Replace key** — collapsed by default (small "Replace key" link). Expanded: input field + Save button. On Save: build a fresh `AgentFsClient` with the new key, call `getMe()` to validate. **Cross-user safety**: if the new key's `email` differs from the currently displayed `email`, render a confirm step ("This key belongs to a different account (`<new-email>`). Replace anyway?") before persisting. On confirm, call `saveCredential({ ...credential, apiKey: newKey })`, invalidate `["credential-details", credential.id]` via `queryClient.invalidateQueries`, and call `onCredentialUpdated()` so `Credentials.tsx` re-reads from localStorage.
- Use `Spinner` from `live/src/components/ui/spinner.tsx` for the server-side fetch.

#### 2. Wire the modal into `Credentials.tsx`
**File**: `live/src/pages/Credentials.tsx`
**Changes**:
- Add state `const [detailsCred, setDetailsCred] = useState<Credential | null>(null)`.
- On each saved-account card (around `Credentials.tsx:166-191`), add a "Details" `Button` (lucide `Info` or `Settings` icon) that calls `setDetailsCred(cred)`.
- Render `<CredentialDetailsDialog credential={detailsCred} open={!!detailsCred} onOpenChange={(o) => !o && setDetailsCred(null)} onCredentialUpdated={() => setCredentials(getCredentials())} />` once at the page level.

#### 3. Helper for masking
**File**: `live/src/lib/mask-key.ts` *(new, or inline in the dialog)*
**Changes**: small utility `maskApiKey(key: string): string` returning e.g. `af_a1b2…f3a2` (first 6, last 4, with em-ellipsis between).

### Success Criteria:

#### Automated Verification:
- [x] Type-check passes: `bun run typecheck`
- [x] Live build succeeds: `cd live && pnpm build`
- [ ] `maskApiKey` correctness for short input is verified in the QA scenario (live/ has no test runner configured today — confirmed 2026-05-04).

#### Automated QA:
- [x] Browser-use agent: open `/credentials` with at least one saved account. Click "Details" on a card. Modal opens. Verify visible fields: name, endpoint, masked key, id, email (from `/auth/me`), userId, org count > 0, drive count > 0. — qa-use P2-1, evidence at `P2-1.png`
- [x] Browser-use agent (show/hide): qa-use P2-2, button label flips Show ↔ Hide, full key matches `^af_[0-9a-f]{64}$`.
- [ ] Browser-use agent (copy): click the Copy button on the masked key. Then `navigator.clipboard.readText()` (or fallback to a paste into a textarea) returns the full unmasked key. — Copy click executed without crash but readback not verified (qa-use tunneled browser cannot eval clipboard).
- [ ] Browser-use agent (replace key, happy path): click Replace key, paste a *valid* key (use the active credential's existing key as the "new" one for the test), Save. Modal closes (or shows success). Reopen Details; verify saved-accounts list still has the same `id` and now has the updated key (verify via `localStorage` read). — Skipped during automated QA pass; defer to manual.
- [x] Browser-use agent (replace key, invalid): paste a junk key (e.g. `af_invalid`), Save. Verify in-modal error message and that the credential is **not** mutated in localStorage. — qa-use P2-5, "Invalid API key" rendered + masked key unchanged, evidence at `P2-5.png`
- [ ] Browser-use agent (server unreachable): manually stop the daemon, open Details on the credential pointing at it. Verify the modal still shows local fields and renders a friendly error in the Server section instead of crashing. — Skipped during automated QA pass; defer to manual.
- [x] Browser-use agent (multi-account correctness): qa-use P2-7, two registered accounts, Details on each shows the correct distinct name/email, evidence at `P2-7-first.png`, `P2-7-second.png`.

#### Manual Verification:
- [ ] Visual: modal is centered, scrolls if content overflows, dark-mode contrast is acceptable, masked-key monospace formatting reads well.

### QA Spec:

End-to-end scenarios for both phases live in [`thoughts/taras/qa/2026-05-04-auto-register-and-api-key-details.md`](../qa/2026-05-04-auto-register-and-api-key-details.md). Run against a local daemon (`bun run packages/cli/src/index.ts serve --port 8787`) + local `pnpm --dir live dev`. Phase 2 scenarios (P2-1 … P2-7) cover Open Details, show/hide, copy, replace (valid + invalid), server-unreachable degradation, and multi-account correctness.

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was enabled, commit as `[phase 2] credential details modal with copy + replace key`.

---

## Appendix

- **Derail notes**:
  - **Magic link / email verification** — explicitly deferred. If we go hosted-multitenant, revisit with: Resend integration, `magic_link_tokens` table, `/auth/request-link` + `/auth/verify-link` routes, callback page in `live/`, CORS.
  - **Server-side key metadata** — `users.apiKeyHash` is opaque; surfacing `keyPrefix`, `lastUsedAt`, `createdAt` requires a schema migration (additive, low-risk). Worth a small follow-up plan if rotate/revoke from the server lands.
  - **Switch-account from inside the file browser** — useful follow-up; today users have to navigate back to `/credentials`. Could be a header dropdown using the existing AuthContext's `switchAccount`.
  - **CLI parity** — `agent-fs auth register` already exists in CLI; no work required, but if we ever revamp the CLI's `init` / `onboard` flow to call the HTTP register endpoint instead of writing to SQLite directly (`packages/cli/src/commands/onboard.ts:89-114`), this plan is a useful UX reference.
- **References**:
  - `packages/server/src/routes/auth.ts:9-37` (register endpoint)
  - `packages/server/src/middleware/auth.ts:6` (PUBLIC_PATHS)
  - `packages/core/src/identity/users.ts:12-49` (key generation + createUser)
  - `live/src/pages/Credentials.tsx:1-201`
  - `live/src/stores/credentials.ts:1-52`
  - `live/src/contexts/auth.tsx:32-162`
  - `live/src/api/client.ts:1-99`
  - `live/src/api/types.ts:190-218`
  - `live/src/App.tsx:129-152` (route mount, `/credentials` outside `AuthProvider`)
  - `DEPLOYMENT.md:110-116` (existing curl-based register flow)
  - CLAUDE.md "Gotcha: `live/` is pnpm, not bun" — Phase 1 + 2 use `pnpm` inside `live/`.

## Review Errata

_Reviewed: 2026-05-04 by claude (desplega:reviewing, Auto-apply mode). No Critical findings. All Important + Minor items applied directly._

### Applied

- [x] **Important** — Phase 1 #1: specify endpoint trailing-slash normalization for register, mirroring `client.ts:17` and `Credentials.tsx:43`. — auto-applied
- [x] **Important** — Phase 1 #1: spell out 409 detection contract (`error.error === "CONFLICT"`, not message-string match) so the implementer doesn't write brittle UI code. — auto-applied
- [x] **Important** — Phase 1 #2: clarify saved-accounts list visibility — show in **both** Connect and Register modes so returning users always see their stored creds. — auto-applied
- [x] **Important** — Phase 2 #1 §3: add cross-user safety check on Replace key — if `getMe()` returns a different email than the credential currently shows, confirm before overwriting locally to prevent silent account swaps. — auto-applied
- [x] **Minor** — Phase 1 #2: explicit `<Input type="email" required />` for native browser validation. — auto-applied
- [x] **Minor** — Phase 2 #1 §1: clipboard API fallback for non-secure (plain-HTTP) origins. — auto-applied
- [x] **Minor** — Phase 2 #1 §2: explicit null-handling for `MeResponse.defaultOrgId` (drive count renders `—` when null). — auto-applied
- [x] **Minor** — Phase 2 #1 §3: `queryClient.invalidateQueries(["credential-details", id])` after successful Replace key, so the modal's Server section re-fetches. — auto-applied
- [x] **Minor** — Phase 2 Automated Verification: drop the hypothetical `mask-key.test.ts` reference (live/ has no test runner today) — verification covered in QA. — auto-applied
- [x] **Minor** — Appendix References: corrected `Credentials.tsx:1-200` → `1-201` to match actual file length. — auto-applied

