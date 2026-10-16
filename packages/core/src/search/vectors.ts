/**
 * Every vector in `chunk_vectors` and every query vector is unit length, so the
 * index's L2 distance ranks exactly like cosine similarity and converts to it.
 * Providers do not agree on this: the local nomic model returns vectors with a
 * norm around 23, which made L2 rank by length as much as by meaning.
 */
export function toUnitVector(values: readonly number[]): Float32Array {
  const vec = Float32Array.from(values);
  let sumSq = 0;
  for (const x of vec) sumSq += x * x;
  const norm = Math.sqrt(sumSq);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  }
  return vec;
}

/** Cosine similarity of two unit vectors from their L2 distance: 1 - d²/2. */
export function similarityFromDistance(distance: number): number {
  return Math.max(-1, Math.min(1, 1 - (distance * distance) / 2));
}
