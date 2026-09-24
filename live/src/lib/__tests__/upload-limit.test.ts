import { describe, expect, test } from "bun:test"
import { healthQueryOptions, uploadLimitBytes } from "../upload-limit"
import { AgentFsClient } from "../../api/client"

describe("upload limit discovery", () => {
  test("uses the server value, including limits above and below 50 MiB", () => {
    for (const maxUploadBytes of [1, 104857600]) {
      expect(uploadLimitBytes({ ok: true, version: "test", maxUploadBytes })).toBe(maxUploadBytes)
    }
  })
  test("older servers, unavailable health and malformed limits use 50 MiB", () => {
    expect(uploadLimitBytes()).toBe(52428800)
    for (const maxUploadBytes of [undefined, 0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(uploadLimitBytes({ ok: true, version: "old", maxUploadBytes })).toBe(52428800)
    }
  })
  test("health caches are separate for different endpoints", () => {
    const a = new AgentFsClient({ endpoint: "https://a.example/", apiKey: "a" })
    const b = new AgentFsClient({ endpoint: "https://b.example", apiKey: "b" })
    expect(healthQueryOptions(a).queryKey).not.toEqual(healthQueryOptions(b).queryKey)
    expect(healthQueryOptions(a).queryKey).toEqual(["health", "https://a.example"])
  })
})
