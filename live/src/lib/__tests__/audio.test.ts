import { describe, expect, test } from "bun:test"
import { readHead, sniffAudioType } from "../audio"

function bytes(...parts: (string | number[])[]): Uint8Array {
  const out: number[] = []
  for (const part of parts) {
    if (typeof part === "string") for (const ch of part) out.push(ch.charCodeAt(0))
    else out.push(...part)
  }
  return new Uint8Array(out)
}

describe("sniffAudioType", () => {
  test("recognizes the containers chat audio and voice notes arrive in", () => {
    // Telegram voice notes are Ogg/Opus; TTS output is usually mp3 with an ID3 tag.
    expect(sniffAudioType(bytes("OggS", [0, 2, 0, 0]))).toBe("audio/ogg")
    expect(sniffAudioType(bytes("ID3", [4, 0, 0]))).toBe("audio/mpeg")
    expect(sniffAudioType(bytes("fLaC", [0, 0, 0, 34]))).toBe("audio/flac")
    expect(sniffAudioType(bytes("RIFF", [0x24, 0, 0, 0], "WAVE"))).toBe("audio/wav")
    expect(sniffAudioType(bytes([0, 0, 0, 0x20], "ftypM4A "))).toBe("audio/mp4")
  })

  test("tells a bare mp3 frame from AAC in ADTS", () => {
    expect(sniffAudioType(bytes([0xff, 0xfb, 0x90, 0x64]))).toBe("audio/mpeg")
    expect(sniffAudioType(bytes([0xff, 0xf1, 0x50, 0x80]))).toBe("audio/aac")
  })

  test("returns null for anything else", () => {
    expect(sniffAudioType(bytes("hello world"))).toBeNull()
    expect(sniffAudioType(bytes([0x89], "PNG"))).toBeNull()
    expect(sniffAudioType(bytes("RIFF", [0, 0, 0, 0], "AVI "))).toBeNull()
    expect(sniffAudioType(bytes([0, 0, 0, 0x20], "ftypisom"))).toBeNull()
    expect(sniffAudioType(new Uint8Array())).toBeNull()
  })
})

describe("readHead", () => {
  test("joins chunks up to the limit and cancels the rest of the body", async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes("Og"))
        controller.enqueue(bytes("gS", [0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 9, 9]))
      },
      cancel() {
        cancelled = true
      },
    })

    const head = await readHead(new Response(body), 6)

    expect(Array.from(head)).toEqual(Array.from(bytes("OggS", [0, 2])))
    expect(cancelled).toBe(true)
  })

  test("returns what there is when the body is shorter than the limit", async () => {
    const head = await readHead(new Response(bytes("ID")))
    expect(Array.from(head)).toEqual(Array.from(bytes("ID")))
  })
})
