---
date: 2026-05-04
author: taras
topic: "QA spec — auto-register on /credentials + API key details modal"
status: ready
related:
  - thoughts/taras/plans/2026-04-30-auto-register-and-api-key-details.md
---

# QA Spec — Auto-Register + API Key Details

End-to-end functional validation for the two phases in [`thoughts/taras/plans/2026-04-30-auto-register-and-api-key-details.md`](../plans/2026-04-30-auto-register-and-api-key-details.md). Runs against a **local** agent-fs server (no Fly / hosted dependency).

## Environment

### Prereqs

- Bun installed (CLI/server) and pnpm installed (live).
- A clean `AGENT_FS_HOME` for each run so we exercise true first-time state. Use a temp dir to avoid trampling `~/.agent-fs/`.

### One-shot setup script

```bash
# Pick a unique home so previous runs don't leak users.
export AGENT_FS_HOME="$(mktemp -d -t agent-fs-qa-XXXX)"
export AGENT_FS_API_URL="http://localhost:8787"

# Terminal 1 — daemon
bun run packages/cli/src/index.ts serve --port 8787 \
  2>&1 | tee /tmp/agent-fs-qa-daemon.log

# Terminal 2 — live SPA
cd live && pnpm install && pnpm dev   # default Vite port 5173
```

Open `http://localhost:5173` in a fresh browser profile (or run `localStorage.clear()` in DevTools before each scenario).

### Cleanup

- Kill daemon (Ctrl-C) and `rm -rf "$AGENT_FS_HOME"`.
- `localStorage.clear()` between scenarios to reset both `agent-fs-credentials` and `agent-fs-active-credential`.

## Evidence Capture

For each scenario, record:
- A screenshot at the expected-result step (PNG under `thoughts/taras/qa/evidence/2026-05-04/<scenario-id>.png`).
- The relevant `localStorage` snapshot at the end (paste JSON into the scenario notes).
- Daemon log excerpt if the scenario asserts server-side behavior (e.g. 409 path).

---

## Phase 1 — Inline auto-register

### P1-1: Happy path register

**Steps**:
1. `localStorage.clear()`; reload `/`.
2. Verify auto-redirect to `/credentials`.
3. Click "Register new account" mode toggle.
4. Endpoint `http://localhost:8787`, email `qa-p1-1-$(date +%s)@test.local`, name `QA P1-1`.
5. Submit.

**Expected**:
- Navigates to `/files`.
- File browser renders the empty personal drive (no errors in console).
- `localStorage.agent-fs-credentials` has one entry; `apiKey` matches `^af_[0-9a-f]{64}$`.
- `localStorage.agent-fs-active-credential` matches that entry's `id`.
- Daemon log shows `POST /auth/register 200`.

**Pass criteria**: All four bullets above. **Fail**: any missing.

### P1-2: Duplicate email

**Steps**:
1. Run P1-1 once and capture the email.
2. `localStorage.clear()`; reload.
3. Register again with the *same* email.

**Expected**:
- Stay on `/credentials`.
- Visible error "User with this email already exists" (or close phrasing) — actionable hint to switch to Connect.
- Daemon log shows `POST /auth/register 409`.
- `localStorage.agent-fs-credentials` is empty (no partial save).

### P1-3: Unreachable endpoint

**Steps**:
1. `localStorage.clear()`.
2. Register with endpoint `http://localhost:9999` (no daemon there), valid email.

**Expected**:
- In-form error referencing network failure (e.g. "Failed to fetch" or "Connection failed").
- No localStorage mutation.
- No console crash.

### P1-4: Mode toggle preserves layout

**Steps**:
1. `/credentials`, default Connect mode.
2. Switch to Register mode, then back to Connect.

**Expected**:
- Form fields swap (Register hides API-key field, Connect re-shows it).
- No layout shift / overflow on the centered card.
- Saved-accounts list (if any) stays visible below the form.

### P1-5: Personal drive readable post-register

**Steps**:
1. Run P1-1.
2. After landing on `/files`, refresh the browser.

**Expected**:
- Stays on `/files` (no redirect to `/credentials`) — confirms `/auth/me` validates the new key.
- File browser shell loads; org/drive selectors show the personal org and default drive.

---

## Phase 2 — Credential details modal

### Pre-state

Run P1-1 to seed at least one credential. Optionally run P1-1 with a second email to seed a second credential for multi-account scenarios.

### P2-1: Open Details

**Steps**:
1. Navigate to `/credentials` (sign out / clear active credential or use the saved-accounts list).
2. Click "Details" on the seeded credential.

**Expected**:
- Modal opens.
- **Local section**: shows `name`, `endpoint`, masked key (format `af_xxxx…<4chars>`), internal `id` (UUID).
- **Server section** (after spinner): `email` matches what was registered, `userId` is a UUID, `defaultOrgId` non-null, `defaultDriveId` non-null, `Orgs: 1`, `Drives in default org: 1`.

### P2-2: Show / hide masked key

**Steps**:
1. From open modal, click the show/hide eye toggle on the key.

**Expected**:
- Toggles between masked (`af_xxxx…f3a2`) and full plaintext key.
- Aria-label flips between "Show API key" / "Hide API key".

### P2-3: Copy key

**Steps**:
1. From open modal, click Copy.
2. In DevTools console: `await navigator.clipboard.readText()`.

**Expected**:
- Returned string equals the credential's plaintext key.
- Visible "Copied" toast or icon flash (whichever the impl uses).

### P2-4: Replace key — valid

**Steps**:
1. Open Details on credential A (active or not).
2. Run `agent-fs auth register qa-p2-4-$(date +%s)@test.local` to mint a fresh valid key (or run P1-1 in another browser to avoid contaminating localStorage).
3. Paste the fresh key into Replace key field. Save.

**Expected**:
- Modal shows success / closes.
- Reopen Details — masked key reflects the *new* key's last 4 hex chars.
- `localStorage.agent-fs-credentials`: same `id`, updated `apiKey`.
- Server section re-fetches and shows the *new* user's `email` / `userId`.

### P2-5: Replace key — invalid

**Steps**:
1. Open Details.
2. Replace key field: `af_invalid` (or random hex).
3. Save.

**Expected**:
- Inline error "Invalid API key" or 401 message.
- `localStorage.agent-fs-credentials` unchanged for that `id`.
- Modal stays open; user can retry or cancel.

### P2-6: Server unreachable graceful degradation

**Steps**:
1. Stop the daemon (Ctrl-C in Terminal 1).
2. Open Details on a credential pointing at the now-dead endpoint.

**Expected**:
- Local section renders fully.
- Server section shows a friendly error (e.g. "Server unreachable") instead of an indefinite spinner or unhandled exception.
- No console crash.

### P2-7: Multiple accounts — correct fields per card

**Steps**:
1. Seed two credentials (run P1-1 twice with different emails).
2. Open Details on credential B; close. Open Details on credential A.

**Expected**:
- Each modal shows that credential's specific `name`, `endpoint`, masked key, `id`, and the matching server-side `email` from `/auth/me`.
- No leak of credential A's data when viewing B.

---

## Regression checks

- [ ] Existing Connect flow (paste key + endpoint) still works after Phase 1+2.
- [ ] Existing "Quick Connect" (switch active credential from saved-accounts list) still works.
- [ ] Existing "Remove" (Trash) on saved-accounts cards still works after Phase 2.
- [ ] `/auth/me` redirect-on-error still routes back to `/credentials` (i.e. AuthProvider behavior unchanged).

## Out of scope (covered elsewhere)

- Magic-link / email verification — deferred per plan.
- Server schema metadata (`keyPrefix`, `lastUsedAt`) — deferred.
- CLI `agent-fs auth register` — already covered by `scripts/e2e.ts` if/when the CLI changes.
