/**
 * Workers AI embedding helpers.
 *
 * bge-small-en-v1.5 produces 384-dimension vectors and has a 512-token context
 * window; anything longer is silently truncated by the model, so we truncate
 * deliberately and predictably instead. Embeddings are the cheapest thing in the
 * system (~1.8k neurons per million tokens) but the dimensionality check matters:
 * a short vector written into D1 corrupts every future cosine search.
 */

import { EMBEDDING_DIMS, MODEL } from '../types';

/**
 * Character budget per embedding input.
 *
 * bge-small accepts 512 tokens. English log text averages ~3.5 chars/token and
 * stack traces (punctuation-dense) are worse, so 1,600 chars keeps us inside the
 * window with margin even for pathological input.
 */
export const MAX_EMBED_CHARS = 1600;

/**
 * Texts per `ai.run` call. Workers AI accepts batched input for bge; batching is
 * one request instead of N, which matters far more than the token count here.
 */
export const EMBED_BATCH_SIZE = 50;

/** Raw shape returned by the bge models. */
interface EmbeddingResponse {
  shape?: number[];
  data?: number[][];
}

/** Deterministic truncation so the same log always yields the same vector. */
export function truncateForEmbedding(text: string): string {
  const normalised = (text ?? '').replace(/\r\n/g, '\n').trim();
  if (normalised.length <= MAX_EMBED_CHARS) return normalised;
  return normalised.slice(0, MAX_EMBED_CHARS);
}

function assertDims(vector: unknown, index: number, batchSize: number): number[] {
  if (!Array.isArray(vector)) {
    throw new Error(
      `Embedding model ${MODEL.EMBEDDING} returned a non-array vector at index ${index} of ${batchSize}.`,
    );
  }
  if (vector.length !== EMBEDDING_DIMS) {
    throw new Error(
      `Embedding model ${MODEL.EMBEDDING} returned ${vector.length} dimensions at index ${index} of ${batchSize}; expected ${EMBEDDING_DIMS}. Refusing to persist a malformed vector.`,
    );
  }
  for (let i = 0; i < vector.length; i++) {
    const value = vector[i];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(
        `Embedding model ${MODEL.EMBEDDING} returned a non-finite value at dimension ${i} of vector ${index}.`,
      );
    }
  }
  return vector as number[];
}

async function runEmbedding(ai: Ai, texts: string[]): Promise<number[][]> {
  const response = (await ai.run(MODEL.EMBEDDING, {
    text: texts,
  } as never)) as unknown as EmbeddingResponse;

  const data = response?.data;
  if (!Array.isArray(data)) {
    throw new Error(
      `Embedding model ${MODEL.EMBEDDING} returned no \`data\` array (got ${JSON.stringify(response)?.slice(0, 200)}).`,
    );
  }
  if (data.length !== texts.length) {
    throw new Error(
      `Embedding model ${MODEL.EMBEDDING} returned ${data.length} vectors for ${texts.length} inputs.`,
    );
  }
  return data.map((vector, index) => assertDims(vector, index, texts.length));
}

/**
 * Embed a single string. Input is truncated to `MAX_EMBED_CHARS` first, and the
 * returned vector is validated to be exactly `EMBEDDING_DIMS` long.
 */
export async function embed(ai: Ai, text: string): Promise<number[]> {
  const input = truncateForEmbedding(text);
  if (!input) {
    throw new Error('embed() called with empty text; refusing to embed an empty string.');
  }
  const [vector] = await runEmbedding(ai, [input]);
  return vector;
}

/**
 * Embed many strings using bge's native array input, chunked into batches of
 * `EMBED_BATCH_SIZE`. Order of the output matches the order of the input.
 *
 * Empty strings are rejected rather than silently embedded, because an all-zero
 * or degenerate vector poisons cosine ranking for every later search.
 */
export async function embedBatch(ai: Ai, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const inputs = texts.map((text, index) => {
    const truncated = truncateForEmbedding(text);
    if (!truncated) {
      throw new Error(`embedBatch() received empty text at index ${index}.`);
    }
    return truncated;
  });

  const out: number[][] = [];
  for (let offset = 0; offset < inputs.length; offset += EMBED_BATCH_SIZE) {
    const batch = inputs.slice(offset, offset + EMBED_BATCH_SIZE);
    out.push(...(await runEmbedding(ai, batch)));
  }
  return out;
}
