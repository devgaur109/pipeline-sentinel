/**
 * Every prompt string in Pipeline Sentinel lives in this file.
 *
 * Rationale: prompts are the product. Keeping them in one module means they can
 * be diffed, reviewed and token-budgeted in isolation, and it guarantees no other
 * module quietly grows its own inline prompt that nobody is measuring.
 *
 * Token budget: the Workers AI free tier is 10,000 neurons/day and Llama 3.3 70B
 * costs roughly 205k neurons per million output tokens, so a single day's budget
 * is on the order of ~50k output tokens. Every injected context block below is
 * explicitly capped; nothing is interpolated unbounded.
 */

import type {
  ChatMessage,
  ErrorSignature,
  FailureRecord,
  RepoStats,
  SimilarFailure,
} from '../types';

/** Chat-completion message shape accepted by the Workers AI text models. */
export interface PromptMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/* ------------------------------------------------------------------ *
 * Explicit context caps. These are the only knobs that affect cost.
 * ------------------------------------------------------------------ */
export const PROMPT_LIMITS = {
  /** Prior resolved failures injected into the triage prompt. */
  MAX_SIMILAR: 4,
  /** Raw log excerpt handed to the reasoning model. */
  MAX_EXCERPT_CHARS: 2000,
  /** Normalised signature text. */
  MAX_SIGNATURE_CHARS: 600,
  /** Per-prior-failure field caps inside the memory block. */
  MAX_PRIOR_SIGNATURE_CHARS: 200,
  MAX_PRIOR_ROOT_CAUSE_CHARS: 260,
  MAX_PRIOR_FIX_CHARS: 340,
  /** Recent failures listed in the chat context block. */
  MAX_RECENT: 8,
  MAX_RECENT_LINE_CHARS: 160,
  /** Top flaky signatures listed in the chat context block. */
  MAX_FLAKES: 6,
  /** Turns of conversation history replayed into the chat prompt. */
  MAX_HISTORY_MESSAGES: 6,
  MAX_HISTORY_CHARS: 500,
  /** Log excerpt handed to the cheap summariser. */
  MAX_SUMMARY_EXCERPT_CHARS: 1200,
} as const;

/** Hard character cap with a visible marker so the model knows it was cut. */
function cap(value: string | null | undefined, max: number): string {
  const text = (value ?? '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated]`;
}

/** Collapse runs of whitespace onto one line — used for list entries. */
function oneLine(value: string | null | undefined, max: number): string {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function daysAgo(epochMs: number | null): string {
  if (!epochMs) return 'unknown date';
  const days = Math.floor((Date.now() - epochMs) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

/* ------------------------------------------------------------------ *
 * 1. Triage — the expensive REASONING call
 * ------------------------------------------------------------------ */

/** The exact JSON contract we ask the reasoning model to emit (mirrors TriageResult). */
const TRIAGE_SCHEMA = `{
  "headline":        string,   // <= 80 chars, reads as a PR comment title
  "rootCause":       string,   // <= 400 chars, the single most probable cause
  "suggestedFix":    string,   // <= 600 chars, a concrete command/diff/config change
  "confidence":      number,   // 0.0-1.0, your calibrated confidence in rootCause
  "isLikelyFlake":   boolean,  // true = infra/flake that would pass on retry
  "citedFailureIds": string[]  // ids copied verbatim from PRIOR RESOLVED FAILURES, or []
}`;

/**
 * Root-cause analysis for one failure, grounded in this repo's prior resolved
 * failures. The memory block is the whole point: a system that has seen this
 * error before should reuse the human-verified fix and say where it came from.
 */
export function triagePrompt(
  signature: ErrorSignature,
  similar: SimilarFailure[],
): PromptMessage[] {
  const system = [
    'You are a senior build and release engineer triaging a failed CI job.',
    'You are precise and terse. You never speculate beyond the evidence you are given.',
    '',
    'Do all four of these:',
    '1. DECIDE THE CLASS. A REAL DEFECT is a code, config or dependency problem a human must fix.',
    '   An INFRA FLAKE is a runner timeout, OOM kill, network blip, registry 5xx, disk-full,',
    '   clock skew or a race in the test harness itself — it would likely pass on a plain retry.',
    '   Set isLikelyFlake accordingly. Do not call something a flake just because the cause is unclear.',
    '2. NAME THE ROOT CAUSE in one or two sentences. Point at the specific symbol, file, package',
    '   version or resource limit implicated by the log, not a general category.',
    '3. GIVE A FIX that someone can act on immediately: a command to run, a line to change, a version',
    '   to pin, a limit to raise. Never answer "investigate further" or "check the logs".',
    '4. USE INSTITUTIONAL MEMORY. The PRIOR RESOLVED FAILURES block lists problems from this same',
    '   repository that were already diagnosed and fixed by a human. If one of them is the same',
    '   problem, reuse its fix, say so in one clause of rootCause, and put that failure id in',
    '   citedFailureIds. Cite only ids that literally appear in that block; never invent an id.',
    '   If none of them match, return an empty citedFailureIds array and reason from the log alone.',
    '',
    'Output rules — these are strict:',
    '- Reply with exactly ONE JSON object and nothing else. No prose before or after, no markdown fences.',
    '- Use this schema and these exact key names:',
    TRIAGE_SCHEMA,
    '- Every key is required. Use "" / 0 / false / [] rather than null.',
    '- Report confidence honestly: 0.8+ only when the log names the cause outright, 0.3-0.6 when you',
    '  are inferring, below 0.3 when the log is truncated or uninformative.',
  ].join('\n');

  const memory = renderPriorFailures(similar);

  const user = [
    '=== FAILING JOB ===',
    `category: ${signature.category}`,
    `parser confidence: ${signature.confidence.toFixed(2)}`,
    signature.fileHint ? `implicated file/test: ${signature.fileHint}` : 'implicated file/test: unknown',
    '',
    'normalised signature:',
    cap(signature.text, PROMPT_LIMITS.MAX_SIGNATURE_CHARS),
    '',
    'log excerpt:',
    cap(signature.excerpt, PROMPT_LIMITS.MAX_EXCERPT_CHARS),
    '',
    memory,
    '',
    'Return the JSON object now.',
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Renders the retrieved memory as a clearly delimited, id-addressable block.
 * Exported so the workflow can log exactly what context a triage decision saw.
 */
export function renderPriorFailures(similar: SimilarFailure[]): string {
  const chosen = similar.slice(0, PROMPT_LIMITS.MAX_SIMILAR);
  if (chosen.length === 0) {
    return [
      '=== PRIOR RESOLVED FAILURES (from this repo) ===',
      '(none — no similar past failure was retrieved; reason from the log alone and return citedFailureIds: [])',
      '=== END PRIOR RESOLVED FAILURES ===',
    ].join('\n');
  }

  const entries = chosen.map((prior) =>
    [
      `--- id: ${prior.id}`,
      `similarity: ${prior.score.toFixed(3)} | status: ${prior.status} | seen: ${daysAgo(prior.lastSeenAt)} | occurrences: ${prior.occurrenceCount}`,
      `signature: ${oneLine(prior.signatureText, PROMPT_LIMITS.MAX_PRIOR_SIGNATURE_CHARS)}`,
      `root cause: ${oneLine(prior.rootCause, PROMPT_LIMITS.MAX_PRIOR_ROOT_CAUSE_CHARS) || '(not recorded)'}`,
      `fix that worked: ${oneLine(prior.resolutionNote ?? prior.suggestedFix, PROMPT_LIMITS.MAX_PRIOR_FIX_CHARS) || '(not recorded)'}`,
    ].join('\n'),
  );

  return [
    '=== PRIOR RESOLVED FAILURES (from this repo) ===',
    'These were diagnosed and fixed before. Reuse a fix only if the problem genuinely matches.',
    ...entries,
    '=== END PRIOR RESOLVED FAILURES ===',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * 2. Repo chat — the cheap FAST call
 * ------------------------------------------------------------------ */

/**
 * Grounded Q&A over one repository's CI health. The model gets stats and a
 * recent-failure list and is told, firmly, that this is the entire world.
 */
export function chatPrompt(
  question: string,
  stats: RepoStats,
  recent: FailureRecord[],
  history: ChatMessage[],
): PromptMessage[] {
  const system = [
    `You are Pipeline Sentinel, the CI reliability assistant for the repository "${stats.repo}".`,
    '',
    'Grounding rules — follow them exactly:',
    '- Answer ONLY from the CONTEXT block in the user message. It is the complete set of facts you have.',
    '- Never invent a failure, id, test name, error message, count, branch or date that is not in CONTEXT.',
    '- If CONTEXT does not answer the question, say plainly what is missing (e.g. "no failures recorded',
    '  for this repo in the last 7 days") and stop. Do not guess and do not pad.',
    '- Quote failure ids and signature text verbatim when you refer to them.',
    '- A signature seen 3+ times in the window is what this repo calls flaky; use the TOP REPEAT',
    '  SIGNATURES list for "what is flaky" questions.',
    '',
    'Style: 1-3 short paragraphs, or a tight bullet list when listing failures. Plain text.',
    'No markdown headings, no preamble, no "based on the context provided".',
  ].join('\n');

  const messages: PromptMessage[] = [{ role: 'system', content: system }];

  // Replay a short tail of the conversation so follow-ups ("and the second one?")
  // resolve, without dragging the whole session into every request.
  for (const turn of history.slice(-PROMPT_LIMITS.MAX_HISTORY_MESSAGES)) {
    const content = oneLine(turn.content, PROMPT_LIMITS.MAX_HISTORY_CHARS);
    if (content) messages.push({ role: turn.role, content });
  }

  messages.push({
    role: 'user',
    content: [
      '=== CONTEXT ===',
      renderStats(stats),
      '',
      renderRecentFailures(recent),
      '=== END CONTEXT ===',
      '',
      `Question: ${oneLine(question, 600)}`,
    ].join('\n'),
  });

  return messages;
}

function renderStats(stats: RepoStats): string {
  const lines = [
    `repo: ${stats.repo}`,
    `window: last ${stats.windowDays} days`,
    `open failures: ${stats.openCount}`,
    `resolved failures: ${stats.resolvedCount}`,
    '',
    'TOP REPEAT SIGNATURES (seen 3+ times in the window, most frequent first):',
  ];
  const flakes = stats.topFlakes.slice(0, PROMPT_LIMITS.MAX_FLAKES);
  if (flakes.length === 0) {
    lines.push('  (none)');
  } else {
    for (const flake of flakes) {
      lines.push(`  - ${flake.count}x [${flake.signatureHash.slice(0, 8)}] ${oneLine(flake.signatureText, PROMPT_LIMITS.MAX_RECENT_LINE_CHARS)}`);
    }
  }
  return lines.join('\n');
}

function renderRecentFailures(recent: FailureRecord[]): string {
  const rows = recent.slice(0, PROMPT_LIMITS.MAX_RECENT);
  if (rows.length === 0) {
    return 'RECENT FAILURES:\n  (none recorded)';
  }
  return [
    'RECENT FAILURES (newest first):',
    ...rows.map((failure) =>
      `  - id=${failure.id} | ${failure.status} | ${failure.category} | ${failure.branch || 'unknown-branch'} | ${daysAgo(failure.lastSeenAt)} | x${failure.occurrenceCount} | ${oneLine(failure.signatureText, PROMPT_LIMITS.MAX_RECENT_LINE_CHARS)}`,
    ),
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * 3. Signature summary — cheapest call in the system
 * ------------------------------------------------------------------ */

/**
 * One-line, human-readable gloss of a raw log excerpt. Intended for MODEL.FAST:
 * keep both the prompt and the expected answer tiny.
 */
export function signatureSummaryPrompt(excerpt: string): PromptMessage[] {
  return [
    {
      role: 'system',
      content: [
        'You turn raw CI log excerpts into one short sentence a developer can scan.',
        'Reply with a single sentence of at most 100 characters naming what broke and where.',
        'No preamble, no quotes, no markdown, no trailing period-padding. Just the sentence.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: cap(excerpt, PROMPT_LIMITS.MAX_SUMMARY_EXCERPT_CHARS) || '(empty log)',
    },
  ];
}
