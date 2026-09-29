import { afterEach, expect, test } from "bun:test"
import {
  MutationObserver,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query"
import type { AgentFsClient } from "@/api/client"
import type { CommentAddResult, CommentEntry, CommentListEntry, CommentListResult } from "@/api/types"
import { getVisibleCommentSurfaces } from "@/lib/desktop-breakpoint"
import {
  createAddCommentMutationOptions,
  createCommentQueryOptions,
  createResolveCommentMutationOptions,
} from "../use-comments"

const orgId = "org"
const driveId = "drive"
const path = "docs/readme.md"
const unresolvedKey = ["comments", orgId, driveId, path] as const
const resolvedKey = [...unresolvedKey, "resolved"] as const
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

function makeEntry(id: string, overrides: Partial<CommentListEntry> = {}): CommentListEntry {
  return {
    id,
    path,
    body: id,
    author: "other-user",
    resolved: false,
    replyCount: 0,
    createdAt: "2026-09-28T12:00:00.000Z",
    updatedAt: "2026-09-28T12:00:00.000Z",
    replies: [],
    ...overrides,
  }
}

function makeReply(id: string, parentId: string, overrides: Partial<CommentEntry> = {}): CommentEntry {
  return {
    id,
    parentId,
    path,
    body: id,
    author: "other-user",
    resolved: false,
    replyCount: 0,
    createdAt: "2026-09-28T12:00:00.000Z",
    updatedAt: "2026-09-28T12:00:00.000Z",
    ...overrides,
  }
}

function list(...comments: CommentListEntry[]): CommentListResult {
  return { comments }
}

function makeClient(handler: (operation: string, args: Record<string, unknown>) => unknown) {
  return {
    callOp: async (_orgId: string, operation: string, args: Record<string, unknown>) => handler(operation, args),
  } as unknown as AgentFsClient
}

function addOptions(client: AgentFsClient, queryClient: QueryClient) {
  return createAddCommentMutationOptions({
    client,
    orgId,
    driveId,
    user: { userId: "current-user", displayName: "Current User" },
    queryClient,
  })
}

function queryOptions(client: AgentFsClient, queryClient: QueryClient, isOpen = false) {
  return createCommentQueryOptions({ client, queryClient, orgId, driveId, path, isOpen, poll: true })
}

async function flushPromises() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
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

test("the sidebar and count share one unresolved request", async () => {
  const requests: Record<string, unknown>[] = []
  let serverList = list()
  const client = makeClient((_operation, args) => {
    requests.push(args)
    return args.resolved ? list() : serverList
  })
  const queryClient = createQueryClient()
  const badgeObserver = new QueryObserver(queryClient, createCommentQueryOptions({
    client, queryClient, orgId, driveId, path,
  }))
  const sidebarObserver = new QueryObserver(queryClient, queryOptions(client, queryClient, true))
  const resolvedObserver = new QueryObserver(queryClient, createCommentQueryOptions({
    client, queryClient, orgId, driveId, path, isOpen: true, resolved: true, poll: true,
  }))
  const stopBadge = badgeObserver.subscribe(() => {})
  const stopSidebar = sidebarObserver.subscribe(() => {})
  const stopResolved = resolvedObserver.subscribe(() => {})

  await flushPromises()
  expect(requests).toHaveLength(2)
  expect(requests.filter((args) => args.resolved === true)).toHaveLength(1)
  expect(requests.filter((args) => args.resolved !== true)).toHaveLength(1)

  stopBadge()
  stopSidebar()
  stopResolved()
})

test("closed comment options disable polling across resize and reopen transitions", async () => {
  let requestCount = 0
  const client = makeClient(() => {
    requestCount++
    return list()
  })
  const queryClient = createQueryClient()
  let isDesktop = false
  let desktopOpen = false
  let mobileOpen = false
  const currentSurfaceOpen = () => {
    const surfaces = getVisibleCommentSurfaces(isDesktop, desktopOpen, mobileOpen)
    return surfaces.desktopOpen || surfaces.mobileOpen
  }
  const observer = new QueryObserver(queryClient, queryOptions(client, queryClient, currentSurfaceOpen()))
  const stop = observer.subscribe(() => {})
  await flushPromises()
  expect(requestCount).toBe(0)
  expect(observer.options.refetchInterval).toBe(false)

  mobileOpen = true
  observer.setOptions(queryOptions(client, queryClient, currentSurfaceOpen()))
  await flushPromises()
  expect(requestCount).toBe(1)
  expect(observer.options.refetchInterval).toBe(10_000)
  await observer.refetch()
  expect(requestCount).toBe(2)

  isDesktop = true
  desktopOpen = false
  observer.setOptions(queryOptions(client, queryClient, currentSurfaceOpen()))
  expect(observer.options.refetchInterval).toBe(false)
  await flushPromises()
  expect(requestCount).toBe(2)

  mobileOpen = false
  isDesktop = false
  observer.setOptions(queryOptions(client, queryClient, currentSurfaceOpen()))
  expect(observer.options.refetchInterval).toBe(false)
  expect(requestCount).toBe(2)

  isDesktop = true
  desktopOpen = true
  observer.setOptions(queryOptions(client, queryClient, currentSurfaceOpen()))
  await flushPromises()
  expect(observer.options.refetchInterval).toBe(10_000)
  await observer.refetch()
  expect(requestCount).toBe(3)

  stop()
})

test("resolved refetch does not copy unresolved optimistic comments", async () => {
  const queryClient = createQueryClient()
  const optimistic = makeEntry("optimistic:root", { body: "pending" })
  const resolvedRoot = makeEntry("resolved-root", { resolved: true })
  queryClient.setQueryData(unresolvedKey, list(optimistic))
  const client = makeClient((_operation, args) => args.resolved ? list(resolvedRoot) : list())

  await queryClient.fetchQuery({
    ...createCommentQueryOptions({ client, queryClient, orgId, driveId, path, resolved: true }),
    staleTime: 0,
  })

  expect(queryClient.getQueryData<CommentListResult>(resolvedKey)?.comments.map((comment) => comment.id))
    .toEqual([resolvedRoot.id])
})

test("a rejected resolve restores its pre-mutation thread without dropping concurrent cache entries", async () => {
  const olderRoot = makeEntry("older-unresolved-root", {
    createdAt: "2026-01-01T12:00:00.000Z",
  })
  const newerResolvedRoots = Array.from({ length: 50 }, (_, index) => makeEntry(`resolved-${index}`, {
    resolved: true,
    createdAt: `2026-09-${String(28 - Math.floor(index / 12)).padStart(2, "0")}T12:00:00.000Z`,
  }))
  const request = deferred<never>()
  const started = deferred<void>()
  const client = makeClient((operation) => {
    if (operation === "comment-resolve") {
      started.resolve()
      return request.promise
    }
    return list()
  })
  const queryClient = createQueryClient()
  queryClient.setQueryData(unresolvedKey, list(olderRoot))
  queryClient.setQueryData(resolvedKey, list(...newerResolvedRoots))
  const mutation = new MutationObserver(queryClient, createResolveCommentMutationOptions({
    client, orgId, driveId, queryClient,
  }))

  const pending = mutation.mutate({ id: olderRoot.id, resolved: true, path })
  await started.promise
  expect(queryClient.getQueryData<CommentListResult>(unresolvedKey)?.comments).toEqual([])

  const concurrentRoot = makeEntry("concurrent-root", { createdAt: "2026-09-29T12:00:00.000Z" })
  queryClient.setQueryData<CommentListResult>(unresolvedKey, (current) => list(concurrentRoot, ...(current?.comments ?? [])))
  request.reject(new Error("offline"))
  await expect(pending).rejects.toThrow("offline")

  const restored = queryClient.getQueryData<CommentListResult>(unresolvedKey)?.comments ?? []
  expect(restored.map((comment) => comment.id)).toContain(olderRoot.id)
  expect(restored.map((comment) => comment.id)).toContain(concurrentRoot.id)
  expect(queryClient.getQueryData<CommentListResult>(resolvedKey)?.comments.map((comment) => comment.id))
    .not.toContain(olderRoot.id)
})

test("a failed resolve preserves concurrent reply deletions", async () => {
  const deletedReply = makeReply("deleted-reply", "thread-root")
  const root = makeEntry("thread-root", { replies: [deletedReply], replyCount: 1 })
  const request = deferred<never>()
  const started = deferred<void>()
  const client = makeClient((operation) => {
    if (operation === "comment-resolve") {
      started.resolve()
      return request.promise
    }
    return list()
  })
  const queryClient = createQueryClient()
  queryClient.setQueryData(unresolvedKey, list(root))
  queryClient.setQueryData(resolvedKey, list(root))
  const mutation = new MutationObserver(queryClient, createResolveCommentMutationOptions({
    client, orgId, driveId, queryClient,
  }))

  const pending = mutation.mutate({ id: root.id, resolved: true, path })
  await started.promise
  queryClient.setQueryData<CommentListResult>(resolvedKey, list({ ...root, replies: [], replyCount: 0 }))
  request.reject(new Error("offline"))
  await expect(pending).rejects.toThrow("offline")

  const restored = queryClient.getQueryData<CommentListResult>(unresolvedKey)?.comments[0]
  expect(restored?.id).toBe(root.id)
  expect(restored?.replies).toEqual([])
  expect(restored?.replyCount).toBe(0)
})

test("a rejected reopen removes the optimistic thread from unresolved comments", async () => {
  const resolvedRoot = makeEntry("resolved-root", { resolved: true })
  const request = deferred<never>()
  const started = deferred<void>()
  const client = makeClient((operation) => {
    if (operation === "comment-resolve") {
      started.resolve()
      return request.promise
    }
    return list()
  })
  const queryClient = createQueryClient()
  queryClient.setQueryData(unresolvedKey, list())
  queryClient.setQueryData(resolvedKey, list(resolvedRoot))
  const mutation = new MutationObserver(queryClient, createResolveCommentMutationOptions({
    client, orgId, driveId, queryClient,
  }))

  const pending = mutation.mutate({ id: resolvedRoot.id, resolved: false, path })
  await started.promise
  expect(queryClient.getQueryData<CommentListResult>(unresolvedKey)?.comments.map((comment) => comment.id))
    .toContain(resolvedRoot.id)

  const concurrentRoot = makeEntry("concurrent-root", { createdAt: "2026-09-29T12:00:00.000Z" })
  queryClient.setQueryData<CommentListResult>(unresolvedKey, (current) => list(concurrentRoot, ...(current?.comments ?? [])))
  request.reject(new Error("offline"))
  await expect(pending).rejects.toThrow("offline")

  expect(queryClient.getQueryData<CommentListResult>(unresolvedKey)?.comments.map((comment) => comment.id))
    .toEqual([concurrentRoot.id])
  expect(queryClient.getQueryData<CommentListResult>(resolvedKey)?.comments[0].resolved).toBe(true)
})

test("optimistic root and reply adds survive refetch and replace their temporary entries once", async () => {
  const rootAdd = deferred<CommentAddResult>()
  const rootStarted = deferred<void>()
  const rootServerComment = makeEntry("saved-root", { body: "new root", author: "current-user" })
  let serverList = list()
  const client = makeClient((operation, args) => {
    if (operation === "comment-add") {
      rootStarted.resolve()
      return rootAdd.promise
    }
    return serverList
  })
  const queryClient = createQueryClient()
  queryClient.setQueryData(unresolvedKey, list())
  const mutation = new MutationObserver(queryClient, addOptions(client, queryClient))

  const pendingRoot = mutation.mutate({ path, body: "new root" })
  await rootStarted.promise
  let cached = queryClient.getQueryData<CommentListResult>(unresolvedKey)!
  const optimisticRoot = cached.comments.find((comment) => comment.id.startsWith("optimistic:"))!
  expect(cached.comments).toHaveLength(1)

  await queryClient.fetchQuery({ ...createCommentQueryOptions({ client, queryClient, orgId, driveId, path }), staleTime: 0 })
  cached = queryClient.getQueryData<CommentListResult>(unresolvedKey)!
  expect(cached.comments.filter((comment) => comment.id === optimisticRoot.id)).toHaveLength(1)

  serverList = list(rootServerComment)
  rootAdd.resolve({
    id: rootServerComment.id,
    path,
    body: rootServerComment.body,
    author: rootServerComment.author,
    createdAt: rootServerComment.createdAt,
  })
  await pendingRoot
  cached = queryClient.getQueryData<CommentListResult>(unresolvedKey)!
  expect(cached.comments.filter((comment) => comment.id === rootServerComment.id)).toHaveLength(1)
  expect(cached.comments.some((comment) => comment.id.startsWith("optimistic:"))).toBe(false)

  const replyAdd = deferred<CommentAddResult>()
  const replyStarted = deferred<void>()
  mutation.setOptions(addOptions(makeClient((operation) => {
    if (operation === "comment-add") {
      replyStarted.resolve()
      return replyAdd.promise
    }
    return serverList
  }), queryClient))
  serverList = list(rootServerComment)
  const pendingReply = mutation.mutate({ path, parentId: rootServerComment.id, body: "new reply" })
  await replyStarted.promise

  cached = queryClient.getQueryData<CommentListResult>(unresolvedKey)!
  const optimisticReply = cached.comments[0].replies[0]
  expect(optimisticReply.id.startsWith("optimistic:")).toBe(true)
  expect(cached.comments[0].replyCount).toBe(1)

  await queryClient.fetchQuery({ ...createCommentQueryOptions({
    client: makeClient((_operation) => serverList), queryClient, orgId, driveId, path,
  }), staleTime: 0 })
  cached = queryClient.getQueryData<CommentListResult>(unresolvedKey)!
  expect(cached.comments[0].replies.filter((reply) => reply.id === optimisticReply.id)).toHaveLength(1)

  const savedReply = makeReply("saved-reply", rootServerComment.id, { body: "new reply", author: "current-user" })
  serverList = list(makeEntry(rootServerComment.id, { ...rootServerComment, replies: [savedReply], replyCount: 1 }))
  replyAdd.resolve({
    id: savedReply.id,
    path,
    body: savedReply.body,
    parentId: rootServerComment.id,
    author: savedReply.author,
    createdAt: savedReply.createdAt,
  })
  await pendingReply
  cached = queryClient.getQueryData<CommentListResult>(unresolvedKey)!
  expect(cached.comments[0].replies.map((reply) => reply.id)).toEqual([savedReply.id])
  expect(cached.comments[0].replyCount).toBe(1)
})

test("rejecting one overlapping add and refetching does not erase the other pending add", async () => {
  const firstAdd = deferred<CommentAddResult>()
  const firstStarted = deferred<void>()
  const secondAdd = deferred<CommentAddResult>()
  const secondStarted = deferred<void>()
  let serverList = list()
  const client = makeClient((operation, args) => {
    if (operation === "comment-add") {
      if (args.body === "first") {
        firstStarted.resolve()
        return firstAdd.promise
      }
      secondStarted.resolve()
      return secondAdd.promise
    }
    return serverList
  })
  const queryClient = createQueryClient()
  queryClient.setQueryData(unresolvedKey, list())
  const firstMutation = new MutationObserver(queryClient, addOptions(client, queryClient))
  const secondMutation = new MutationObserver(queryClient, addOptions(client, queryClient))

  const first = firstMutation.mutate({ path, body: "first" }).catch((error) => error)
  const second = secondMutation.mutate({ path, body: "second" })
  await Promise.all([firstStarted.promise, secondStarted.promise])

  let cached = queryClient.getQueryData<CommentListResult>(unresolvedKey)!
  const firstId = cached.comments.find((comment) => comment.body === "first")!.id
  const secondId = cached.comments.find((comment) => comment.body === "second")!.id
  expect(cached.comments).toHaveLength(2)

  firstAdd.reject(new Error("first rejected"))
  await first
  cached = queryClient.getQueryData<CommentListResult>(unresolvedKey)!
  expect(cached.comments.map((comment) => comment.id)).toEqual([secondId])

  await queryClient.fetchQuery({ ...createCommentQueryOptions({ client, queryClient, orgId, driveId, path }), staleTime: 0 })
  cached = queryClient.getQueryData<CommentListResult>(unresolvedKey)!
  expect(cached.comments.map((comment) => comment.id)).toEqual([secondId])

  const savedSecond = makeEntry("saved-second", { body: "second", author: "current-user" })
  serverList = list(savedSecond)
  secondAdd.resolve({
    id: savedSecond.id,
    path,
    body: savedSecond.body,
    author: savedSecond.author,
    createdAt: savedSecond.createdAt,
  })
  await second
  cached = queryClient.getQueryData<CommentListResult>(unresolvedKey)!
  expect(cached.comments.map((comment) => comment.id)).toEqual([savedSecond.id])
  expect(cached.comments.some((comment) => comment.id === firstId)).toBe(false)
})
