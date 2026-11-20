# Testing the macOS mount

The branch `feat/macos-nfs-mount` mounts one agent-fs drive as a normal folder (`~/agent-fs`) on a Mac.
The CLI runs a small NFS server on `127.0.0.1` and mounts it with the `mount_nfs` that ships with macOS.
There is no kext, no macFUSE, and no app signing.
File contents never touch local disk: reads and unsaved writes live in the CLI's memory.

Copy-paste each block into Terminal, top to bottom. About 10 minutes.

## 0. Prerequisites

- A Mac with git (`xcode-select --install` if `git` is missing).
- An agent-fs server and an API key for it (the one you use with the web app).

## 1. Install the branch build

```bash
curl -fsSL https://raw.githubusercontent.com/desplega-ai/agent-fs/feat/macos-nfs-mount/scripts/install.sh \
  | AGENT_FS_BRANCH=feat/macos-nfs-mount AGENT_FS_NO_MOUNT=1 sh
```

This installs bun if missing, clones the branch to `~/.agent-fs-src`, builds it, and puts an `agent-fs` wrapper in `~/.bun/bin`.
Open a new terminal tab, then check:

```bash
which agent-fs        # ~/.bun/bin/agent-fs
agent-fs --version
```

Already have `@desplega.ai/agent-fs` installed globally? The wrapper replaces it. Go back after testing with `bun add -g @desplega.ai/agent-fs@latest`.

## 2. Connect the CLI to your server

Skip if `agent-fs auth whoami` already prints your user.

```bash
agent-fs config set apiUrl https://YOUR-AGENT-FS-SERVER
agent-fs config set apiKey YOUR_API_KEY
agent-fs auth whoami
agent-fs ls /          # the drive you will see in Finder
```

The mount uses the same org and drive as `agent-fs ls`. Pick another with `agent-fs --drive <driveId> mount`.

## 3. Mount and read

```bash
agent-fs mount              # mounts at ~/agent-fs
agent-fs mount status
ls ~/agent-fs
open ~/agent-fs             # Finder window
```

In Finder: select a `.md` or `.csv` file and press Space (Quick Look), then double-click to open it in its app.

If `mount` prints `mount_nfs failed`, macOS refused a mount without root. Use this instead and tell us:

```bash
agent-fs mount --serve-only --port 20490 &
mkdir -p ~/agent-fs
sudo /sbin/mount_nfs -o vers=3,tcp,port=20490,mountport=20490,locallocks,nfc,soft,intr,timeo=600,retrans=2,actimeo=3,rsize=1048576,wsize=1048576 127.0.0.1:/ ~/agent-fs
```

## 4. Write

```bash
echo "# hello from the mac mount" > ~/agent-fs/mac-test.md
agent-fs cat /mac-test.md
printf 'a,b\n1,2\n' > ~/agent-fs/mac-test.csv
agent-fs cat /mac-test.csv
```

Then open `mac-test.md` in TextEdit (or VS Code), change a line, save, and run `agent-fs cat /mac-test.md` again.
The upload happens when the app closes the file (NFS COMMIT), or after 2 s without writes.

## 5. Agent changes show up in Finder

```bash
agent-fs write /from-agent.md --content "written by an agent"
sleep 6; ls ~/agent-fs/from-agent.md && cat ~/agent-fs/from-agent.md
```

Expect a delay of up to about 5 s (2 s server listing cache plus 3 s macOS attribute cache).

## 6. No file contents on local disk

```bash
du -sh ~/.agent-fs
cat ~/agent-fs/some-big-file.pdf > /dev/null     # any large file on the drive
du -sh ~/.agent-fs                                 # same size as before
```

`~/.agent-fs` holds only config, the mount state file and `mount.log`.

## 7. Open in the web app

```bash
agent-fs open ~/agent-fs/mac-test.md          # opens live.agent-fs.dev on that file
agent-fs open --print ~/agent-fs/mac-test.md  # prints the URL only
```

The web app must already be connected to the same server in your browser.
Set `appUrl` (`agent-fs config set appUrl https://...`) to use a different web app.

## 8. Mount at login, plus Finder right-click

```bash
agent-fs unmount
agent-fs mount --install
```

This writes `~/Library/LaunchAgents/dev.agent-fs.mount.plist` (mounts at every login) and the Quick Action `~/Library/Services/Open in agent-fs.workflow`, then starts the mount.

In Finder, right-click a file in `~/agent-fs` and pick **Quick Actions > Open in agent-fs** (on some macOS versions it is under **Services**).
Not listed? Open System Settings > Privacy & Security > Extensions > Finder, and turn on **Open in agent-fs**.

Check the login mount without logging out:

```bash
launchctl kickstart -k gui/$(id -u)/dev.agent-fs.mount
sleep 3; agent-fs mount status
```

## 9. Clean up

```bash
agent-fs mount --uninstall     # removes the LaunchAgent and Quick Action, unmounts
rm -rf ~/.agent-fs-src ~/.bun/bin/agent-fs
```

## When something breaks

- Logs: `tail -50 ~/.agent-fs/mount.log`
- A stuck mount (Finder beach ball after the server died): `diskutil unmount force ~/agent-fs`, then `agent-fs mount`.
- Run attached to see every error: `agent-fs mount --foreground` (Ctrl-C unmounts).

## Known limits

- Each read fetches the whole file into memory, because the server has no range reads yet. Large files (multi-GB video) are slow and use that much RAM.
- Unsaved writes are held in RAM. If the CLI is killed with `kill -9` before an upload, those bytes are lost. A clean `agent-fs unmount` uploads first.
- Last writer wins: a save from the Mac overwrites a concurrent agent edit (the server keeps both versions in history).
- Renaming a folder that already exists on the drive fails. Renaming files works, and so does renaming a new empty folder.
- An empty folder created in Finder exists only until the mount stops. It becomes real once a file is saved in it.
- Finder's `.DS_Store` and `._*` files stay in memory and are never uploaded.
- Trash is disabled on the mount, so Finder offers "Delete Immediately", and the delete goes straight to the drive.
- One drive per mount. Symlinks and hard links are not supported.

## What was tested where

Tested on Linux (no root, so no kernel mount): the NFS server end to end with the independent libnfs client (`nfs-ls`, `nfs-cat`, `nfs-cp`, `nfs-stat`) against a real agent-fs daemon. That covers listing 300 files, reading md and csv, writing new files, a 3 MB binary round trip, and unicode, `#` and space file names.

Not tested anywhere yet (Mac-only):

- `mount_nfs` without sudo, and the exact mount options on current macOS.
- Finder, TextEdit and VS Code behaviour on the mount (atomic saves, Quick Look, Spotlight).
- The LaunchAgent at login, and the Quick Action appearing in Finder.
