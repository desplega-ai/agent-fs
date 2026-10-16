import { EmbeddingProviderError } from "../errors.js";

/**
 * Every vector in `chunk_vectors` and every query vector is unit length, so the
 * index's L2 distance ranks exactly like cosine similarity and converts to it.
 * Providers do not agree on this: the local nomic model returns vectors with a
 * norm around 23, which made L2 rank by length as much as by meaning.
 *
 * Throws `EmbeddingProviderError` on a wrong dimension count, a zero vector or a
 * non-finite value, so a bad provider response fails the job instead of
 * storing a vector that matches everything.
 */
export function toUnitVector(values: readonly number[], dimensions: number): Float32Array {
  if (values.length !== dimensions) {
    throw new EmbeddingProviderError(
      `Embedding has ${values.length} dimensions, expected ${dimensions}`
    );
  }
  // Check the Float32 values: a large finite double becomes Infinity here.
  const vec = Float32Array.from(values);
  let sumSq = 0;
  for (const x of vec) {
    if (!Number.isFinite(x)) throw new EmbeddingProviderError("Embedding contains a non-finite value");
    sumSq += x * x;
  }
  const norm = Math.sqrt(sumSq);
  // A zero vector has no direction. Scaled as is, it would score as a perfect match.
  if (!(norm > 0) || !Number.isFinite(norm)) {
    throw new EmbeddingProviderError("Embedding has zero or non-finite length");
  }
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

/** Cosine similarity of two unit vectors from their L2 distance: 1 - d²/2. */
export function similarityFromDistance(distance: number): number {
  return Math.max(-1, Math.min(1, 1 - (distance * distance) / 2));
}
