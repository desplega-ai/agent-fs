import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { resolveContext, subscribeDrive } from "@/core";
import type { DB } from "@/core";
import type { AppEnv } from "../types.js";

const MAX_STREAMS_PER_USER = 8;
const HEARTBEAT_MS = 5000;

export function eventRoutes(db: DB) {
  const router = new Hono<AppEnv>();
  const streams = new Map<string, number>();

  router.get("/:orgId/drives/:driveId/events", (c) => {
    const userId = c.get("user").id;
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

    try {
      return streamSSE(c, async (stream) => {
        let unsubscribe = () => {};
        let timer: ReturnType<typeof setInterval> | undefined;
        let finish!: () => void;
        const done = new Promise<void>((resolve) => { finish = resolve; });
        const abort = () => stream.abort();
        const cleanup = () => {
          unsubscribe();
          clearInterval(timer);
          c.req.raw.signal.removeEventListener("abort", abort);
          release();
          finish();
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
            })).catch(abort);
          });
          timer = setInterval(() => {
            pending = pending.then(async () => { await stream.write(": ping\n\n"); }).catch(abort);
          }, HEARTBEAT_MS);
          await pending;
          await done;
        } finally {
          cleanup();
        }
      });
    } catch (err) {
      release();
      throw err;
    }
  });

  return router;
}
