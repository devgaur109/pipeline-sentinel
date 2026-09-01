/**
 * Embedding maths and D1 serialisation.
 *
 * Why hand-rolled instead of Cloudflare Vectorize
 * -----------------------------------------------
 * Vectorize is a Workers **Paid**-plan binding; Pipeline Sentinel is required to
 * run end-to-end on the free plan, so there is no Vectorize index available to
 * us. Instead every failure's 384-dim bge-small-en-v1.5 embedding is stored as a
 * 1536-byte little-endian float32 BLOB in the D1 `failures.embedding` column and
 * similarity search is a linear scan inside the Worker.
 *
 * That is affordable because:
 *   - vectors are L2-normalised **on write**, so similarity is a bare dot
 *     product with no per-query square roots;
 *   - 384 multiply-adds over a few thousand rows is well under the free plan's
 *     10ms CPU budget (roughly 1M flops for a 2,500-row corpus);
 *   - candidates are pre-filtered by repo in SQL before they ever reach here.
 *
 * If the corpus ever outgrows a linear scan, the swap-in point is `topK` alone.
 */

import { EMBEDDING_DIMS } from '../types';

/** Bytes occupied by one serialised embedding: 384 × 4. */
export const EMBEDDING_BYTES = EMBEDDING_DIMS * 4;

/**
 * L2-normalise `v` into a new `Float32Array`.
 *
 * A zero (or non-finite) vector has no direction, so it normalises to all
 * zeros rather than `NaN`. A zero vector scores 0 against everything, which is
 * the correct "matches nothing" behaviour for a failed embedding call.
 *
 * @param v Raw embedding of any length (callers should pass {@link EMBEDDING_DIMS}).
 */
export function normalise(v: number[] | Float32Array): Float32Array {
  const out = new Float32Array(v.length);
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i] as number;
    const safe = Number.isFinite(x) ? x : 0;
    out[i] = safe;
    sumSq += safe * safe;
  }
  if (sumSq === 0) return out; // already all zeros
  const inv = 1 / Math.sqrt(sumSq);
  if (!Number.isFinite(inv)) return new Float32Array(v.length);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) * inv;
  return out;
}

/**
 * Serialise an embedding to the little-endian float32 blob stored in D1.
 *
 * Normalises on write, so {@link cosineSimilarity} on the unpacked value is a
 * plain dot product. Vectors shorter than {@link EMBEDDING_DIMS} are zero-padded
 * and longer ones are rejected, so the column width stays fixed.
 *
 * @throws {RangeError} if `v` has more than {@link EMBEDDING_DIMS} elements.
 */
export function packEmbedding(v: number[] | Float32Array): ArrayBuffer {
  if (v.length > EMBEDDING_DIMS) {
    throw new RangeError(
      `packEmbedding: expected at most ${EMBEDDING_DIMS} dimensions, got ${v.length}`,
    );
  }
  const unit = normalise(v);
  const buf = new ArrayBuffer(EMBEDDING_BYTES);
  const view = new DataView(buf);
  for (let i = 0; i < unit.length; i++) {
    view.setFloat32(i * 4, unit[i] as number, /* littleEndian */ true);
  }
  return buf;
}

/**
 * Inverse of {@link packEmbedding}. Accepts what D1 hands back for a BLOB
 * column (`ArrayBuffer`, or a `Uint8Array` view of a larger buffer).
 *
 * @throws {RangeError} if the blob is not exactly {@link EMBEDDING_BYTES} long.
 */
export function unpackEmbedding(buf: ArrayBuffer | Uint8Array): Float32Array {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.byteLength !== EMBEDDING_BYTES) {
    throw new RangeError(
      `unpackEmbedding: expected ${EMBEDDING_BYTES} bytes (${EMBEDDING_DIMS} float32s), got ${bytes.byteLength}`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(EMBEDDING_DIMS);
  for (let i = 0; i < EMBEDDING_DIMS; i++) {
    out[i] = view.getFloat32(i * 4, /* littleEndian */ true);
  }
  return out;
}

/**
 * Dot product of two vectors.
 *
 * **Assumes both operands are already L2-normalised** — which everything that
 * goes through {@link packEmbedding} / {@link normalise} is — so the dot product
 * *is* the cosine and no magnitudes are recomputed. Pass a non-unit vector and
 * you get an unnormalised score, not a cosine.
 *
 * Length mismatches are tolerated by comparing the shared prefix, so a stale
 * row from an older model cannot take the whole search down.
 *
 * @returns Cosine similarity in [-1, 1]; [0, 1] in practice for bge embeddings.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += (a[i] as number) * (b[i] as number);
  return Number.isFinite(dot) ? dot : 0;
}

/** One scored candidate returned by {@link topK}. */
export interface ScoredId {
  id: string;
  score: number;
}

/**
 * Highest-scoring `k` candidates above `minScore`, best first.
 *
 * Single pass over `candidates` with a bounded insertion into a `k`-element
 * array — O(n·d + n·k) rather than scoring everything and sorting O(n log n)
 * with a full-size intermediate. For the `k <= 10` this project uses, the
 * insertion is effectively free and no large array is ever allocated.
 *
 * All vectors are assumed pre-normalised (see {@link cosineSimilarity}).
 *
 * @param query     Normalised query embedding.
 * @param candidates Rows to score; duplicates of `id` are not de-duplicated.
 * @param k         Maximum results. `<= 0` yields an empty array.
 * @param minScore  Inclusive lower bound on the cosine score.
 */
export function topK(
  query: Float32Array,
  candidates: Array<{ id: string; embedding: Float32Array }>,
  k: number,
  minScore: number,
): ScoredId[] {
  if (k <= 0 || candidates.length === 0) return [];
  const limit = Math.min(k, candidates.length);
  const best: ScoredId[] = [];

  for (const candidate of candidates) {
    const score = cosineSimilarity(query, candidate.embedding);
    if (score < minScore) continue;
    // Reject early once full: cheaper than an insertion we would undo.
    if (best.length === limit && score <= (best[best.length - 1] as ScoredId).score) continue;

    let pos = best.length;
    while (pos > 0 && (best[pos - 1] as ScoredId).score < score) pos--;
    best.splice(pos, 0, { id: candidate.id, score });
    if (best.length > limit) best.pop();
  }
  return best;
}
