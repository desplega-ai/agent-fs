# @desplega.ai/agent-fs-just-bash

`just-bash` compatible filesystem adapter for agent-fs.

```ts
import { Bash } from "just-bash";
import { AgentFsFileSystem } from "@desplega.ai/agent-fs-just-bash";

const fs = new AgentFsFileSystem({
  baseUrl: "http://127.0.0.1:7433",
  apiKey: process.env.AGENT_FS_API_KEY,
  orgId: "org_...",
  driveId: "drive_...",
});

const bash = new Bash({ fs, cwd: "/" });
await bash.exec("cat README.md");
```

The adapter talks to the agent-fs daemon HTTP API. It uses `/raw` for byte-safe
reads and writes, and `/ops` for `ls`, `stat`, `rm`, `cp`, and `mv`.

## Supported semantics

- Files are read and written as raw bytes.
- Directories are agent-fs prefixes. Empty directories are represented with a
  hidden `.agent-fs-dir` marker file that this adapter filters from `readdir`.
- `appendFile` creates files when missing.
- `chmod` and `utimes` verify the path exists, then no-op because agent-fs does
  not persist POSIX mode or caller-supplied timestamps.
- Symlink creation is not supported and throws `EPERM`; `lstat` is equivalent to
  `stat`; `realpath` returns the normalized virtual path.
- Hard links are approximated as file copies.

`getAllPaths()` is synchronous in the `just-bash` interface, so this adapter
returns a local cache of paths discovered through reads, writes, and listings.
Call `await fs.refreshAllPaths()` before shell commands that rely on globbing an
already-populated remote drive.
