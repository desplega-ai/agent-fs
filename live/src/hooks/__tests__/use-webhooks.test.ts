import { afterEach, expect, test } from "bun:test"
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import type { AgentFsClient } from "@/api/client"
import type { Webhook, WebhookWithSecret } from "@/api/types"
import { createWebhook, rotateWebhookSecret, webhooksKey } from "../use-webhooks"

// Lives outside src/lib/ on purpose: the root `bun run test` only has the root
// install, which has no React Query. Run it from live/ with `pnpm test:webhooks`.

const credentialId = "cred"
const orgId = "org"
const driveId = "drive"
const queryClients: QueryClient[] = []

afterEach(() => {
  for (const queryClient of queryClients) queryClient.clear()
  queryClients.length = 0
})

const hook: Webhook = {
  id: "wh_1",
  scope: "drive",
  driveId,
  url: "https://hooks.example.test/in",
  description: null,
  eventTypes: ["comment.created"],
  enabled: true,
  disabledReason: null,
  disabledAt: null,
  consecutiveFailures: 0,
  lastSuccessAt: null,
  lastFailureAt: null,
  createdBy: "qa",
  createdAt: "2026-11-05T10:00:00.000Z",
  updatedAt: "2026-11-05T10:00:00.000Z",
  workerEnabled: true,
}

/** A server that hands out a fresh secret on create and rotate and never lists one. */
function fakeClient() {
  let n = 0
  const hooks: Webhook[] = []
  const issued: string[] = []
  const mint = (): string => {
    const secret = `whsec_${"A".repeat(30)}${++n}`
    issued.push(secret)
    return secret
  }
  const client = {
    listWebhooks: async () => ({ webhooks: hooks.map((h) => ({ ...h })) }),
    createWebhook: async (): Promise<WebhookWithSecret> => {
      hooks.push({ ...hook })
      return { ...hook, secret: mint() }
    },
    rotateWebhookSecret: async (): Promise<WebhookWithSecret> => ({ ...hook, secret: mint() }),
  } as unknown as AgentFsClient
  return { client, issued }
}

/** Every byte React Query holds: query data and errors, mutation results and variables. */
function cacheDump(queryClient: QueryClient): string {
  return JSON.stringify({
    queries: queryClient.getQueryCache().getAll().map((q) => ({ key: q.queryKey, state: q.state })),
    mutations: queryClient.getMutationCache().getAll().map((m) => m.state),
  })
}

test("create returns the secret to the caller and leaves none in the query or mutation cache", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  queryClients.push(queryClient)
  const { client, issued } = fakeClient()
  // The page's list query is mounted while the dialog is open.
  const observer = new QueryObserver(queryClient, {
    queryKey: webhooksKey(credentialId, orgId, driveId),
    queryFn: () => client.listWebhooks(orgId, driveId),
  })
  const unsubscribe = observer.subscribe(() => {})
  await observer.refetch()

  const res = await createWebhook(queryClient, client, credentialId, orgId, driveId, {
    scope: "drive",
    url: hook.url,
    eventTypes: ["comment.created"],
  })

  expect(res.secret).toBe(issued[0])
  expect("secret" in res.webhook).toBe(false)
  // The list refetched after the create and now shows the new hook...
  expect(observer.getCurrentResult().data?.webhooks.map((h) => h.id)).toEqual(["wh_1"])
  // ...but nothing React Query holds carries the secret.
  const dump = cacheDump(queryClient)
  expect(dump).toContain("wh_1")
  expect(dump).not.toContain("whsec_")
  expect(queryClient.getMutationCache().getAll()).toHaveLength(0)
  unsubscribe()
})

test("rotate returns the new secret and leaves none in the cache", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  queryClients.push(queryClient)
  const { client, issued } = fakeClient()
  await createWebhook(queryClient, client, credentialId, orgId, driveId, { scope: "drive", url: hook.url, eventTypes: ["comment.created"] })
  await queryClient.fetchQuery({
    queryKey: webhooksKey(credentialId, orgId, driveId),
    queryFn: () => client.listWebhooks(orgId, driveId),
  })

  const res = await rotateWebhookSecret(queryClient, client, credentialId, orgId, driveId, "wh_1")

  expect(res.secret).toBe(issued[1])
  expect(res.secret).not.toBe(issued[0])
  expect("secret" in res.webhook).toBe(false)
  expect(cacheDump(queryClient)).not.toContain("whsec_")
})

test("a failed create leaves no secret and no mutation behind", async () => {
  const queryClient = new QueryClient()
  queryClients.push(queryClient)
  const client = {
    createWebhook: async () => {
      throw Object.assign(new Error("url must be public https"), { status: 400 })
    },
  } as unknown as AgentFsClient

  await expect(
    createWebhook(queryClient, client, credentialId, orgId, driveId, { scope: "drive", url: "http://x", eventTypes: ["comment.created"] }),
  ).rejects.toThrow("url must be public https")
  expect(queryClient.getMutationCache().getAll()).toHaveLength(0)
})
