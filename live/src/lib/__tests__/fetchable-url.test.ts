import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { AgentFsClient } from "../../api/client"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function setup(signed: { url: string; expiresAt: string; kind?: "presigned" | "app" }) {
  const client = new AgentFsClient({ endpoint: "https://fs.example", apiKey: "key" })
  const callOp = spyOn(client, "callOp").mockResolvedValue(signed as never)
  const requests: { url: string; init?: RequestInit }[] = []
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    requests.push({ url: String(url), init })
    init?.signal?.throwIfAborted()
    return new Response("bytes", { headers: { "Content-Type": "image/png" } })
  }) as unknown as typeof fetch
  return { client, callOp, requests }
}

describe("fetchableUrl", () => {
  test("a presigned URL is returned as-is, with no raw read", async () => {
    const { client, requests } = setup({ url: "https://bucket.example/a.png?sig=1", expiresAt: "2030-01-01T00:00:00Z" })

    const result = await client.fetchableUrl("org", "drive", "/a.png")

    expect(result).toEqual({ url: "https://bucket.example/a.png?sig=1", expiresAt: "2030-01-01T00:00:00Z", objectUrl: false })
    expect(requests).toEqual([])
  })

  test("an app link is read through the authenticated raw route into an object URL", async () => {
    const { client, requests } = setup({ url: "https://app.example/file/~/org/drive/a.png", expiresAt: "", kind: "app" })

    const result = await client.fetchableUrl("org", "drive", "/a.png")

    expect(result.objectUrl).toBe(true)
    expect(result.url.startsWith("blob:")).toBe(true)
    expect(requests.map((r) => r.url)).toEqual([client.getRawUrl("org", "drive", "/a.png")])
    expect(requests[0].init?.headers).toEqual({ Authorization: "Bearer key" })
    expect(requests[0].init?.cache).toBe("no-store")
    URL.revokeObjectURL(result.url)
  })

  test("the signal reaches both the signed-url op and the raw read", async () => {
    const { client, callOp, requests } = setup({ url: "https://app.example/file/~/org/drive/a.png", expiresAt: "", kind: "app" })
    const controller = new AbortController()

    const result = await client.fetchableUrl("org", "drive", "/a.png", { signal: controller.signal })

    expect(callOp.mock.calls[0][4]).toEqual({ signal: controller.signal })
    expect(requests[0].init?.signal).toBe(controller.signal)
    URL.revokeObjectURL(result.url)
  })

  test("an aborted read rejects instead of minting an object URL", async () => {
    const { client } = setup({ url: "https://app.example/file/~/org/drive/a.png", expiresAt: "", kind: "app" })
    const controller = new AbortController()
    controller.abort()

    await expect(client.fetchableUrl("org", "drive", "/a.png", { signal: controller.signal })).rejects.toThrow()
  })
})
