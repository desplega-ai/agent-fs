import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"

mock.module("../../stores/toast", () => ({
  toast: Object.assign(() => 0, { success: () => 0, error: () => 0, dismiss: () => {} }),
}))

const { AgentFsClient } = await import("../../api/client")
const { downloadFile } = await import("../download")

interface FakeAnchor {
  href: string
  download: string
  rel: string
  target: string
  click: () => void
  remove: () => void
}

const realDocument = globalThis.document
let clicked: FakeAnchor[] = []

beforeEach(() => {
  clicked = []
  globalThis.document = {
    createElement: () => {
      const a: FakeAnchor = { href: "", download: "", rel: "", target: "", click: () => clicked.push(a), remove: () => {} }
      return a
    },
    body: { appendChild: () => {} },
  } as unknown as Document
})

afterEach(() => {
  globalThis.document = realDocument
})

function setup(signed: { url: string; expiresAt: string; kind?: "presigned" | "app" } | Error) {
  const client = new AgentFsClient({ endpoint: "https://fs.example", apiKey: "key" })
  const getSignedUrl = spyOn(client, "getSignedUrl").mockImplementation(async () => {
    if (signed instanceof Error) throw signed
    return signed
  })
  const fetchRaw = spyOn(client, "fetchRaw").mockResolvedValue(new Blob(["bytes"]))
  return { client, getSignedUrl, fetchRaw }
}

describe("downloadFile", () => {
  test("a presigned URL is downloaded directly", async () => {
    const { client, fetchRaw } = setup({ url: "https://bucket.example/a.pdf?sig=1", expiresAt: "", kind: "presigned" })

    await downloadFile(client, "org", "drive", "/a.pdf", undefined, { newWindow: true })

    expect(clicked.map((a) => a.href)).toEqual(["https://bucket.example/a.pdf?sig=1"])
    expect(clicked[0].target).toBe("_blank")
    expect(fetchRaw).not.toHaveBeenCalled()
  })

  test("an app link downloads the raw bytes instead of opening the viewer page", async () => {
    const { client, fetchRaw } = setup({ url: "https://app.example/file/~/org/drive/a.pdf", expiresAt: "", kind: "app" })

    await downloadFile(client, "org", "drive", "/a.pdf")

    expect(fetchRaw).toHaveBeenCalledTimes(1)
    expect(clicked).toHaveLength(1)
    expect(clicked[0].href.startsWith("blob:")).toBe(true)
    expect(clicked[0].download).toBe("a.pdf")
  })

  test("a failed signed-url op still falls back to the raw bytes", async () => {
    const { client, fetchRaw } = setup(new Error("signed-url unavailable"))

    await downloadFile(client, "org", "drive", "/a.pdf")

    expect(fetchRaw).toHaveBeenCalledTimes(1)
    expect(clicked[0].href.startsWith("blob:")).toBe(true)
  })
})
