/**
 * Pipeline Sentinel — Worker entry point.
 *
 * Thin HTTP surface: validate, delegate, serialise. No business logic lives here.
 * Durable work happens in the Workflow; state lives in D1 and the RepoState DO.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';

import type {
  ApiError,
  ApprovalEvent,
  ChatMessage,
  ChatRequest,
  Env,
  FailureRecord,
  IngestResponse,
  FailureDetailResponse,
  FailureListResponse,
  RepoStats,
  TriageParams,
  TriageRun,
} from './types';

import {
  failuresMissingEmbedding,
  getCitedFailures,
  getFailure,
  listRepos,
  getRepoStats,
  markResolved,
  recentFailures,
  setEmbedding,
} from './lib/d1';
import { embedBatch } from './ai/embeddings';
import { packEmbedding } from './lib/vector';
import { detectProvider, normaliseFailure, verifySignature } from './lib/webhooks';
import { answerRepoQuestion, streamRepoAnswer } from './ai/llm';

/**
 * wrangler resolves `durable_objects` and `workflows` class bindings against the
 * entry point's exports, so both classes must be re-exported here even though
 * nothing in this file references them directly.
 */
export { RepoState } from './repo-state';
export { TriageWorkflow } from './workflow';

type Variables = { requestId: string; startedAt: number };

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/* ------------------------------------------------------------------ *
 * Limits and validation helpers
 * ------------------------------------------------------------------ */

const LIMITS = {
  MAX_REPO_LENGTH: 200,
  MAX_MESSAGE_LENGTH: 2000,
  MAX_NOTE_LENGTH: 4000,
  MAX_FIX_LENGTH: 8000,
  /** Ingest bodies are logs; generous, but not unbounded. */
  MAX_INGEST_BYTES: 1_000_000,
  FAILURES_DEFAULT_LIMIT: 25,
  FAILURES_MAX_LIMIT: 100,
  STATS_DEFAULT_DAYS: 7,
  STATS_MAX_DAYS: 90,
  CHAT_HISTORY_TURNS: 10,
  CHAT_RECENT_FAILURES: 8,
} as const;

function badRequest(detail: string): HTTPException {
  return new HTTPException(400, { message: detail });
}

/** Parses and clamps an integer query param; a non-numeric value falls back to the default. */
function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function requireRepo(raw: string | undefined): string {
  const repo = (raw ?? '').trim();
  if (!repo) throw badRequest('Query parameter "repo" is required.');
  if (repo.length > LIMITS.MAX_REPO_LENGTH) {
    throw badRequest(`"repo" must be at most ${LIMITS.MAX_REPO_LENGTH} characters.`);
  }
  return repo;
}

function requireId(raw: string | undefined): string {
  const id = (raw ?? '').trim();
  // Ids are crypto.randomUUID() values; reject anything that is not id-shaped
  // before it reaches a query or a Workflow instance lookup.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw badRequest('Path parameter "id" must be an id of up to 64 [A-Za-z0-9_-] characters.');
  }
  return id;
}

async function readJsonBody(rawBody: string): Promise<Record<string, unknown>> {
  if (!rawBody.trim()) throw badRequest('Request body is required and must be JSON.');
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw badRequest('Request body must be a JSON object.');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    throw badRequest('Request body is not valid JSON.');
  }
}

function repoStub(env: Env, repo: string) {
  return env.REPO_STATE.get(env.REPO_STATE.idFromName(repo));
}

/* ------------------------------------------------------------------ *
 * Middleware: CORS, request id, structured access logging
 * ------------------------------------------------------------------ */

app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: [
      'Content-Type',
      'X-GitHub-Event',
      'X-GitHub-Delivery',
      'X-Hub-Signature-256',
      'X-Gitlab-Event',
      'X-Jenkins',
      'X-Sentinel-Signature',
    ],
    exposeHeaders: ['X-Request-Id'],
    maxAge: 86400,
  }),
);

app.use('*', async (c, next) => {
  // Prefer Cloudflare's own trace id so Worker logs correlate with the dashboard.
  const requestId = c.req.header('cf-ray') ?? crypto.randomUUID();
  const startedAt = Date.now();
  c.set('requestId', requestId);
  c.set('startedAt', startedAt);

  await next();

  // Static asset responses are left untouched (re-wrapping them to add a header
  // would rebuild the Response for every image and script); the API surface gets
  // a correlation header and one structured access-log line.
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/api/')) {
    c.header('X-Request-Id', requestId);
    console.log(
      JSON.stringify({
        requestId,
        method: c.req.method,
        path,
        status: c.res.status,
        durationMs: Date.now() - startedAt,
      }),
    );
  }
});

/* ------------------------------------------------------------------ *
 * POST /api/ingest — webhook entry
 * ------------------------------------------------------------------ */

app.post('/api/ingest', async (c) => {
  // The raw body is read exactly once: HMAC must be computed over the bytes as
  // sent, so re-serialising the parsed object would break verification.
  const rawBody = await c.req.text();
  if (rawBody.length > LIMITS.MAX_INGEST_BYTES) {
    throw new HTTPException(413, {
      message: `Body exceeds ${LIMITS.MAX_INGEST_BYTES} bytes. Trim the log before posting.`,
    });
  }

  const verified = await verifySignature(c.req.raw, rawBody, c.env.WEBHOOK_SECRET);
  if (!verified) {
    throw new HTTPException(401, { message: 'Webhook signature verification failed.' });
  }

  const payload = await readJsonBody(rawBody);
  const provider = detectProvider(c.req.raw, payload);
  const incoming = normaliseFailure(provider, payload);

  if (!incoming) {
    // Not a failure we act on (a green run, a non-terminal delivery, or a shape
    // we do not understand). Answer 200 so the provider does not retry forever.
    const ignored: IngestResponse = {
      accepted: false,
      failureId: null,
      reason: 'ignored',
    };
    return c.json(ignored, 200);
  }

  if (!incoming.logText.trim()) {
    throw badRequest('Normalised payload contained no log text to triage.');
  }
  if (!incoming.occurredAt) incoming.occurredAt = Date.now();

  const failureId = crypto.randomUUID();
  // The workflow instance is named after the failure, so /approve can find it
  // again from the failure id alone without a second lookup table.
  const params: TriageParams = {
    failureId,
    incoming,
    requireApproval:
      payload['requireApproval'] === true ||
      c.req.query('requireApproval') === 'true' ||
      c.req.query('approval') === '1',
  };

  // `create` only enqueues the instance — it does not await any step — so the
  // request path stays short. All the expensive work happens in the Workflow.
  await c.env.TRIAGE_WORKFLOW.create({ id: failureId, params });

  const body: IngestResponse = {
    accepted: true,
    failureId,
    workflowId: failureId,
    // Dedupe is decided inside the workflow (it owns the RepoState round-trip),
    // so at ingest time every accepted failure is reported as new.
    reason: 'new',
  };
  return c.json(body, 202);
});

/* ------------------------------------------------------------------ *
 * POST /api/chat — grounded repo Q&A, streamed as SSE
 * ------------------------------------------------------------------ */

app.post('/api/chat', async (c) => {
  const body = await readJsonBody(await c.req.text());

  const repo = requireRepo(typeof body['repo'] === 'string' ? (body['repo'] as string) : undefined);
  const message = typeof body['message'] === 'string' ? body['message'].trim() : '';
  if (!message) throw badRequest('Field "message" is required and must be a non-empty string.');
  if (message.length > LIMITS.MAX_MESSAGE_LENGTH) {
    throw badRequest(`"message" must be at most ${LIMITS.MAX_MESSAGE_LENGTH} characters.`);
  }
  const request: ChatRequest = { repo, message };

  const stub = repoStub(c.env, request.repo);

  // Gather grounding context before opening the stream so a context failure is a
  // clean JSON error rather than a half-written event stream.
  const [history, stats, recent] = await Promise.all([
    stub.getHistory(LIMITS.CHAT_HISTORY_TURNS) as Promise<ChatMessage[]>,
    getRepoStats(c.env.DB, request.repo, LIMITS.STATS_DEFAULT_DAYS),
    recentFailures(c.env.DB, request.repo, LIMITS.CHAT_RECENT_FAILURES),
  ]);

  await stub.appendMessage({
    role: 'user',
    content: request.message,
    createdAt: Date.now(),
  } satisfies ChatMessage);

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const requestId = c.get('requestId');

  const pump = (async () => {
    let answer = '';
    try {
      for await (const delta of streamRepoAnswer(
        c.env.AI,
        request.message,
        stats,
        recent,
        history,
      )) {
        answer += delta;
        await writer.write(encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`));
      }

      if (!answer.trim()) {
        // Streaming produced nothing usable; fall back to a blocking call so the
        // user never sees an empty bubble.
        answer = await answerRepoQuestion(c.env.AI, request.message, stats, recent, history);
        await writer.write(encoder.encode(`data: ${JSON.stringify({ delta: answer })}\n\n`));
      }

      await stub.appendMessage({
        role: 'assistant',
        content: answer,
        createdAt: Date.now(),
      } satisfies ChatMessage);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ requestId, event: 'chat_stream_failed', detail }));
      await writer.write(
        encoder.encode(`data: ${JSON.stringify({ error: 'chat_failed', detail })}\n\n`),
      );
    } finally {
      await writer.write(encoder.encode('data: [DONE]\n\n'));
      await writer.close();
    }
  })();

  // Keep the isolate alive for the tail of the stream even if the client hangs up.
  try {
    c.executionCtx.waitUntil(pump);
  } catch {
    // No execution context (e.g. some test harnesses) — the response stream itself
    // keeps the request alive.
  }

  return new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Defeat proxy buffering so deltas actually arrive incrementally.
      'X-Accel-Buffering': 'no',
      'X-Request-Id': requestId,
    },
  });
});

/* ------------------------------------------------------------------ *
 * GET /api/failures — recent failures for a repo
 * ------------------------------------------------------------------ */

app.get('/api/failures', async (c) => {
  // `repo` is optional: omitting it lists across every repo, which is how the
  // UI discovers what repos exist before it has one selected.
  const repoParam = c.req.query('repo');
  const repo = repoParam && repoParam.trim() ? repoParam.trim() : null;
  const limit = clampInt(
    c.req.query('limit'),
    LIMITS.FAILURES_DEFAULT_LIMIT,
    1,
    LIMITS.FAILURES_MAX_LIMIT,
  );

  const failures = await recentFailures(c.env.DB, repo, limit);
  const body: FailureListResponse = { repo, limit, count: failures.length, failures };
  return c.json(body);
});

/* ------------------------------------------------------------------ *
 * GET /api/failures/:id — one failure plus its workflow audit trail
 * ------------------------------------------------------------------ */

app.get('/api/failures/:id', async (c) => {
  const id = requireId(c.req.param('id'));

  const failure = await getFailure(c.env.DB, id);
  if (!failure) {
    throw new HTTPException(404, { message: `No failure with id ${id}.` });
  }

  // `triage_runs` is the workflow's own audit log; it has no d1.ts accessor
  // because only this read-only endpoint consumes it.
  const runs = await c.env.DB.prepare(
    `SELECT id, failure_id, workflow_id, step, status, detail, duration_ms, created_at
       FROM triage_runs
      WHERE failure_id = ?
      ORDER BY created_at ASC, rowid ASC`,
  )
    .bind(id)
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

  const trail: TriageRun[] = (runs.results ?? []).map((row) => ({
    id: row.id,
    failureId: row.failure_id,
    workflowId: row.workflow_id,
    step: row.step,
    // D1 hands back a bare string; narrow it to the contract's union and treat
    // anything unrecognised as an error row rather than trusting the column.
    status:
      row.status === 'started' || row.status === 'ok' || row.status === 'error'
        ? row.status
        : 'error',
    detail: row.detail,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  }));

  // Hydrated server-side so the UI renders the "answered from precedent" panel
  // without issuing one request per citation.
  const citations = await getCitedFailures(c.env.DB, failure.citedFailureIds);

  const body: FailureDetailResponse = { failure, runs: trail, citations };
  return c.json(body);
});

/* ------------------------------------------------------------------ *
 * POST /api/failures/:id/resolve — close the memory loop
 * ------------------------------------------------------------------ */

app.post('/api/failures/:id/resolve', async (c) => {
  const id = requireId(c.req.param('id'));
  const body = await readJsonBody(await c.req.text());

  const note = typeof body['note'] === 'string' ? body['note'].trim() : '';
  if (!note) throw badRequest('Field "note" is required: describe what actually fixed the build.');
  if (note.length > LIMITS.MAX_NOTE_LENGTH) {
    throw badRequest(`"note" must be at most ${LIMITS.MAX_NOTE_LENGTH} characters.`);
  }

  const failure = await getFailure(c.env.DB, id);
  if (!failure) throw new HTTPException(404, { message: `No failure with id ${id}.` });

  /*
   * THIS IS THE MEMORY LOOP.
   *
   * The failure row already carries its embedding, so once it is marked resolved
   * with a human-written note it becomes a first-class retrieval target: the next
   * time a similar log arrives, `searchSimilar` surfaces this row, `triagePrompt`
   * injects `resolution_note` as "fix that worked", and the model reuses it and
   * cites this id. Every resolution therefore makes the next triage better —
   * which is why resolving is a first-class API action and not a UI-only flag.
   */
  await markResolved(c.env.DB, id, note);

  return c.json({ ok: true, id, status: 'resolved' as const, note });
});

/* ------------------------------------------------------------------ *
 * POST /api/failures/:id/approve — human-in-the-loop gate
 * ------------------------------------------------------------------ */

/** `sendEvent` is present on WorkflowInstance but not in every workers-types release. */
interface EventCapableInstance {
  sendEvent(event: { type: string; payload: unknown }): Promise<void>;
}

app.post('/api/failures/:id/approve', async (c) => {
  const id = requireId(c.req.param('id'));
  const body = await readJsonBody(await c.req.text());

  if (typeof body['approved'] !== 'boolean') {
    throw badRequest('Field "approved" is required and must be a boolean.');
  }
  const editedFix = typeof body['editedFix'] === 'string' ? body['editedFix'].trim() : undefined;
  if (editedFix && editedFix.length > LIMITS.MAX_FIX_LENGTH) {
    throw badRequest(`"editedFix" must be at most ${LIMITS.MAX_FIX_LENGTH} characters.`);
  }
  const reviewer = typeof body['reviewer'] === 'string' ? body['reviewer'].trim() : undefined;

  const approval: ApprovalEvent = {
    approved: body['approved'],
    ...(editedFix ? { editedFix } : {}),
    ...(reviewer ? { reviewer } : {}),
  };

  // Ingest names the workflow instance after the failure id, so the id is enough.
  let instance: EventCapableInstance;
  try {
    instance = (await c.env.TRIAGE_WORKFLOW.get(id)) as unknown as EventCapableInstance;
  } catch {
    throw new HTTPException(404, {
      message: `No triage workflow instance for failure ${id}. It may have already completed or been evicted.`,
    });
  }

  try {
    // Resumes the workflow's `waitForEvent('approval')` step.
    await instance.sendEvent({ type: 'approval', payload: approval });
  } catch (error) {
    throw new HTTPException(409, {
      message: `Workflow ${id} did not accept the approval event: ${
        error instanceof Error ? error.message : String(error)
      }. It is probably no longer waiting for approval.`,
    });
  }

  return c.json({ ok: true, id, approved: approval.approved, reviewer: approval.reviewer ?? null });
});

/* ------------------------------------------------------------------ *
 * GET /api/stats — repo health summary
 * ------------------------------------------------------------------ */

app.get('/api/stats', async (c) => {
  const repo = requireRepo(c.req.query('repo'));
  const days = clampInt(c.req.query('days'), LIMITS.STATS_DEFAULT_DAYS, 1, LIMITS.STATS_MAX_DAYS);

  const stats: RepoStats = await getRepoStats(c.env.DB, repo, days);
  return c.json(stats);
});

/* ------------------------------------------------------------------ *
 * GET /api/health — binding presence check
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * POST /api/admin/reembed — backfill placeholder embeddings
 *
 * The SQL seed corpus stores zero-vector placeholders because fixtures cannot
 * call Workers AI. This route embeds each pending signature and writes the real
 * vector back, which is what makes the seeded history retrievable. Run it once
 * after seeding:
 *
 *   curl -X POST http://localhost:8787/api/admin/reembed
 *
 * Costs roughly `pending * ~30` neurons on bge-small, so backfilling the whole
 * demo corpus is a rounding error against the 10,000/day free allowance.
 * ------------------------------------------------------------------ */
app.post('/api/admin/reembed', async (c) => {
  const limit = clampInt(c.req.query('limit'), 50, 1, 200);
  const pending = await failuresMissingEmbedding(c.env.DB, limit);

  if (pending.length === 0) {
    return c.json({ ok: true, embedded: 0, remaining: 0, note: 'Nothing to backfill.' });
  }

  // One batched bge call rather than N round trips.
  const vectors = await embedBatch(
    c.env.AI,
    pending.map((row) => row.signatureText),
  );

  if (vectors.length !== pending.length) {
    throw new HTTPException(502, {
      message: `Embedding service returned ${vectors.length} vectors for ${pending.length} inputs.`,
    });
  }

  let embedded = 0;
  for (let i = 0; i < pending.length; i += 1) {
    await setEmbedding(c.env.DB, pending[i]!.id, packEmbedding(vectors[i]!));
    embedded += 1;
  }

  const remaining = (await failuresMissingEmbedding(c.env.DB, 200)).length;
  return c.json({ ok: true, embedded, remaining });
});

/* ------------------------------------------------------------------ *
 * GET /api/repos — repos that have reported at least one failure
 * ------------------------------------------------------------------ */
app.get('/api/repos', async (c) => {
  const repos = await listRepos(c.env.DB);
  return c.json({ repos });
});

/* ------------------------------------------------------------------ *
 * GET /api/chat?repo= — the Durable Object's stored conversation
 *
 * Chat history lives in the repo's DO rather than the browser, so it survives
 * a reload and is shared by everyone looking at the same repo.
 * ------------------------------------------------------------------ */
app.get('/api/chat', async (c) => {
  const repo = requireRepo(c.req.query('repo'));
  const limit = clampInt(c.req.query('limit'), 50, 1, 50);
  const stub = c.env.REPO_STATE.get(c.env.REPO_STATE.idFromName(repo));
  const messages = await stub.getHistory(limit);
  return c.json({ repo, messages });
});

app.get('/api/health', async (c) => {
  const bindings = {
    AI: Boolean(c.env.AI),
    DB: Boolean(c.env.DB),
    ASSETS: Boolean(c.env.ASSETS),
    REPO_STATE: Boolean(c.env.REPO_STATE),
    TRIAGE_WORKFLOW: Boolean(c.env.TRIAGE_WORKFLOW),
  };

  // Cheap liveness probe: proves the D1 binding is not just present but usable
  // and that the schema has been applied.
  let database: 'ok' | 'unavailable' | 'unmigrated' = 'unavailable';
  if (bindings.DB) {
    try {
      await c.env.DB.prepare('SELECT COUNT(*) AS n FROM failures').first<{ n: number }>();
      database = 'ok';
    } catch {
      database = 'unmigrated';
    }
  }

  const ok = Object.values(bindings).every(Boolean) && database === 'ok';
  return c.json(
    {
      ok,
      bindings,
      database,
      webhookSecretConfigured: Boolean(c.env.WEBHOOK_SECRET),
      requestId: c.get('requestId'),
      time: Date.now(),
    },
    ok ? 200 : 503,
  );
});

/* ------------------------------------------------------------------ *
 * Errors, unknown API routes, static assets
 * ------------------------------------------------------------------ */

const ERROR_CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'payload_too_large',
  429: 'rate_limited',
  500: 'internal_error',
  503: 'service_unavailable',
};

app.onError((err, c) => {
  const requestId = c.get('requestId') ?? 'unknown';

  if (err instanceof HTTPException) {
    const status = err.status;
    const body: ApiError = {
      error: ERROR_CODES[status] ?? 'error',
      detail: err.message || undefined,
    };
    console.warn(JSON.stringify({ requestId, event: 'http_error', status, detail: err.message }));
    return c.json(body, status);
  }

  const detail = err instanceof Error ? err.message : String(err);
  console.error(
    JSON.stringify({
      requestId,
      event: 'unhandled_error',
      detail,
      stack: err instanceof Error ? err.stack?.slice(0, 2000) : undefined,
    }),
  );
  const body: ApiError = { error: 'internal_error', detail };
  return c.json(body, 500);
});

// Unknown /api/* paths must be JSON, never the SPA shell.
app.all('/api/*', (c) => {
  const body: ApiError = {
    error: 'not_found',
    detail: `No route for ${c.req.method} ${new URL(c.req.url).pathname}.`,
  };
  return c.json(body, 404);
});

// Everything else is the static chat UI in ./public.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
