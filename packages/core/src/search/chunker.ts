export interface Chunk {
  content: string;
  charOffset: number;
  tokenCount: number;
}

// Keep chunks under the nomic 2048-token context.
const CHUNK_CHARS = 2000;

/**
 * Chunking is synchronous CPU work: 2 MB of text in one call kept the event
 * loop busy for about 3 s, long enough to fail health checks. Longer text is
 * cut at line breaks into segments of about this size, chunked one at a time
 * with a yield to the event loop in between. Shorter text is one segment.
 */
const SEGMENT_CHARS = 64 * 1024;

export async function chunkContent(content: string): Promise<Chunk[]> {
  if (content.length === 0) return [];

  try {
    const { RecursiveChunker } = await import("@chonkiejs/core");
    const chunker = await RecursiveChunker.create({
      chunkSize: CHUNK_CHARS,
    });

    const result: Chunk[] = [];
    for (const [start, end] of segments(content, SEGMENT_CHARS)) {
      if (start > 0) await new Promise((resolve) => setImmediate(resolve));
      const chunks = await chunker.chunk(content.slice(start, end));
      for (const c of chunks) {
        result.push({
          content: c.text,
          charOffset: start + (c.startIndex ?? 0),
          tokenCount: Math.ceil(c.text.length / 4),
        });
      }
    }
    return result;
  } catch {
    // Fallback: simple paragraph-based splitting
    return fallbackChunk(content);
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** `[start, end)` ranges of about `size` characters, cut after a line break when one is near. */
export function segments(content: string, size: number): [number, number][] {
  const ranges: [number, number][] = [];
  let start = 0;
  while (start < content.length) {
    let end = Math.min(start + size, content.length);
    if (end < content.length) {
      const lineBreak = content.lastIndexOf("\n", end - 1);
      if (lineBreak >= start + size / 2) end = lineBreak + 1;
      // Never split a surrogate pair (an emoji, for example).
      else if (isHighSurrogate(content.charCodeAt(end - 1))) end -= 1;
    }
    ranges.push([start, end]);
    start = end;
  }
  return ranges;
}

function fallbackChunk(content: string): Chunk[] {
  const TARGET_SIZE = CHUNK_CHARS;
  const OVERLAP = 512;
  const chunks: Chunk[] = [];

  if (content.length === 0) return [];

  if (content.length <= TARGET_SIZE) {
    return [
      { content, charOffset: 0, tokenCount: Math.ceil(content.length / 4) },
    ];
  }

  let offset = 0;
  while (offset < content.length) {
    const end = Math.min(offset + TARGET_SIZE, content.length);
    let chunk = content.slice(offset, end);

    if (end < content.length) {
      const lastParagraph = chunk.lastIndexOf("\n\n");
      if (lastParagraph > TARGET_SIZE * 0.5) {
        chunk = chunk.slice(0, lastParagraph);
      }
    }

    chunks.push({
      content: chunk,
      charOffset: offset,
      tokenCount: Math.ceil(chunk.length / 4),
    });

    offset += chunk.length - OVERLAP;
    if (offset <= chunks[chunks.length - 1].charOffset) {
      offset = chunks[chunks.length - 1].charOffset + chunk.length;
    }
  }

  return chunks;
}
