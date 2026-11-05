import { randomBytes } from "node:crypto"
import type { Page } from "@playwright/test"

export const ENDPOINT = "http://fixture.test"

type Hook = {
  id: string
  scope: "drive" | "org"
  driveId: string | null
  url: string
  description: string | null
  eventTypes: string[]
  enabled: boolean
  disabledReason: "gone" | "failing" | "manual" | null
  disabledAt: string | null
  consecutiveFailures: number
  lastSuccessAt: string | null
  lastFailureAt: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
  workerEnabled: boolean
}

type Delivery = {
  id: string
  subscriptionId: string
  eventId: string
  eventType: string
  status: "pending" | "delivered" | "failed"
  attempts: number
  nextAttemptAt: string | null
  lastAttemptAt: string | null
  lastStatusCode: number | null
  lastError: string | null
  deliveredAt: string | null
  createdAt: string
}

const ALL_EVENTS = [
  "comment.created",
  "comment.mentioned",
  "comment.updated",
  "comment.resolved",
  "comment.reopened",
  "comment.deleted",
]

const at = (minutesAgo: number) => new Date(Date.UTC(2026, 10, 5, 11, 0) - minutesAgo * 60_000).toISOString()

function hook(id: string, over: Partial<Hook>): Hook {
  return {
    id,
    scope: "drive",
    driveId: "work",
    url: `https://${id}.example.test/hook`,
    description: null,
    eventTypes: ALL_EVENTS,
    enabled: true,
    disabledReason: null,
    disabledAt: null,
    consecutiveFailures: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    createdBy: "qa",
    createdAt: at(600),
    updatedAt: at(600),
    workerEnabled: true,
    ...over,
  }
}

/**
 * The live app against an in-memory org with webhooks on drive "work". It
 * keeps the server's rules that matter to the page: webhook-list (scope all)
 * returns drive hooks to a drive admin and adds org hooks for an org admin,
 * everything else 403s; create and rotate return a fresh `whsec_` secret once
 * and nothing else ever returns it; redeliver is refused while the hook is off.
 */
export class WebhooksFixture {
  orgAdmin: boolean
  driveAdmin: boolean
  /** Fault injection: the drive list says admin but the webhook endpoint 403s (role lost mid-session). */
  listForbidden = false
  readonly hooks: Hook[] = [
    hook("comments", {
      url: "https://hooks.example.test/comments",
      description: "Comment bot",
      eventTypes: ["comment.created", "comment.mentioned"],
      lastSuccessAt: at(20),
      lastFailureAt: at(5),
      consecutiveFailures: 1,
    }),
    hook("orgwide", {
      scope: "org",
      driveId: null,
      url: "https://ops.example.test/agent-fs",
      description: "Org audit sink",
      lastSuccessAt: at(30),
    }),
  ]
  readonly deliveries: Delivery[] = [
    {
      id: "dl_failed",
      subscriptionId: "comments",
      eventId: "evt_2",
      eventType: "comment.mentioned",
      status: "failed",
      attempts: 8,
      nextAttemptAt: null,
      lastAttemptAt: at(5),
      lastStatusCode: 500,
      lastError: "Internal Server Error",
      deliveredAt: null,
      createdAt: at(300),
    },
    {
      id: "dl_ok",
      subscriptionId: "comments",
      eventId: "evt_1",
      eventType: "comment.created",
      status: "delivered",
      attempts: 1,
      nextAttemptAt: null,
      lastAttemptAt: at(20),
      lastStatusCode: 200,
      lastError: null,
      deliveredAt: at(20),
      createdAt: at(20),
    },
  ]
  /** Every secret handed out, in order. */
  readonly secrets: string[] = []
  /** One line per webhook op the UI sent. */
  readonly calls: string[] = []
  private n = 0

  constructor(opts: { orgAdmin?: boolean; driveAdmin?: boolean } = {}) {
    this.orgAdmin = opts.orgAdmin ?? true
    this.driveAdmin = opts.driveAdmin ?? true
  }

  private mint(): string {
    const secret = `whsec_${randomBytes(24).toString("base64")}`
    this.secrets.push(secret)
    return secret
  }

  private canManage(h: Hook): boolean {
    return h.scope === "org" ? this.orgAdmin : this.driveAdmin || this.orgAdmin
  }

  async install(page: Page) {
    await page.addInitScript((endpoint) => {
      localStorage.setItem("agent-fs-credentials", JSON.stringify([
        { id: "qa", name: "QA", endpoint, apiKey: "fixture" },
      ]))
      localStorage.setItem("agent-fs-active-credential", "qa")
    }, ENDPOINT)

    await page.route(`${ENDPOINT}/**`, async (route) => {
      const req = route.request()
      const url = new URL(req.url())
      const path = url.pathname
      const forbidden = () => route.fulfill({ status: 403, json: { error: "PERMISSION_DENIED", message: "Requires admin" } })
      const notFound = () => route.fulfill({ status: 404, json: { error: "NOT_FOUND", message: "Webhook not found" } })

      if (path === "/auth/me") return route.fulfill({ json: { userId: "qa", email: "qa@example.test", displayName: "QA Admin", defaultOrgId: "org", defaultDriveId: "work" } })
      if (path === "/orgs") return route.fulfill({ json: { orgs: [{ id: "org", name: "QA org", role: this.orgAdmin ? "admin" : "editor" }] } })
      if (path === "/health") return route.fulfill({ json: { ok: true, version: "test", features: ["drive-members"] } })
      if (path === "/orgs/org/drives") {
        if (url.searchParams.get("scope") === "manageable") {
          const admin = this.orgAdmin || this.driveAdmin
          return route.fulfill({ json: { drives: admin ? [{ id: "work", name: "work", isDefault: true, myRole: this.driveAdmin ? "admin" : "editor" }] : [] } })
        }
        return route.fulfill({ json: { drives: [{ id: "work", name: "work", orgId: "org", isDefault: true }] } })
      }
      if (path !== "/orgs/org/ops") return route.abort()

      const body = req.postDataJSON()
      const { op } = body
      switch (op) {
        case "ls": return route.fulfill({ json: { entries: [] } })
        case "comment-list": return route.fulfill({ json: { comments: [] } })
        case "comment-notification-list": return route.fulfill({ json: { notifications: [], unreadCount: 0 } })
        case "favorite-list": return route.fulfill({ json: { favorites: [] } })
        case "drive-members": return route.fulfill({ json: { members: [] } })
      }
      if (!String(op).startsWith("webhook-")) return route.abort()
      this.calls.push(`${op} ${JSON.stringify({ ...body, op: undefined, driveId: undefined })}`)
      const now = new Date().toISOString()

      if (op === "webhook-list") {
        if (this.listForbidden || !(this.driveAdmin || this.orgAdmin)) return forbidden()
        const visible = this.hooks.filter((h) => (h.scope === "org" ? this.orgAdmin : h.driveId === body.driveId))
        // The real server lists org hooks first.
        visible.sort((a, b) => (a.scope === b.scope ? 0 : a.scope === "org" ? -1 : 1))
        return route.fulfill({ json: { webhooks: visible } })
      }
      if (op === "webhook-create") {
        const scope = body.scope ?? "drive"
        if (scope === "org" ? !this.orgAdmin : !(this.driveAdmin || this.orgAdmin)) return forbidden()
        const created = hook(`wh_${++this.n}`, {
          scope,
          driveId: scope === "org" ? null : body.driveId,
          url: body.url,
          description: body.description ?? null,
          eventTypes: body.eventTypes,
          createdAt: now,
          updatedAt: now,
        })
        this.hooks.push(created)
        return route.fulfill({ json: { ...created, secret: this.mint() } })
      }
      if (op === "webhook-redeliver") {
        const d = this.deliveries.find((x) => x.id === body.deliveryId)
        const h = d && this.hooks.find((x) => x.id === d.subscriptionId)
        if (!d || !h) return notFound()
        if (!this.canManage(h)) return forbidden()
        if (!h.enabled) return route.fulfill({ status: 409, json: { error: "CONFLICT", message: "Webhook is disabled" } })
        Object.assign(d, { status: "pending", nextAttemptAt: now })
        return route.fulfill({ json: d })
      }

      const h = this.hooks.find((x) => x.id === body.id)
      if (!h) return notFound()
      if (!this.canManage(h)) return forbidden()
      switch (op) {
        case "webhook-update": {
          if (body.enabled !== undefined) {
            Object.assign(h, body.enabled
              ? { enabled: true, disabledReason: null, disabledAt: null, consecutiveFailures: 0 }
              : { enabled: false, disabledReason: "manual", disabledAt: now })
          }
          h.updatedAt = now
          return route.fulfill({ json: body.rotateSecret ? { ...h, secret: this.mint() } : h })
        }
        case "webhook-delete":
          this.hooks.splice(this.hooks.indexOf(h), 1)
          return route.fulfill({ json: { deleted: true } })
        case "webhook-test":
          return route.fulfill({ json: { ok: true, statusCode: 200, durationMs: 42, webhookId: "msg_ping" } })
        case "webhook-deliveries": {
          const rows = this.deliveries.filter((d) => d.subscriptionId === h.id && (!body.status || d.status === body.status))
          return route.fulfill({ json: { deliveries: rows, nextCursor: null } })
        }
      }
      return route.abort()
    })
  }
}
