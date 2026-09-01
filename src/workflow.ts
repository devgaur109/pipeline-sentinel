/**
 * `TriageWorkflow` — the durable brain of Pipeline Sentinel.
 *
 * A CI failure arrives, and answering it well takes ~2 seconds of parsing, two
 * network calls to Workers AI (one of which is a 70B model), three D1 writes,
 * and — sometimes — an hour of waiting for a human to press Approve. None of
 * that fits in a request handler: a Worker invocation cannot survive an hour,
 * cannot retry step 6 without redoing steps 1-5, and cannot be resumed after an
 * isolate is evicted. A Workflow can.
 *
 * Every `step.do` below is a genuine unit of retryable work with its own
 * failure mode, and its retry policy is chosen to match that failure mode
 * rather than copy-pasted:
 *
 *   deterministic CPU (parse)      -> no retries; it will fail identically
 *   local coordination (DO, D1)    -> few retries, short delay
 *   remote inference (Workers AI)  -> several retries, exponential backoff,
 *                                     because 429/503 is the expected failure
 *   third-party HTTP (post-back)   -> several retries, exponential backoff
 *
 * Each step is bracketed by a `triage_runs` audit write, so the UI can show
 * exactly what the agent did, how long it took, and which attempts failed.
 */

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from 'cloudflare:workers';
import { EMBEDDING_DIMS, SIMILARITY_THRESHOLD } from './types';
import type {
  ApprovalEvent,
  Env,
  ErrorSignature,
  FailureRecord,
  FailureStatus,
  SimilarFailure,
  TriageParams,
  TriageResult,
} from './types';
import { parseFailure } from './lib/log-parser';
import { packEmbedding } from './lib/vector';
import { embed } from './ai/embeddings';
import { analyseFailure } from './ai/llm';
import {
  insertFailure,
  logStep,
  searchSimilar,
  setEmbedding,
  setStatus,
  updateTriage,
} from './lib/d1';

/* ------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------ */

/** How many prior failures to retrieve as context for the reasoning model. */
const MEMORY_K = 5;

/** How long a human gets to approve before we post anyway. */
const APPROVAL_TIMEOUT = '1 hour';

/**
 * Retrieved neighbours are carried across step boundaries as persisted JSON.
 * Excerpts are capped at 4000 chars each by the parser, so five neighbours can
 * be 20KB of step state that we then feed into a prompt. Trim to the part that
 * actually helps the model — the head of the excerpt is where the error is.
 */
const NEIGHBOUR_EXCERPT_CHARS = 1200;

/* ------------------------------------------------------------------ *
 * Step configuration
 * ------------------------------------------------------------------ */

/** Alias so the per-step policies below read as policy rather than plumbing. */
type StepConfig = WorkflowStepConfig;

/** Pure CPU. A retry would reproduce the same result, so don't pay for one. */
const CFG_DETERMINISTIC: StepConfig = {
  retries: { limit: 0, delay: 0 },
  timeout: '30 seconds',
};

/** Durable Object RPC. Fast and consistent; only transient dispatch can fail. */
const CFG_COORDINATION: StepConfig = {
  retries: { limit: 2, delay: '2 seconds', backoff: 'exponential' },
  timeout: '15 seconds',
};

/** D1 write. Occasionally throws on replica hiccups; cheap to repeat. */
const CFG_WRITE: StepConfig = {
  retries: { limit: 3, delay: '2 seconds', backoff: 'exponential' },
  timeout: '20 seconds',
};

/** D1 read plus in-Worker vector maths. */
const CFG_READ: StepConfig = {
  retries: { limit: 2, delay: '2 seconds', backoff: 'exponential' },
  timeout: '30 seconds',
};

/** Workers AI embedding: a real network call that rate-limits under burst. */
const CFG_EMBED: StepConfig = {
  retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
  timeout: '30 seconds',
};

/**
 * Workers AI reasoning on Llama 3.3 70B.
 *
 * NEURON SPEND: this is by far the most expensive thing the system does —
 * roughly 205k neurons per million output tokens against a 10,000 neuron/day
 * free allowance, i.e. a handful of triages per day. That economics is exactly
 * why the `dedupe-check` step exists two steps earlier and why we would rather
 * wait and back off than fire a second inference. Longer timeout, because a
 * 70B model with a few thousand tokens of retrieved context is not fast.
 */
const CFG_REASONING: StepConfig = {
  retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
  timeout: '2 minutes',
};

/** Outbound HTTP to a third party we do not control. */
const CFG_POSTBACK: StepConfig = {
  retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
  timeout: '30 seconds',
};

/* ------------------------------------------------------------------ *
 * Result types
 * ------------------------------------------------------------------ */

export type TriageOutcomeReason =
  | 'completed'
  | 'duplicate_in_flight'
  | 'recently_triaged'
  | 'rejected'
  | 'failed';

export type ApprovalOutcome = 'not_required' | 'approved' | 'rejected' | 'timed_out';

export interface TriageOutcome {
  failureId: string;
  workflowId: string;
  reason: TriageOutcomeReason;
  status: FailureStatus | 'skipped';
  headline: string | null;
  isLikelyFlake: boolean;
  citedFailureIds: string[];
  similarCount: number;
  approval: ApprovalOutcome;
  postedBack: boolean;
  /** Set when `reason === 'duplicate_in_flight' | 'recently_triaged'`. */
  supersededBy?: string;
}

/** Result of the post-back attempt. Never throws for "no credentials". */
interface PostBackResult {
  posted: boolean;
  reason: 'no_run_url' | 'no_credentials' | 'posted';
  detail?: string;
}

/* ------------------------------------------------------------------ *
 * Post-back
 * ------------------------------------------------------------------ */

/**
 * The only outbound HTTP in the system, kept behind one small function so the
 * demo runs end-to-end with no real credentials configured.
 *
 * Without a token we deliberately do NOT attempt the request: an unauthenticated
 * POST at a GitHub API URL is a guaranteed 401 that would burn three retries and
 * paint the audit trail red for no reason. We record the no-op and move on.
 */
export async function postResultBack(
  runUrl: string | null | undefined,
  token: string | undefined,
  payload: { headline: string; rootCause: string; suggestedFix: string; confidence: number },
): Promise<PostBackResult> {
  if (!runUrl) return { posted: false, reason: 'no_run_url' };
  if (!token) {
    return {
      posted: false,
      reason: 'no_credentials',
      detail: `would POST triage to ${runUrl}`,
    };
  }

  const body = [
    `**${payload.headline}**`,
    '',
    `**Root cause** — ${payload.rootCause}`,
    '',
    `**Suggested fix**`,
    payload.suggestedFix,
    '',
    `_Pipeline Sentinel · confidence ${(payload.confidence * 100).toFixed(0)}%_`,
  ].join('\n');

  const res = await fetch(runUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'pipeline-sentinel',
    },
    body: JSON.stringify({ body }),
  });

  if (!res.ok) {
    // Throw so the step's retry policy gets a chance at a transient 5xx.
    throw new Error(`post-back failed: ${res.status} ${res.statusText}`);
  }
  return { posted: true, reason: 'posted' };
}

/* ------------------------------------------------------------------ *
 * Workflow
 * ------------------------------------------------------------------ */

export class TriageWorkflow extends WorkflowEntrypoint<Env, TriageParams> {
  async run(event: WorkflowEvent<TriageParams>, step: WorkflowStep): Promise<TriageOutcome> {
    const params = event.payload;
    const { failureId, incoming, requireApproval } = params;
    const db = this.env.DB;
    const workflowId = readInstanceId(event);
    const occurredAt = incoming.occurredAt ?? Date.now();

    /**
     * Audit writes must never be the reason a triage fails. Every logStep call
     * goes through here.
     */
    const safeLog = async (
      name: string,
      status: 'started' | 'ok' | 'error',
      detail: string | null = null,
      durationMs: number | null = null,
    ): Promise<void> => {
      try {
        await logStep(db, failureId, workflowId, name, status, detail, durationMs);
      } catch {
        // Swallow: the audit trail is observability, not correctness.
      }
    };

    /**
     * Run one step with `started` / `ok` / `error` audit rows around it.
     *
     * The bracketing lives INSIDE the step body on purpose: a retried step
     * re-logs, so `triage_runs` shows the failed attempts as well as the
     * successful one. That is what makes the retry behaviour visible in the UI
     * instead of merely claimed in a README.
     */
    /**
     * `step.do` is declared as `do<T extends Rpc.Serializable<T>>`, a
     * self-referential constraint that a generic wrapper cannot satisfy without
     * threading it through every call site. Everything we hand to `tracked`
     * below is a plain JSON value, so we borrow the erased signature once,
     * here, rather than sprinkling casts through the step bodies.
     */
    type LooseStep = {
      do<T>(name: string, config: StepConfig, callback: () => Promise<T>): Promise<T>;
    };
    const rawStep = step as unknown as LooseStep;

    const tracked = <T>(
      name: string,
      config: StepConfig,
      fn: () => Promise<T>,
      describe?: (value: T) => string,
    ): Promise<T> =>
      rawStep.do<T>(name, config, async () => {
        const startedAt = Date.now();
        await safeLog(name, 'started');
        try {
          const value = await fn();
          await safeLog(name, 'ok', describe ? describe(value) : null, Date.now() - startedAt);
          return value;
        } catch (err) {
          await safeLog(name, 'error', errorText(err), Date.now() - startedAt);
          throw err;
        }
      });

    const repoStub = this.env.REPO_STATE.get(this.env.REPO_STATE.idFromName(incoming.repo));

    /* -- 1. parse-log ------------------------------------------------ *
     * Deterministic normalisation of a raw job log into a stable signature.
     * Same input, same hash, every time — so no retries: a second attempt
     * would fail in exactly the same way. */
    const signature: ErrorSignature = await tracked(
      'parse-log',
      CFG_DETERMINISTIC,
      () => parseFailure(incoming.logText),
      (sig) => `${sig.category} · ${sig.hash} · conf ${sig.confidence.toFixed(2)}`,
    );

    /* -- 2. dedupe-check --------------------------------------------- *
     * The concurrency guard. Ten matrix jobs failing for one reason produce
     * ten webhooks and ten workflow instances; exactly one of them gets
     * `shouldTriage: true` out of the repo's Durable Object. The other nine
     * stop here, before spending a single neuron. */
    const verdict = await tracked(
      'dedupe-check',
      CFG_COORDINATION,
      () => repoStub.claimTriage(signature.hash, failureId),
      (v) => `${v.reason}${v.existingFailureId ? ` -> ${v.existingFailureId}` : ''}`,
    );

    if (!verdict.shouldTriage) {
      // Terminal, and deliberately NOT an error: this is the system working.
      // No claim was taken, so there is nothing to release — releasing here
      // would clear the live holder's claim.
      await safeLog(
        'skip-duplicate',
        'ok',
        `suppressed as ${verdict.reason}; owner=${verdict.existingFailureId ?? 'unknown'}`,
      );
      return {
        failureId,
        workflowId,
        reason: verdict.reason === 'in_flight' ? 'duplicate_in_flight' : 'recently_triaged',
        status: 'skipped',
        headline: null,
        isLikelyFlake: false,
        citedFailureIds: [],
        similarCount: 0,
        approval: 'not_required',
        postedBack: false,
        supersededBy: verdict.existingFailureId,
      };
    }

    // From here on we hold the claim, so every exit path must release it.
    let approval: ApprovalOutcome = requireApproval ? 'timed_out' : 'not_required';
    let postedBack = false;
    let finalStatus: FailureStatus = 'open';
    let similarCount = 0;

    try {
      /* -- 3. persist-failure --------------------------------------- *
       * Deliberately BEFORE embedding. The embedding is a network call to
       * Workers AI, which is exactly the dependency most likely to be down or
       * rate-limited when an org's CI goes red all at once. Persisting first
       * means an AI outage costs us the triage but never the record of the
       * failure itself — which, for a build-triage tool, is the far worse loss.
       *
       * The row lands with an all-zero placeholder vector. A zero vector scores
       * 0 against every query, so the row is inert in similarity search until
       * step 4 writes the real embedding; if that never happens,
       * `POST /api/admin/reembed` backfills it later. Idempotent on the primary
       * key, so a retry after a partial write is safe. */
      await tracked<FailureRecord>(
        'persist-failure',
        CFG_WRITE,
        async () => {
          const row: FailureRecord = {
            id: failureId,
            repo: incoming.repo,
            branch: incoming.branch,
            provider: incoming.provider,
            pipelineId: incoming.pipelineId,
            jobName: incoming.jobName,
            runUrl: incoming.runUrl ?? null,
            commitSha: incoming.commitSha ?? null,
            signatureHash: signature.hash,
            signatureText: signature.text,
            category: signature.category,
            fileHint: signature.fileHint ?? null,
            excerpt: signature.excerpt,
            status: 'open',
            // The parser's own confidence in the fingerprint, preserved so a
            // weak (fallback) signature stays visibly weak downstream.
            signatureConfidence: signature.confidence,
            rootCause: null,
            suggestedFix: null,
            confidence: null,
            // Populated by the `analyse` / `persist-triage` steps below.
            headline: null,
            isLikelyFlake: false,
            citedFailureIds: [],
            resolutionNote: null,
            resolvedAt: null,
            occurrenceCount: 1,
            createdAt: occurredAt,
            lastSeenAt: occurredAt,
          };
          await insertFailure(db, row, new ArrayBuffer(EMBEDDING_DIMS * 4));
          await repoStub.noteFailure();
          return row;
        },
        (row) => `stored ${row.id} (${row.category}) status=open, vector pending`,
      );

      /* -- 4. embed-signature --------------------------------------- *
       * Workers AI, bge-small-en-v1.5 -> 384 floats. A network call that
       * rate-limits when a whole org's CI goes red at once, so: three
       * attempts with exponential backoff.
       *
       * Returned as number[] rather than Float32Array — step results are
       * persisted as JSON between steps, and a typed array would not survive
       * the round trip. */
      const vector: number[] = await tracked(
        'embed-signature',
        CFG_EMBED,
        async () => {
          const v = await embed(this.env.AI, signature.text);
          // Replace the placeholder written above; only now does this failure
          // become findable by similarity search.
          await setEmbedding(db, failureId, packEmbedding(v));
          return v;
        },
        (v) => `${v.length} dims stored`,
      );
      void vector;

      finalStatus = 'open';

      /* -- 5. search-memory ---------------------------------------- *
       * The retrieval half of RAG: bounded candidate scan over this repo's
       * past failures, preferring resolved ones because they carry a known
       * fix. `excludeId` keeps the row we just wrote from retrieving itself
       * at similarity 1.0. */
      const similar: SimilarFailure[] = await tracked(
        'search-memory',
        CFG_READ,
        async () => {
          const hits = await searchSimilar(
            db,
            incoming.repo,
            Float32Array.from(vector),
            MEMORY_K,
            SIMILARITY_THRESHOLD,
            failureId,
          );
          // Trim excerpts before they cross the step boundary (see comment on
          // NEIGHBOUR_EXCERPT_CHARS).
          return hits.map((hit) => ({
            ...hit,
            excerpt: hit.excerpt.slice(0, NEIGHBOUR_EXCERPT_CHARS),
          }));
        },
        (hits) =>
          hits.length === 0
            ? 'no prior matches'
            : hits
                .map((h) => `${h.id}:${h.score.toFixed(3)}:${h.status}`)
                .join(', '),
      );
      similarCount = similar.length;

      /* -- 6. analyse ----------------------------------------------- *
       * Llama 3.3 70B, given the signature plus the retrieved neighbours.
       * The single most expensive operation in the system — see CFG_REASONING
       * for the neuron arithmetic. Retried, because a 429 here would
       * otherwise waste all the work above. */
      let triage: TriageResult = await tracked(
        'analyse',
        CFG_REASONING,
        () => analyseFailure(this.env.AI, signature, similar),
        (t) =>
          `${t.headline} · conf ${t.confidence.toFixed(2)} · flake=${t.isLikelyFlake} · cited ${t.citedFailureIds.length}`,
      );

      /* -- 7. persist-triage ---------------------------------------- *
       * When a human must sign off we park the row in `awaiting_approval`
       * rather than `triaged`, so the dashboard can show a review queue that
       * is exactly the set of workflows currently blocked on step 8. */
      const persistedStatus: FailureStatus = requireApproval ? 'awaiting_approval' : 'triaged';
      const resultForPersist = triage;
      await tracked(
        'persist-triage',
        CFG_WRITE,
        async () => {
          await updateTriage(db, failureId, resultForPersist, persistedStatus);
          return persistedStatus;
        },
        (s) => `status=${s}`,
      );
      finalStatus = persistedStatus;

      /* -- 8. await-approval ---------------------------------------- *
       * THE STEP THAT CANNOT EXIST IN A PLAIN WORKER.
       *
       * A Worker invocation is bounded by the request that created it; it
       * cannot go to sleep for an hour and wake up where it left off. Here
       * the instance is checkpointed to durable storage and costs nothing
       * while it waits. An operator hits Approve minutes or an hour later,
       * `index.ts` calls `instance.sendEvent({type: 'approval', ...})`, and
       * this line resumes with every earlier step's result intact.
       *
       * The timeout is a deliberate policy choice: an unanswered review must
       * not strand the finding. After an hour we post anyway, with the
       * expiry noted in the comment so nobody mistakes it for a human sign-off.
       */
      if (requireApproval) {
        await safeLog('await-approval', 'started', `waiting up to ${APPROVAL_TIMEOUT}`);
        const approvalStartedAt = Date.now();
        try {
          const received = await step.waitForEvent<ApprovalEvent>('await-approval', {
            type: 'approval',
            timeout: APPROVAL_TIMEOUT,
          });
          const decision = readEventPayload<ApprovalEvent>(received);
          approval = decision?.approved ? 'approved' : 'rejected';

          await safeLog(
            'await-approval',
            'ok',
            `${approval} by ${decision?.reviewer ?? 'unknown'}`,
            Date.now() - approvalStartedAt,
          );

          if (approval === 'rejected') {
            /* Reviewer says this is not a real finding. Park it as dismissed,
             * skip the post-back, and still release the claim below. */
            await tracked(
              'dismiss-triage',
              CFG_WRITE,
              async () => {
                await setStatus(db, failureId, 'dismissed');
                return 'dismissed';
              },
              () => `dismissed by ${decision?.reviewer ?? 'unknown'}`,
            );
            finalStatus = 'dismissed';
            return {
              failureId,
              workflowId,
              reason: 'rejected',
              status: 'dismissed',
              headline: triage.headline,
              isLikelyFlake: triage.isLikelyFlake,
              citedFailureIds: triage.citedFailureIds,
              similarCount,
              approval,
              postedBack: false,
            };
          }

          // Approved, possibly with the reviewer's own wording for the fix.
          if (decision?.editedFix && decision.editedFix.trim().length > 0) {
            const edited: TriageResult = { ...triage, suggestedFix: decision.editedFix.trim() };
            triage = edited;
            await tracked(
              'apply-approval-edit',
              CFG_WRITE,
              async () => {
                await updateTriage(db, failureId, edited, 'triaged');
                return 'edited';
              },
              () => `fix edited by ${decision.reviewer ?? 'reviewer'}`,
            );
          } else {
            await tracked(
              'confirm-approval',
              CFG_WRITE,
              async () => {
                await setStatus(db, failureId, 'triaged');
                return 'triaged';
              },
              () => `approved by ${decision?.reviewer ?? 'reviewer'}`,
            );
          }
          finalStatus = 'triaged';
        } catch (err) {
          /* waitForEvent rejects when the timeout elapses. That is not a
           * failure of the triage — fall through and auto-post, flagged. */
          approval = 'timed_out';
          await safeLog(
            'await-approval',
            'error',
            `approval window expired (${APPROVAL_TIMEOUT}); auto-posting. ${errorText(err)}`,
            Date.now() - approvalStartedAt,
          );
          const expired: TriageResult = {
            ...triage,
            suggestedFix: `${triage.suggestedFix}\n\n_Auto-posted: the ${APPROVAL_TIMEOUT} approval window expired without a reviewer decision._`,
          };
          triage = expired;
          await tracked(
            'approval-expired',
            CFG_WRITE,
            async () => {
              await updateTriage(db, failureId, expired, 'triaged');
              return 'triaged';
            },
            () => 'approval expired; status forced to triaged',
          );
          finalStatus = 'triaged';
        }
      }

      /* -- 9. post-back --------------------------------------------- *
       * Deliver the finding to wherever the failure came from. No run URL or
       * no credentials means a recorded no-op rather than a red step, so the
       * demo is honest about what it did without needing a real GitHub token. */
      const resultForPost = triage;
      const postToken = readOptionalSecret(this.env, 'POSTBACK_TOKEN');
      const post = await tracked(
        'post-back',
        CFG_POSTBACK,
        () =>
          postResultBack(incoming.runUrl, postToken, {
            headline: resultForPost.headline,
            rootCause: resultForPost.rootCause,
            suggestedFix: resultForPost.suggestedFix,
            confidence: resultForPost.confidence,
          }),
        (r) => `${r.reason}${r.detail ? ` (${r.detail})` : ''}`,
      );
      postedBack = post.posted;

      return {
        failureId,
        workflowId,
        reason: 'completed',
        status: finalStatus,
        headline: triage.headline,
        isLikelyFlake: triage.isLikelyFlake,
        citedFailureIds: triage.citedFailureIds,
        similarCount,
        approval,
        postedBack,
      };
    } catch (err) {
      /* One record of the overall failure before it propagates — the per-step
       * `error` row says which step died, this one says the run died. */
      await safeLog('triage-failed', 'error', errorText(err));
      throw err;
    } finally {
      /* -- 10. release-claim ---------------------------------------- *
       * ALWAYS. Happy path, dismissed path, and crash path alike. A claim that
       * is never released blocks the signature until the DO's alarm reaps it
       * ten minutes later; releasing here means the next genuine occurrence is
       * only suppressed for the intended 15-minute window.
       *
       * Guarded so a broken release can never mask the real error: if the
       * workflow is already unwinding, an exception thrown from a `finally`
       * would replace the original one. */
      try {
        await tracked(
          'release-claim',
          CFG_COORDINATION,
          async () => {
            const released = await repoStub.releaseTriage(signature.hash, failureId);
            return released;
          },
          (ok) => (ok ? 'claim released' : 'claim already reassigned or reaped'),
        );
      } catch (releaseErr) {
        await safeLog('release-claim', 'error', errorText(releaseErr));
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * `WorkflowEvent` gained `instanceId` after the first Workflows release; read
 * it defensively so the audit trail still has a correlation id on older
 * runtimes rather than throwing.
 */
function readInstanceId(event: unknown): string {
  const candidate = (event as { instanceId?: unknown } | null)?.instanceId;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : 'unknown-instance';
}

/**
 * `step.waitForEvent` resolves to a wrapper carrying the sent payload. Unwrap
 * it tolerantly: some runtime versions hand back the payload directly.
 */
function readEventPayload<T>(received: unknown): T | null {
  if (received === null || typeof received !== 'object') return null;
  const wrapper = received as { payload?: unknown };
  if (wrapper.payload !== undefined && wrapper.payload !== null) return wrapper.payload as T;
  return received as T;
}

/**
 * Optional secret that is deliberately absent from the frozen `Env` contract in
 * types.ts. Read structurally so the demo runs with no post-back credentials at
 * all, and so adding the secret later needs no change to the frozen type.
 */
function readOptionalSecret(env: Env, key: string): string | undefined {
  const value = (env as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
