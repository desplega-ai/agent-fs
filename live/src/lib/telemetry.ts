/**
 * Anonymized usage telemetry for the live UI: one `live.session_started`
 * event per browser session, sent to the Desplega telemetry proxy.
 *
 * The event carries a random browser ID, `is_cloud`, the app version, and
 * the entry route TEMPLATE (e.g. `/file/~/:orgId/:driveId/*`). Never the
 * concrete path: no file names, drive or org IDs, emails, API keys, or
 * server URLs. Disabled in dev builds, when
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
  pathname: string
  version: string
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
    pathname: location.pathname,
    version: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "unknown",
    local: localStorage,
    session: sessionStorage,
    fetch: window.fetch.bind(window),
  }
}

function randomHex(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16)
}

/** Route templates from App.tsx. Keep in sync when routes change. */
const ROUTE_TEMPLATES: [RegExp, string][] = [
  [/^\/credentials\/?$/, "/credentials"],
  [/^\/files\/?$/, "/files"],
  [/^\/orgs\/[^/]+\/files(\/.*)?$/, "/orgs/:orgId/files/*"],
  [/^\/file\/~\/[^/]+\/[^/]+(\/.*)?$/, "/file/~/:orgId/:driveId/*"],
  [/^\/detail\/~\/[^/]+\/[^/]+(\/.*)?$/, "/detail/~/:orgId/:driveId/*"],
  [/^\/sql\/~\/[^/]+\/[^/]+\/?$/, "/sql/~/:orgId/:driveId"],
  [/^\/?$/, "/"],
]

/** Map a concrete path to its route template; unknown paths become "other". */
export function routeTemplate(pathname: string): string {
  for (const [pattern, template] of ROUTE_TEMPLATES) {
    if (pattern.test(pathname)) return template
  }
  return "other"
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
          properties: {
            is_cloud: isCloud,
            version: deps.version,
            entry_route: routeTemplate(deps.pathname),
          },
          metadata: { transport: "https", schema_version: 1, environment: "production", is_cloud: isCloud },
        }),
        keepalive: true,
      })
      .catch(() => {})
  } catch {
    // Never throw
  }
}
