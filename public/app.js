/* ==================================================================== *
 * Pipeline Sentinel — frontend
 *
 * Three panes: failure feed (left), triage detail (centre), stats + chat
 * (right). Vanilla JS, no build step, no dependencies.
 *
 * Architecture
 *   - `store`      : one explicit state object. Nothing else holds state.
 *   - `api.*`      : every network call, each one throwing ApiError on failure.
 *   - `render*()`  : pure-ish DOM builders reading from `store`.
 *   - fingerprints : each pane re-renders only when its slice of state
 *                    actually changed (the feed polls every 5s).
 *
 * Security: server data is only ever put into the DOM as text (textContent /
 * document.createTextNode). `innerHTML` is never used with any value that
 * came off the network — CI logs are full of HTML-looking junk.
 * ==================================================================== */

'use strict';

/* -------------------------------------------------------------------- *
 * 1. Configuration
 * -------------------------------------------------------------------- */

const POLL_MS = 5000;
const FEED_LIMIT = 50;
const STATS_WINDOW_DAYS = 7;
const MAX_CITATIONS_HYDRATED = 8;

const CATEGORY_LABEL = {
  test_failure: 'test',
  compile_error: 'compile',
  dependency_error: 'deps',
  infra_timeout: 'infra',
  oom: 'oom',
  lint_error: 'lint',
  permission_error: 'perms',
  network_error: 'network',
  unknown: 'unknown',
};

const STATUS_LABEL = {
  open: 'open',
  awaiting_approval: 'awaiting you',
  triaged: 'triaged',
  resolved: 'resolved',
  dismissed: 'dismissed',
};

const SUGGESTED_QUESTIONS = [
  "What's flaky this week?",
  'What broke most often?',
  'Any known fix for the current failure?',
];

/* Built-in sample payloads for the "Replay a demo failure" button.
 * Shape = IncomingFailure from src/types.ts. Deliberately includes
 * HTML-looking log content to prove the escaping path. */
const DEMO_FAILURES = [
  {
    provider: 'github',
    repo: 'acme/checkout-api',
    branch: 'main',
    jobName: 'unit-tests (node 20)',
    pipelineId: 'gh-run-88213',
    runUrl: 'https://github.com/acme/checkout-api/actions/runs/88213',
    commitSha: '9f2c41ab77de0031aa5b19c3d8e4f61027bb8d55',
    author: 'rmehta',
    logText: [
      '2026-08-31T09:14:02.113Z ##[group]Run npm test',
      '> checkout-api@3.4.1 test',
      '> jest --ci --runInBand',
      '',
      'FAIL src/cart/__tests__/totals.test.ts',
      '  ● Cart totals › applies a percentage discount before tax',
      '',
      '    expect(received).toEqual(expected) // deep equality',
      '',
      '    - Expected  - 1',
      '    + Received  + 1',
      '',
      '      Object {',
      '    -   "total": 4275,',
      '    +   "total": 4280,',
      '        "currency": "USD",',
      '      }',
      '',
      '      at Object.<anonymous> (src/cart/__tests__/totals.test.ts:118:24)',
      '      at TestScheduler.scheduleTests (node_modules/@jest/core/build/TestScheduler.js:333:13)',
      '',
      'Tests:       1 failed, 264 passed, 265 total',
      'Time:        31.42 s',
      '##[error]Process completed with exit code 1.',
    ].join('\n'),
  },
  {
    provider: 'github',
    repo: 'acme/checkout-api',
    branch: 'release/3.5',
    jobName: 'integration (postgres)',
    pipelineId: 'gh-run-88240',
    runUrl: 'https://github.com/acme/checkout-api/actions/runs/88240',
    commitSha: '2b81ee0c1a4f9b7735d0c6ee9812f4a0b1c7e934',
    author: 'ops-bot',
    logText: [
      '2026-08-31T11:02:44.007Z Starting service container postgres:16-alpine',
      'Waiting for database to accept connections (attempt 1/30)...',
      'Waiting for database to accept connections (attempt 17/30)...',
      'Waiting for database to accept connections (attempt 30/30)...',
      'Error: connect ETIMEDOUT 172.18.0.3:5432',
      '    at Socket.<anonymous> (node_modules/pg/lib/connection.js:87:17)',
      '    at Object.onceWrapper (node:events:634:26)',
      '##[error]The operation was canceled after 600000ms.',
      '##[error]The job running on runner ubuntu-22.04 has exceeded the maximum execution time.',
    ].join('\n'),
  },
  {
    provider: 'jenkins',
    repo: 'acme/web-dashboard',
    branch: 'feat/reporting-v2',
    jobName: 'build-bundle',
    pipelineId: 'jenkins-4412',
    runUrl: 'https://ci.acme.dev/job/web-dashboard/4412/console',
    commitSha: 'c7148aa93e5bd2210ff40a6b8c2e11d7f0a3b6ce',
    author: 'jlin',
    logText: [
      '[2026-08-31T13:44:10.882Z] > vite build',
      'transforming (1842) node_modules/@charts/core/dist/index.mjs',
      '',
      '<--- Last few GCs --->',
      '[1841:0x5f8a0b0]   118442 ms: Mark-Compact 4051.2 (4128.9) -> 4048.7 (4130.4) MB',
      '',
      'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
      ' 1: 0xb8a0f0 node::Abort() [node]',
      ' 2: 0xa8d1b4 node::FatalError(char const*, char const*) [node]',
      'Aborted (core dumped)',
      'ERROR: script returned exit code 134',
      'Finished: FAILURE',
    ].join('\n'),
  },
  {
    provider: 'gitlab',
    repo: 'acme/payments-worker',
    branch: 'main',
    jobName: 'install',
    pipelineId: 'gl-pipeline-99120',
    runUrl: 'https://gitlab.acme.dev/acme/payments-worker/-/jobs/99120',
    commitSha: 'ee0417d3c9a2b58f6104d7ab3c9e2f7180bb45aa',
    author: 'dep-bot',
    logText: [
      '$ npm ci --omit=dev',
      'npm error code ERESOLVE',
      'npm error ERESOLVE could not resolve',
      'npm error',
      'npm error While resolving: @acme/ledger-sdk@4.2.0',
      'npm error Found: undici@6.19.2',
      'npm error node_modules/undici',
      'npm error   undici@"^6.19.0" from the root project',
      'npm error',
      'npm error Could not resolve dependency:',
      'npm error peer undici@"^7.0.0" from @acme/ledger-sdk@4.2.0',
      'npm error',
      'npm error Fix the upstream dependency conflict, or retry',
      'npm error this command with --force or --legacy-peer-deps',
      'ERROR: Job failed: exit code 1',
    ].join('\n'),
  },
];

/* Repos we know about even before the backend has any data, so the repo
 * selector is never empty on a cold install. */
const DEMO_REPOS = [...new Set(DEMO_FAILURES.map((d) => d.repo))];

/* -------------------------------------------------------------------- *
 * 2. Store — the single source of truth
 * -------------------------------------------------------------------- */

const store = {
  /* repo selection */
  repos: [...DEMO_REPOS],
  repo: DEMO_REPOS[0],

  /* left pane */
  failures: [],
  feedState: 'loading', // loading | ready | error
  feedError: null,

  /* centre pane */
  selectedId: null,
  detail: null, // { failure: FailureRecord, runs: TriageRun[] }
  detailState: 'empty', // empty | loading | ready | error
  detailError: null,
  /** id -> { state: 'loading'|'ok'|'error', failure?: FailureRecord } */
  citations: Object.create(null),

  /* centre-pane interaction */
  editingFix: false,
  drafts: { note: '', editedFix: '' },
  actionBusy: null, // 'approve' | 'reject' | 'approve-edited' | 'resolve' | null
  actionError: null,

  /* right pane */
  stats: null,
  statsState: 'loading',
  statsError: null,

  chat: [], // { role, content, streaming?: boolean, failed?: boolean }
  chatBusy: false,
  chatError: null,

  /* chrome */
  health: null,
  healthError: null,
  replayBusy: false,
  /** Set when a *background* poll fails; surfaced in the feed header rather
   *  than by destroying the last-good data on screen. */
  pollError: null,

  /* render bookkeeping */
  fp: { feed: '', detail: '', stats: '', chat: '', repos: '', health: '', sync: '' },
};

/** In-flight chat request, aborted when a new one starts. */
let chatAbort = null;
/** Round-robin cursor over DEMO_FAILURES. */
let demoCursor = 0;

/* -------------------------------------------------------------------- *
 * 3. Small DOM + formatting utilities
 * -------------------------------------------------------------------- */

/**
 * Build an element. Every text value goes in via textContent, so nothing
 * from the server can ever be parsed as markup.
 */
function el(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const key of Object.keys(props)) {
      const val = props[key];
      if (val === null || val === undefined || val === false) continue;
      if (key === 'class') node.className = val;
      else if (key === 'text') node.textContent = String(val);
      else if (key === 'on') {
        for (const evt of Object.keys(val)) node.addEventListener(evt, val[evt]);
      } else if (key === 'style') Object.assign(node.style, val);
      else if (key.startsWith('data-') || key.startsWith('aria-') || key === 'role') {
        node.setAttribute(key, String(val));
      } else if (key in node) {
        node[key] = val;
      } else {
        node.setAttribute(key, String(val));
      }
    }
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) appendChildren(node, child);
    else if (child instanceof Node) node.appendChild(child);
    else node.appendChild(document.createTextNode(String(child)));
  }
}

/** <svg class="ico"><use href="#id"></svg> — ids are author constants only. */
function icon(id, cls) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', cls || 'ico');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', '#' + id);
  svg.appendChild(use);
  return svg;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function mount(node, ...children) {
  clear(node);
  appendChildren(node, children);
}

/** Relative time for epoch-ms values, tolerant of nulls and seconds-based values. */
function relTime(ms) {
  const t = normaliseEpochMs(ms);
  if (t === null) return '—';
  const diff = Date.now() - t;
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  if (d < 30) return d + 'd ago';
  return new Date(t).toLocaleDateString();
}

function absTime(ms) {
  const t = normaliseEpochMs(ms);
  return t === null ? '' : new Date(t).toLocaleString();
}

/** The API speaks epoch ms; accept seconds defensively rather than showing 1970. */
function normaliseEpochMs(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return v < 1e12 ? v * 1000 : v;
}

function fmtDuration(msRaw) {
  if (typeof msRaw !== 'number' || !Number.isFinite(msRaw) || msRaw < 0) return '';
  if (msRaw < 1000) return Math.round(msRaw) + 'ms';
  if (msRaw < 60000) return (msRaw / 1000).toFixed(msRaw < 10000 ? 2 : 1) + 's';
  const m = Math.floor(msRaw / 60000);
  return m + 'm ' + Math.round((msRaw % 60000) / 1000) + 's';
}

function shortId(id) {
  const s = String(id || '');
  return s.length > 12 ? s.slice(0, 8) + '…' + s.slice(-3) : s;
}

function categoryLabel(cat) {
  return CATEGORY_LABEL[cat] || String(cat || 'unknown');
}

function statusLabel(status) {
  return STATUS_LABEL[status] || String(status || 'unknown');
}

/* -------------------------------------------------------------------- *
 * 4. Network layer
 * -------------------------------------------------------------------- */

class ApiError extends Error {
  constructor(message, detail, status) {
    super(message);
    this.name = 'ApiError';
    this.detail = detail || '';
    this.status = status || 0;
  }
}

/**
 * fetch + JSON, normalising every failure mode (network down, non-2xx,
 * non-JSON body) into a single ApiError so callers have one path.
 */
async function requestJson(url, options) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new ApiError('Network request failed', String((err && err.message) || err), 0);
  }

  const raw = await res.text();
  let body = null;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    // ApiError shape from types.ts: { error, detail? }
    const msg = (body && typeof body.error === 'string' && body.error) || 'HTTP ' + res.status + ' ' + res.statusText;
    const det = (body && typeof body.detail === 'string' && body.detail) || (!body && raw ? raw.slice(0, 240) : '');
    throw new ApiError(msg, det, res.status);
  }
  if (body === null && raw) {
    throw new ApiError('Malformed response from server', raw.slice(0, 240), res.status);
  }
  return body;
}

function postJson(url, payload, signal) {
  return requestJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: signal,
  });
}

const api = {
  /** GET /api/health -> binding status (shape tolerated generically). */
  health: () => requestJson('/api/health'),

  /**
   * GET /api/failures?repo=&limit= -> FailureListResponse
   * Omitting `repo` lists across every repo. The server wraps the rows in
   * `{repo, limit, count, failures}`; a bare array is still tolerated so the
   * pane degrades rather than blanking if the envelope ever changes.
   */
  failures: async (repo, limit) => {
    const qs = new URLSearchParams();
    if (repo) qs.set('repo', repo);
    if (limit) qs.set('limit', String(limit));
    const q = qs.toString();
    const body = await requestJson('/api/failures' + (q ? '?' + q : ''));
    if (Array.isArray(body)) return body;
    return body && Array.isArray(body.failures) ? body.failures : [];
  },

  /** GET /api/repos -> string[] */
  repos: async () => {
    const body = await requestJson('/api/repos');
    return body && Array.isArray(body.repos) ? body.repos : [];
  },

  /** GET /api/failures/:id -> { failure, runs } */
  failure: (id) => requestJson('/api/failures/' + encodeURIComponent(id)),

  /** POST /api/failures/:id/resolve { note } */
  resolve: (id, note) => postJson('/api/failures/' + encodeURIComponent(id) + '/resolve', { note: note }),

  /** POST /api/failures/:id/approve { approved, editedFix? } */
  approve: (id, approved, editedFix) => {
    const payload = { approved: approved };
    if (typeof editedFix === 'string' && editedFix.trim()) payload.editedFix = editedFix;
    return postJson('/api/failures/' + encodeURIComponent(id) + '/approve', payload);
  },

  /** GET /api/stats?repo=&days= -> RepoStats */
  stats: (repo, days) => {
    const qs = new URLSearchParams();
    if (repo) qs.set('repo', repo);
    if (days) qs.set('days', String(days));
    return requestJson('/api/stats?' + qs.toString());
  },

  /** POST /api/ingest -> IngestResponse */
  ingest: (payload) => postJson('/api/ingest', payload),
};

/* -------------------------------------------------------------------- *
 * 5. Shared UI fragments
 * -------------------------------------------------------------------- */

function statusPill(status) {
  return el('span', { class: 'pill', 'data-status': status, title: 'status: ' + String(status) },
    el('i', {}),
    statusLabel(status),
  );
}

function categoryBadge(cat) {
  return el('span', { class: 'badge badge--cat', title: 'category: ' + String(cat) }, categoryLabel(cat));
}

function emptyState(iconId, title, text, action) {
  return el('div', { class: 'empty' },
    el('div', { class: 'empty__icon' }, icon(iconId)),
    el('div', { class: 'empty__title', text: title }),
    text ? el('div', { class: 'empty__text', text: text }) : null,
    action || null,
  );
}

/** Human-readable one-liner for any thrown value. */
function errText(err) {
  if (err instanceof ApiError) {
    return [err.status ? 'HTTP ' + err.status : null, err.message, err.detail].filter(Boolean).join(' · ');
  }
  return String((err && err.message) || err || 'Unknown error');
}

/** Inline, non-silent error block with an optional retry. */
function errorState(title, err, onRetry) {
  const detail = errText(err);
  return el('div', { class: 'inline-error' },
    icon('i-alert'),
    el('div', { class: 'inline-error__body' },
      el('div', { class: 'inline-error__title', text: title }),
      detail ? el('div', { class: 'inline-error__detail', text: detail }) : null,
      onRetry
        ? el('div', { style: { marginTop: '8px' } },
            el('button', { class: 'btn btn--sm', type: 'button', on: { click: onRetry } }, 'Retry'))
        : null,
    ),
  );
}

function skeleton(rows) {
  const widths = ['sk--w90', 'sk--w70', 'sk--w45'];
  const kids = [];
  for (let i = 0; i < rows; i++) kids.push(el('div', { class: 'sk ' + widths[i % widths.length] }));
  return el('div', { class: 'skeleton' }, kids);
}

/**
 * Feed-header indicator. Green "live" normally; red "sync failed" when a
 * background poll errored — so a transient failure is visible without
 * blowing away the data already on screen.
 */
function renderSyncState() {
  const dot = document.getElementById('live-dot');
  const err = store.pollError;
  const fp = err ? 'err:' + errText(err) : 'ok';
  if (fp === store.fp.sync) return;
  store.fp.sync = fp;

  clear(dot);
  dot.classList.toggle('live--error', !!err);
  dot.title = err ? 'Background refresh failed: ' + errText(err) : 'Polling every 5s';
  dot.appendChild(el('i', {}));
  dot.appendChild(document.createTextNode(err ? 'sync failed' : 'live'));
}

function toast(message, tone) {
  const host = document.getElementById('toast-host');
  const node = el('div', { class: 'toast', 'data-tone': tone || 'info' }, message);
  host.appendChild(node);
  setTimeout(() => { if (node.parentNode) node.parentNode.removeChild(node); }, 5200);
}

/* -------------------------------------------------------------------- *
 * 6. Left pane — failure feed
 * -------------------------------------------------------------------- */

/** Cheap change fingerprint: only what the feed actually draws. */
function feedFingerprint() {
  if (store.feedState !== 'ready') return store.feedState + '|' + (store.feedError ? store.feedError.message : '');
  return 'ready|' + store.repo + '|' + store.selectedId + '|' + store.failures
    .map((f) => [f.id, f.status, f.occurrenceCount, f.lastSeenAt, f.category].join(':'))
    .join('|');
}

function renderFeed(force) {
  const fp = feedFingerprint();
  if (!force && fp === store.fp.feed) return;
  store.fp.feed = fp;

  const body = document.getElementById('feed-body');
  const countEl = document.getElementById('feed-count');

  if (store.feedState === 'loading') {
    countEl.textContent = '';
    mount(body, skeleton(9));
    return;
  }

  if (store.feedState === 'error') {
    countEl.textContent = '';
    mount(body, errorState('Could not load failures', store.feedError, () => refreshFailures(true)));
    return;
  }

  const list = store.failures;
  const awaiting = list.filter((f) => f.status === 'awaiting_approval').length;
  countEl.textContent = list.length
    ? String(list.length) + (awaiting ? ' · ' + awaiting + ' awaiting you' : '')
    : '';

  if (!list.length) {
    mount(body, emptyState(
      'i-flask',
      'No failures yet',
      'Point a CI webhook at /api/ingest, or replay one of the built-in sample builds to see the agent work.',
      el('button', {
        class: 'btn btn--accent btn--sm',
        type: 'button',
        style: { marginTop: '10px' },
        on: { click: replayDemoFailure },
      }, icon('i-play'), 'Replay a demo failure'),
    ));
    return;
  }

  const frag = document.createDocumentFragment();
  for (const f of list) frag.appendChild(feedRow(f));
  mount(body, frag);
}

function feedRow(f) {
  const selected = f.id === store.selectedId;
  const hot = Number(f.occurrenceCount) > 2;

  return el('button', {
      class: 'frow',
      type: 'button',
      'data-status': f.status,
      'aria-current': selected ? 'true' : 'false',
      title: String(f.jobName || '') + ' · ' + absTime(f.lastSeenAt),
      on: { click: () => selectFailure(f.id) },
    },
    el('div', { class: 'frow__top' },
      categoryBadge(f.category),
      f.status === 'awaiting_approval'
        ? el('span', { class: 'needs-you' }, icon('i-alert'), 'needs you')
        : null,
      Number(f.occurrenceCount) > 1
        ? el('span', {
            class: 'count-chip',
            'data-hot': String(hot),
            title: 'seen ' + f.occurrenceCount + ' times',
          }, '×' + f.occurrenceCount)
        : null,
    ),
    el('div', { class: 'frow__sig', text: f.signatureText || '(no signature)' }),
    el('div', { class: 'frow__bot' },
      statusPill(f.status),
      el('span', { class: 'frow__branch', text: f.branch || '—' }),
      el('span', { class: 'frow__time', text: relTime(f.lastSeenAt) }),
    ),
  );
}

/* -------------------------------------------------------------------- *
 * 7. Centre pane — triage detail
 * -------------------------------------------------------------------- */

/**
 * The triage output the UI needs (root cause, fix, confidence, flake flag,
 * cited prior failures) partly lives on FailureRecord and partly only inside
 * TriageResult, which the API does not currently surface directly. So we
 * merge three sources, most authoritative first:
 *   1. fields on FailureRecord itself
 *   2. optional TriageResult-ish fields the backend may attach to the record
 *   3. any triage_runs row whose `detail` parses as JSON carrying them
 */
function triageOf(detail) {
  const f = detail.failure || {};
  const fromRuns = triageFromRuns(detail.runs);

  const pick = (key) => (f[key] !== undefined && f[key] !== null ? f[key] : fromRuns[key]);

  const cited = pick('citedFailureIds');
  const citedList = Array.isArray(cited) ? cited.filter((x) => typeof x === 'string' && x) : [];

  return {
    rootCause: typeof f.rootCause === 'string' && f.rootCause ? f.rootCause : (fromRuns.rootCause || null),
    suggestedFix: typeof f.suggestedFix === 'string' && f.suggestedFix ? f.suggestedFix : (fromRuns.suggestedFix || null),
    confidence: typeof f.confidence === 'number' ? f.confidence : (typeof fromRuns.confidence === 'number' ? fromRuns.confidence : null),
    isLikelyFlake: pick('isLikelyFlake') === true,
    citedFailureIds: citedList.filter((id) => id !== f.id).slice(0, MAX_CITATIONS_HYDRATED),
    headline: typeof pick('headline') === 'string' ? pick('headline') : null,
  };
}

/** Scan the audit trail for a step whose detail is JSON-encoded TriageResult. */
function triageFromRuns(runs) {
  const out = {};
  if (!Array.isArray(runs)) return out;
  for (const run of runs) {
    if (!run || typeof run.detail !== 'string') continue;
    const s = run.detail.trim();
    if (!s.startsWith('{')) continue;
    let parsed;
    try {
      parsed = JSON.parse(s);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    for (const key of ['rootCause', 'suggestedFix', 'confidence', 'isLikelyFlake', 'citedFailureIds', 'headline']) {
      if (parsed[key] !== undefined && parsed[key] !== null && out[key] === undefined) out[key] = parsed[key];
    }
  }
  return out;
}

/** True when this signature shows up in the repo's top-flake list. */
function flakeEvidence(failure) {
  const flakes = store.stats && Array.isArray(store.stats.topFlakes) ? store.stats.topFlakes : [];
  return flakes.find((x) => x && x.signatureHash === failure.signatureHash) || null;
}

function detailFingerprint() {
  if (store.detailState !== 'ready' || !store.detail) {
    return store.detailState + '|' + store.selectedId + '|' + (store.detailError ? store.detailError.message : '');
  }
  const f = store.detail.failure;
  const runs = (store.detail.runs || [])
    .map((r) => [r.step, r.status, r.durationMs, r.createdAt, (r.detail || '').length].join(':'))
    .join('|');
  const cites = Object.keys(store.citations)
    .map((id) => id + ':' + store.citations[id].state)
    .join('|');
  return [
    'ready', f.id, f.status, f.occurrenceCount, f.lastSeenAt, f.confidence,
    (f.rootCause || '').length, (f.suggestedFix || '').length, (f.resolutionNote || '').length,
    runs, cites,
    store.editingFix, store.actionBusy, store.actionError ? store.actionError.message : '',
    store.stats ? (store.stats.topFlakes || []).length : -1,
  ].join('|');
}

function renderDetail(force) {
  const fp = detailFingerprint();
  if (!force && fp === store.fp.detail) return;
  store.fp.detail = fp;

  const body = document.getElementById('detail-body');
  const meta = document.getElementById('detail-meta');
  const focus = captureFocus(body);

  if (store.detailState === 'empty') {
    meta.textContent = '';
    mount(body, emptyState(
      'i-bolt',
      'Nothing selected',
      'Pick a failure from the feed to see its root-cause analysis, the prior failures the agent cited, and the full workflow audit trail.',
    ));
    return;
  }

  if (store.detailState === 'loading') {
    meta.textContent = '';
    mount(body, skeleton(10));
    return;
  }

  if (store.detailState === 'error') {
    meta.textContent = '';
    mount(body, errorState('Could not load this failure', store.detailError,
      () => { if (store.selectedId) loadDetail(store.selectedId, true); }));
    return;
  }

  const d = store.detail;
  const f = d.failure;
  const t = triageOf(d);
  meta.textContent = shortId(f.id);

  const wrap = el('div', { class: 'detail' });
  appendChildren(wrap, [
    detailHeader(f, t),
    store.actionError ? errorState('Action failed', store.actionError, null) : null,
    actionZone(f, t),
    triageZone(f, t),
    memoryZone(t),
    logZone(f),
    timelineZone(d.runs),
  ]);
  mount(body, wrap);
  restoreFocus(body, focus);
}

function detailHeader(f, t) {
  const facts = [
    ['job', f.jobName],
    ['branch', f.branch],
    ['provider', f.provider],
    ['pipeline', f.pipelineId],
    ['commit', f.commitSha ? String(f.commitSha).slice(0, 8) : null],
    ['seen', String(f.occurrenceCount) + '×'],
    ['first', relTime(f.createdAt)],
    ['last', relTime(f.lastSeenAt)],
  ].filter((pair) => pair[1] !== null && pair[1] !== undefined && pair[1] !== '');

  return el('div', { class: 'detail__head' },
    el('div', { class: 'detail__crumbs' },
      el('span', { text: f.repo || '—' }),
      el('span', { class: 'sep', text: '/' }),
      categoryBadge(f.category),
      statusPill(f.status),
      f.fileHint ? el('span', { class: 'sep', text: '·' }) : null,
      f.fileHint ? el('span', { text: f.fileHint, title: 'implicated file' }) : null,
      f.runUrl
        ? el('a', {
            href: String(f.runUrl), target: '_blank', rel: 'noopener noreferrer',
            style: { marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '5px' },
          }, icon('i-link'), 'open run')
        : null,
    ),
    t.headline ? el('div', { class: 'prose', style: { color: 'var(--ink-3)', marginBottom: '6px' }, text: t.headline }) : null,
    el('div', { class: 'detail__sig', text: f.signatureText || '(no signature)' }),
    el('div', { class: 'detail__facts' },
      facts.map(([k, v]) => el('span', {}, k + ' ', el('b', { text: String(v) }))),
    ),
  );
}

/* ---- root cause / fix / confidence -------------------------------- */

function triageZone(f, t) {
  const section = el('div', { class: 'section' },
    el('div', { class: 'section__head' }, icon('i-bolt'), 'Agent analysis'),
  );

  if (!t.rootCause && !t.suggestedFix) {
    section.appendChild(el('div', { class: 'card' },
      emptyState(
        'i-bolt',
        f.status === 'open' ? 'Triage in progress' : 'No analysis recorded',
        f.status === 'open'
          ? 'The workflow is parsing the log, embedding the error signature and searching memory. This view updates automatically.'
          : 'The workflow finished without storing a root cause for this failure.',
      ),
    ));
    return section;
  }

  const card = el('div', { class: 'card' });

  if (t.rootCause) {
    card.appendChild(el('div', { class: 'section__head', style: { marginTop: '0' } }, 'Root cause'));
    card.appendChild(el('div', { class: 'prose', text: t.rootCause }));
  }

  if (t.suggestedFix) {
    card.appendChild(el('div', { class: 'section__head', style: { marginTop: '16px' } }, 'Suggested fix'));
    card.appendChild(el('div', { class: 'prose prose--fix', text: t.suggestedFix }));
  }

  if (typeof t.confidence === 'number') {
    const pct = Math.max(0, Math.min(1, t.confidence));
    const band = pct >= 0.75 ? 'high' : pct >= 0.45 ? 'mid' : 'low';
    card.appendChild(el('div', { class: 'meter', style: { marginTop: '18px' } },
      el('span', { class: 'meter__label', text: 'confidence' }),
      el('span', {
          class: 'meter__track',
          role: 'meter',
          'aria-valuenow': String(Math.round(pct * 100)),
          'aria-valuemin': '0',
          'aria-valuemax': '100',
          'aria-label': 'Model confidence',
        },
        el('span', { class: 'meter__fill', 'data-band': band, style: { width: (pct * 100).toFixed(0) + '%' } }),
      ),
      el('span', { class: 'meter__val', text: Math.round(pct * 100) + '%' }),
    ));
  }

  const flake = flakeEvidence(f);
  if (t.isLikelyFlake || flake) {
    const bits = [];
    if (t.isLikelyFlake) bits.push('The agent judged this a flaky or infrastructure failure rather than a real defect.');
    if (flake) bits.push('This signature has been seen ' + flake.count + '× in the last ' + (store.stats ? store.stats.windowDays : STATS_WINDOW_DAYS) + ' days.');
    card.appendChild(el('div', { class: 'flake-flag' }, icon('i-alert'),
      el('span', {}, el('b', { text: 'Likely flake. ' }), bits.join(' '))));
  }

  if (f.resolutionNote) {
    card.appendChild(el('div', { class: 'section__head', style: { marginTop: '18px' } }, 'Resolution note'));
    card.appendChild(el('div', { class: 'prose', text: f.resolutionNote }));
    if (f.resolvedAt) {
      card.appendChild(el('div', { class: 'step__time', text: 'resolved ' + relTime(f.resolvedAt) + ' · ' + absTime(f.resolvedAt) }));
    }
  }

  section.appendChild(card);
  return section;
}

/* ---- cited prior failures: the visible proof that memory works ----- */

function memoryZone(t) {
  const ids = t.citedFailureIds;
  const section = el('div', { class: 'section' },
    el('div', { class: 'section__head' }, icon('i-memory'), 'Memory · cited prior failures'),
  );

  if (!ids.length) {
    section.appendChild(el('div', { class: 'card' },
      emptyState('i-memory', 'No prior failures cited',
        'Nothing in memory matched this error signature closely enough. Once this failure is resolved it becomes memory for the next one.'),
    ));
    return section;
  }

  const box = el('div', { class: 'memory' },
    el('div', { class: 'memory__head' },
      icon('i-memory'),
      el('span', { class: 'memory__title', text: 'The agent reused ' + ids.length + ' past ' + (ids.length === 1 ? 'failure' : 'failures') }),
      el('span', { class: 'memory__sub', text: 'D1 vector recall' }),
    ),
  );

  for (const id of ids) box.appendChild(citationRow(id));
  section.appendChild(box);
  return section;
}

function citationRow(id) {
  const entry = store.citations[id];

  if (!entry || entry.state === 'loading') {
    return el('div', { class: 'cite' },
      el('div', { class: 'cite__top' }, el('span', { class: 'badge', text: 'loading' }), el('span', { class: 'cite__id', text: shortId(id) })),
      el('div', { class: 'sk sk--w70' }),
    );
  }

  if (entry.state === 'error' || !entry.failure) {
    return el('div', { class: 'cite' },
      el('div', { class: 'cite__top' },
        el('span', { class: 'badge', text: 'unavailable' }),
        el('span', { class: 'cite__id', text: shortId(id) }),
      ),
      el('div', { class: 'cite__sig', text: 'Cited failure ' + id + ' could not be loaded.' }),
    );
  }

  const c = entry.failure;
  return el('button', {
      class: 'cite',
      type: 'button',
      title: 'Open cited failure ' + c.id,
      on: { click: () => selectFailure(c.id) },
    },
    el('div', { class: 'cite__top' },
      categoryBadge(c.category),
      statusPill(c.status),
      Number(c.occurrenceCount) > 1 ? el('span', { class: 'count-chip', text: '×' + c.occurrenceCount }) : null,
      el('span', { class: 'cite__id', text: relTime(c.lastSeenAt) }),
    ),
    el('div', { class: 'cite__sig', text: c.signatureText || '(no signature)' }),
    c.resolutionNote
      ? el('div', { class: 'cite__note' }, el('b', { text: 'Known fix: ' }), c.resolutionNote)
      : (c.suggestedFix ? el('div', { class: 'cite__note' }, el('b', { text: 'Prior fix: ' }), c.suggestedFix) : null),
  );
}

/* ---- log excerpt --------------------------------------------------- */

function logZone(f) {
  return el('div', { class: 'section' },
    el('div', { class: 'section__head' }, 'Log excerpt'),
    f.excerpt
      ? el('pre', { class: 'logblock', tabindex: '0', 'aria-label': 'Log excerpt' }, String(f.excerpt))
      : el('div', { class: 'card' }, emptyState('i-flask', 'No excerpt captured', 'The parser stored no log slice for this failure.')),
  );
}

/* ---- workflow audit trail ------------------------------------------ */

function timelineZone(runs) {
  const section = el('div', { class: 'section' },
    el('div', { class: 'section__head' }, 'Workflow audit trail'),
  );

  if (!Array.isArray(runs) || !runs.length) {
    section.appendChild(el('div', { class: 'card' },
      emptyState('i-refresh', 'No steps recorded yet', 'Workflow steps appear here as the agent runs them.'),
    ));
    return section;
  }

  const ordered = runs.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const line = el('div', { class: 'timeline' });

  for (const run of ordered) {
    const status = String(run.status || '');
    const detailText = typeof run.detail === 'string' ? run.detail : '';
    line.appendChild(el('div', { class: 'step', 'data-status': status },
      el('div', { class: 'step__top' },
        el('span', { class: 'step__name', text: String(run.step || 'step') }),
        el('span', { class: 'step__status', text: status || '—' }),
        el('span', { class: 'step__dur', text: fmtDuration(run.durationMs) }),
      ),
      detailText ? el('div', { class: 'step__detail', text: detailText }) : null,
      el('div', { class: 'step__time', text: relTime(run.createdAt) + ' · ' + absTime(run.createdAt) }),
    ));
  }

  section.appendChild(el('div', { class: 'card' }, line));
  return section;
}

/* ---- approve / reject / resolve controls --------------------------- */

function actionZone(f, t) {
  if (f.status === 'awaiting_approval') return approvalBox(f, t);
  if (f.status === 'triaged' || (f.status === 'open' && t.rootCause)) return resolveBox(f);
  return null;
}

function approvalBox(f, t) {
  const busy = store.actionBusy;

  const box = el('div', { class: 'section' },
    el('div', { class: 'actionbox' },
      el('div', { class: 'actionbox__title' }, icon('i-alert'), 'This failure is waiting on you'),
      el('div', { class: 'actionbox__hint', text:
        'The workflow is paused on a human-approval gate. Approving resumes it and posts the fix back to the pipeline; rejecting resumes it without posting.' }),
    ),
  );
  const inner = box.firstChild;

  if (store.editingFix) {
    inner.appendChild(el('textarea', {
      class: 'ta',
      'data-draft': 'editedFix',
      placeholder: 'Edited fix to post back instead of the agent suggestion…',
      value: store.drafts.editedFix,
      'aria-label': 'Edited fix',
      on: { input: (e) => { store.drafts.editedFix = e.target.value; } },
    }));
  }

  const row = el('div', { class: 'actionbox__row' });
  row.appendChild(el('button', {
    class: 'btn btn--ok', type: 'button', disabled: !!busy,
    on: { click: () => submitApproval(f.id, true, null, 'approve') },
  }, icon('i-check'), busy === 'approve' ? 'Approving…' : 'Approve'));

  if (!store.editingFix) {
    row.appendChild(el('button', {
      class: 'btn', type: 'button', disabled: !!busy,
      on: { click: () => {
        store.editingFix = true;
        if (!store.drafts.editedFix) store.drafts.editedFix = t.suggestedFix || '';
        renderDetail(true);
        const ta = document.querySelector('[data-draft="editedFix"]');
        if (ta) ta.focus();
      } },
    }, icon('i-pencil'), 'Edit fix'));
  } else {
    row.appendChild(el('button', {
      class: 'btn btn--ok', type: 'button', disabled: !!busy,
      on: { click: () => {
        const edited = store.drafts.editedFix.trim();
        if (!edited) { store.actionError = new ApiError('Edited fix is empty', 'Write a fix or use Approve to post the agent suggestion.'); renderDetail(true); return; }
        submitApproval(f.id, true, edited, 'approve-edited');
      } },
    }, icon('i-check'), busy === 'approve-edited' ? 'Posting…' : 'Approve edited fix'));
    row.appendChild(el('button', {
      class: 'btn', type: 'button', disabled: !!busy,
      on: { click: () => { store.editingFix = false; renderDetail(true); } },
    }, 'Cancel edit'));
  }

  row.appendChild(el('button', {
    class: 'btn btn--danger', type: 'button', disabled: !!busy,
    on: { click: () => submitApproval(f.id, false, null, 'reject') },
  }, icon('i-x'), busy === 'reject' ? 'Rejecting…' : 'Reject'));

  inner.appendChild(row);
  return box;
}

function resolveBox(f) {
  const busy = store.actionBusy === 'resolve';
  return el('div', { class: 'section' },
    el('div', { class: 'actionbox actionbox--resolve' },
      el('div', { class: 'actionbox__title' }, icon('i-check'), 'Mark resolved'),
      el('div', { class: 'actionbox__hint', text:
        'What actually fixed it? The note is stored with this failure and becomes memory the agent can cite next time this signature appears.' }),
      el('textarea', {
        class: 'ta',
        'data-draft': 'note',
        placeholder: 'e.g. Pinned undici to ^6.19 in the ledger-sdk peer range and re-ran install.',
        value: store.drafts.note,
        'aria-label': 'Resolution note',
        on: { input: (e) => { store.drafts.note = e.target.value; } },
      }),
      el('div', { class: 'actionbox__row' },
        el('button', {
          class: 'btn btn--ok', type: 'button', disabled: busy,
          on: { click: () => submitResolve(f.id) },
        }, icon('i-check'), busy ? 'Saving…' : 'Resolve & remember'),
        el('span', { class: 'pane__meta', text: 'Stored as long-term memory' }),
      ),
    ),
  );
}

/* ---- focus/caret preservation across detail re-renders ------------- */

function captureFocus(container) {
  const active = document.activeElement;
  if (!active || !container.contains(active)) return null;
  const key = active.getAttribute && active.getAttribute('data-draft');
  if (!key) return null;
  return { key: key, start: active.selectionStart, end: active.selectionEnd };
}

function restoreFocus(container, snapshot) {
  if (!snapshot) return;
  const node = container.querySelector('[data-draft="' + snapshot.key + '"]');
  if (!node) return;
  node.focus();
  try {
    node.setSelectionRange(snapshot.start, snapshot.end);
  } catch {
    /* not a text input any more; focus alone is enough */
  }
}

/* -------------------------------------------------------------------- *
 * 8. Right pane — stats strip
 * -------------------------------------------------------------------- */

function statsFingerprint() {
  if (store.statsState !== 'ready' || !store.stats) {
    return store.statsState + '|' + (store.statsError ? store.statsError.message : '');
  }
  const s = store.stats;
  const top = (s.topFlakes || [])[0];
  return ['ready', s.repo, s.openCount, s.resolvedCount, s.windowDays, top ? top.signatureHash + ':' + top.count : 'none'].join('|');
}

function renderStats(force) {
  const fp = statsFingerprint();
  if (!force && fp === store.fp.stats) return;
  store.fp.stats = fp;

  const host = document.getElementById('stats-strip');
  host.classList.remove('stats--error');

  if (store.statsState === 'loading') {
    mount(host, statTile('open', '—'), statTile('resolved', '—'), statTile('top flake', '—'));
    return;
  }
  if (store.statsState === 'error') {
    host.classList.add('stats--error');
    mount(host, errorState('Stats unavailable', store.statsError, () => refreshStats(true)));
    return;
  }

  const s = store.stats || {};
  const top = Array.isArray(s.topFlakes) && s.topFlakes.length ? s.topFlakes[0] : null;
  const days = typeof s.windowDays === 'number' ? s.windowDays : STATS_WINDOW_DAYS;

  mount(host,
    statTile('open · ' + days + 'd', String(s.openCount != null ? s.openCount : 0), 'open'),
    statTile('resolved · ' + days + 'd', String(s.resolvedCount != null ? s.resolvedCount : 0), 'resolved'),
    top
      ? el('div', { class: 'stat', title: String(top.signatureText || '') },
          el('div', { class: 'stat__k', text: 'top flake ×' + top.count }),
          el('div', { class: 'stat__v stat__v--sm', text: top.signatureText || '(no signature)' }),
        )
      : statTile('top flake', 'none'),
  );
}

function statTile(label, value, tone) {
  return el('div', { class: 'stat' },
    el('div', { class: 'stat__k', text: label }),
    el('div', { class: 'stat__v', 'data-tone': tone || 'neutral', text: value }),
  );
}

/* -------------------------------------------------------------------- *
 * 9. Right pane — chat (SSE)
 * -------------------------------------------------------------------- */

function chatFingerprint() {
  return store.chat.map((m) => m.role + ':' + m.content.length + ':' + (m.streaming ? 1 : 0) + ':' + (m.failed ? 1 : 0)).join('|')
    + '|' + store.chatBusy + '|' + store.repo;
}

function renderChat(force) {
  const fp = chatFingerprint();
  if (!force && fp === store.fp.chat) return;
  store.fp.chat = fp;

  const log = document.getElementById('chat-log');
  const pinned = isPinnedToBottom(log);

  document.getElementById('chat-repo').textContent = store.repo || '';

  if (!store.chat.length) {
    mount(log, emptyState(
      'i-send',
      'No questions yet',
      'Ask about failure patterns in ' + (store.repo || 'this repo') + '. Answers stream from Llama 3.3 with the repo’s failure memory as context.',
    ));
  } else {
    const frag = document.createDocumentFragment();
    for (const m of store.chat) frag.appendChild(chatBubble(m));
    mount(log, frag);
  }

  // The send button reflects streaming state but stays usable: a new question
  // aborts the in-flight one.
  document.getElementById('chat-send').setAttribute('data-busy', String(store.chatBusy));

  if (pinned) log.scrollTop = log.scrollHeight;
}

function chatBubble(m) {
  const body = el('div', { class: 'msg__body' });
  body.appendChild(document.createTextNode(m.content));
  if (m.streaming) {
    if (!m.content) body.appendChild(document.createTextNode('Thinking'));
    body.appendChild(el('span', { class: 'caret' }));
  }
  return el('div', { class: 'msg msg--' + m.role },
    el('div', { class: 'msg__role', text: m.role === 'user' ? 'you' : 'sentinel' }),
    body,
  );
}

function isPinnedToBottom(node) {
  return node.scrollHeight - node.scrollTop - node.clientHeight < 60;
}

/** Fast path used during streaming: mutate the last bubble instead of rebuilding. */
function updateStreamingBubble() {
  const log = document.getElementById('chat-log');
  const bodies = log.querySelectorAll('.msg--assistant .msg__body');
  const last = bodies[bodies.length - 1];
  const msg = store.chat[store.chat.length - 1];
  if (!last || !msg || msg.role !== 'assistant') { renderChat(true); return; }
  const pinned = isPinnedToBottom(log);
  clear(last);
  last.appendChild(document.createTextNode(msg.content));
  if (msg.streaming) {
    if (!msg.content) last.appendChild(document.createTextNode('Thinking'));
    last.appendChild(el('span', { class: 'caret' }));
  }
  store.fp.chat = chatFingerprint(); // keep the fingerprint in sync
  if (pinned) log.scrollTop = log.scrollHeight;
}

/** Inline chat error, shown just above the composer. Never a silent failure. */
function setChatError(err) {
  const box = document.getElementById('chat-error');
  if (!err) {
    box.hidden = true;
    clear(box);
    return;
  }
  box.hidden = false;
  mount(box, errorState('Chat failed', err, () => {
    // Re-send the question that failed, without duplicating its bubble.
    const tail = store.chat[store.chat.length - 1];
    if (!tail || tail.role !== 'user') return;
    store.chat.pop();
    renderChat(true);
    sendChat(tail.content);
  }));
}

/**
 * Send a message and consume the SSE response.
 *
 * The stream is `data: {"delta":"..."}` lines terminated by `data: [DONE]`.
 * Chunks from the network do NOT align with event boundaries, so we keep a
 * buffer and only process complete newline-terminated lines.
 */
async function sendChat(message) {
  const text = String(message || '').trim();
  if (!text) return;
  if (!store.repo) {
    setChatError(new ApiError('No repository selected', 'Pick a repo before asking a question.'));
    return;
  }

  // Abort any in-flight request before starting a new one, and close out the
  // half-written bubble it left behind.
  if (chatAbort) chatAbort.abort();
  finalizeLingeringStream();
  chatAbort = new AbortController();
  const signal = chatAbort.signal;

  setChatError(null);
  store.chatError = null;
  store.chatBusy = true;
  store.chat.push({ role: 'user', content: text });
  const assistant = { role: 'assistant', content: '', streaming: true };
  store.chat.push(assistant);
  renderChat(true);

  let res;
  try {
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ repo: store.repo, message: text }),
      signal: signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') return; // superseded; newer request owns the UI
    finishChat(assistant, new ApiError('Network request failed', String((err && err.message) || err), 0));
    return;
  }

  if (!res.ok) {
    let detail = '';
    try {
      const raw = await res.text();
      try {
        const parsed = JSON.parse(raw);
        detail = (parsed && (parsed.detail || parsed.error)) || raw.slice(0, 240);
      } catch { detail = raw.slice(0, 240); }
    } catch { /* body unreadable */ }
    finishChat(assistant, new ApiError('HTTP ' + res.status + ' ' + res.statusText, detail, res.status));
    return;
  }

  if (!res.body) {
    finishChat(assistant, new ApiError('Streaming not supported', 'The response had no readable body.', res.status));
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  let streamError = null;

  try {
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        const verdict = handleSseLine(line, assistant);
        if (verdict === 'done') { done = true; break; }
        if (verdict && verdict.error) { streamError = verdict.error; done = true; break; }
      }
    }
    // Flush whatever the decoder and buffer still hold (stream ended mid-line).
    if (!streamError) {
      buffer += decoder.decode();
      const tail = buffer.replace(/\r$/, '').trim();
      if (tail) handleSseLine(tail, assistant);
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return; // superseded
    streamError = new ApiError('Stream interrupted', String((err && err.message) || err), 0);
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }

  if (!streamError && !assistant.content) {
    streamError = new ApiError('Empty response', 'The model returned no content for this question.', 0);
  }
  finishChat(assistant, streamError);
}

/**
 * Process one SSE line.
 * Returns 'done' on the terminator, {error} on a server-sent error, else null.
 */
function handleSseLine(line, assistant) {
  if (!line) return null;                       // event separator
  if (line.startsWith(':')) return null;         // comment / keep-alive
  if (!line.startsWith('data:')) return null;    // event:/id:/retry: — nothing we need

  const payload = line.slice(5).trimStart();
  if (!payload) return null;
  if (payload === '[DONE]') return 'done';

  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    // Not JSON: treat the raw payload as a text delta rather than dropping it.
    assistant.content += payload;
    updateStreamingBubble();
    return null;
  }

  if (parsed && typeof parsed === 'object') {
    if (typeof parsed.error === 'string' && parsed.error) {
      return { error: new ApiError(parsed.error, typeof parsed.detail === 'string' ? parsed.detail : '', 0) };
    }
    // Contract field is `delta`; the others are harmless fallbacks.
    const delta = [parsed.delta, parsed.text, parsed.response, parsed.token]
      .find((v) => typeof v === 'string');
    if (delta) {
      assistant.content += delta;
      updateStreamingBubble();
    }
    if (parsed.done === true) return 'done';
  }
  return null;
}

/** Close out an assistant bubble whose stream was aborted mid-flight. */
function finalizeLingeringStream() {
  for (let i = store.chat.length - 1; i >= 0; i--) {
    const m = store.chat[i];
    if (!m.streaming) continue;
    m.streaming = false;
    if (!m.content) store.chat.splice(i, 1);
  }
  store.chatBusy = false;
}

function finishChat(assistant, err) {
  assistant.streaming = false;
  store.chatBusy = false;
  chatAbort = null;
  if (err) {
    assistant.failed = true;
    if (!assistant.content) {
      // Drop the empty bubble; the inline error carries the message.
      const idx = store.chat.indexOf(assistant);
      if (idx !== -1) store.chat.splice(idx, 1);
    }
    store.chatError = err;
    setChatError(err);
  }
  renderChat(true);
}

/* -------------------------------------------------------------------- *
 * 10. Data loading
 * -------------------------------------------------------------------- */

async function refreshHealth() {
  try {
    const data = await api.health();
    store.health = data;
    store.healthError = null;
  } catch (err) {
    store.health = null;
    store.healthError = err;
  }
  renderHealth();
}

/**
 * /api/health returns "binding status" without a typed shape in types.ts, so
 * this renders defensively: any object of name -> boolean|string is shown as
 * one chip per binding.
 */
function renderHealth() {
  const host = document.getElementById('health-strip');
  const fp = JSON.stringify(store.health) + '|' + (store.healthError ? store.healthError.message : '');
  if (fp === store.fp.health) return;
  store.fp.health = fp;

  if (store.healthError) {
    mount(host, el('span', { class: 'health__chip', 'data-ok': 'false', title: store.healthError.message },
      el('i', {}), 'api unreachable'));
    return;
  }

  const data = store.health;
  if (!data || typeof data !== 'object') { mount(host); return; }

  const source = (data.bindings && typeof data.bindings === 'object') ? data.bindings
    : (data.checks && typeof data.checks === 'object') ? data.checks
    : data;

  const chips = [];
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (value === null || typeof value === 'object') continue;
    const ok = value === true || value === 'ok' || value === 'up' || value === 'connected' || value === 1;
    const bad = value === false || value === 'error' || value === 'down' || value === 'missing';
    chips.push(el('span', {
      class: 'health__chip',
      'data-ok': ok ? 'true' : bad ? 'false' : 'unknown',
      title: key + ': ' + String(value),
    }, el('i', {}), key));
  }
  mount(host, chips.slice(0, 6));
}

/** Repo list comes from GET /api/repos (distinct repos that have ever failed). */
async function refreshRepos() {
  let found = [];
  try {
    found = await api.repos();
    store.pollError = null;
  } catch (err) {
    // Non-fatal for the pane itself (the per-repo feed fetch reports its own
    // error), but still surfaced in the feed header rather than swallowed.
    store.pollError = err;
    renderSyncState();
    found = [];
  }
  if (!Array.isArray(found)) found = [];
  const merged = [...new Set([...found, ...DEMO_REPOS])].sort();
  store.repos = merged;
  if (!merged.includes(store.repo)) store.repo = found[0] || merged[0] || null;
  renderRepoSelect();
}

function renderRepoSelect() {
  const fp = store.repos.join('|') + '||' + store.repo;
  if (fp === store.fp.repos) return;
  store.fp.repos = fp;

  const select = document.getElementById('repo-select');
  clear(select);
  for (const repo of store.repos) {
    select.appendChild(el('option', { value: repo, text: repo, selected: repo === store.repo }));
  }
  if (store.repo) select.value = store.repo;
}

async function refreshFailures(force) {
  if (!store.repo) {
    store.failures = [];
    store.feedState = 'ready';
    renderFeed(true);
    return;
  }
  if (force) { store.feedState = 'loading'; renderFeed(true); }

  try {
    const rows = await api.failures(store.repo, FEED_LIMIT);
    store.failures = Array.isArray(rows) ? rows : [];
    store.feedState = 'ready';
    store.feedError = null;
    store.pollError = null;
  } catch (err) {
    if (!force && store.feedState === 'ready') {
      // Keep what is on screen; flag the failure in the header instead.
      store.pollError = err;
    } else {
      store.feedState = 'error';
      store.feedError = err;
    }
  }
  renderSyncState();
  renderFeed();
}

async function refreshStats(force) {
  if (!store.repo) return;
  if (force) { store.statsState = 'loading'; renderStats(true); }
  try {
    const data = await api.stats(store.repo, STATS_WINDOW_DAYS);
    store.stats = data;
    store.statsState = 'ready';
    store.statsError = null;
  } catch (err) {
    if (!force && store.statsState === 'ready') {
      store.pollError = err;
    } else {
      store.statsState = 'error';
      store.statsError = err;
    }
  }
  renderSyncState();
  renderStats();
}

async function loadDetail(id, force) {
  if (!id) return;
  if (force) {
    store.detailState = 'loading';
    store.detailError = null;
    renderDetail(true);
  }
  try {
    const data = await api.failure(id);
    if (store.selectedId !== id) return; // selection moved on while we waited
    store.detail = data && data.failure ? data : { failure: data, runs: [] };
    store.detailState = 'ready';
    store.detailError = null;
    renderDetail();
    hydrateCitations(triageOf(store.detail).citedFailureIds);
  } catch (err) {
    if (store.selectedId !== id) return;
    if (!force && store.detailState === 'ready') {
      store.pollError = err;
      renderSyncState();
      return;
    }
    store.detailState = 'error';
    store.detailError = err;
    renderDetail(true);
  }
}

/**
 * GET /api/failures/:id returns a hydrated `citations` array, so the common
 * path costs no extra requests. The per-id fetch below remains only as a
 * fallback for ids the server could not resolve.
 */
function hydrateCitations(ids) {
  const served = store.detail && Array.isArray(store.detail.citations) ? store.detail.citations : [];
  for (const rec of served) {
    if (rec && rec.id) store.citations[rec.id] = { state: 'ok', failure: rec };
  }

  for (const id of ids) {
    if (store.citations[id]) continue;
    store.citations[id] = { state: 'loading' };
    api.failure(id).then(
      (data) => {
        const rec = data && data.failure ? data.failure : data;
        store.citations[id] = rec && rec.id ? { state: 'ok', failure: rec } : { state: 'error' };
        renderDetail();
      },
      () => {
        store.citations[id] = { state: 'error' };
        renderDetail();
      },
    );
  }
  renderDetail();
}

function selectFailure(id) {
  if (!id) return;
  if (store.selectedId === id && store.detailState === 'ready') {
    setMobilePane('detail');
    return;
  }
  store.selectedId = id;
  store.detail = null;
  store.editingFix = false;
  store.drafts.note = '';
  store.drafts.editedFix = '';
  store.actionError = null;
  store.actionBusy = null;
  renderFeed();
  loadDetail(id, true);
  setMobilePane('detail');
}

/* -------------------------------------------------------------------- *
 * 11. Mutating actions
 * -------------------------------------------------------------------- */

async function submitApproval(id, approved, editedFix, busyKey) {
  store.actionBusy = busyKey;
  store.actionError = null;
  renderDetail(true);
  try {
    await api.approve(id, approved, editedFix);
    store.actionBusy = null;
    store.editingFix = false;
    store.drafts.editedFix = '';
    toast(approved ? 'Approved — workflow resumed.' : 'Rejected — workflow resumed without posting.', approved ? 'ok' : 'info');
    await Promise.all([loadDetail(id, false), refreshFailures(false), refreshStats(false)]);
  } catch (err) {
    store.actionBusy = null;
    store.actionError = err;
    toast('Approval failed.', 'error');
    renderDetail(true);
  }
}

async function submitResolve(id) {
  const note = store.drafts.note.trim();
  if (!note) {
    store.actionError = new ApiError('A resolution note is required', 'The note is what gets stored as memory for future triage.');
    renderDetail(true);
    return;
  }
  store.actionBusy = 'resolve';
  store.actionError = null;
  renderDetail(true);
  try {
    await api.resolve(id, note);
    store.actionBusy = null;
    store.drafts.note = '';
    toast('Resolved. Stored as memory for future triage.', 'ok');
    await Promise.all([loadDetail(id, false), refreshFailures(false), refreshStats(false)]);
  } catch (err) {
    store.actionBusy = null;
    store.actionError = err;
    toast('Could not resolve this failure.', 'error');
    renderDetail(true);
  }
}

/** POST a built-in sample build to /api/ingest — the demo entry point. */
async function replayDemoFailure() {
  if (store.replayBusy) return;
  const btn = document.getElementById('btn-replay');
  store.replayBusy = true;
  btn.disabled = true;

  const template = DEMO_FAILURES[demoCursor % DEMO_FAILURES.length];
  demoCursor++;

  const payload = Object.assign({}, template, {
    pipelineId: template.pipelineId + '-' + Date.now().toString(36).slice(-5),
    occurredAt: Date.now(),
  });

  try {
    const res = await api.ingest(payload);
    const reason = res && res.reason ? res.reason : 'new';
    const label = reason === 'new' ? 'Ingested' : reason === 'in_flight' ? 'Deduped (already triaging)' : 'Deduped (recently triaged)';
    toast(label + ' — ' + payload.repo, reason === 'new' ? 'ok' : 'info');

    if (payload.repo !== store.repo) {
      if (!store.repos.includes(payload.repo)) {
        store.repos = [...new Set([...store.repos, payload.repo])].sort();
      }
      store.repo = payload.repo;
      renderRepoSelect();
      await onRepoChanged();
    } else {
      await Promise.all([refreshFailures(false), refreshStats(false)]);
    }

    if (res && res.failureId) selectFailure(res.failureId);
    setMobilePane('detail');
  } catch (err) {
    store.feedError = err;
    store.feedState = 'error';
    renderFeed(true);
    toast('Ingest failed — see the feed for details.', 'error');
  } finally {
    store.replayBusy = false;
    btn.disabled = false;
  }
}

/* -------------------------------------------------------------------- *
 * 12. Repo switching, polling, wiring
 * -------------------------------------------------------------------- */

async function onRepoChanged() {
  store.selectedId = null;
  store.detail = null;
  store.detailState = 'empty';
  store.detailError = null;
  store.citations = Object.create(null);
  store.editingFix = false;
  store.drafts.note = '';
  store.drafts.editedFix = '';
  store.actionError = null;

  if (chatAbort) { chatAbort.abort(); chatAbort = null; }
  store.chat = [];
  store.chatBusy = false;
  setChatError(null);

  store.feedState = 'loading';
  store.statsState = 'loading';
  renderAll(true);

  await Promise.all([refreshFailures(false), refreshStats(false)]);
}

function renderAll(force) {
  renderSyncState();
  renderRepoSelect();
  renderFeed(force);
  renderDetail(force);
  renderStats(force);
  renderChat(force);
}

/** Poll every 5s. Skipped while the tab is hidden; renders only on change. */
function startPolling() {
  setInterval(async () => {
    if (document.hidden) return;
    await refreshFailures(false);
    await refreshStats(false);
    if (store.selectedId && store.detailState !== 'loading') await loadDetail(store.selectedId, false);
  }, POLL_MS);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshFailures(false);
      refreshStats(false);
      if (store.selectedId) loadDetail(store.selectedId, false);
    }
  });
}

function setMobilePane(pane) {
  const app = document.getElementById('app');
  if (app.dataset.mobilePane === pane) return;
  app.dataset.mobilePane = pane;
  for (const tab of document.querySelectorAll('.pane-tab')) {
    tab.classList.toggle('is-active', tab.dataset.pane === pane);
  }
  if (window.matchMedia('(max-width: 900px)').matches) window.scrollTo({ top: 0 });
}

function wireChrome() {
  document.getElementById('repo-select').addEventListener('change', (e) => {
    store.repo = e.target.value;
    onRepoChanged();
  });

  document.getElementById('btn-refresh').addEventListener('click', () => {
    refreshHealth();
    refreshRepos();
    refreshFailures(true);
    refreshStats(true);
    if (store.selectedId) loadDetail(store.selectedId, true);
  });

  document.getElementById('btn-replay').addEventListener('click', replayDemoFailure);

  for (const tab of document.querySelectorAll('.pane-tab')) {
    tab.addEventListener('click', () => setMobilePane(tab.dataset.pane));
  }
}

function wireChat() {
  const chips = document.getElementById('chat-chips');
  for (const question of SUGGESTED_QUESTIONS) {
    chips.appendChild(el('button', {
      class: 'chip', type: 'button',
      // No busy guard: asking a new question aborts the in-flight stream.
      on: { click: () => sendChat(question) },
    }, question));
  }

  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    autoGrow(input);
    sendChat(text);
  });

  input.addEventListener('input', () => autoGrow(input));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
}

function autoGrow(node) {
  node.style.height = 'auto';
  node.style.height = Math.min(node.scrollHeight, 132) + 'px';
}

/* -------------------------------------------------------------------- *
 * 13. Boot
 * -------------------------------------------------------------------- */

async function init() {
  wireChrome();
  wireChat();
  renderAll(true);

  refreshHealth();
  await refreshRepos();
  await Promise.all([refreshFailures(false), refreshStats(false)]);

  // Auto-select whatever most needs a human, else the newest failure.
  if (!store.selectedId && store.failures.length) {
    const awaiting = store.failures.find((f) => f.status === 'awaiting_approval');
    selectFailure((awaiting || store.failures[0]).id);
    setMobilePane('feed'); // don't yank small screens away from the feed on load
  }

  startPolling();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
