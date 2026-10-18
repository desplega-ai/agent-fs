import { useEffect } from "react"
import { useQuery } from "@tanstack/react-query"
import type { AgentFsClient } from "@/api/client"
import type { PresenceEvent, PresenceSnapshot } from "@/api/types"
import { useAuth } from "@/contexts/auth"
import { createThrottle, supportsPresence } from "@/lib/presence"
import { healthQueryOptions } from "@/lib/upload-limit"
import { createSseParser, type SseFrame } from "@/lib/sse"
import { commentAnchors } from "@/stores/comment-anchors"
import { presenceStore } from "@/stores/presence"

const LIVENESS_MS = 15_000
const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 30_000
const POLL_MS = 10_000
const STREAM_RETRY_MS = 60_000
const HEARTBEAT_MS = 15_000
const POINTER_THROTTLE_MS = 100
const STATE_THROTTLE_MS = 300
const POINTER_PAUSE_MS = 10_000

/**
 * Runs presence for the active drive while the server advertises it: one
 * event stream per tab (or a snapshot poll when the per-user stream cap is
 * reached) feeding the presence store, and the publisher that PUTs this tab's
 * state. Renders nothing. With an older server it makes no requests at all.
 */
export function PresenceConnection() {
  const { client, orgId, driveId, user } = useAuth()
  // Reads the health query the header's indicator polls (useHealth); a second
  // polling observer here would double the /health traffic.
  const { data: health } = useQuery(healthQueryOptions(client))
  const enabled = supportsPresence(health)
  const userId = user?.userId
  useEffect(() => {
    if (!enabled || !orgId || !driveId || !userId) return
    return startPresence(client, orgId, driveId, userId)
  }, [enabled, client, orgId, driveId, userId])
  return null
}

function startPresence(client: AgentFsClient, orgId: string, driveId: string, userId: string): () => void {
  // A fresh id per page load, not one kept in sessionStorage: a duplicated tab
  // copies sessionStorage, and two tabs on one id would overwrite each other.
  // A reload loses nothing, because closing the old stream drops its session.
  const sessionId = crypto.randomUUID()
  let stopped = false
  let polling = false
  let stream: AbortController | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let backoff = BACKOFF_MIN_MS
  let pointerPausedUntil = 0
  let lastSent: string | null = null
  let inFlight = false
  let queued: { force: boolean } | null = null

  presenceStore.start(userId)

  // --- Publisher ------------------------------------------------------------

  // One PUT at a time, so a slow earlier PUT cannot land after a later one and
  // leave a stale state on the server. A send during a PUT runs after it.
  const send = (force = false) => {
    if (stopped) return
    if (inFlight) {
      queued = { force: force || queued?.force === true }
      return
    }
    const state = presenceStore.getLocalState()
    const body = JSON.stringify(state)
    if (!force && body === lastSent) return
    lastSent = body
    inFlight = true
    client.putPresence(orgId, driveId, sessionId, state)
      .catch((err: { status?: number }) => {
        lastSent = null
        // Over the presence rate limit: hold pointer moves, keep the rest and the heartbeat.
        if (err?.status === 429) pointerPausedUntil = Date.now() + POINTER_PAUSE_MS
      })
      .finally(() => {
        inFlight = false
        const next = queued
        queued = null
        if (next) send(next.force)
      })
  }
  const throttle = createThrottle(() => send())
  const unsubscribeLocal = presenceStore.subscribeLocal((change) => {
    if (change === "pointer" && Date.now() < pointerPausedUntil) return
    throttle.request(change === "pointer" ? POINTER_THROTTLE_MS : STATE_THROTTLE_MS)
  })
  const heartbeat = setInterval(() => send(true), HEARTBEAT_MS)
  throttle.request(0)

  // Hovering a comment card or its highlight counts as viewing that thread.
  const unsubscribeHover = commentAnchors.subscribe(() =>
    presenceStore.setCommentActivity("hover", commentAnchors.getHovered()?.id ?? null),
  )

  const onVisibility = () => {
    if (document.hidden) presenceStore.dropPointer()
  }
  // Best effort: the stream's close also drops the session, and the server
  // expires it after 45 s without a PUT.
  const onPageHide = () => {
    lastSent = null
    void client.deletePresence(orgId, driveId, sessionId, { keepalive: true }).catch(() => {})
  }
  const onPageShow = (e: PageTransitionEvent) => {
    if (e.persisted) send(true)
  }
  document.addEventListener("visibilitychange", onVisibility)
  window.addEventListener("pagehide", onPageHide)
  window.addEventListener("pageshow", onPageShow)

  // --- Stream ---------------------------------------------------------------

  const onFrame = (frame: SseFrame) => {
    let data: unknown
    try {
      data = JSON.parse(frame.data)
    } catch {
      return
    }
    switch (frame.event) {
      case "ready":
        backoff = BACKOFF_MIN_MS
        stopPolling()
        presenceStore.setMode("stream")
        // The session went away with the previous stream, if there was one.
        send(true)
        break
      case "presence.snapshot":
        presenceStore.setSessions((data as PresenceSnapshot).sessions ?? [])
        break
      case "presence.updated":
        presenceStore.upsertSession((data as Extract<PresenceEvent, { type: "presence.updated" }>).session)
        break
      case "presence.left":
        presenceStore.removeSession((data as Extract<PresenceEvent, { type: "presence.left" }>).sessionId)
        break
      // file.changed / comment.changed: not used here yet.
    }
  }

  const connect = async () => {
    reconnectTimer = undefined
    if (stopped) return
    const controller = new AbortController()
    stream = controller
    let liveness: ReturnType<typeof setTimeout> | undefined
    // The server pings every 5 s. Silence for 15 s means a dead connection.
    const alive = () => {
      clearTimeout(liveness)
      liveness = setTimeout(() => controller.abort(), LIVENESS_MS)
    }
    try {
      alive()
      const res = await client.openDriveEvents(orgId, driveId, { sessionId, signal: controller.signal })
      if (res.status === 429) {
        // Over the per-user stream cap: poll the snapshot instead.
        startPolling()
        return
      }
      if (!res.ok || !res.body) throw new Error(`Event stream: HTTP ${res.status}`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      const feed = createSseParser({ onFrame })
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        alive()
        feed(decoder.decode(value, { stream: true }))
      }
    } catch {
      // Network error, a dead connection, or teardown: handled below like a clean end.
    } finally {
      clearTimeout(liveness)
      if (stream === controller) stream = null
    }
    if (stopped) return
    // The stream is gone. Outside poll mode the list can no longer be trusted.
    if (!polling) {
      presenceStore.setMode("off")
      presenceStore.setSessions([])
    }
    if (polling) {
      reconnectTimer = setTimeout(connect, STREAM_RETRY_MS)
      return
    }
    reconnectTimer = setTimeout(connect, backoff)
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
  }

  // --- Poll fallback --------------------------------------------------------

  const poll = async () => {
    try {
      const snapshot = await client.getPresence(orgId, driveId)
      if (!stopped && polling) presenceStore.setSessions(snapshot.sessions)
    } catch {
      // Keep the last list; the next poll retries.
    }
  }

  const startPolling = () => {
    if (!polling) {
      polling = true
      presenceStore.setMode("poll")
      void poll()
      pollTimer = setInterval(poll, POLL_MS)
    }
    // A stream slot frees up when another tab closes: try again later.
    reconnectTimer = setTimeout(connect, STREAM_RETRY_MS)
  }

  function stopPolling() {
    if (!polling) return
    polling = false
    clearInterval(pollTimer)
  }

  void connect()

  return () => {
    stopped = true
    stream?.abort()
    clearTimeout(reconnectTimer)
    clearInterval(pollTimer)
    clearInterval(heartbeat)
    throttle.cancel()
    unsubscribeLocal()
    unsubscribeHover()
    document.removeEventListener("visibilitychange", onVisibility)
    window.removeEventListener("pagehide", onPageHide)
    window.removeEventListener("pageshow", onPageShow)
    void client.deletePresence(orgId, driveId, sessionId).catch(() => {})
    presenceStore.stop()
  }
}
