import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getUserByApiKey, resolveContext, subscribeDrive, presenceSessionIdSchema } from "@/core";
import type { DB, PresenceRegistry } from "@/core";
import type { AppEnv } from "../types.js";

const MAX_STREAMS_PER_USER = 8;
const HEARTBEAT_MS = 5000;
// Writes still waiting on the client; past this the client has stopped reading and the stream closes.
const MAX_QUEUED_WRITES = 1000;
// How a stream whose client is behind gets its EOF. On Linux Bun drops a clean end queued behind
// unsent bytes, so the body is errored. On macOS Bun (1.4.4) never closes a connection whose body
// errors behind unsent bytes, but a clean end with "Connection: close" does reach the client.
const CLOSE_BY_ERROR = process.platform !== "darwin";

export function eventRoutes(db: DB, heartbeatMs = HEARTBEAT_MS, presence?: PresenceRegistry) {
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
    const withPresence = presence && c.req.query("presence") === "1" ? presence : undefined;
    const sessionId = presenceSessionIdSchema.safeParse(c.req.query("sessionId"));
    const unbind = withPresence && sessionId.success ? withPresence.bind(driveId, sessionId.data, userId) : () => {};
    streams.set(userId, count + 1);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const remaining = (streams.get(userId) ?? 1) - 1;
      if (remaining === 0) streams.delete(userId);
      else streams.set(userId, remaining);
    };

    // Errors the response body; set when the body below is built.
    let failBody = () => {};
    const response = streamSSE(c, async (stream) => {
      let unsubscribe = () => {};
      let unsubscribePresence = () => {};
      let timer: ReturnType<typeof setInterval> | undefined;
      let finish!: () => void;
      let cleaned = false;
      let queued = 0;
      const done = new Promise<void>((resolve) => { finish = resolve; });
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        unsubscribe();
        unsubscribePresence();
        unbind();
        clearInterval(timer);
        c.req.raw.signal.removeEventListener("abort", abort);
        release();
        finish();
      };
      const abort = () => {
        // A client that is behind would see no EOF until idleTimeout: see CLOSE_BY_ERROR.
        if (queued > 0 && CLOSE_BY_ERROR) failBody();
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
        let pending: Promise<unknown> = stream.writeSSE({
          event: "ready",
          data: JSON.stringify({ driveId, at: new Date().toISOString() }),
        });
        const enqueue = (write: () => Promise<unknown>) => {
          if (++queued > MAX_QUEUED_WRITES) return abort();
          pending = pending.then(write).finally(() => { queued--; });
        };
        if (withPresence) {
          const snapshot = withPresence.snapshot(driveId);
          pending = pending.then(() => stream.writeSSE({ event: "presence.snapshot", data: JSON.stringify(snapshot) }));
          unsubscribePresence = withPresence.subscribe(driveId, (event) => {
            enqueue(() => stream.writeSSE({ event: event.type, data: JSON.stringify(event) }));
          });
        }
        unsubscribe = subscribeDrive(driveId, (event) => {
          enqueue(() => stream.writeSSE({
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
          enqueue(() => stream.write(": ping\n\n"));
        }, heartbeatMs);
        await pending;
        await done;
      } finally {
        cleanup();
      }
    });
    const source = response.body!.getReader();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // No reason: Bun logs an errored body's reason as an uncaught error.
        failBody = () => controller.error();
      },
      async pull(controller) {
        const { done, value } = await source.read();
        try {
          if (done) controller.close();
          else controller.enqueue(value);
        } catch {
          // Already errored by failBody.
        }
      },
      cancel: (reason) => source.cancel(reason),
    });
    const result = new Response(body, response);
    if (!CLOSE_BY_ERROR) {
      // streamSSE sets keep-alive, which makes the clean end a last chunk and not an EOF.
      // Set it on both: Hono copies the context's headers over the response's when middleware touched c.res.
      c.header("Connection", "close");
      result.headers.set("Connection", "close");
    }
    return result;
  });

  return router;
}
