/**
 * D1 persistence layer for Pipeline Sentinel.
 *
 * This module is the ONLY place that knows about D1's snake_case column names.
 * Everything above it speaks `FailureRecord` / `TriageResult` from `../types`.
 *
 * Rules enforced here:
 *  - every statement is prepared with bound parameters (no string interpolation
 *    of values, ever — the only interpolation is a `?,?,?` placeholder run whose
 *    length is derived from an array we built ourselves);
 *  - writes that belong together go through `db.batch()` so they land in one
 *    round trip (D1 wraps a batch in an implicit transaction);
 *  - reads that feed the similarity search use a NARROW projection and a hard
 *    LIMIT, because the free plan gives us ~10ms of CPU per request.
 */

import { EMBEDDING_DIMS, SIMILARITY_THRESHOLD } from '../types';
import type {
  ErrorCategory,
  FailureRecord,
  FailureStatus,
  Provider,
  RepoStats,
  SimilarFailure,
  TriageResult,
  TriageRun,
} from '../types';
import { unpackEmbedding, topK } from './vector';

/* ------------------------------------------------------------------ *
 * Tuning knobs
 * ------------------------------------------------------------------ */

/**
 * Candidate-set bounds for `searchSimilar`.
 *
 * TRADEOFF: cosine similarity is computed in the Worker, so every candidate
 * costs us 384 multiply-adds plus one 1536-byte BLOB decode. A full table scan
 * is O(corpus) and will blow the 10ms CPU cap once a repo accumulates a few
 * thousand failures, so we never scan the table — we take a bounded, *ordered*
 * slice instead:
 *
 *   - up to RESOLVED_CANDIDATES rows with status='resolved', newest first.
 *     Resolved failures are the ones worth retrieving: they carry a
 *     human-confirmed root cause and fix, which is the entire value of the
 *     memory. They get the lion's share of the budget.
 *   - up to UNRESOLVED_CANDIDATES rows that are still open/triaged, newest
 *     first, so a failure that is recurring *right now* can still be matched
 *     even before anyone has resolved it.
 *
 * The cost of the bound is recall: a matching failure that is both unresolved
 * and older than the newest ~64 unresolved failures in that repo will be
 * missed. That is the right trade for a demo-scale corpus on the free plan —
 * the alternative (Vectorize, or an ANN index) is paid-plan only. If recall
 * ever matters more than CPU, raise these numbers or shard by `category`.
 */
const RESOLVED_CANDIDATES = 192;
const UNRESOLVED_CANDIDATES = 64;

/** Rows returned by `getRepoStats().topFlakes`. */
const TOP_FLAKES_LIMIT = 10;

/** A signature must have been seen this many times to count as "flaky". */
const FLAKE_MIN_OCCURRENCES = 3;

/** Statuses that count as "still costing someone time". */
const OPEN_STATUSES: FailureStatus[] = ['open', 'awaiting_approval', 'triaged'];

/* ------------------------------------------------------------------ *
 * Row shape + mapping
 * ------------------------------------------------------------------ */

/** Exact shape of a `failures` row as D1 hands it back. */
interface FailureRow {
  id: string;
  repo: string;
  branch: string;
  provider: string;
  pipeline_id: string;
  job_name: string;
  run_url: string | null;
  commit_sha: string | null;
  signature_hash: string;
  signature_text: string;
  category: string;
  file_hint: string | null;
  excerpt: string;
  signature_confidence: number;
  status: string;
  root_cause: string | null;
  suggested_fix: string | null;
  confidence: number | null;
  headline: string | null;
  is_likely_flake: number;
  cited_failure_ids: string | null;
  resolution_note: string | null;
  resolved_at: number | null;
  occurrence_count: number;
  created_at: number;
  last_seen_at: number;
}

/** Narrow projection used by the similarity search — id + vector only. */
interface CandidateRow {
  id: string;
  embedding: unknown;
}

/**
 * `cited_failure_ids` is a JSON array in TEXT. It is written by us, but seed
 * fixtures and older rows may hold anything, so parse defensively: a bad value
 * degrades the citations panel rather than failing the whole request.
 */
function parseCitedIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The single snake_case -> camelCase boundary in the codebase.
 * `category` and `status` are widened strings in SQLite; we cast rather than
 * validate because the only writer is `insertFailure`, which takes typed input.
 */
function toRecord(row: FailureRow): FailureRecord {
  return {
    id: row.id,
    repo: row.repo,
    branch: row.branch,
    provider: row.provider as Provider,
    pipelineId: row.pipeline_id,
    jobName: row.job_name,
    runUrl: row.run_url,
    commitSha: row.commit_sha,
    signatureHash: row.signature_hash,
    signatureText: row.signature_text,
    category: row.category as ErrorCategory,
    fileHint: row.file_hint,
    excerpt: row.excerpt,
    status: row.status as FailureStatus,
    signatureConfidence: row.signature_confidence,
    rootCause: row.root_cause,
    suggestedFix: row.suggested_fix,
    confidence: row.confidence,
    headline: row.headline,
    isLikelyFlake: row.is_likely_flake === 1,
    citedFailureIds: parseCitedIds(row.cited_failure_ids),
    resolutionNote: row.resolution_note,
    resolvedAt: row.resolved_at,
    occurrenceCount: row.occurrence_count,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

/** Every column of `failures` except the embedding BLOB, in schema order. */
/**
 * Every column of `FailureRow` except `embedding`, which is excluded on purpose:
 * it is 1.5KB of binary per row and no caller of `toRecord` needs it.
 *
 * This list MUST stay in sync with `FailureRow`. TypeScript cannot check that —
 * the row interface describes what we *claim* the query returns, so a column
 * missing here surfaces as `undefined` at runtime with a green build. There is
 * a test asserting the two agree; add new columns to both.
 */
const FAILURE_COLUMNS = `
  id, repo, branch, provider, pipeline_id, job_name, run_url, commit_sha,
  signature_hash, signature_text, category, file_hint, excerpt,
  signature_confidence, status, root_cause, suggested_fix, confidence,
  headline, is_likely_flake, cited_failure_ids, resolution_note, resolved_at,
  occurrence_count, created_at, last_seen_at
`;

/** Exported so the schema-drift test can compare it against `schema.sql`. */
export const FAILURE_SELECT_COLUMNS = FAILURE_COLUMNS;

/**
 * D1 has returned BLOB columns as `ArrayBuffer` and, in older releases, as a
 * plain `number[]` of byte values. Normalise both to something
 * `unpackEmbedding` accepts, and reject anything that isn't a full vector so a
 * malformed row can't poison the scoring pass.
 */
function toVectorBytes(value: unknown): Uint8Array | null {
  const expected = EMBEDDING_DIMS * 4;
  let bytes: Uint8Array | null = null;

  if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  } else if (Array.isArray(value)) {
    bytes = Uint8Array.from(value as number[]);
  }

  if (bytes === null || bytes.byteLength !== expected) return null;
  return bytes;
}

/** `?,?,?` for an array of length n. Placeholder count only — values stay bound. */
function placeholders(n: number): string {
  return new Array(n).fill('?').join(',');
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

/**
 * Insert a brand-new failure together with its packed embedding.
 *
 * Idempotent by primary key: the workflow's `persist-failure` step can be
 * retried after a partial failure without exploding, and a duplicate delivery
 * of the same failure id refreshes `last_seen_at` instead of erroring.
 */
export async function insertFailure(
  db: D1Database,
  record: FailureRecord,
  embedding: ArrayBuffer,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO failures (
         id, repo, branch, provider, pipeline_id, job_name, run_url, commit_sha,
         signature_hash, signature_text, category, file_hint, excerpt, embedding,
         signature_confidence, status, root_cause, suggested_fix, confidence,
         headline, is_likely_flake, cited_failure_ids, resolution_note, resolved_at,
         occurrence_count, created_at, last_seen_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         embedding    = excluded.embedding`,
    )
    .bind(
      record.id,
      record.repo,
      record.branch,
      record.provider,
      record.pipelineId,
      record.jobName,
      record.runUrl,
      record.commitSha,
      record.signatureHash,
      record.signatureText,
      record.category,
      record.fileHint,
      record.excerpt,
      embedding,
      record.signatureConfidence,
      record.status,
      record.rootCause,
      record.suggestedFix,
      record.confidence,
      record.headline,
      record.isLikelyFlake ? 1 : 0,
      JSON.stringify(record.citedFailureIds ?? []),
      record.resolutionNote,
      record.resolvedAt,
      record.occurrenceCount,
      record.createdAt,
      record.lastSeenAt,
    )
    .run();
}

/**
 * Record the model's verdict.
 *
 * `status` defaults to `triaged`; the workflow passes `awaiting_approval`
 * instead when a human has to sign off before the result is posted back.
 */
export async function updateTriage(
  db: D1Database,
  id: string,
  result: TriageResult,
  status: FailureStatus = 'triaged',
): Promise<void> {
  await db
    .prepare(
      `UPDATE failures
          SET root_cause        = ?,
              suggested_fix     = ?,
              confidence        = ?,
              headline          = ?,
              is_likely_flake   = ?,
              cited_failure_ids = ?,
              status            = ?
        WHERE id = ?`,
    )
    .bind(
      result.rootCause,
      result.suggestedFix,
      result.confidence,
      result.headline,
      result.isLikelyFlake ? 1 : 0,
      // Persisted so the UI can prove the answer came from a prior precedent.
      JSON.stringify(result.citedFailureIds ?? []),
      status,
      id,
    )
    .run();
}

/**
 * Another run hit an already-known failure. Bump the counter and push
 * `last_seen_at` forward — never backwards, so an out-of-order webhook can't
 * make a failure look older than it is.
 */
export async function bumpOccurrence(db: D1Database, id: string, seenAt: number): Promise<void> {
  await db
    .prepare(
      `UPDATE failures
          SET occurrence_count = occurrence_count + 1,
              last_seen_at     = MAX(last_seen_at, ?)
        WHERE id = ?`,
    )
    .bind(seenAt, id)
    .run();
}

/**
 * Close a failure out. This is what turns a row into useful memory: from here
 * on `searchSimilar` will preferentially retrieve it, fix and all.
 */
export async function markResolved(db: D1Database, id: string, note: string): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `UPDATE failures
          SET status          = 'resolved',
              resolution_note = ?,
              resolved_at     = ?
        WHERE id = ?`,
    )
    .bind(note, now, id)
    .run();
}

/** Move a failure between states without touching the triage columns. */
export async function setStatus(db: D1Database, id: string, status: FailureStatus): Promise<void> {
  await db.prepare(`UPDATE failures SET status = ? WHERE id = ?`).bind(status, id).run();
}

/**
 * Append one row to the workflow audit trail.
 *
 * Deliberately fire-and-forget in shape: callers log around every step, and a
 * logging hiccup must never be the reason a triage fails, so `TriageWorkflow`
 * wraps this in a swallowing helper.
 */
export async function logStep(
  db: D1Database,
  failureId: string,
  workflowId: string,
  step: string,
  status: 'started' | 'ok' | 'error',
  detail: string | null = null,
  durationMs: number | null = null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO triage_runs (id, failure_id, workflow_id, step, status, detail, duration_ms, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .bind(
      crypto.randomUUID(),
      failureId,
      workflowId,
      step,
      status,
      detail === null ? null : detail.slice(0, 2000),
      durationMs,
      Date.now(),
    )
    .run();
}

/**
 * Resolve a failure and record the closing audit line in a single round trip.
 * `db.batch()` runs both statements inside one implicit transaction.
 */
export async function resolveWithAudit(
  db: D1Database,
  id: string,
  note: string,
  workflowId: string,
): Promise<void> {
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        `UPDATE failures
            SET status = 'resolved', resolution_note = ?, resolved_at = ?
          WHERE id = ?`,
      )
      .bind(note, now, id),
    db
      .prepare(
        `INSERT INTO triage_runs (id, failure_id, workflow_id, step, status, detail, duration_ms, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .bind(crypto.randomUUID(), id, workflowId, 'resolve', 'ok', note.slice(0, 2000), null, now),
  ]);
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export async function getFailure(db: D1Database, id: string): Promise<FailureRecord | null> {
  const row = await db
    .prepare(`SELECT ${FAILURE_COLUMNS} FROM failures WHERE id = ?`)
    .bind(id)
    .first<FailureRow>();
  return row ? toRecord(row) : null;
}

/** Newest failures for a repo, for the dashboard list. */
export async function recentFailures(
  db: D1Database,
  repo: string | null,
  limit: number,
): Promise<FailureRecord[]> {
  const capped = Math.max(1, Math.min(limit, 200));
  // A null repo means "across every repo" — the UI uses that to populate its
  // repo selector before it knows which repos exist.
  const stmt = repo
    ? db
        .prepare(
          `SELECT ${FAILURE_COLUMNS}
             FROM failures
            WHERE repo = ?
            ORDER BY last_seen_at DESC
            LIMIT ?`,
        )
        .bind(repo, capped)
    : db
        .prepare(
          `SELECT ${FAILURE_COLUMNS}
             FROM failures
            ORDER BY last_seen_at DESC
            LIMIT ?`,
        )
        .bind(capped);

  const { results } = await stmt.all<FailureRow>();
  return (results ?? []).map(toRecord);
}

/** Distinct repos that have ever reported a failure, most recently active first. */
export async function listRepos(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT repo, MAX(last_seen_at) AS seen
         FROM failures
        GROUP BY repo
        ORDER BY seen DESC
        LIMIT 100`,
    )
    .all<{ repo: string; seen: number }>();
  return (results ?? []).map((row) => row.repo);
}

/**
 * Most recent still-open failure carrying a given signature, if any.
 * Used by the ingest path to decide between "new failure" and "bump the
 * existing one" without waking the workflow.
 */
export async function findOpenBySignature(
  db: D1Database,
  repo: string,
  signatureHash: string,
): Promise<FailureRecord | null> {
  const row = await db
    .prepare(
      `SELECT ${FAILURE_COLUMNS}
         FROM failures
        WHERE repo = ? AND signature_hash = ? AND status NOT IN ('resolved','dismissed')
        ORDER BY last_seen_at DESC
        LIMIT 1`,
    )
    .bind(repo, signatureHash)
    .first<FailureRow>();
  return row ? toRecord(row) : null;
}

/* ------------------------------------------------------------------ *
 * Retrieval core
 * ------------------------------------------------------------------ */

/**
 * Vector search over a repo's failure memory.
 *
 * Three phases, deliberately separated so the expensive one stays small:
 *
 *  1. CANDIDATE FETCH — two bounded, index-backed queries (`idx_failures_repo_seen`
 *     / `idx_failures_status`) batched into one round trip, projecting only
 *     `id, embedding`. Pulling the full row here would drag ~4KB of `excerpt`
 *     per candidate across the wire for rows we are about to throw away.
 *  2. SCORING — decode each 1536-byte BLOB into a Float32Array and hand the lot
 *     to `topK`. See RESOLVED_CANDIDATES above for the recall tradeoff.
 *  3. HYDRATION — one `WHERE id IN (...)` for the handful of winners, then
 *     re-sorted into score order (SQL will not preserve it).
 *
 * `excludeId` matters: the workflow persists the new failure *before* it
 * searches, so without it every failure retrieves itself at score 1.0.
 */
export async function searchSimilar(
  db: D1Database,
  repo: string,
  queryEmbedding: Float32Array,
  k: number,
  minScore: number = SIMILARITY_THRESHOLD,
  excludeId?: string,
): Promise<SimilarFailure[]> {
  const wanted = Math.max(1, Math.min(k, 25));

  // Phase 1: bounded candidate fetch, narrow projection, one round trip.
  const batched = await db.batch<CandidateRow>([
    db
      .prepare(
        `SELECT id, embedding
           FROM failures
          WHERE repo = ? AND status = 'resolved'
          ORDER BY last_seen_at DESC
          LIMIT ?`,
      )
      .bind(repo, RESOLVED_CANDIDATES),
    db
      .prepare(
        `SELECT id, embedding
           FROM failures
          WHERE repo = ? AND status NOT IN ('resolved','dismissed')
          ORDER BY last_seen_at DESC
          LIMIT ?`,
      )
      .bind(repo, UNRESOLVED_CANDIDATES),
  ]);

  // Phase 2: decode + score. `topK` takes `{ id, embedding }` pairs and returns
  // them already sorted by descending score.
  const candidates: Array<{ id: string; embedding: Float32Array }> = [];
  const seen = new Set<string>();
  if (excludeId) seen.add(excludeId);

  for (const result of batched) {
    for (const row of result.results ?? []) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const bytes = toVectorBytes(row.embedding);
      if (bytes === null) continue; // wrong width — a seed placeholder or corrupt row
      const vector = unpackEmbedding(bytes);
      candidates.push({ id: row.id, embedding: vector });
    }
  }

  if (candidates.length === 0) return [];

  const scored = topK(queryEmbedding, candidates, wanted, minScore).filter(
    (hit) => Number.isFinite(hit.score),
  );
  if (scored.length === 0) return [];

  // Phase 3: hydrate the winners only.
  const ids = scored.map((hit) => hit.id);
  const { results } = await db
    .prepare(
      `SELECT ${FAILURE_COLUMNS} FROM failures WHERE id IN (${placeholders(ids.length)})`,
    )
    .bind(...ids)
    .all<FailureRow>();

  const byId = new Map<string, FailureRecord>();
  for (const row of results ?? []) byId.set(row.id, toRecord(row));

  const out: SimilarFailure[] = [];
  for (const hit of scored) {
    const record = byId.get(hit.id);
    if (record) out.push({ ...record, score: hit.score });
  }
  return out; // already in descending score order, courtesy of topK
}

/* ------------------------------------------------------------------ *
 * Aggregates
 * ------------------------------------------------------------------ */

interface StatsRow {
  open_count: number | null;
  resolved_count: number | null;
}

interface FlakeRow {
  signature_hash: string;
  signature_text: string;
  count: number;
}

/**
 * Backs the "what's flaky this week?" question.
 *
 * The window is applied to `last_seen_at`, not `created_at`: a failure first
 * seen two months ago but still firing today is exactly what we want surfaced.
 *
 * `count` sums `occurrence_count` across every row sharing a signature, so ten
 * separate rows seen once each and one row seen ten times both read as 10 —
 * which is the honest answer to "how often did this bite us".
 */
export async function getRepoStats(
  db: D1Database,
  repo: string,
  windowDays: number,
): Promise<RepoStats> {
  const days = Math.max(1, Math.min(windowDays, 365));
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const openList = placeholders(OPEN_STATUSES.length);

  const [statsResult, flakeResult] = await db.batch([
    db
      .prepare(
        `SELECT
           SUM(CASE WHEN status IN (${openList}) THEN 1 ELSE 0 END) AS open_count,
           SUM(CASE WHEN status = 'resolved'     THEN 1 ELSE 0 END) AS resolved_count
         FROM failures
        WHERE repo = ? AND last_seen_at >= ?`,
      )
      .bind(...OPEN_STATUSES, repo, since),
    db
      .prepare(
        `SELECT signature_hash,
                MIN(signature_text)      AS signature_text,
                SUM(occurrence_count)    AS count
           FROM failures
          WHERE repo = ? AND last_seen_at >= ?
          GROUP BY signature_hash
         HAVING SUM(occurrence_count) >= ?
          ORDER BY count DESC, MAX(last_seen_at) DESC
          LIMIT ?`,
      )
      .bind(repo, since, FLAKE_MIN_OCCURRENCES, TOP_FLAKES_LIMIT),
  ]);

  const stats = (statsResult.results as unknown as StatsRow[] | undefined)?.[0];
  const flakes = (flakeResult.results as unknown as FlakeRow[] | undefined) ?? [];

  return {
    repo,
    openCount: stats?.open_count ?? 0,
    resolvedCount: stats?.resolved_count ?? 0,
    topFlakes: flakes.map((row) => ({
      signatureHash: row.signature_hash,
      signatureText: row.signature_text,
      count: row.count,
    })),
    windowDays: days,
  };
}

/** One row of the audit trail. `logStep` only ever writes these three states. */
export type TriageRunStatus = 'started' | 'ok' | 'error';

export async function getTriageRuns(
  db: D1Database,
  failureId: string,
  limit: number = 100,
): Promise<TriageRun[]> {
  const capped = Math.max(1, Math.min(limit, 500));
  const { results } = await db
    .prepare(
      `SELECT id, failure_id, workflow_id, step, status, detail, duration_ms, created_at
         FROM triage_runs
        WHERE failure_id = ?
        ORDER BY created_at ASC
        LIMIT ?`,
    )
    .bind(failureId, capped)
    .all<{
      id: string;
      failure_id: string;
      workflow_id: string;
      step: string;
      status: string;
      detail: string | null;
      duration_ms: number | null;
      created_at: number;
    }>();

  return (results ?? []).map((row) => ({
    id: row.id,
    failureId: row.failure_id,
    workflowId: row.workflow_id,
    step: row.step,
    status: row.status as TriageRunStatus,
    detail: row.detail,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  }));
}

/* ------------------------------------------------------------------ *
 * Embedding backfill
 *
 * `fixtures/seed.sql` writes `zeroblob(1536)` placeholders, because generating
 * real vectors requires Workers AI and SQL fixtures cannot call it. A zero
 * vector scores 0 against everything, so until this backfill runs the seeded
 * corpus is invisible to `searchSimilar` — which would make the memory feature
 * look broken in a demo. `POST /api/admin/reembed` drives these two helpers.
 * ------------------------------------------------------------------ */

/** A failure whose stored embedding is still an all-zero placeholder. */
export interface PendingEmbedding {
  id: string;
  signatureText: string;
}

export async function failuresMissingEmbedding(
  db: D1Database,
  limit = 50,
): Promise<PendingEmbedding[]> {
  const capped = Math.max(1, Math.min(limit, 200));
  const { results } = await db
    .prepare(
      `SELECT id, signature_text
         FROM failures
        WHERE hex(embedding) = hex(zeroblob(?))
        ORDER BY last_seen_at DESC
        LIMIT ?`,
    )
    .bind(EMBEDDING_DIMS * 4, capped)
    .all<{ id: string; signature_text: string }>();

  return (results ?? []).map((row) => ({ id: row.id, signatureText: row.signature_text }));
}

export async function setEmbedding(
  db: D1Database,
  id: string,
  embedding: ArrayBuffer,
): Promise<void> {
  await db
    .prepare(`UPDATE failures SET embedding = ? WHERE id = ?`)
    .bind(embedding, id)
    .run();
}

/**
 * Hydrates the prior failures a triage cited, so the UI can render the
 * "answered from precedent" panel in a single request instead of N+1 lookups.
 * Returns them in the order the model cited them; unknown ids are dropped.
 */
export async function getCitedFailures(
  db: D1Database,
  citedIds: string[],
): Promise<SimilarFailure[]> {
  const ids = citedIds.filter((v) => typeof v === 'string' && v.length > 0).slice(0, 8);
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(',');
  const { results } = await db
    .prepare(`SELECT * FROM failures WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<FailureRow>();

  const byId = new Map((results ?? []).map((row) => [row.id, toRecord(row)]));
  return ids
    .map((id) => byId.get(id))
    .filter((rec): rec is FailureRecord => rec !== undefined)
    // The score is not re-derived here: these are recorded citations, not a
    // fresh search. `score: 1` marks them as "the model actually used this".
    .map((rec) => ({ ...rec, score: 1 }));
}
