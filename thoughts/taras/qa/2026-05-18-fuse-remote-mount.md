---
date: 2026-05-18
author: taras
topic: "QA spec — FUSE remote-mount v0.7.0 (mount --remote + daemon-start + optional-dep fixes)"
status: passed
results_date: 2026-05-19
related:
  - thoughts/taras/plans/2026-05-18-fuse-remote-mount-and-fixes.md
  - https://github.com/desplega-ai/agent-fs/pull/15
---

# QA Spec — FUSE Remote-Mount v0.7.0

Functional validation of the 7-phase implementation that ships v0.7.0:
1. Daemon-start ENOENT bugfix (npm-installed CLI)
2. Optional FUSE subpackage auto-install bugfix (`libc` array → omitted)
3. `agent-fs mount --remote` — FUSE mount routed directly to a remote HTTP API
4. Docs / SKILL / release plumbing

PR: [#15](https://github.com/desplega-ai/agent-fs/pull/15) on `feat/fuse-remote-mount-v0.7`. Phase 7 prep at commit `841d8cb`.

## Test environments

| Env | Purpose | Status |
|---|---|---|
| **Local Docker** (`scripts/e2e-remote-mount.ts`) | Regression harness for the remote-mount path | ✅ 9/9 — Phase 5 |
| **Local Rust unit + integration** (`cargo test`) | HttpIpcClient per-op contract | ✅ 64/64 — Phases 3–4 |
| **Hetzner VM** (cx22, Ubuntu 24.04, fsn1) | First-party install-from-tarball + mount against fly drive | 🟡 In progress |
| **Sprite** (Taras-provided) | Real sandbox with the 4 prereq commands | ⏸ Pending Taras hand-off |

## Evidence capture

For each scenario:
- Capture command output to `thoughts/taras/qa/evidence/2026-05-18/<scenario-id>.log` (with sensitive data redacted).
- Note `agent-fs --version` actually run.
- Note pass/fail + any deviations inline below the scenario.

---

## Environment A — Local Docker (regression baseline)

### A-1: scripts/e2e-remote-mount.ts — full 9-op cycle

**Setup**: Docker Desktop / OrbStack running on Darwin.

**Steps**:
```bash
bun run scripts/e2e-remote-mount.ts
```

**Expected**:
- 9/9 tests pass: mount succeeds, drives listed, `current/` symlink visible, mkdir no-ops, host→mount visibility, echo+cat roundtrip, ls reflects new file, mv within drive, rm, fusermount3 -u clean exit
- Wallclock ≈ 4 min including cargo build
- No leftover containers / volumes / networks after teardown

**Status**: ✅ PASS — captured at Phase 5 commit `1b6cefe`. Re-run optional.

---

## Environment B — Hetzner VM (install from local tarball)

### Setup

**VM**: `cx22` Ubuntu 24.04, fsn1, hcloud project `local-cli`, key `taras-local-cli-tmp`. Created during this QA run; deleted at end.

**Prep the tarball on Darwin host**:
```bash
# From repo root
bun run build                                    # produces packages/cli/dist/cli.js
cd packages/cli && npm pack                      # → desplega.ai-agent-fs-0.7.0.tgz
cd ../fuse-helper-linux-x64 && npm pack          # → desplega.ai-agent-fs-fuse-linux-x64-0.7.0.tgz
# (helper sub-package bin/ is empty locally — see deviation note)
```

**Build the Linux helper binary** (needed because the sub-package tarball ships empty bin/):
```bash
cd packages/fuse-helper
docker run --rm -v "$PWD":/io -w /io rust:1.86-slim \
  bash -c "apt-get update && apt-get install -y musl-tools && rustup target add x86_64-unknown-linux-musl && cargo build --release --target x86_64-unknown-linux-musl"
# → target/x86_64-unknown-linux-musl/release/agent-fs-fuse
```

**scp everything to the VM**:
```bash
SERVER_IP=$(hcloud server ip agent-fs-v0-7-0-qa)
scp -o StrictHostKeyChecking=no \
    packages/cli/desplega.ai-agent-fs-0.7.0.tgz \
    packages/fuse-helper-linux-x64/desplega.ai-agent-fs-fuse-linux-x64-0.7.0.tgz \
    packages/fuse-helper/target/x86_64-unknown-linux-musl/release/agent-fs-fuse \
    root@$SERVER_IP:/root/
```

### B-1: Prereqs + global install

**Steps** (via SSH):
```bash
ssh root@$SERVER_IP
apt-get update -qq
apt-get install -y fuse3 nodejs npm

# Install main + sub-package side-by-side
npm install -g /root/desplega.ai-agent-fs-fuse-linux-x64-0.7.0.tgz
npm install -g /root/desplega.ai-agent-fs-0.7.0.tgz

# Wire the locally-built helper into the sub-package bin slot
SUBPKG=$(npm root -g)/@desplega.ai/agent-fs-fuse-linux-x64
mkdir -p "$SUBPKG/bin"
cp /root/agent-fs-fuse "$SUBPKG/bin/agent-fs-fuse"
chmod +x "$SUBPKG/bin/agent-fs-fuse"

agent-fs --version    # expect: 0.7.0
agent-fs --help       # expect: mount command present with --remote flag
```

**Expected**:
- Both packages install without `EOPTIONAL` / `libc filter` errors.
- `agent-fs --version` prints `0.7.0`.
- `agent-fs mount --help` shows `--remote`, `--api-url`, `--api-key` flags.

**Pass criteria**: exit codes 0; `0.7.0` printed; mount help text shows new flags.

### B-2: Daemon-start bugfix (Bug 1)

**Steps**:
```bash
# Was the failing case on 0.6.1: npm-installed CLI hit dist/index.ts ENOENT.
agent-fs daemon start
sleep 2
agent-fs daemon status
cat ~/.agent-fs/agent-fs.log | head -20
```

**Expected**:
- `daemon start` exits 0, prints `Daemon started (PID: ...)`.
- `daemon status` reports running.
- Log does NOT contain `Module not found` or `dist/index.ts`.
- Daemon process listening on the unix socket at `~/.agent-fs/agent-fs.sock`.

### B-3: Auth — remote API key against fly drive

**Steps**:
```bash
agent-fs daemon stop   # we're going --remote, daemon not needed

mkdir -p ~/.agent-fs
cat > ~/.agent-fs/config.json <<EOF
{
  "apiUrl": "https://agent-fs-taras.fly.dev",
  "apiKey": "<API_KEY redacted — provided by Taras>"
}
EOF

AGENT_FS_API_URL=https://agent-fs-taras.fly.dev \
AGENT_FS_API_KEY=<...> \
agent-fs auth whoami
```

**Expected**:
- whoami returns Taras's email + default org/drive (live fly response).
- HTTP 200 round-trip.

### B-4: mount --remote happy path (read-only)

**Steps**:
```bash
mkdir -p /mnt/agent-fs
agent-fs mount /mnt/agent-fs --remote &
MOUNT_PID=$!
sleep 3
mount | grep agent-fs    # expect: agent-fs on /mnt/agent-fs type fuse.agent-fs
ls /mnt/agent-fs                              # drive list
ls /mnt/agent-fs/current/                     # default drive root
cat /mnt/agent-fs/current/<some-known-file>   # if a file exists
```

**Expected**:
- Mount table shows `agent-fs on /mnt/agent-fs type fuse.agent-fs`.
- `ls /mnt/agent-fs` returns the drive list from fly.
- `cat` of a known file returns the same bytes as `agent-fs files cat` against the same path.

### B-5: mount --remote write ops

**Steps**:
```bash
FNAME="hetzner-qa-$(date +%s).txt"
echo "hetzner v0.7.0 qa $(date)" > /mnt/agent-fs/current/$FNAME
cat /mnt/agent-fs/current/$FNAME
ls /mnt/agent-fs/current/ | grep $FNAME
mv /mnt/agent-fs/current/$FNAME /mnt/agent-fs/current/${FNAME%.txt}-renamed.txt
ls /mnt/agent-fs/current/ | grep renamed
rm /mnt/agent-fs/current/${FNAME%.txt}-renamed.txt
ls /mnt/agent-fs/current/ | grep $FNAME && echo "FAIL: file still there" || echo "PASS: cleaned"
```

**Expected**:
- echo + cat roundtrip works (HTTP PUT then GET).
- mv within drive succeeds (POST /ops mv).
- rm removes the file (POST /ops rm).
- Dashboard shows the v1 history during the run (verify out-of-band).

### B-6: fusermount3 -u clean exit

**Steps**:
```bash
fusermount3 -u /mnt/agent-fs
wait $MOUNT_PID
echo "exit=$?"
mount | grep agent-fs && echo "FAIL: still mounted" || echo "PASS: unmounted"
```

**Expected**:
- fusermount3 exits 0.
- Helper process exits cleanly.
- Mount table no longer shows `fuse.agent-fs`.

### B-7: Tarball-resolved optional dependency (Bug 2 sanity)

**Steps**:
```bash
# Inspect what npm thinks of the optional dep after install
npm list -g @desplega.ai/agent-fs 2>&1 | grep -A 2 agent-fs-fuse
ls -la $(npm root -g)/@desplega.ai/
```

**Expected**:
- `@desplega.ai/agent-fs-fuse-linux-x64` is present in the global node_modules.
- `npm view @desplega.ai/agent-fs-fuse-linux-x64 libc` would return `undefined` (post-release; for tarball we just need it installed).

Note: full Bug 2 validation against the real npm registry is post-release — see C-1.

### Teardown

```bash
hcloud server delete agent-fs-v0-7-0-qa
hcloud ssh-key delete taras-local-cli-tmp
```

---

## Environment C — Existing sprite (Taras hand-off)

To be filled in once Taras provides sprite access. Same scenarios as B, with the 4 prereq commands run first:

```bash
sudo apt-get update -qq && sudo apt-get install -y fuse3
sudo chmod 666 /dev/fuse
sudo ln -sf /proc/mounts /etc/mtab
echo user_allow_other | sudo tee -a /etc/fuse.conf
```

### C-1: Post-release npm install (deferred to after merge)

Once v0.7.0 is on npm, on the sprite:

```bash
npm install -g @desplega.ai/agent-fs@0.7.0
# Should bring agent-fs-fuse-linux-x64 with it (Bug 2 fix). Was silently
# skipped on 0.6.1.
ls $(npm root -g)/@desplega.ai/   # expect: agent-fs + agent-fs-fuse-linux-*
agent-fs daemon start              # was broken on 0.6.1
agent-fs --version                 # 0.7.0
npm view @desplega.ai/agent-fs-fuse-linux-x64@0.7.0 libc  # expect: undefined
```

---

## Acceptance criteria

- [x] A-1: local Docker harness still 9/9 (regression baseline) — Phase 5
- [x] **B-1: Hetzner — global install + version + help** — agent-fs 0.7.0 installed; `--remote`/`--api-url`/`--api-key` flags visible
- [x] **B-2: Hetzner — daemon start exits cleanly (Bug 1 regression check)** — PID 9725, listened on 127.0.0.1:7433 + unix socket, log clean, stopped cleanly
- [x] **B-3: Hetzner — auth whoami against fly drive** — returned userId/email/defaultOrgId/defaultDriveId for `t@desplega.ai`
- [x] **B-4: Hetzner — mount --remote happy path (read)** — mount table shows `fuse.agent-fs`, drives listed, `current/` shows 17 real entries
- [x] **B-5: Hetzner — mount --remote write ops (echo/cat/mv/rm)** — `hetzner-qa-v0-7-0-1779142898.txt` written, read-back matched, renamed, removed
- [x] **B-6: Hetzner — fusermount3 -u clean exit** — unmounted, helper process exited
- [x] **B-7: Hetzner — FUSE subpackage in npm tree (Bug 2 sanity)** — both `agent-fs` and `agent-fs-fuse-linux-x64` present under `/usr/lib/node_modules/@desplega.ai/`
- [x] **C-1..C-6: Sprite (`code-health-scan`, Ubuntu 25.10)** — all 4 FUSE prereqs were already in place on this sprite (fuse3, /dev/fuse 0666, /etc/mtab → /proc/mounts, user_allow_other). bun install -g + helper build natively (1m6s) + inject into subpackage bin/. agent-fs 0.7.0 ran cleanly. mount --remote against fly succeeded; write/cat/mv/rm roundtrip succeeded; fusermount3 -u clean. Daemon start spawned correctly (Bug 1 fixed) but port 7433 was already occupied by a leftover bun process from a prior sprite test — separate issue, not a regression.

## Environment D — Real npm registry (post-release validation)

After v0.7.0 was published to npm (release workflow run `26065064538`, tag at commit `169935b`), re-ran the install + mount path against the actual published artifacts to confirm Bug 2 was end-to-end fixed on the wire.

### D-1: Hetzner cx23 Ubuntu 24.04 (fresh VM)

```bash
apt install -y fuse3 unzip curl
curl -fsSL https://bun.sh/install | bash
bun install -g @desplega.ai/agent-fs@0.7.0   # — pulls from real npm registry
```

Result:
- ✅ `agent-fs --version` → `0.7.0`
- ✅ Both `@desplega.ai/agent-fs` and `@desplega.ai/agent-fs-fuse-linux-x64` auto-installed in global `node_modules/@desplega.ai/`
- ✅ Helper binary present at `node_modules/@desplega.ai/agent-fs-fuse-linux-x64/bin/agent-fs-fuse` (3.67 MB, ELF 64-bit x86-64, stripped, dynamically linked) — shipped by the release workflow, **Bug 2 fully fixed on the wire**
- ✅ `agent-fs daemon start` → PID assigned, log clean, no `Module not found` / `dist/index.ts` — **Bug 1 fully fixed on the wire**
- ✅ `agent-fs auth whoami` against fly returns Taras's identity
- ✅ `mount --remote` against fly: mount table healthy, drive listing matches, write/cat/mv/rm roundtrip clean (file `hetzner-realnpm-1779145567.txt` → renamed → removed)
- ✅ `fusermount3 -u` clean exit

### D-2: Sprite `code-health-scan` Ubuntu 25.10

```bash
bun install -g @desplega.ai/agent-fs@0.7.0   # — fuse3 + /dev/fuse + mtab + user_allow_other already in place on this sprite
```

Result:
- ✅ same shape as Hetzner — both packages auto-installed, helper binary present (3.7 MB)
- ✅ `agent-fs daemon start` clean (had to clear a leftover bun process from earlier QA; daemon picked a fresh port 3013)
- ✅ `mount --remote` against fly: write/cat/mv/rm roundtrip clean (file `sprite-realnpm-1779145622.txt`)
- ✅ `fusermount3 -u` clean

**Bottom line**: a real-world user running `bun install -g @desplega.ai/agent-fs@0.7.0` on a fresh Ubuntu 24.04 (Hetzner) or 25.10 (sprite) machine gets a working `agent-fs mount --remote` against any agent-fs HTTP API. Both v0.7.0 bug fixes are validated against the published artifacts.

## Findings

### F-1: `npm install -g` fails on Ubuntu 24.04 default Node 18.19.1 (pre-existing, NOT a v0.7.0 regression)

`node-llama-cpp@3.18.1` postinstall uses ES2023 `import ... with { type: 'json' }` syntax which Node 18.19 cannot parse (added in 18.20). `npm install -g @desplega.ai/agent-fs` aborts before `agent-fs` ends up on PATH.

**Workarounds**:
- Node 20+ (the nodesource setup script bumped this VM to v22.22.2 → install succeeds)
- Bun's installer (`bun install -g @desplega.ai/agent-fs`) — what `docs/mounting/hetzner.md` actually recommends

**Suggested follow-ups** (separate plan, not blocking 0.7.0):
- `README.md` "FUSE mount (Linux)" snippet says `npm install -g @desplega.ai/agent-fs` without mentioning Bun. Either bump that to `bun install -g` (matching the Hetzner doc) or add a "Node 20+" prerequisite note. As-is, anyone copy-pasting from the README onto a stock Ubuntu 24.04 hits an opaque postinstall stack trace.
- Consider moving `node-llama-cpp` to `optionalDependencies`. The CLI bundle externalizes it via `--external node-llama-cpp` and the embedding feature is opt-in; declaring it required is what forces the postinstall failure to abort the whole install.

### F-2: `default` drive appears 3× under mount root

`ls /mnt/agent-fs` shows `current default default default example`. Likely a multi-org flat-namespace artifact (one "default" per org Taras belongs to). The helper's `list_drives` flattens across orgs without disambiguation, so duplicate slugs aren't deduplicated.

**Not a v0.7.0 regression** — same behavior under the local-daemon path. Worth a follow-up to scope drive names per org in the FUSE root (e.g., `<orgSlug>-<driveSlug>` or nested `<orgSlug>/<driveSlug>/...`), but out of scope here.

## Deviations / known limits

- **Sub-package tarball ships empty `bin/`** locally. The release workflow populates `bin/agent-fs-fuse` per platform. For B-1, we copy the locally-built binary into the sub-package's `bin/` slot after install. This mimics what the release workflow will produce but is NOT identical to a real `npm install -g @desplega.ai/agent-fs@0.7.0` from the registry — C-1 covers that.
- **Live fly drive** has stable state we shouldn't disturb. All writes go under a per-run timestamped filename and are deleted at end of B-5. If interrupted, manual cleanup may be needed (`agent-fs files rm`).
- **API key** is provided out-of-band by Taras; not embedded in this doc.
