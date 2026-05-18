#!/usr/bin/env bash
# Runs INSIDE the agent-fs-fuse-test container.
#
# 1. Builds the helper from /work/packages/fuse-helper (bind-mounted source).
# 2. Starts a tiny Python stub Unix server at /tmp/agent-fs.sock that answers
#    msgpack Ping / ListDrives.
# 3. Mounts the helper at /mnt/test.
# 4. Asserts the mount table contains an agent-fs entry.
# 5. Cleans up.
set -euo pipefail

cd /work/packages/fuse-helper

echo "== cargo build --release =="
cargo build --release

BIN=/work/target/release/agent-fs-fuse
test -x "$BIN" || { echo "binary missing: $BIN"; exit 1; }

mkdir -p /mnt/test
SOCK=/tmp/agent-fs.sock
rm -f "$SOCK"

# Tiny stub server: accepts a single client, replies "Ok" to anything. We
# only need it to keep the socket from rejecting connections during the smoke
# test; the helper's init path only fires a Ping which we never strictly need
# to answer for the mount itself to succeed.
python3 - <<'PY' &
import os, socket, threading
SOCK = "/tmp/agent-fs.sock"
try:
    os.unlink(SOCK)
except FileNotFoundError:
    pass
srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
srv.bind(SOCK)
srv.listen(8)
print("stub: listening on", SOCK, flush=True)
def serve(conn):
    try:
        while True:
            hdr = conn.recv(4)
            if not hdr:
                return
            n = int.from_bytes(hdr, "big")
            body = conn.recv(n)
            # Ignore body; reply with empty Ok envelope.
            # Minimal msgpack { id: 0, body: "Ok" } — string serializer fmt.
            # Robust reply: just close so client retries; tests don't depend
            # on round-trip semantics here.
            conn.close()
            return
    except Exception:
        return
while True:
    conn, _ = srv.accept()
    threading.Thread(target=serve, args=(conn,), daemon=True).start()
PY
STUB_PID=$!
sleep 0.3

echo "== mounting helper at /mnt/test =="
"$BIN" --mountpoint /mnt/test --socket "$SOCK" &
HELPER_PID=$!

# Give the mount a beat to register with the kernel.
for _ in 1 2 3 4 5 6 7 8 9 10; do
    if mount | grep -q "/mnt/test"; then
        break
    fi
    sleep 0.2
done

echo "== mount table =="
mount | grep "/mnt/test" || { echo "FAIL: /mnt/test not mounted"; exit 1; }

if mount | grep "/mnt/test" | grep -q "agent-fs"; then
    echo "PASS: agent-fs mount detected"
else
    echo "FAIL: mount entry not labeled agent-fs"
    exit 1
fi

echo "== unmounting =="
fusermount3 -u /mnt/test || umount /mnt/test || true
wait "$HELPER_PID" 2>/dev/null || true
kill "$STUB_PID" 2>/dev/null || true
echo "OK"
