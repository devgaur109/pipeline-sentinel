/**
 * Provider webhook adapters.
 *
 * Everything upstream of this file is provider-shaped and untrusted; everything
 * downstream sees only `IncomingFailure`. Each adapter returns `null` when the
 * payload is not a build failure it recognises — a successful `workflow_run` is
 * not an error, it is simply not our business, and the caller should answer 200.
 */

import type { IncomingFailure, Provider } from '../types';

/* ------------------------------------------------------------------ *
 * Small, total accessors over untrusted JSON
 * ------------------------------------------------------------------ */

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

/** Reads a dotted path, returning undefined for any missing/typed-wrong link. */
function at(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const key of path.split('.')) {
    const node = obj(current);
    if (!node) return undefined;
    current = node[key];
  }
  return current;
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** First defined string among several dotted paths. */
function firstStr(root: unknown, ...paths: string[]): string | undefined {
  for (const path of paths) {
    const value = str(at(root, path));
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Coerce a provider timestamp (epoch ms, epoch s, or ISO-8601) to epoch ms. */
function toEpochMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: anything below ~1e12 is seconds, not milliseconds.
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim() !== '') return toEpochMs(numeric);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Strip a leading `refs/heads/` that GitHub and GitLab sometimes include. */
function cleanBranch(value: string | undefined): string {
  if (!value) return '';
  return value.replace(/^refs\/heads\//, '').replace(/^origin\//, '').trim();
}

/**
 * Log text almost never arrives in a webhook body — providers send a pointer to
 * the run, not its output. Our senders (the demo replayer, a CI post-step, or a
 * curl) attach the log under one of these keys; adapters fall back to whatever
 * descriptive text the provider did include.
 */
const LOG_KEYS = [
  'logText',
  'log_text',
  'logs',
  'log',
  'output',
  'consoleText',
  'console_text',
  'body',
] as const;

function extractLogText(payload: unknown, ...extraPaths: string[]): string {
  for (const key of LOG_KEYS) {
    const value = str(at(payload, key));
    if (value) return value;
  }
  for (const path of extraPaths) {
    const value = str(at(payload, path));
    if (value) return value;
  }
  return '';
}

/* ------------------------------------------------------------------ *
 * GitHub Actions
 * ------------------------------------------------------------------ */

/** Conclusions that mean "this run did not pass". `cancelled` is deliberately excluded. */
const GITHUB_FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);

/**
 * `workflow_run` and `check_run` events whose `action` is `completed` and whose
 * `conclusion` indicates failure. Anything else returns null.
 */
export function fromGitHubActions(payload: unknown): IncomingFailure | null {
  const root = obj(payload);
  if (!root) return null;

  const run = obj(root['workflow_run']) ?? obj(root['check_run']);
  if (!run) return null;

  const isCheckRun = obj(root['check_run']) !== null;

  const status = str(run['status']);
  const conclusion = str(run['conclusion'])?.toLowerCase();
  // `completed` is the only status that carries a conclusion; guard both so a
  // `requested`/`in_progress` delivery never creates a phantom failure.
  if (status && status !== 'completed') return null;
  if (!conclusion || !GITHUB_FAILURE_CONCLUSIONS.has(conclusion)) return null;

  const repo =
    firstStr(root, 'repository.full_name', 'repository.name') ??
    firstStr(run, 'repository.full_name');
  if (!repo) return null;

  const branch = cleanBranch(
    firstStr(run, 'head_branch') ??
      firstStr(run, 'check_suite.head_branch') ??
      firstStr(root, 'workflow_run.head_branch'),
  );

  const pipelineId =
    firstStr(run, 'id', 'run_number', 'check_suite.id') ?? firstStr(root, 'repository.id') ?? 'unknown';

  const jobName = firstStr(run, 'name', 'display_title') ?? (isCheckRun ? 'check' : 'workflow');

  // GitHub does not ship logs in the hook; `check_run.output` is the closest
  // thing, and our own senders may attach the real log under `logs`.
  const logText =
    extractLogText(root) ||
    [
      firstStr(run, 'output.title'),
      firstStr(run, 'output.summary'),
      firstStr(run, 'output.text'),
    ]
      .filter(Boolean)
      .join('\n') ||
    `GitHub Actions ${isCheckRun ? 'check_run' : 'workflow_run'} "${jobName}" concluded: ${conclusion}. No log body was included in the webhook payload.`;

  return {
    provider: 'github',
    repo,
    branch,
    pipelineId,
    jobName,
    runUrl: firstStr(run, 'html_url', 'url', 'details_url'),
    commitSha: firstStr(run, 'head_sha', 'head_commit.id'),
    author:
      firstStr(run, 'head_commit.author.name', 'actor.login', 'triggering_actor.login') ??
      firstStr(root, 'sender.login'),
    logText,
    occurredAt:
      toEpochMs(at(run, 'updated_at')) ??
      toEpochMs(at(run, 'completed_at')) ??
      toEpochMs(at(run, 'created_at')),
  };
}

/* ------------------------------------------------------------------ *
 * Jenkins (notification plugin)
 * ------------------------------------------------------------------ */

const JENKINS_FAILURE_STATUSES = new Set(['FAILURE', 'FAILED', 'UNSTABLE', 'ERROR', 'REGRESSION']);

/**
 * The Jenkins Notification plugin posts:
 * `{ name, url, build: { number, phase, status, full_url, log, scm: { url, branch, commit } } }`
 * Only `phase: COMPLETED|FINALIZED` deliveries carry a meaningful status.
 */
export function fromJenkins(payload: unknown): IncomingFailure | null {
  const root = obj(payload);
  if (!root) return null;

  const build = obj(root['build']);
  if (!build) return null;

  const phase = str(build['phase'])?.toUpperCase();
  if (phase && phase !== 'COMPLETED' && phase !== 'FINALIZED') return null;

  const status = str(build['status'])?.toUpperCase();
  if (!status || !JENKINS_FAILURE_STATUSES.has(status)) return null;

  // Jenkins has no repo concept; prefer the SCM URL, fall back to the job name.
  const scmUrl = firstStr(build, 'scm.url');
  const jobName = firstStr(root, 'name', 'displayName') ?? 'jenkins-job';
  const repo = repoFromScmUrl(scmUrl) ?? jobName;

  const logText =
    extractLogText(root, 'build.log', 'build.consoleText', 'build.output') ||
    `Jenkins job "${jobName}" build #${str(build['number']) ?? '?'} finished with status ${status}. No console log was included in the notification payload.`;

  return {
    provider: 'jenkins',
    repo,
    branch: cleanBranch(firstStr(build, 'scm.branch')),
    pipelineId: firstStr(build, 'number', 'queue_id', 'url') ?? 'unknown',
    jobName,
    runUrl: firstStr(build, 'full_url', 'url') ?? firstStr(root, 'url'),
    commitSha: firstStr(build, 'scm.commit'),
    author: firstStr(build, 'parameters.author', 'scm.culprits.0'),
    logText,
    occurredAt: toEpochMs(at(build, 'timestamp')),
  };
}

/** `git@github.com:acme/api.git` / `https://host/acme/api.git` -> `acme/api`. */
function repoFromScmUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const cleaned = url.replace(/\.git$/, '').replace(/\/+$/, '');
  const parts = cleaned.split(/[:/]/).filter(Boolean);
  if (parts.length < 2) return undefined;
  return parts.slice(-2).join('/');
}

/* ------------------------------------------------------------------ *
 * GitLab CI
 * ------------------------------------------------------------------ */

const GITLAB_FAILURE_STATUSES = new Set(['failed', 'failure']);

/**
 * GitLab pipeline/job hooks. Included because `detectProvider` can legitimately
 * return `'gitlab'` (the `Provider` union has the member) and falling through to
 * the permissive manual adapter would mislabel the source.
 */
export function fromGitLab(payload: unknown): IncomingFailure | null {
  const root = obj(payload);
  if (!root) return null;

  const kind = str(root['object_kind']);
  if (kind !== 'pipeline' && kind !== 'build' && kind !== 'job') return null;

  const attrs = obj(root['object_attributes']);
  const status = (
    firstStr(attrs ?? {}, 'status') ??
    firstStr(root, 'build_status', 'status')
  )?.toLowerCase();
  if (!status || !GITLAB_FAILURE_STATUSES.has(status)) return null;

  const repo =
    firstStr(root, 'project.path_with_namespace', 'project.name', 'repository.name') ?? undefined;
  if (!repo) return null;

  const jobName = firstStr(root, 'build_name') ?? firstStr(attrs ?? {}, 'name', 'ref') ?? 'pipeline';

  return {
    provider: 'gitlab',
    repo,
    branch: cleanBranch(firstStr(attrs ?? {}, 'ref') ?? firstStr(root, 'ref')),
    pipelineId:
      firstStr(attrs ?? {}, 'id') ?? firstStr(root, 'build_id', 'pipeline_id') ?? 'unknown',
    jobName,
    runUrl: firstStr(attrs ?? {}, 'url') ?? firstStr(root, 'project.web_url'),
    commitSha: firstStr(root, 'commit.sha', 'commit.id') ?? firstStr(attrs ?? {}, 'sha'),
    author: firstStr(root, 'user.username', 'user.name', 'commit.author.name'),
    logText:
      extractLogText(root, 'build_log', 'object_attributes.log') ||
      `GitLab ${kind} "${jobName}" finished with status ${status}. No job log was included in the webhook payload.`,
    occurredAt:
      toEpochMs(at(attrs ?? {}, 'finished_at')) ?? toEpochMs(at(root, 'build_finished_at')),
  };
}

/* ------------------------------------------------------------------ *
 * Manual / demo
 * ------------------------------------------------------------------ */

/**
 * Deliberately permissive: the demo UI and `curl` should be able to post a repo
 * name and a blob of log text and get a triage. Only `repo` and a non-empty
 * `logText` are actually required.
 */
export function fromManual(payload: unknown): IncomingFailure | null {
  const root = obj(payload);
  if (!root) return null;

  const repo = firstStr(
    root,
    'repo',
    'repository',
    'repo_name',
    'repoName',
    'project',
    'repository.full_name',
  );
  const logText = extractLogText(root, 'message', 'error', 'text');

  if (!repo || !logText) return null;

  const providerHint = firstStr(root, 'provider')?.toLowerCase();
  const provider: Provider =
    providerHint === 'github' || providerHint === 'jenkins' || providerHint === 'gitlab'
      ? providerHint
      : 'manual';

  return {
    provider,
    repo,
    branch: cleanBranch(firstStr(root, 'branch', 'ref', 'head_branch')),
    pipelineId:
      firstStr(root, 'pipelineId', 'pipeline_id', 'runId', 'run_id', 'buildNumber', 'build_number') ??
      `manual-${Date.now()}`,
    jobName: firstStr(root, 'jobName', 'job_name', 'job', 'workflow', 'name') ?? 'manual',
    runUrl: firstStr(root, 'runUrl', 'run_url', 'url', 'html_url'),
    commitSha: firstStr(root, 'commitSha', 'commit_sha', 'commit', 'sha'),
    author: firstStr(root, 'author', 'actor', 'user'),
    logText,
    occurredAt:
      toEpochMs(at(root, 'occurredAt')) ??
      toEpochMs(at(root, 'occurred_at')) ??
      toEpochMs(at(root, 'timestamp')),
  };
}

/* ------------------------------------------------------------------ *
 * Provider detection + dispatch
 * ------------------------------------------------------------------ */

/** Sniff the provider from delivery headers first, then payload shape. */
export function detectProvider(request: Request, payload: unknown): Provider {
  const headers = request.headers;

  if (headers.get('x-github-event') || headers.get('x-github-delivery')) return 'github';
  if (headers.get('x-gitlab-event') || headers.get('x-gitlab-token')) return 'gitlab';
  if (headers.get('x-jenkins') || headers.get('x-jenkins-event')) return 'jenkins';

  const explicit = str(at(payload, 'provider'))?.toLowerCase();
  if (explicit === 'github' || explicit === 'gitlab' || explicit === 'jenkins' || explicit === 'manual') {
    return explicit;
  }

  const root = obj(payload);
  if (root) {
    if (root['workflow_run'] || root['check_run'] || root['workflow_job']) return 'github';
    if (root['object_kind']) return 'gitlab';
    if (obj(root['build']) && root['name']) return 'jenkins';
    if (obj(root['repository']) && str(at(root, 'repository.full_name'))) return 'github';
  }

  return 'manual';
}

/**
 * Runs the adapter for `provider`, falling back to the permissive manual adapter
 * so a hand-rolled payload that merely *looks* like GitHub still gets triaged.
 */
export function normaliseFailure(provider: Provider, payload: unknown): IncomingFailure | null {
  switch (provider) {
    case 'github':
      return fromGitHubActions(payload) ?? fromManual(payload);
    case 'jenkins':
      return fromJenkins(payload) ?? fromManual(payload);
    case 'gitlab':
      return fromGitLab(payload) ?? fromManual(payload);
    case 'manual':
    default:
      return fromManual(payload);
  }
}

/* ------------------------------------------------------------------ *
 * HMAC verification
 * ------------------------------------------------------------------ */

/** Headers that may carry an HMAC-SHA256 of the raw body, in priority order. */
const SIGNATURE_HEADERS = [
  'x-hub-signature-256', // GitHub
  'x-gitlab-signature-256',
  'x-jenkins-signature',
  'x-signature-256',
  'x-sentinel-signature',
  'x-webhook-signature',
] as const;

function readSignatureHeader(request: Request): string | null {
  for (const name of SIGNATURE_HEADERS) {
    const value = request.headers.get(name);
    if (value) return value;
  }
  return null;
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** Length-independent, data-independent comparison of two hex digests. */
function constantTimeEqual(a: string, b: string): boolean {
  // Compare a fixed number of characters regardless of input so the loop count
  // does not depend on where the first mismatch is.
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * Verifies an HMAC-SHA256 of `rawBody` against the signature header.
 *
 * When no secret is configured verification is skipped and that fact is logged —
 * the demo has to work with a bare `curl`, but an unverified ingest should never
 * be silent.
 */
export async function verifySignature(
  request: Request,
  rawBody: string,
  secret: string | undefined,
): Promise<boolean> {
  if (!secret) {
    console.warn(
      '[webhooks] HMAC verification SKIPPED: WEBHOOK_SECRET is not configured. Set it via `wrangler secret put WEBHOOK_SECRET` before exposing /api/ingest publicly.',
    );
    return true;
  }

  const header = readSignatureHeader(request);
  if (!header) {
    console.warn('[webhooks] rejected: WEBHOOK_SECRET is set but the request carried no signature header.');
    return false;
  }

  // Accept both `sha256=<hex>` and a bare hex digest.
  const provided = header.trim().replace(/^sha256=/i, '').toLowerCase();
  if (!/^[0-9a-f]+$/.test(provided)) {
    console.warn('[webhooks] rejected: signature header is not a hex digest.');
    return false;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const expected = toHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody)));

  const ok = constantTimeEqual(expected, provided);
  if (!ok) console.warn('[webhooks] rejected: HMAC signature mismatch.');
  return ok;
}
