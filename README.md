# Pipeline Sentinel

An AI agent that triages failed CI pipelines and gets better at it over time.

A build fails. A webhook fires. A durable workflow parses the log, fingerprints the
error, searches everything that has ever broken in this repo before, asks Llama 3.3
for a root cause grounded in those precedents, optionally waits for a human to sign
off, and posts the answer back. When an engineer marks the fix as correct, that
becomes memory — and the next occurrence of the same failure is answered from
experience rather than from scratch.

**Runs entirely on the Cloudflare Workers free plan.** No paid bindings anywhere.

---

## Assignment components

| Requirement | Implementation |
|---|---|
| **LLM** | Workers AI — `llama-3.3-70b-instruct-fp8-fast` for root-cause reasoning, `llama-3.1-8b-instruct` for cheap chat and summarisation, `bge-small-en-v1.5` for embeddings |
| **Workflow / coordination** | Cloudflare **Workflows** (`TriageWorkflow`, 10 retryable steps incl. a human-in-the-loop pause) + a **Durable Object** (`RepoState`) per repository for dedupe and session state |
| **User input** | Chat UI served as Workers static assets, streaming responses over SSE; webhook ingestion from GitHub Actions / Jenkins |
| **Memory / state** | **D1** stores every failure with its 384-dim embedding and, once known, its verified fix. Retrieval is cosine search over that corpus. **DO SQLite** holds per-repo conversation history and in-flight claims |

---

## Why the memory is load-bearing

This is the part worth pushing on in review. Most "AI + CI" demos pipe a log into an
LLM and print the answer — the model has no idea whether this exact failure was
solved last Tuesday.

Here, retrieval sits *between* the log and the model:

```
failed build → error signature → embedding → cosine search over past failures
                                                        ↓
                                       prior resolved failures + their fixes
                                                        ↓
                                      Llama 3.3 (grounded, cites failure IDs)
```

`searchSimilar()` deliberately prefers failures with status `resolved`, because those
carry a fix a human confirmed. The UI renders the cited prior failures next to the
answer, so you can see when the agent is recalling rather than guessing. Delete the
D1 corpus and the product still runs — it just gets measurably worse, which is the
definition of memory doing work.

## Why Workflows rather than a plain Worker

Three things in the triage path cannot live in a request handler:

1. **Retries across independent failure domains.** Workers AI rate-limiting, D1
   contention, and the callback POST fail in different ways and want different
   backoff. Each is its own `step.do` with its own retry policy.
2. **The human-in-the-loop pause.** `step.waitForEvent('approval', { timeout: '1 hour' })`
   suspends the run — no compute burning, state durably held — until an engineer
   clicks Approve in the UI, then resumes exactly where it stopped. A Worker has
   milliseconds; this waits an hour.
3. **Crash safety.** A build failure that triggered triage must not be silently lost
   because an eviction landed mid-run.

Step order encodes the same priority. `persist-failure` runs *before*
`embed-signature`, because embedding is a call to Workers AI — the dependency most
likely to be rate-limited exactly when an org's CI goes red all at once. Persisting
first means an AI outage costs the triage but never the record of the failure. The
row lands with an all-zero placeholder vector, which scores 0 against every query
and is therefore inert in search until the real embedding is written (or backfilled
later by `POST /api/admin/reembed`).

Dedupe deliberately lives *inside* the workflow (step 2) rather than in the request
handler, so `POST /api/ingest` acknowledges immediately and the durable, crash-safe
run decides whether the failure is a duplicate. The cost is that the ingest response
always reports `reason: "new"`; the benefit is that ingestion never blocks on a
Durable Object round trip and a webhook is never lost to a mid-request eviction.

The Durable Object handles what Workflows deliberately does not: **cross-instance
coordination**. A 12-way test matrix failing for one root cause fires 12 webhooks. All
12 workflows call `RepoState.claimTriage(signatureHash)`; exactly one wins and the
other 11 short-circuit. That's one LLM call instead of twelve — which on a 10,000
neuron/day budget is the difference between a working demo and an exhausted quota.

---

## Free-tier engineering

The interesting constraints, and what they forced:

| Constraint | Consequence |
|---|---|
| **Vectorize is Workers-Paid only** | Embeddings are stored as `float32` BLOBs in D1 and searched by cosine similarity in the Worker. Vectors are L2-normalised on write, so search is a plain dot product |
| **10ms CPU per invocation** | The similarity scan is bounded (`LIMIT` on candidates, single-pass top-K with no full sort). Log parsing works backwards from the end of the log and caps at ~2000 lines. Regexes are anchored to avoid backtracking |
| **10,000 neurons/day** | Model routing: 70B only for the final root-cause call, 8B for chat and summaries, and dedupe prevents duplicate spend. **Measured on this account:** a full triage costs 47-73 neurons, a chat answer ~0.4, an embedding backfill of 14 signatures ~1.3s and negligible spend. That is roughly 150 triages/day inside the free allowance |
| **KV allows 1,000 writes/day** | KV is not used at all. Session state lives in DO SQLite, corpus in D1 |
| **Workflows: 3,000 steps/day free** | 10 steps per triage → ~300 triages/day, comfortably above demo needs |

---

## Architecture

```
  GitHub Actions ─┐
  Jenkins ────────┼──▶ POST /api/ingest ──▶ TriageWorkflow (Workflows)
  Demo replay ────┘         │                      │
                            │                      ├─ 1  parse-log        (deterministic)
                            │                      ├─ 2  dedupe-check ────┼──▶ RepoState (DO)
                            │                      ├─ 3  persist-failure ─┼──▶ D1
                            │                      ├─ 4  embed-signature ─┼──▶ Workers AI (bge)
                            │                      ├─ 5  search-memory ───┼──▶ D1 + cosine
                            │                      ├─ 6  analyse ─────────┼──▶ Workers AI (Llama 3.3)
                            │                      ├─ 7  persist-triage
                            │                      ├─ 8  waitForEvent('approval')  ◀── human
                            │                      ├─ 9  post-back
                            ▼                      └─ 10 release-claim
                    Chat UI (static assets)
                            │
                            └──▶ POST /api/chat ──▶ RepoState history + D1 stats ──▶ Llama 3.1 8B (SSE)
```

## Layout

```
src/
  index.ts          Hono router, all HTTP routes, SSE chat
  workflow.ts       TriageWorkflow — the 10-step durable triage pipeline
  repo-state.ts     RepoState Durable Object — dedupe, claims, chat history
  types.ts          Frozen shared contract (bindings, domain types, model IDs)
  ai/
    embeddings.ts   bge-small wrapper
    llm.ts          Llama calls + defensive JSON extraction
    prompts.ts      All prompt text, in one place
  lib/
    log-parser.ts   CI log → stable error signature
    vector.ts       Pack/unpack, cosine, top-K
    d1.ts           All SQL; the retrieval core
    webhooks.ts     GitHub/Jenkins payload adapters + HMAC verification
public/             Chat UI (no build step)
fixtures/           Realistic sample failures + seed corpus
docs/                Architecture notes and CI integration guide
```

---

## Running it

```bash
npm install

# One-time: create the D1 database, then paste the printed ID into wrangler.jsonc
npx wrangler d1 create pipeline-sentinel-db

npm run db:local          # apply schema
npm run seed:local        # load the demo corpus
npm run dev               # http://localhost:8787

# In a second terminal, once dev is up: turn the seed corpus's placeholder
# vectors into real embeddings. Without this the seeded history is invisible
# to similarity search, and the memory feature will look broken.
npm run seed:embed
```

> The seed fixtures store `zeroblob` placeholders because SQL fixtures cannot call
> Workers AI. `POST /api/admin/reembed` backfills them in one batched bge call.

Deploy:

```bash
npm run db:remote
npx wrangler deploy
```

Send a failure:

```bash
curl -X POST http://localhost:8787/api/ingest \
  -H 'content-type: application/json' \
  -d @fixtures/gh-actions-jest-failure.json
```

Or click **Replay a demo failure** in the UI.

## Two things worth knowing before you change models

**Workers AI response shapes are not uniform.** `env.AI.run()` on
`llama-3.3-70b-instruct-fp8-fast` returns `response` as an already-parsed OBJECT when
the model emits valid JSON, alongside an OpenAI-style `choices[0].message.content`.
A `typeof response === 'string'` check yields `''` for every call. Worse, in the
streaming path a purely numeric token arrives as `{"response":300}` — a number — so
the same guard silently drops it. That corrupts output in the nastiest way available:
`30000ms` renders as `00ms` and a signature hash `[c3a91e77]` as `[cae]`, while the
surrounding sentence still reads perfectly. `src/ai/llm.ts` coerces both cases.

**Model IDs expire.** `@cf/meta/llama-3.1-8b-instruct` was deprecated on 2026-05-30
and now returns error 5028. `MODEL.FAST` is `@cf/meta/llama-3.1-8b-instruct-fast`,
verified live. If chat starts returning the "temporarily unavailable" fallback, check
for a deprecation before anything else.

## Tests

```bash
npm test
```

Covers signature stability (same bug, different timestamps and paths → same hash),
category detection, embedding round-trips, and top-K ranking.
