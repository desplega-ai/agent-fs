import { afterEach, expect, test } from "bun:test"
import { MutationObserver, QueryClient } from "@tanstack/react-query"
import type { AgentFsClient } from "@/api/client"
import type { Favorite } from "@/api/types"
import { favoritesQueryKey } from "@/lib/favorites"
import { createToggleFavoriteMutationOptions } from "../use-favorites"

const endpoint = "https://agent-fs.test"
const orgId = "org"
const driveId = "drive"
const aliceKey = favoritesQueryKey("alice", endpoint, orgId, driveId)
const bobKey = favoritesQueryKey("bob", endpoint, orgId, driveId)
const queryClients: QueryClient[] = []

afterEach(() => {
  for (const queryClient of queryClients) queryClient.clear()
  queryClients.length = 0
})

function createQueryClient() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  })
  queryClients.push(queryClient)
  return queryClient
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function star(path: string): Favorite {
  return { path, kind: "file", createdAt: "2026-10-10T12:00:00.000Z" }
}

/** A client whose next `setFavorite` waits until the test settles it. */
function pendingClient() {
  const started = deferred<void>()
  const request = deferred<void>()
  const client = {
    endpoint,
    setFavorite: () => {
      started.resolve()
      return request.promise
    },
  } as unknown as AgentFsClient
  return { client, started, request }
}

test("two accounts on the same drive get different cache entries", () => {
  expect(aliceKey).not.toEqual(bobKey)
})

test("a failed toggle rolls back the list it changed", async () => {
  const queryClient = createQueryClient()
  const { client, started, request } = pendingClient()
  const saved = { favorites: [star("/a.md")] }
  queryClient.setQueryData(aliceKey, saved)

  const mutation = new MutationObserver(
    queryClient,
    createToggleFavoriteMutationOptions({ client, orgId, driveId, queryKey: aliceKey, queryClient }),
  )
  const pending = mutation.mutate({ path: "b.md", kind: "file", on: true })
  await started.promise
  expect(queryClient.getQueryData<{ favorites: Favorite[] }>(aliceKey)?.favorites.map((f) => f.path))
    .toEqual(["/a.md", "/b.md"])

  request.reject(new Error("offline"))
  await expect(pending).rejects.toThrow("offline")
  expect(queryClient.getQueryData(aliceKey)).toEqual(saved)
})

test("a toggle that fails after an account switch leaves the new account's list alone", async () => {
  const queryClient = createQueryClient()
  const { client, started, request } = pendingClient()
  queryClient.setQueryData(aliceKey, { favorites: [star("/alice.md")] })

  const mutation = new MutationObserver(
    queryClient,
    createToggleFavoriteMutationOptions({ client, orgId, driveId, queryKey: aliceKey, queryClient }),
  )
  const pending = mutation.mutate({ path: "draft.md", kind: "file", on: true })
  await started.promise

  // AuthProvider.switchAccount clears the cache; Bob's list then loads.
  queryClient.clear()
  const bob = { favorites: [star("/bob.md")] }
  queryClient.setQueryData(bobKey, bob)

  request.reject(new Error("offline"))
  await expect(pending).rejects.toThrow("offline")

  expect(queryClient.getQueryData(bobKey)).toEqual(bob)
  // Alice's list is not written back into the cleared cache either.
  expect(queryClient.getQueryData(aliceKey)).toBeUndefined()
})
