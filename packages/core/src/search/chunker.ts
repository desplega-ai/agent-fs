export interface Chunk {
  content: string;
  charOffset: number;
  tokenCount: number;
}

export async function chunkContent(content: string): Promise<Chunk[]> {
  try {
    const { RecursiveChunker } = await import("chonkie");
    const chunker = await RecursiveChunker.create({
      chunkSize: 900,
    });

    const chunks = await chunker.chunk(content);
    return chunks.map((c: any) => ({
      content: c.text,
      charOffset: c.startIndex ?? 0,
      tokenCount: c.tokenCount ?? Math.ceil(c.text.length / 4),
    }));
  } catch {
    // Fallback: simple paragraph-based splitting
    return fallbackChunk(content);
  }
}

function fallbackChunk(content: string): Chunk[] {
  const TARGET_SIZE = 3600; // ~900 tokens * 4 chars/token
  const OVERLAP = 512;
  const chunks: Chunk[] = [];

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
