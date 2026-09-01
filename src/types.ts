/**
 * Shared contract for Pipeline Sentinel.
 * Every module in src/ builds against these types. Do not redefine them locally.
 */

import type { RepoState } from './repo-state';

// NOTE: `Workflow`, `WorkflowEntrypoint`, `WorkflowStep` and friends are AMBIENT
// GLOBALS from @cloudflare/workers-types — they are not exports of the
// 'cloudflare:workers' module (which only exports `connect`). Importing them
// yields an error type, which silently disables type checking on every call
// through the binding. Reference them unqualified.

/* ------------------------------------------------------------------ *
 * Model IDs — chosen to stay inside the 10,000 neuron/day free tier.
 * ------------------------------------------------------------------ */
export const MODEL = {
  /** Final root-cause reasoning. ~205k neurons / M output tokens — use sparingly. */
  REASONING: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  /**
   * Cheap structured work: chat answers, summarisation.
   *
   * NOT `@cf/meta/llama-3.1-8b-instruct` — that was deprecated on 2026-05-30
   * and now returns error 5028. Verified live against the account: this one
   * costs ~0.40 neurons for a short completion, versus ~47-73 neurons for a
   * full triage on the 70B, which is why chat is routed here.
   */
  FAST: '@cf/meta/llama-3.1-8b-instruct-fast',
  /** 384-dimension embeddings. ~1.8k neurons / M tokens. */
  EMBEDDING: '@cf/baai/bge-small-en-v1.5',
} as const;

/** bge-small-en-v1.5 output dimensionality. */
export const EMBEDDING_DIMS = 384;

/**
 * Cosine score at or above which two failures are considered the same problem.
 *
 * MEASURED, not guessed. Against the seed corpus, embedding CI error signatures
 * with bge-small-en-v1.5 produces:
 *
 *   0.82   near-identical signature text (same error, different build)
 *   0.77   same root cause, different wording (npm 401 vs 403 on one registry)
 *   0.74   same failure CLASS, different system (docker registry auth)
 *   0.63   unrelated failure in the same repo (a JWT assertion)
 *   0.57   unrelated failure, different subsystem (a Postgres connection)
 *
 * True positives cluster at 0.77+, and there is a wide gap below 0.74, so 0.75
 * separates them cleanly. The original value here was 0.82, which admitted only
 * near-verbatim repeats and silently returned "no prior matches" for a genuine
 * recurrence phrased differently — i.e. it disabled the memory feature in
 * exactly the case it exists for.
 *
 * Re-measure this if the embedding model changes; it is model-specific.
 */
export const SIMILARITY_THRESHOLD = 0.75;

/* ------------------------------------------------------------------ *
 * Worker environment bindings (must match wrangler.jsonc)
 * ------------------------------------------------------------------ */
export interface Env {
  AI: Ai;
  DB: D1Database;
  ASSETS: Fetcher;
  REPO_STATE: DurableObjectNamespace<RepoState>;
  TRIAGE_WORKFLOW: Workflow<TriageParams>;
  /** Optional shared secret for webhook HMAC verification (set via .dev.vars / secret). */
  WEBHOOK_SECRET?: string;
  /**
   * Optional bearer token for posting triage results back to the CI provider.
   * When absent, the `post-back` step records a no-op instead of spending three
   * retries on a request that is guaranteed to 401.
   */
  POSTBACK_TOKEN?: string;
}

/* ------------------------------------------------------------------ *
 * Ingestion
 * ------------------------------------------------------------------ */
export type Provider = 'github' | 'jenkins' | 'gitlab' | 'manual';

/** Normalised webhook payload. Provider-specific adapters produce this shape. */
export interface IncomingFailure {
  provider: Provider;
  repo: string;
  branch: string;
  /** Provider's run/build identifier. */
  pipelineId: string;
  jobName: string;
  /** URL back to the failing run, if the provider gave one. */
  runUrl?: string;
  commitSha?: string;
  author?: string;
  /** Raw job log. May be large; the parser is responsible for trimming. */
  logText: string;
  /** Epoch ms. Defaults to now when absent. */
  occurredAt?: number;
}

/* ------------------------------------------------------------------ *
 * Log parsing
 * ------------------------------------------------------------------ */
export type ErrorCategory =
  | 'test_failure'
  | 'compile_error'
  | 'dependency_error'
  | 'infra_timeout'
  | 'oom'
  | 'lint_error'
  | 'permission_error'
  | 'network_error'
  | 'unknown';

/**
 * A stable, noise-free fingerprint of why a build failed.
 * `hash` must be deterministic: identical failures across runs produce the same hash.
 */
export interface ErrorSignature {
  /**
   * SHA-256 (hex, first 32 chars) of `${category}\n${text}`.
   *
   * The category is part of the hashed input on purpose: two different kinds of
   * failure can normalise to the same line (a bare `[ERROR] ...`), and without
   * the prefix they would collide into one signature and be wrongly deduped as
   * the same problem.
   */
  hash: string;
  /** Normalised one-to-five line description, with timestamps/paths/ids stripped. */
  text: string;
  category: ErrorCategory;
  /** Best-guess source file or test name implicated, if any. */
  fileHint?: string;
  /** The most relevant raw log slice, capped at 4000 chars, for LLM context. */
  excerpt: string;
  /**
   * 0-1 confidence that this signature is meaningful rather than a fallback.
   *
   * NOT the same quantity as `TriageResult.confidence`, which is the model's
   * self-reported confidence in its diagnosis. This one is the parser's
   * confidence in the fingerprint. They are persisted to separate columns
   * (`signature_confidence` vs `confidence`).
   */
  confidence: number;
}

/* ------------------------------------------------------------------ *
 * Persistence (D1 `failures` table)
 * ------------------------------------------------------------------ */
export type FailureStatus = 'open' | 'awaiting_approval' | 'triaged' | 'resolved' | 'dismissed';

export interface FailureRecord {
  id: string;
  repo: string;
  branch: string;
  provider: Provider;
  pipelineId: string;
  jobName: string;
  runUrl: string | null;
  commitSha: string | null;
  signatureHash: string;
  signatureText: string;
  category: ErrorCategory;
  fileHint: string | null;
  excerpt: string;
  status: FailureStatus;
  /** The parser's confidence in the error fingerprint. Always present. */
  signatureConfidence: number;
  rootCause: string | null;
  /** The model's confidence in its diagnosis. Null until triage has run. */
  confidence: number | null;
  suggestedFix: string | null;
  /** One-line summary; null until triage has run. */
  headline: string | null;
  isLikelyFlake: boolean;
  /** Prior failure ids the model cited. Empty until triage has run. */
  citedFailureIds: string[];
  resolutionNote: string | null;
  resolvedAt: number | null;
  occurrenceCount: number;
  createdAt: number;
  lastSeenAt: number;
}

/** A past failure retrieved by vector search, with its similarity score attached. */
export interface SimilarFailure extends FailureRecord {
  /** Cosine similarity in [-1, 1]; in practice [0, 1] for bge embeddings. */
  score: number;
}

/* ------------------------------------------------------------------ *
 * Triage output
 * ------------------------------------------------------------------ */
export interface TriageResult {
  rootCause: string;
  suggestedFix: string;
  /** 0-1, the model's self-reported confidence. */
  confidence: number;
  /** True when the model judged this a flaky/infra failure rather than a real defect. */
  isLikelyFlake: boolean;
  /** IDs of prior failures the model actually leaned on. */
  citedFailureIds: string[];
  /** One-line summary suitable for a PR comment title. */
  headline: string;
}

/* ------------------------------------------------------------------ *
 * Workflow
 * ------------------------------------------------------------------ */
export interface TriageParams {
  failureId: string;
  incoming: IncomingFailure;
  /** When true the workflow pauses on `waitForEvent` before posting back. */
  requireApproval: boolean;
}

/** Payload delivered to the workflow's `approval` event. */
export interface ApprovalEvent {
  approved: boolean;
  editedFix?: string;
  reviewer?: string;
}

/* ------------------------------------------------------------------ *
 * Durable Object RPC surface (RepoState)
 * ------------------------------------------------------------------ */
export interface DedupeVerdict {
  /** False when an identical signature is already being triaged right now. */
  shouldTriage: boolean;
  reason: 'new' | 'in_flight' | 'recently_triaged';
  /** Present when reason !== 'new'. */
  existingFailureId?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
}

/** Cheap running totals held in the Durable Object, avoiding a D1 round trip. */
export interface RepoCounters {
  failures: number;
  resolved: number;
  lastFailureAt: number | null;
}

export interface RepoStats {
  repo: string;
  openCount: number;
  resolvedCount: number;
  /** Signatures seen 3+ times in the window, most frequent first. */
  topFlakes: Array<{ signatureHash: string; signatureText: string; count: number }>;
  windowDays: number;
}

/* ------------------------------------------------------------------ *
 * HTTP API contract (frontend <-> worker)
 * ------------------------------------------------------------------ */
export interface ApiError {
  error: string;
  detail?: string;
}

export interface IngestResponse {
  accepted: boolean;
  /** Null when the payload was not a failure at all (e.g. a green workflow_run). */
  failureId: string | null;
  workflowId?: string;
  /** `'ignored'` covers non-failure deliveries, which dedupe has no opinion on. */
  reason: DedupeVerdict['reason'] | 'ignored';
}

/** One row of the workflow audit trail (`triage_runs`). Rendered by the UI timeline. */
export interface TriageRun {
  id: string;
  failureId: string;
  workflowId: string;
  step: string;
  status: 'started' | 'ok' | 'error';
  detail: string | null;
  durationMs: number | null;
  createdAt: number;
}

/** Response of `GET /api/failures/:id`. */
export interface FailureDetailResponse {
  failure: FailureRecord;
  runs: TriageRun[];
  /**
   * The prior failures this triage cited, already hydrated with their scores.
   * Returned server-side so the UI does not have to issue one request per
   * citation to render the panel that proves memory is working.
   */
  citations: SimilarFailure[];
}

/** Response of `GET /api/failures`. Null `repo` means the list spans all repos. */
export interface FailureListResponse {
  repo: string | null;
  limit: number;
  count: number;
  failures: FailureRecord[];
}

export interface ChatRequest {
  repo: string;
  message: string;
}
