import { describe, expect, it } from 'vitest';

import {
  EMBEDDING_BYTES,
  cosineSimilarity,
  normalise,
  packEmbedding,
  topK,
  unpackEmbedding,
} from '../src/lib/vector';
import { EMBEDDING_DIMS, SIMILARITY_THRESHOLD } from '../src/types';

/** Deterministic pseudo-random vector so failures are reproducible. */
function pseudoRandomVector(seed: number, dims = EMBEDDING_DIMS): number[] {
  let state = seed >>> 0;
  return Array.from({ length: dims }, () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff - 0.5;
  });
}

function magnitude(v: Float32Array): number {
  let sum = 0;
  for (const x of v) sum += x * x;
  return Math.sqrt(sum);
}

describe('constants', () => {
  it('matches the D1 column width promised in schema.sql', () => {
    expect(EMBEDDING_DIMS).toBe(384);
    expect(EMBEDDING_BYTES).toBe(1536);
  });
});

describe('normalise', () => {
  it('produces a unit vector', () => {
    const unit = normalise([3, 4]);
    expect(magnitude(unit)).toBeCloseTo(1, 6);
    expect(unit[0]).toBeCloseTo(0.6, 6);
    expect(unit[1]).toBeCloseTo(0.8, 6);
  });

  it('normalises a full-width embedding to unit length', () => {
    expect(magnitude(normalise(pseudoRandomVector(7)))).toBeCloseTo(1, 5);
  });

  it('returns zeros — not NaN — for a zero vector', () => {
    const zero = normalise(new Array<number>(EMBEDDING_DIMS).fill(0));
    expect(zero).toHaveLength(EMBEDDING_DIMS);
    expect(Array.from(zero).every((x) => x === 0)).toBe(true);
    expect(Array.from(zero).some(Number.isNaN)).toBe(false);
  });

  it('scores zero against everything, rather than poisoning the search', () => {
    const zero = normalise([0, 0, 0]);
    const other = normalise([1, 2, 3]);
    expect(cosineSimilarity(zero, other)).toBe(0);
    expect(Number.isNaN(cosineSimilarity(zero, zero))).toBe(false);
  });

  it('treats NaN and Infinity as zero instead of propagating them', () => {
    const unit = normalise([3, Number.NaN, 4, Number.POSITIVE_INFINITY]);
    expect(Array.from(unit).some(Number.isNaN)).toBe(false);
    expect(magnitude(unit)).toBeCloseTo(1, 6);
    expect(unit[1]).toBe(0);
  });

  it('does not mutate its input', () => {
    const input = [3, 4];
    normalise(input);
    expect(input).toEqual([3, 4]);
  });

  it('accepts a Float32Array as well as a plain array', () => {
    const a = normalise([3, 4]);
    const b = normalise(Float32Array.from([3, 4]));
    expect(Array.from(b)).toEqual(Array.from(a));
  });
});

describe('packEmbedding / unpackEmbedding', () => {
  it('round-trips a 384-dim vector', () => {
    const raw = pseudoRandomVector(42);
    const restored = unpackEmbedding(packEmbedding(raw));
    const expected = normalise(raw);
    expect(restored).toHaveLength(EMBEDDING_DIMS);
    for (let i = 0; i < EMBEDDING_DIMS; i++) {
      expect(restored[i]).toBeCloseTo(expected[i] as number, 6);
    }
  });

  it('always produces exactly EMBEDDING_BYTES', () => {
    expect(packEmbedding(pseudoRandomVector(1)).byteLength).toBe(EMBEDDING_BYTES);
    expect(packEmbedding([1, 2, 3]).byteLength).toBe(EMBEDDING_BYTES);
    expect(packEmbedding(new Float32Array(EMBEDDING_DIMS)).byteLength).toBe(EMBEDDING_BYTES);
  });

  it('normalises on write so stored vectors are always unit length', () => {
    const restored = unpackEmbedding(packEmbedding(pseudoRandomVector(9).map((x) => x * 1000)));
    expect(magnitude(restored)).toBeCloseTo(1, 5);
  });

  it('writes little-endian float32', () => {
    const buf = packEmbedding([1]); // normalises to exactly 1.0
    const bytes = new Uint8Array(buf);
    // IEEE-754 1.0 = 0x3F800000; little-endian byte order is 00 00 80 3F.
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x00, 0x00, 0x80, 0x3f]);
    expect(new DataView(buf).getFloat32(0, true)).toBe(1);
  });

  it('zero-pads vectors shorter than EMBEDDING_DIMS', () => {
    const restored = unpackEmbedding(packEmbedding([1, 0, 0]));
    expect(restored[0]).toBe(1);
    expect(restored[3]).toBe(0);
    expect(restored[EMBEDDING_DIMS - 1]).toBe(0);
  });

  it('round-trips a zero vector without NaN', () => {
    const restored = unpackEmbedding(packEmbedding(new Array<number>(EMBEDDING_DIMS).fill(0)));
    expect(Array.from(restored).every((x) => x === 0)).toBe(true);
  });

  it('rejects vectors wider than the column', () => {
    expect(() => packEmbedding(new Array<number>(EMBEDDING_DIMS + 1).fill(0.1))).toThrow(RangeError);
    expect(() => packEmbedding(new Array<number>(EMBEDDING_DIMS + 1).fill(0.1))).toThrow(/385/);
  });

  it('rejects blobs of the wrong length with a clear message', () => {
    expect(() => unpackEmbedding(new ArrayBuffer(0))).toThrow(RangeError);
    expect(() => unpackEmbedding(new ArrayBuffer(EMBEDDING_BYTES - 4))).toThrow(/1532/);
    expect(() => unpackEmbedding(new ArrayBuffer(EMBEDDING_BYTES + 4))).toThrow(/expected 1536 bytes/);
  });

  it('accepts a Uint8Array view, including one at a non-zero offset', () => {
    const packed = packEmbedding(pseudoRandomVector(3));
    expect(unpackEmbedding(new Uint8Array(packed))[0]).toBeCloseTo(unpackEmbedding(packed)[0] as number, 6);

    const padded = new Uint8Array(EMBEDDING_BYTES + 8);
    padded.set(new Uint8Array(packed), 8);
    const view = new Uint8Array(padded.buffer, 8, EMBEDDING_BYTES);
    const restored = unpackEmbedding(view);
    expect(magnitude(restored)).toBeCloseTo(1, 5);
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors', () => {
    const v = normalise(pseudoRandomVector(11));
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity(normalise([1, 0, 0]), normalise([0, 1, 0]))).toBeCloseTo(0, 6);
    expect(cosineSimilarity(normalise([1, 1, 0]), normalise([1, -1, 0]))).toBeCloseTo(0, 6);
  });

  it('is -1 for opposite vectors', () => {
    expect(cosineSimilarity(normalise([1, 2, 3]), normalise([-1, -2, -3]))).toBeCloseTo(-1, 5);
  });

  it('survives a pack/unpack round-trip well above the similarity threshold', () => {
    const raw = pseudoRandomVector(23);
    const a = unpackEmbedding(packEmbedding(raw));
    const b = normalise(raw);
    expect(cosineSimilarity(a, b)).toBeGreaterThan(SIMILARITY_THRESHOLD);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
  });

  it('does not return NaN for zero vectors or length mismatches', () => {
    expect(cosineSimilarity(new Float32Array(4), new Float32Array(4))).toBe(0);
    expect(cosineSimilarity(normalise([1, 0, 0]), normalise([1, 0]))).toBeCloseTo(1, 6);
  });
});

describe('topK', () => {
  const candidates = [
    { id: 'exact', embedding: normalise([1, 0, 0]) },
    { id: 'near', embedding: normalise([0.95, 0.05, 0]) },
    { id: 'mid', embedding: normalise([0.6, 0.8, 0]) },
    { id: 'orthogonal', embedding: normalise([0, 1, 0]) },
    { id: 'opposite', embedding: normalise([-1, 0, 0]) },
  ];
  const query = normalise([1, 0, 0]);

  it('returns the best matches in descending score order', () => {
    const result = topK(query, candidates, 3, -1);
    expect(result.map((r) => r.id)).toEqual(['exact', 'near', 'mid']);
    for (let i = 1; i < result.length; i++) {
      expect((result[i - 1] as { score: number }).score).toBeGreaterThanOrEqual(
        (result[i] as { score: number }).score,
      );
    }
    expect(result[0]?.score).toBeCloseTo(1, 5);
  });

  it('honours k', () => {
    expect(topK(query, candidates, 1, -1).map((r) => r.id)).toEqual(['exact']);
    expect(topK(query, candidates, 100, -1)).toHaveLength(candidates.length);
  });

  it('filters by minScore', () => {
    const result = topK(query, candidates, 10, SIMILARITY_THRESHOLD);
    expect(result.map((r) => r.id)).toEqual(['exact', 'near']);
    for (const r of result) expect(r.score).toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD);
  });

  it('returns nothing when minScore excludes everything', () => {
    expect(topK(query, candidates, 10, 1.5)).toEqual([]);
  });

  it('handles empty input and non-positive k', () => {
    expect(topK(query, [], 5, 0)).toEqual([]);
    expect(topK(query, candidates, 0, -1)).toEqual([]);
    expect(topK(query, candidates, -3, -1)).toEqual([]);
  });

  it('finds the true best k in a large corpus, matching a brute-force sort', () => {
    const corpus = Array.from({ length: 500 }, (_, i) => ({
      id: `f_${i}`,
      embedding: normalise(pseudoRandomVector(i + 1, 64)),
    }));
    const q = normalise(pseudoRandomVector(999, 64));

    const expected = corpus
      .map((c) => ({ id: c.id, score: cosineSimilarity(q, c.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    const actual = topK(q, corpus, 5, -1);
    expect(actual.map((r) => r.id)).toEqual(expected.map((r) => r.id));
    actual.forEach((r, i) => expect(r.score).toBeCloseTo(expected[i]?.score as number, 6));
  });

  it('keeps ties stable in first-seen order', () => {
    const tied = [
      { id: 'a', embedding: normalise([1, 0, 0]) },
      { id: 'b', embedding: normalise([1, 0, 0]) },
      { id: 'c', embedding: normalise([1, 0, 0]) },
    ];
    expect(topK(query, tied, 2, -1).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('tolerates a zero-vector candidate', () => {
    const withZero = [...candidates, { id: 'zero', embedding: new Float32Array(3) }];
    const result = topK(query, withZero, 10, -1);
    expect(result.find((r) => r.id === 'zero')?.score).toBe(0);
    expect(result.some((r) => Number.isNaN(r.score))).toBe(false);
  });
});
