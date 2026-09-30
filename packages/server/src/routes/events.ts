import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getUserByApiKey, resolveContext, subscribeDrive } from "@/core";
import type { DB } from "@/core";
import type { AppEnv } from "../types.js";

const MAX_STREAMS_PER_USER = 8;
const HEARTBEAT_MS = 5000;

export function eventRoutes(db: DB, heartbeatMs = HEARTBEAT_MS) {
  const router = new Hono<AppEnv>();
  const streams = new Map<string, number>();

  router.get("/:orgId/drives/:driveId/events", (c) => {
    const userId = c.get("user").id;
    const apiKey = c.req.header("Authorization")!.slice(7);
    const { driveId } = resolveContext(db, {
      userId,
      orgId: c.req.param("orgId"),
      driveId: c.req.param("driveId"),
    });
    const count = streams.get(userId) ?? 0;
    if (count >= MAX_STREAMS_PER_USER) {
      return c.json({ error: "RATE_LIMITED", message: "Too many concurrent event streams" }, 429);
    }
    streams.set(userId, count + 1);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const remaining = (streams.get(userId) ?? 1) - 1;
      if (remaining === 0) streams.delete(userId);
      else streams.set(userId, remaining);
    };

    return streamSSE(c, async (stream) => {
      let unsubscribe = () => {};
      let timer: ReturnType<typeof setInterval> | undefined;
      let finish!: () => void;
      let cleaned = false;
      const done = new Promise<void>((resolve) => { finish = resolve; });
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        unsubscribe();
        clearInterval(timer);
        c.req.raw.signal.removeEventListener("abort", abort);
        release();
        finish();
      };
      const abort = () => {
        stream.abort();
        cleanup();
      };
      stream.onAbort(cleanup);
      c.req.raw.signal.addEventListener("abort", abort, { once: true });

      try {
        if (c.req.raw.signal.aborted || stream.aborted) {
          abort();
          return;
        }
        let pending = stream.writeSSE({
          event: "ready",
          data: JSON.stringify({ driveId, at: new Date().toISOString() }),
        });
        unsubscribe = subscribeDrive(driveId, (event) => {
          pending = pending.then(() => stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          }));
        });
        timer = setInterval(() => {
          const user = getUserByApiKey(db, apiKey);
          try {
            if (!user || user.id !== userId) throw new Error("Event stream authorization revoked");
            resolveContext(db, { userId, orgId: c.req.param("orgId"), driveId });
          } catch {
            abort();
            return;
          }
          pending = pending.then(async () => { await stream.write(": ping\n\n"); });
        }, heartbeatMs);
        await pending;
        await done;
      } finally {
        cleanup();
      }
    });
  });

  return router;
}
