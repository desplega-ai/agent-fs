import { randomBytes } from "node:crypto"
import type { BrowserContext, Page, Route } from "@playwright/test"

export const ENDPOINT = "http://fixture.test"
export type Role = "viewer" | "editor" | "admin"

type User = { id: string; email: string; apiKey: string }
type Invite = {
  id: string
  email: string
  orgRole: Role
  drives: { driveId: string; role: Role }[]
  token: string
  createdAt: Date
  expiresAt: Date
  revoked: boolean
  accepted: boolean
}

export const DRIVES = [
  { id: "work", name: "work", isDefault: true },
  { id: "context", name: "context", isDefault: false },
  { id: "ledger", name: "ledger", isDefault: false },
]

const DAY = 24 * 3600 * 1000

/**
 * An in-memory org ("QA org", admin qa@example.test, drives work/context/ledger)
 * served to any number of browser contexts at once, so a test can invite in one
 * context and accept in another. Identity comes from the Bearer key, as on the
 * real server; registering also creates a personal org, as the real one does.
 */
export class InviteFixture {
  readonly users = new Map<string, User>()
  readonly orgMembers = new Map<string, Role>()
  readonly driveMembers: Record<string, Map<string, Role>> = {
    work: new Map(),
    context: new Map(),
    ledger: new Map(),
  }
  readonly invites: Invite[] = []
  /** One line per write the UI made: invite, add, revoke, accept. */
  readonly calls: string[] = []
  /** Fault injection: what the server does to the reads the dialog depends on. */
  healthDown = false
  membersDelayMs = 0
  membersFail = false
  manageableFail = false

  constructor() {
    const admin = this.addUser("qa@example.test", "admin-key", "qa")
    this.orgMembers.set(admin.id, "admin")
    for (const d of DRIVES) this.driveMembers[d.id].set(admin.id, "admin")
    const ana = this.addUser("ana@example.test", "ana-key", "ana")
    this.orgMembers.set(ana.id, "editor")
    this.driveMembers.work.set(ana.id, "editor")
  }

  private addUser(email: string, apiKey: string, id = `u-${randomBytes(4).toString("hex")}`): User {
    const user = { id, email, apiKey }
    this.users.set(id, user)
    return user
  }

  /** An account that exists but belongs to no org, as after registering. */
  register(email: string, apiKey = `key-${randomBytes(4).toString("hex")}`) {
    return this.addUser(email.trim().toLowerCase(), apiKey)
  }

  userByEmail(email: string) {
    return [...this.users.values()].find((u) => u.email === email.trim().toLowerCase())
  }

  /** Make the invite expire, as if seven days passed. */
  expire(token: string) {
    const invite = this.invites.find((i) => i.token === token)
    if (invite) invite.expiresAt = new Date(Date.now() - 1000)
  }

  /** Store credentials in the page so it opens signed in. */
  async signIn(target: Page | BrowserContext, apiKey: string, name = "QA") {
    await target.addInitScript(
      ([endpoint, key, label]) => {
        localStorage.setItem("agent-fs-credentials", JSON.stringify([{ id: "cred", name: label, endpoint, apiKey: key }]))
        localStorage.setItem("agent-fs-active-credential", "cred")
      },
      [ENDPOINT, apiKey, name] as const,
    )
  }

  async install(target: Page | BrowserContext) {
    await target.route(`${ENDPOINT}/**`, (route) => this.handle(route))
  }

  private open(token: string) {
    const invite = this.invites.find((i) => i.token === token)
    return invite && !invite.revoked && !invite.accepted && invite.expiresAt.getTime() > Date.now() ? invite : null
  }

  private async handle(route: Route) {
    const req = route.request()
    const path = new URL(req.url()).pathname
    const query = new URL(req.url()).searchParams
    const method = req.method()
    const key = req.headers()["authorization"]?.replace(/^Bearer /, "")
    const user = [...this.users.values()].find((u) => u.apiKey === key)
    const isOrgAdmin = !!user && this.orgMembers.get(user.id) === "admin"
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body })
    const forbidden = () => json({ error: "PERMISSION_DENIED", message: "This operation requires 'admin' role in the org" }, 403)
    const gone = () => json({ error: "NOT_FOUND", message: "Invite not found or no longer valid" }, 404)

    if (path === "/health") {
      if (this.healthDown) return json({ error: "UNAVAILABLE", message: "down" }, 503)
      return json({ ok: true, version: "test", features: ["drive-members", "drive-invites", "pending-invites"] })
    }

    if (path === "/auth/register" && method === "POST") {
      const { email } = req.postDataJSON()
      if (this.userByEmail(email)) return json({ error: "CONFLICT", message: "Email already registered" }, 409)
      const created = this.addUser(email.trim().toLowerCase(), `key-${randomBytes(6).toString("hex")}`)
      return json({ apiKey: created.apiKey, userId: created.id, orgId: `personal-${created.id}` })
    }

    const preview = path.match(/^\/invites\/([^/]+)$/)
    if (preview && method === "GET") {
      const invite = this.open(preview[1])
      if (!invite) return gone()
      return json({
        orgId: "org",
        orgName: "QA org",
        invitedBy: "QA Admin",
        email: invite.email,
        drives: invite.drives.map((g) => ({ driveId: g.driveId, name: g.driveId, role: g.role })),
        expiresAt: invite.expiresAt.toISOString(),
      })
    }

    if (!user) return json({ error: "UNAUTHORIZED", message: "Invalid API key" }, 401)

    const accept = path.match(/^\/invites\/([^/]+)\/accept$/)
    if (accept && method === "POST") {
      const invite = this.open(accept[1])
      if (!invite) return gone()
      if (invite.email !== user.email) {
        return json({ error: "PERMISSION_DENIED", message: `This invite is for ${invite.email}` }, 403)
      }
      this.calls.push(`accept ${user.email}`)
      invite.accepted = true
      this.orgMembers.set(user.id, invite.orgRole)
      for (const g of invite.drives) this.driveMembers[g.driveId].set(user.id, g.role)
      return json({ ok: true, orgId: "org", role: invite.orgRole, drives: invite.drives, skippedDrives: [] })
    }

    if (path === "/auth/me") {
      return json({
        userId: user.id,
        email: user.email,
        displayName: null,
        defaultOrgId: user.id === "qa" ? "org" : `personal-${user.id}`,
        defaultDriveId: user.id === "qa" ? "work" : `personal-drive-${user.id}`,
      })
    }

    if (path === "/orgs") {
      const role = this.orgMembers.get(user.id)
      const orgs: { id: string; name: string; role: Role }[] = role ? [{ id: "org", name: "QA org", role }] : []
      if (user.id !== "qa" && user.id !== "ana") orgs.unshift({ id: `personal-${user.id}`, name: user.email, role: "admin" })
      return json({ orgs })
    }

    if (path.startsWith("/orgs/personal-")) {
      if (path.endsWith("/drives")) return json({ drives: [{ id: `personal-drive-${user.id}`, name: "default", orgId: "p", isDefault: true }] })
      return route.abort()
    }

    if (path === "/orgs/org/drives") {
      const mine = DRIVES.filter((d) => this.driveMembers[d.id].has(user.id))
      if (query.get("scope") === "manageable") {
        if (this.manageableFail) return json({ error: "INTERNAL", message: "Drive list unavailable" }, 500)
        const manageable = DRIVES.filter((d) => isOrgAdmin || this.driveMembers[d.id].get(user.id) === "admin")
        return json({ drives: manageable.map((d) => ({ ...d, myRole: this.driveMembers[d.id].get(user.id) ?? null })) })
      }
      return json({ drives: mine.map((d) => ({ ...d, orgId: "org" })) })
    }

    if (path === "/orgs/org/members" && method === "GET") {
      if (!isOrgAdmin) return forbidden()
      if (this.membersDelayMs) await new Promise((resolve) => setTimeout(resolve, this.membersDelayMs))
      if (this.membersFail) return json({ error: "INTERNAL", message: "Member list unavailable" }, 500)
      return json({
        members: [...this.orgMembers].map(([id, role]) => ({ userId: id, email: this.users.get(id)!.email, role })),
      })
    }

    if (path === "/orgs/org/members/invite" && method === "POST") {
      if (!isOrgAdmin) return forbidden()
      const body = req.postDataJSON() as { email: string; role: Role; drives: { driveId: string; role: Role }[] }
      const email = body.email.trim().toLowerCase()
      this.calls.push(`invite ${email} ${body.role} ${body.drives.map((g) => `${g.driveId}:${g.role}`).join(",")}`)
      const existing = this.userByEmail(email)
      if (existing) {
        this.orgMembers.set(existing.id, body.role)
        for (const g of body.drives) this.driveMembers[g.driveId].set(existing.id, g.role)
        return json({ ok: true, status: "added", userId: existing.id, email, drives: body.drives })
      }
      for (const prior of this.invites) if (prior.email === email && !prior.accepted) prior.revoked = true
      const invite: Invite = {
        id: `inv-${this.invites.length + 1}`,
        email,
        orgRole: body.role,
        drives: body.drives,
        token: randomBytes(32).toString("base64url"),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * DAY),
        revoked: false,
        accepted: false,
      }
      this.invites.push(invite)
      return json({
        ok: true,
        status: "pending",
        inviteId: invite.id,
        email,
        token: invite.token,
        expiresAt: invite.expiresAt.toISOString(),
        drives: invite.drives,
      })
    }

    if (path === "/orgs/org/invites" && method === "GET") {
      if (!isOrgAdmin) return forbidden()
      const open = this.invites.filter((i) => !i.revoked && !i.accepted).reverse()
      return json({
        invites: open.map((i) => ({
          id: i.id,
          email: i.email,
          orgRole: i.orgRole,
          drives: i.drives,
          createdBy: "qa",
          createdAt: i.createdAt.toISOString(),
          expiresAt: i.expiresAt.toISOString(),
          expired: i.expiresAt.getTime() <= Date.now(),
        })),
      })
    }

    const revoke = path.match(/^\/orgs\/org\/invites\/([^/]+)$/)
    if (revoke && method === "DELETE") {
      if (!isOrgAdmin) return forbidden()
      const invite = this.invites.find((i) => i.id === revoke[1] && !i.revoked && !i.accepted)
      if (!invite) return json({ error: "NOT_FOUND", message: "Pending invite not found" }, 404)
      this.calls.push(`revoke ${invite.email}`)
      invite.revoked = true
      return json({ ok: true })
    }

    const driveMembers = path.match(/^\/orgs\/org\/drives\/([^/]+)\/members(?:\/([^/]+))?$/)
    if (driveMembers) {
      const [, driveId] = driveMembers
      const drive = this.driveMembers[driveId]
      if (!isOrgAdmin && drive.get(user.id) !== "admin") return forbidden()
      if (method === "GET") {
        return json({ members: [...drive].map(([id, role]) => ({ userId: id, email: this.users.get(id)!.email, role })) })
      }
      if (method === "POST") {
        const { email, role } = req.postDataJSON()
        const target = this.userByEmail(email)
        if (!target || !this.orgMembers.has(target.id)) return json({ error: "NOT_FOUND", message: "Not a member of this org" }, 404)
        this.calls.push(`add ${driveId} ${target.email} ${role}`)
        const created = !drive.has(target.id)
        drive.set(target.id, role)
        return json({ userId: target.id, email: target.email, driveId, role, created }, created ? 201 : 200)
      }
    }

    if (path === "/orgs/org/ops") {
      const { op, driveId } = req.postDataJSON()
      switch (op) {
        case "drive-members":
          return json({
            members: [...(this.driveMembers[driveId ?? "work"] ?? [])].map(([id]) => ({
              userId: id,
              email: this.users.get(id)!.email,
              displayName: null,
            })),
          })
        case "ls": return json({ entries: [] })
        case "comment-list": return json({ comments: [] })
        case "comment-notification-list": return json({ notifications: [], unreadCount: 0 })
        case "favorite-list": return json({ favorites: [] })
      }
    }
    return route.abort()
  }
}
