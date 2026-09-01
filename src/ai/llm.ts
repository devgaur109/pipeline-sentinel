/**
 * Workers AI text-generation calls.
 *
 * Two hard rules live here:
 *  1. `max_tokens` is always set explicitly. The free tier is 10,000 neurons/day
 *     and Llama 3.3 70B bills ~205k neurons per million output tokens, so an
 *     unbounded generation can burn a meaningful slice of the daily budget in one
 *     request.
 *  2. `analyseFailure` never throws. It sits inside a Workflow step; a thrown
 *     error there costs a retry (and therefore another expensive model call) for
 *     what is usually just a model that wrapped its JSON in prose. We parse
 *     defensively, retry once tersely, then degrade to a low-confidence result.
 */

import { MODEL } from '../types';
import type {
  ChatMessage,
  ErrorSignature,
  FailureRecord,
  RepoStats,
  SimilarFailure,
  TriageResult,
} from '../types';
import { chatPrompt, signatureSummaryPrompt, triagePrompt } from './prompts';
import type { PromptMessage } from './prompts';

/* ------------------------------------------------------------------ *
 * Output budgets (see rule 1 above)
 * ------------------------------------------------------------------ */
export const TOKEN_BUDGET = {
  /** Enough for the JSON object and no more. */
  TRIAGE: 700,
  /** Terse retry: the model already reasoned, it just has to re-emit JSON. */
  TRIAGE_RETRY: 500,
  /** 1-3 short paragraphs. */
  CHAT: 500,
  /** One sentence. */
  SUMMARY: 60,
} as const;

/**
 * Workers AI text generation is not one shape. Observed from
 * `@cf/meta/llama-3.3-70b-instruct-fp8-fast`:
 *
 *  - `response` as a plain string (the classic shape), OR
 *  - `response` as an ALREADY-PARSED OBJECT when the model emits valid JSON —
 *    the platform helpfully parses it for us, and a naive
 *    `typeof response === 'string'` check silently yields '' for every call, OR
 *  - an OpenAI-style `choices[0].message.content`, which the service now
 *    returns alongside `response`, OR
 *  - a bare string.
 *
 * All four are handled. `usage.neurons` is surfaced for budget accounting
 * against the 10,000/day free allowance.
 */
interface TextGenerationResponse {
  response?: string | Record<string, unknown> | null;
  choices?: Array<{ message?: { content?: string | null } | null } | null> | null;
  usage?: { neurons?: number; total_tokens?: number } | null;
}

/** Normalises any of the observed response shapes into a string. */
function extractText(result: TextGenerationResponse | string): string {
  if (typeof result === 'string') return result;

  const direct = result?.response;
  if (typeof direct === 'string' && direct.trim()) return direct;
  // Already-parsed JSON: hand it back as text so the caller's tolerant JSON
  // extraction stays the single place that understands the payload shape.
  if (direct && typeof direct === 'object') return JSON.stringify(direct);

  const choice = result?.choices?.[0]?.message?.content;
  if (typeof choice === 'string' && choice.trim()) return choice;

  return '';
}

async function generate(
  ai: Ai,
  model: string,
  messages: PromptMessage[],
  maxTokens: number,
  temperature: number,
): Promise<string> {
  const result = (await ai.run(model as never, {
    messages,
    max_tokens: maxTokens,
    temperature,
  } as never)) as unknown as TextGenerationResponse | string;

  const text = extractText(result);

  if (typeof result !== 'string' && result?.usage?.neurons) {
    // Cheap running visibility into the free-tier budget.
    console.log(
      `[llm] ${model} spent ${result.usage.neurons.toFixed(2)} neurons ` +
        `(${result.usage.total_tokens ?? '?'} tokens)`,
    );
  }

  if (!text) {
    console.warn(
      '[llm] empty completion; response keys =',
      typeof result === 'string' ? 'string' : Object.keys(result ?? {}).join(','),
    );
  }

  return text;
}

/* ------------------------------------------------------------------ *
 * Defensive JSON extraction
 * ------------------------------------------------------------------ */

/**
 * Strips the wrappers models habitually add around JSON: markdown fences, a
 * leading "Here is the JSON:", chatty trailing commentary.
 */
function stripFences(raw: string): string {
  let text = raw.trim();
  // ```json ... ``` or ``` ... ```
  const fenced = text.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fenced && fenced[1]) text = fenced[1].trim();
  // A stray opening fence with no closer (hit the token cap mid-object).
  text = text.replace(/^```(?:json|JSON)?\s*/i, '').replace(/```\s*$/, '');
  return text.trim();
}

/**
 * Scans for the outermost balanced `{...}` span, respecting string literals and
 * escapes so a brace inside `"suggestedFix"` does not end the object early.
 * Returns every balanced candidate, outermost-first, in source order.
 */
function balancedObjects(text: string): string[] {
  const found: string[] = [];
  let index = 0;

  while (index < text.length) {
    const start = text.indexOf('{', index);
    if (start === -1) break;

    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;

    for (let i = start; i < text.length; i++) {
      const char = text[i];

      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        if (inString) escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }

    if (end === -1) break; // unterminated — nothing further can balance either
    found.push(text.slice(start, end + 1));
    index = end + 1;
  }

  return found;
}

/** Best-effort parse of a model response into a plain object. */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const text = stripFences(raw);
  if (!text) return null;

  const candidates = [text, ...balancedObjects(text)];
  const parsed: Record<string, unknown>[] = [];

  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        parsed.push(value as Record<string, unknown>);
      }
    } catch {
      // Try the next candidate.
    }
  }

  if (parsed.length === 0) return null;
  // Prefer an object that actually looks like a TriageResult over, say, a nested
  // example object the model echoed back from the schema.
  return (
    parsed.find((object) => 'rootCause' in object || 'root_cause' in object) ?? parsed[0]
  );
}

/* ------------------------------------------------------------------ *
 * TriageResult coercion
 * ------------------------------------------------------------------ */

function pick(object: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null) return object[key];
  }
  return undefined;
}

function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string').join(' ').trim();
  return fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (lowered === 'true' || lowered === 'yes') return true;
    if (lowered === 'false' || lowered === 'no') return false;
  }
  if (typeof value === 'number') return value !== 0;
  return fallback;
}

function asConfidence(value: unknown, fallback: number): number {
  let number: number | null = null;
  if (typeof value === 'number') number = value;
  else if (typeof value === 'string') {
    const parsed = Number.parseFloat(value.replace('%', ''));
    if (Number.isFinite(parsed)) number = value.includes('%') ? parsed / 100 : parsed;
  }
  if (number === null || !Number.isFinite(number)) return fallback;
  // Models sometimes answer 85 when asked for 0-1.
  if (number > 1 && number <= 100) number = number / 100;
  return Math.min(1, Math.max(0, number));
}

/** Categories where an infra flake is the a-priori likely explanation. */
function flakeByCategory(signature: ErrorSignature): boolean {
  return (
    signature.category === 'infra_timeout' ||
    signature.category === 'network_error' ||
    signature.category === 'oom'
  );
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Turns whatever the model emitted into a valid `TriageResult`. Coerces and
 * defaults rather than throwing; the only thing it is strict about is
 * `citedFailureIds`, which is filtered down to ids that were genuinely supplied
 * in the prompt so a hallucinated citation can never reach the UI.
 */
export function coerceTriageResult(
  object: Record<string, unknown>,
  signature: ErrorSignature,
  similar: SimilarFailure[],
): TriageResult {
  const allowedIds = new Set(similar.map((prior) => prior.id));

  const rootCause =
    asString(pick(object, 'rootCause', 'root_cause', 'cause', 'analysis')) ||
    'The model did not identify a specific root cause from the supplied log.';

  const suggestedFix =
    asString(pick(object, 'suggestedFix', 'suggested_fix', 'fix', 'remediation')) ||
    'No concrete fix was produced. Re-run the job to test for flakiness, then inspect the full log.';

  const headlineRaw = asString(pick(object, 'headline', 'title', 'summary'));

  const rawCited = pick(object, 'citedFailureIds', 'cited_failure_ids', 'citations', 'citedIds');
  const citedList = Array.isArray(rawCited)
    ? rawCited
    : typeof rawCited === 'string' && rawCited.trim()
      ? rawCited.split(/[\s,]+/)
      : [];
  const citedFailureIds = Array.from(
    new Set(
      citedList
        .map((value) => asString(value))
        .filter((id) => id.length > 0 && allowedIds.has(id)),
    ),
  );

  return {
    rootCause: truncate(rootCause, 1200),
    suggestedFix: truncate(suggestedFix, 2000),
    confidence: asConfidence(pick(object, 'confidence', 'confidenceScore', 'confidence_score'), 0.5),
    isLikelyFlake: asBoolean(
      pick(object, 'isLikelyFlake', 'is_likely_flake', 'likelyFlake', 'flake'),
      flakeByCategory(signature),
    ),
    citedFailureIds,
    headline: truncate(headlineRaw || rootCause, 120),
  };
}

/** Last resort: the model gave us prose we could not parse. Keep the prose. */
function fallbackResult(raw: string, signature: ErrorSignature): TriageResult {
  const text = stripFences(raw).trim();
  return {
    rootCause: text
      ? `Unstructured model output (JSON parsing failed): ${truncate(text, 1000)}`
      : 'The reasoning model returned no usable output for this failure.',
    suggestedFix:
      'Automated triage could not produce structured output. Review the log excerpt manually, then re-run triage.',
    confidence: 0.1,
    isLikelyFlake: flakeByCategory(signature),
    citedFailureIds: [],
    headline: truncate(
      signature.text.replace(/\s+/g, ' ').trim() || `Unparsed triage for ${signature.category}`,
      120,
    ),
  };
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Root-cause analysis via `MODEL.REASONING`.
 *
 * Never throws — a transport error, a truncated generation or a chatty model all
 * degrade to a low-confidence `TriageResult` so the workflow always has something
 * to persist and a human always has something to read.
 */
export async function analyseFailure(
  ai: Ai,
  signature: ErrorSignature,
  similar: SimilarFailure[],
): Promise<TriageResult> {
  const messages = triagePrompt(signature, similar);
  let lastRaw = '';

  for (let attempt = 0; attempt < 2; attempt++) {
    const attemptMessages: PromptMessage[] =
      attempt === 0
        ? messages
        : [
            ...messages,
            { role: 'assistant', content: truncate(lastRaw, 400) },
            {
              role: 'user',
              content:
                'That was not valid JSON. Return only the JSON object described in the schema — no prose, no markdown fences, starting with { and ending with }.',
            },
          ];

    try {
      lastRaw = await generate(
        ai,
        MODEL.REASONING,
        attemptMessages,
        attempt === 0 ? TOKEN_BUDGET.TRIAGE : TOKEN_BUDGET.TRIAGE_RETRY,
        // Deterministic-ish: this is structured extraction, not creative writing.
        attempt === 0 ? 0.2 : 0.0,
      );
    } catch (error) {
      console.error('[llm] analyseFailure generation failed', {
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
      // A transport failure will not fix itself with a "return only JSON" nudge.
      break;
    }

    const parsed = extractJsonObject(lastRaw);
    if (parsed) return coerceTriageResult(parsed, signature, similar);

    console.warn('[llm] analyseFailure could not parse JSON', {
      attempt,
      preview: lastRaw.slice(0, 200),
    });
  }

  return fallbackResult(lastRaw, signature);
}

/**
 * Grounded answer to a question about one repository's CI health, via the cheap
 * `MODEL.FAST`. Returns the complete answer; see `streamRepoAnswer` for the
 * token-by-token variant the chat endpoint uses.
 */
export async function answerRepoQuestion(
  ai: Ai,
  question: string,
  stats: RepoStats,
  recent: FailureRecord[],
  history: ChatMessage[],
): Promise<string> {
  const messages = chatPrompt(question, stats, recent, history);
  try {
    const answer = await generate(ai, MODEL.FAST, messages, TOKEN_BUDGET.CHAT, 0.3);
    return (
      answer.trim() ||
      'I could not generate an answer for that. Try asking about recent failures or flaky tests in this repo.'
    );
  } catch (error) {
    console.error('[llm] answerRepoQuestion failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 'The language model is temporarily unavailable, so I cannot answer that right now. The failure data itself is still available via /api/failures and /api/stats.';
  }
}

/**
 * Streaming form of `answerRepoQuestion`, yielding response deltas as the model
 * produces them. Falls back to a single-chunk yield of the non-streaming call if
 * the streaming transport is unavailable, so callers only need one code path.
 */
export async function* streamRepoAnswer(
  ai: Ai,
  question: string,
  stats: RepoStats,
  recent: FailureRecord[],
  history: ChatMessage[],
): AsyncGenerator<string, void, unknown> {
  const messages = chatPrompt(question, stats, recent, history);

  let stream: ReadableStream<Uint8Array> | null = null;
  try {
    const result = (await ai.run(MODEL.FAST as never, {
      messages,
      max_tokens: TOKEN_BUDGET.CHAT,
      temperature: 0.3,
      stream: true,
    } as never)) as unknown;
    if (result instanceof ReadableStream) stream = result as ReadableStream<Uint8Array>;
  } catch (error) {
    console.error('[llm] streamRepoAnswer could not open a stream', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (!stream) {
    yield await answerRepoQuestion(ai, question, stats, recent, history);
    return;
  }

  // Workers AI streams server-sent events: `data: {"response":"tok"}` … `data: [DONE]`.
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let emitted = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');

        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const chunk = JSON.parse(payload) as { response?: unknown };
            // Workers AI emits TYPED JSON values, not always strings: a purely
            // numeric token arrives as `{"response":300}`. A
            // `typeof === 'string'` guard silently drops those, which corrupts
            // output in the worst possible way for this product — timeout
            // values, occurrence counts, exit codes and hash digits all vanish
            // while the sentence around them still reads fine. `[c3a91e]`
            // streamed as `[cae]` before this coercion.
            const token =
              typeof chunk.response === 'string'
                ? chunk.response
                : typeof chunk.response === 'number' || typeof chunk.response === 'boolean'
                  ? String(chunk.response)
                  : '';
            if (token) {
              emitted = true;
              yield token;
            }
          } catch {
            // Ignore malformed keep-alive frames.
          }
        }
      }
    }
  } catch (error) {
    console.error('[llm] streamRepoAnswer read failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    reader.releaseLock();
  }

  if (!emitted) {
    yield 'I could not generate an answer for that. Try asking about recent failures or flaky tests in this repo.';
  }
}

/**
 * One-line human summary of a log excerpt, via `MODEL.FAST`. Cheap enough to run
 * on every ingest; returns an empty string rather than throwing so callers can
 * treat it as strictly optional decoration.
 */
export async function summariseSignature(ai: Ai, excerpt: string): Promise<string> {
  try {
    const summary = await generate(
      ai,
      MODEL.FAST,
      signatureSummaryPrompt(excerpt),
      TOKEN_BUDGET.SUMMARY,
      0.2,
    );
    return truncate(summary.replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').trim(), 120);
  } catch (error) {
    console.error('[llm] summariseSignature failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return '';
  }
}
