/**
 * Anonymized usage telemetry for the live UI: one `live.session_started`
 * event per browser session, sent to the Desplega telemetry proxy.
 *
 * The event carries a random browser ID and one boolean. No paths, file
 * content, emails, API keys, or server URLs. Disabled in dev builds, when
 * built with VITE_ANONYMIZED_TELEMETRY=false, or when the browser sends
 * Do Not Track. See docs/telemetry.md.
 */

const TELEMETRY_ENDPOINT = "https://proxy.desplega.sh/v1/events"
const ID_KEY = "agent-fs:telemetry-id"
const SESSION_KEY = "agent-fs:telemetry-session"

export interface TelemetryDeps {
  enabled: boolean
  doNotTrack: string | null | undefined
  hostname: string
  local: Pick<Storage, "getItem" | "setItem">
  session: Pick<Storage, "getItem" | "setItem">
  fetch: typeof fetch
}

function defaultDeps(): TelemetryDeps {
  return {
    enabled:
      import.meta.env.PROD &&
      !["false", "0"].includes(String(import.meta.env.VITE_ANONYMIZED_TELEMETRY ?? "").trim().toLowerCase()),
    doNotTrack: navigator.doNotTrack,
    hostname: location.hostname,
    local: localStorage,
    session: sessionStorage,
    fetch: window.fetch.bind(window),
  }
}

function randomHex(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16)
}

/** Fire-and-forget. Never throws. */
export function trackSessionStart(deps: TelemetryDeps = defaultDeps()): void {
  try {
    if (!deps.enabled || deps.doNotTrack === "1") return
    if (deps.session.getItem(SESSION_KEY)) return
    deps.session.setItem(SESSION_KEY, "1")

    let id = deps.local.getItem(ID_KEY)
    if (!id) {
      id = `browser_${randomHex()}`
      deps.local.setItem(ID_KEY, id)
    }

    const isCloud = deps.hostname === "agent-fs.dev" || deps.hostname.endsWith(".agent-fs.dev")
    deps
      .fetch(TELEMETRY_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product: "agent-fs",
          event: "live.session_started",
          occurred_at: new Date().toISOString(),
          source: "live",
          actor_mode: "anonymous",
          actor_anonymous_id: id,
          properties: { is_cloud: isCloud },
          metadata: { transport: "https", schema_version: 1, environment: "production", is_cloud: isCloud },
        }),
        keepalive: true,
      })
      .catch(() => {})
  } catch {
    // Never throw
  }
}
