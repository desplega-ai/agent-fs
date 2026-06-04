FROM oven/bun:1 AS builder

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

FROM oven/bun:1-slim

WORKDIR /app
COPY --from=builder /app/package.json /app/bun.lock ./
COPY --from=builder /app/packages/core/package.json packages/core/
COPY --from=builder /app/packages/cli/package.json packages/cli/
COPY --from=builder /app/packages/mcp/package.json packages/mcp/
COPY --from=builder /app/packages/server/package.json packages/server/
COPY --from=builder /app/packages/just-bash/package.json packages/just-bash/
COPY --from=builder /app/packages/fuse-helper-linux-x64/package.json packages/fuse-helper-linux-x64/
COPY --from=builder /app/packages/fuse-helper-linux-arm64/package.json packages/fuse-helper-linux-arm64/
RUN bun install --frozen-lockfile --production
COPY --from=builder /app/packages/cli/dist/ packages/cli/dist/

LABEL org.opencontainers.image.source="https://github.com/desplega-ai/agent-fs"

ENV AGENT_FS_HOME=/data
EXPOSE 7433

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:7433/health || exit 1

CMD ["bun", "run", "packages/cli/dist/cli.js", "server"]
