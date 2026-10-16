/** Audio containers the browser's <audio> element can play. */
export const AUDIO_EXTS = new Set(["mp3", "wav", "flac", "aac", "m4a", "ogg", "oga", "opus"])

/** Bytes needed by {@link sniffAudioType}. */
export const AUDIO_SNIFF_BYTES = 12

function ascii(bytes: Uint8Array, start: number, text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (bytes[start + i] !== text.charCodeAt(i)) return false
  }
  return true
}

/**
 * The audio MIME type that the leading bytes of a file announce, or `null`.
 * Chat audio and voice notes are often stored without an extension (and so as
 * `application/octet-stream`), which leaves their magic bytes as the only hint.
 */
export function sniffAudioType(bytes: Uint8Array): string | null {
  if (ascii(bytes, 0, "OggS")) return "audio/ogg"
  if (ascii(bytes, 0, "ID3")) return "audio/mpeg"
  if (ascii(bytes, 0, "fLaC")) return "audio/flac"
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WAVE")) return "audio/wav"
  if (ascii(bytes, 4, "ftypM4A") || ascii(bytes, 4, "ftypM4B")) return "audio/mp4"
  // An 11-bit frame sync: AAC in ADTS (layer bits 00) or MPEG audio (mp3).
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    const layer = (bytes[1] >> 1) & 0x03
    return layer === 0 ? "audio/aac" : "audio/mpeg"
  }
  return null
}

/** Read at most `count` leading bytes of a response, then drop the rest of the body. */
export async function readHead(res: Response, count = AUDIO_SNIFF_BYTES): Promise<Uint8Array> {
  const head = new Uint8Array(count)
  let filled = 0
  const reader = res.body?.getReader()
  if (!reader) return head.subarray(0, 0)
  try {
    while (filled < count) {
      const { done, value } = await reader.read()
      if (done) break
      const take = Math.min(value.length, count - filled)
      head.set(value.subarray(0, take), filled)
      filled += take
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return head.subarray(0, filled)
}
