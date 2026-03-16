FROM oven/bun:1 AS builder

WORKDIR /app
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY packages/mcp/package.json packages/mcp/
COPY packages/server/package.json packages/server/
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
RUN bun install --frozen-lockfile --production
COPY --from=builder /app/packages/cli/dist/ packages/cli/dist/

ENV AGENT_FS_HOME=/data
EXPOSE 7433

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:7433/health || exit 1

CMD ["bun", "run", "packages/cli/dist/cli.js", "server", "--host", "0.0.0.0"]
