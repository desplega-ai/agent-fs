FROM oven/bun:1.4.4 AS builder

WORKDIR /app
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY packages/mcp/package.json packages/mcp/
COPY packages/server/package.json packages/server/
COPY packages/just-bash/package.json packages/just-bash/
# fuse-helper sub-packages are workspace members; bun needs their manifests to
# resolve the lockfile cleanly (`--frozen-lockfile` fails otherwise). The
# binaries themselves aren't needed inside this image — the daemon container
# never mounts FUSE.
COPY packages/fuse-helper-linux-x64/package.json packages/fuse-helper-linux-x64/
COPY packages/fuse-helper-linux-arm64/package.json packages/fuse-helper-linux-arm64/
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

FROM oven/bun:1.4.4-slim

WORKDIR /app
COPY --from=builder /app/package.json /app/bun.lock ./
COPY --from=builder /app/packages/core/package.json packages/core/
COPY --from=builder /app/packages/cli/package.json packages/cli/
COPY --from=builder /app/packages/mcp/package.json packages/mcp/
COPY --from=builder /app/packages/server/package.json packages/server/
COPY --from=builder /app/packages/just-bash/package.json packages/just-bash/
COPY --from=builder /app/packages/fuse-helper-linux-x64/package.json packages/fuse-helper-linux-x64/
COPY --from=builder /app/packages/fuse-helper-linux-arm64/package.json packages/fuse-helper-linux-arm64/
COPY docker/prune-node-modules.sh /usr/local/bin/prune-node-modules
# Prune in the same step as the install so the removed files never reach a
# layer: GPU and other-platform native builds, and bun's cache, were most of
# the image. See docker/prune-node-modules.sh for what goes and why.
RUN bun install --frozen-lockfile --production && prune-node-modules
COPY --from=builder /app/packages/cli/dist/ packages/cli/dist/

LABEL org.opencontainers.image.source="https://github.com/desplega-ai/agent-fs"

ENV AGENT_FS_HOME=/data
# The server binds 127.0.0.1 by default, which a published port cannot reach.
ENV SERVER_HOST=0.0.0.0
EXPOSE 7433

# The slim base has no curl or wget, so the check uses bun itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.SERVER_PORT || process.env.PORT || 7433) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["bun", "run", "packages/cli/dist/cli.js", "server"]
