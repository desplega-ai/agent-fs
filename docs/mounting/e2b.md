# Mounting agent-fs on E2B

> **Status**: untested. Best-effort instructions follow based on E2B's documented FUSE support. Please report results at <https://github.com/desplega-ai/agent-fs/issues>.

E2B sandboxes run on Firecracker microVMs whose kernel ships `CONFIG_FUSE_FS=y` — FUSE is a first-class capability. E2B's `connect-bucket` API uses FUSE (s3fs / gcsfuse / R2 helpers) under the hood, so the kernel-side plumbing is known to work. What we have **not** validated as of 2026-05-18 is `agent-fs mount` specifically running inside an E2B sandbox.

> See [`README.md`](./README.md) for the general overview and architecture. See [`fuse-compat.md`](../fuse-compat.md#e2b) for the upstream compatibility note.

## Expected prerequisites

E2B's default sandbox image (`base`) does **not** ship `fuse3`. You'll need a custom sandbox built from a Dockerfile that adds it.

### Dockerfile snippet (best-effort)

```dockerfile
FROM e2bdev/code-interpreter:latest

# fuse3 for agent-fs mount
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends fuse3 ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Bun (for `bun install -g @desplega.ai/agent-fs` — npm install -g aborts on stock Node 18.x)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Pre-install agent-fs (so the FUSE sub-package is resolved at image build time)
RUN bun install -g @desplega.ai/agent-fs

# fuse.conf — only needed if you mount with --allow-other
RUN echo user_allow_other >> /etc/fuse.conf

# /etc/mtab → /proc/mounts symlink (E2B base may or may not have this)
RUN [ -e /etc/mtab ] || ln -sf /proc/mounts /etc/mtab
```

Build with the E2B CLI:

```bash
e2b template build --name agent-fs-fuse --dockerfile e2b.Dockerfile
```

## Expected mount flow

Inside the sandbox (Python SDK example — adapt to JS as needed):

```python
from e2b_code_interpreter import Sandbox

sandbox = Sandbox(template="agent-fs-fuse")

# Configure auth
sandbox.commands.run("mkdir -p ~/.agent-fs")
sandbox.files.write("~/.agent-fs/config.json", """{
  "apiUrl": "https://agent-fs-taras.fly.dev",
  "apiKey": "<YOUR_API_KEY>"
}""")

# Mount
sandbox.commands.run("mkdir -p ~/mnt")
sandbox.commands.run("agent-fs mount ~/mnt --remote", background=True)

# Use
sandbox.commands.run("ls ~/mnt/current")
sandbox.commands.run("echo 'hello from e2b' > ~/mnt/current/e2b-test.txt")
```

## What might still go wrong

E2B's runtime documentation states FUSE works, but there are degrees of "works":

| Risk | What to check |
|---|---|
| `/dev/fuse` not exposed to the sandbox user | `ls -l /dev/fuse` inside the sandbox. If missing or unreadable, the E2B template may need to be configured to expose it — open a ticket. |
| `SYS_ADMIN` capability not granted | `agent-fs mount` will return `Operation not permitted`. E2B's stock template should have it; custom templates may strip it. |
| `fusermount3` not on `PATH` | Confirm the Dockerfile snippet above installed `fuse3`. |
| Sandbox lifecycle terminates the mount | Sandboxes can be paused/resumed. The mount may need to be re-established after resume. |

## Fallback: CLI / HTTP without mount

If `agent-fs mount` doesn't work in your E2B sandbox, fall back to direct CLI / HTTP. All file operations are reachable without FUSE:

```bash
agent-fs ls /
agent-fs cat /path/to/file
echo "..." | agent-fs write /path/to/file --stdin
```

## Help us validate this

If you successfully mount agent-fs in an E2B sandbox, please open a PR updating this doc with:

- E2B SDK version
- Sandbox template used (or full Dockerfile)
- Any extra steps not listed here
- A session log of `agent-fs mount ~/mnt --remote && ls ~/mnt`

Report at <https://github.com/desplega-ai/agent-fs/issues>.

## See also

- [`README.md`](./README.md) — overview and shared prerequisites
- [`fuse-compat.md`](../fuse-compat.md#e2b) — E2B in the sandbox compatibility matrix
- [`fuse-troubleshooting.md`](../fuse-troubleshooting.md) — full error catalogue
