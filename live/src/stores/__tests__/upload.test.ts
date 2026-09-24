import { afterEach, expect, spyOn, test } from "bun:test"
import { QueryClient } from "@tanstack/react-query"
import { AgentFsClient } from "../../api/client"
import { uploadStore } from "../../stores/upload"

const queryClient = new QueryClient()
afterEach(() => {
  for (const item of uploadStore.getItems()) uploadStore.dismiss(item.id)
  queryClient.clear()
})

function input(size: number) {
  const file = new File(["x"], "test.bin")
  Object.defineProperty(file, "size", { value: size })
  return [{ file, relativePath: file.name }]
}

test("an immediate drop awaits discovery and accepts files above the old cap", async () => {
  const client = new AgentFsClient({ endpoint: "https://large.example", apiKey: "test" })
  let resolveHealth!: (health: object) => void
  const health = spyOn(client, "get").mockImplementation(() => new Promise((resolve) => { resolveHealth = resolve }) as never)
  const put = spyOn(client, "putRaw").mockResolvedValue({ version: 1, path: "test.bin", size: 51 * 1024 * 1024 })
  try {
    const pending = uploadStore.enqueue({ client, orgId: "org", driveId: "drive", queryClient }, "", input(51 * 1024 * 1024))
    expect(put).not.toHaveBeenCalled()
    resolveHealth({ ok: true, version: "test", maxUploadBytes: 100 * 1024 * 1024 })
    await pending
    expect(put).toHaveBeenCalledTimes(1)
    expect(uploadStore.getItems()[0].status).toBe("done")
  } finally {
    health.mockRestore()
    put.mockRestore()
  }
})

test("a different server's smaller limit rejects before sending", async () => {
  const client = new AgentFsClient({ endpoint: "https://small.example", apiKey: "test" })
  queryClient.setQueryData(["health", "https://large.example"], { maxUploadBytes: 100 * 1024 * 1024 })
  const health = spyOn(client, "get").mockResolvedValue({ ok: true, version: "test", maxUploadBytes: 1024 * 1024 })
  const put = spyOn(client, "putRaw")
  try {
    await uploadStore.enqueue({ client, orgId: "org", driveId: "drive", queryClient }, "", input(1024 * 1024 + 1))
    expect(put).not.toHaveBeenCalled()
    expect(uploadStore.getItems()[0].status).toBe("rejected")
    expect(uploadStore.getItems()[0].error).toBe("Larger than 1 MB")
  } finally {
    health.mockRestore()
    put.mockRestore()
  }
})

test("failed discovery falls back to the old limit", async () => {
  const client = new AgentFsClient({ endpoint: "https://offline.example", apiKey: "test" })
  const health = spyOn(client, "get").mockRejectedValue(new Error("offline"))
  const put = spyOn(client, "putRaw")
  try {
    await uploadStore.enqueue({ client, orgId: "org", driveId: "drive", queryClient }, "", input(51 * 1024 * 1024))
    expect(put).not.toHaveBeenCalled()
    expect(uploadStore.getItems()[0].error).toBe("Larger than 50 MB")
  } finally {
    health.mockRestore()
    put.mockRestore()
  }
})
