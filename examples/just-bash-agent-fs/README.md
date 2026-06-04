# just-bash + agent-fs

This example uses `@desplega.ai/agent-fs-just-bash` as the filesystem
implementation for a `just-bash` shell.

The adapter dependency is local and relative:

```json
"@desplega.ai/agent-fs-just-bash": "file:../../packages/just-bash"
```

## Run

From this directory:

```bash
bun install
cp .env.example .env
# Edit .env with your org and drive ids.
bun run start
```

The example expects an agent-fs daemon or hosted API to be reachable. It reads:

- `AGENT_FS_API_URL` - defaults to `http://127.0.0.1:7433`
- `AGENT_FS_API_KEY`
- `AGENT_FS_ORG_ID`
- `AGENT_FS_DRIVE_ID`

`bun run start` first builds the local adapter package so the relative
dependency resolves through the same `exports` field the npm package uses.
