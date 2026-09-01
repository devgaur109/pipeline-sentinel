-- NOTE: every INSERT names its columns explicitly. Positional inserts break
-- silently whenever a column is added to the schema, which is exactly what
-- happened when headline/is_likely_flake/cited_failure_ids were introduced.
-- Pipeline Sentinel — demo corpus.
--
-- Fourteen historical failures across three repos, seeded so the system has a
-- memory before its first live webhook. The mix is deliberate:
--
--   * RESOLVED rows carry a real root_cause + suggested_fix. These are what
--     `searchSimilar()` preferentially retrieves — a resolved failure is the
--     only kind that can teach the model anything.
--   * OPEN rows sharing a signature_hash with a resolved one are the
--     "this happened again" case, and prove the dedupe + retrieval story.
--   * Three signature_hash values are each spread across two rows with high
--     occurrence_count, so getRepoStats()'s topFlakes (SUM(occurrence_count)
--     >= 3) returns something worth looking at for "what's flaky this week?".
--
-- EMBEDDINGS ARE PLACEHOLDERS. `zeroblob(1536)` is 384 little-endian float32
-- zeros — the correct WIDTH (EMBEDDING_DIMS * 4) so d1.ts accepts the row, but
-- not a real vector. A zero vector scores 0 against everything and is filtered
-- out by SIMILARITY_THRESHOLD, so these rows are inert for retrieval until the
-- re-embed backfill runs them through bge-small-en-v1.5 and UPDATEs the blob.
-- Until then they still power the stats, dedupe and dashboard queries.
--
-- Timestamps are relative to seed time (unixepoch() is seconds; the schema
-- stores epoch MILLIseconds) so the "last 7 days" window is always populated.
--
-- Usage: npm run seed:local   (wrangler d1 execute ... --file=./fixtures/seed.sql)

DELETE FROM triage_runs WHERE failure_id LIKE 'seed-%';
DELETE FROM failures    WHERE id LIKE 'seed-%';

/* ==================================================================== *
 * acme/web-app  —  GitHub Actions
 * ==================================================================== */

-- FLAKE #1 (resolved half). Race between the Stripe mock and the click.
INSERT INTO failures (
  id, repo, branch, provider, pipeline_id, job_name, run_url, commit_sha,
  signature_hash, signature_text, category, file_hint, excerpt, embedding,
  status, root_cause, suggested_fix, confidence, resolution_note, resolved_at,
  occurrence_count, created_at, last_seen_at
) VALUES (
  'seed-wa-001', 'acme/web-app', 'main', 'github', '17840021', 'e2e (chromium)',
  'https://github.com/acme/web-app/actions/runs/17840021', '9f1c4ad',
  'c3a91e77b4d05f2681ac0e4b7d9f1236',
  'Timeout 30000ms exceeded waiting for selector [data-test=checkout-submit] in checkout.spec.ts',
  'test_failure', 'e2e/checkout.spec.ts',
  '  1) checkout.spec.ts:42:3 › completes a card payment' || char(10) ||
  '     TimeoutError: locator.click: Timeout 30000ms exceeded.' || char(10) ||
  '     waiting for locator(''[data-test=checkout-submit]'')' || char(10) ||
  '     - locator resolved to hidden <button disabled>',
  zeroblob(1536),
  'resolved',
  'The checkout button stays disabled until the Stripe mock server answers /v1/payment_intents. In CI the mock boots ~4s after the test runner, so the first spec in the file races it. Not a product defect — a fixture ordering bug.',
  'Await the mock''s readiness probe in the global setup instead of a fixed sleep: add `await waitForPort(12111, { timeout: 20000 })` to e2e/global-setup.ts before returning, and drop the `await page.waitForTimeout(2000)` in checkout.spec.ts:38.',
  0.91,
  'Fixed in #4127. Green for 40 consecutive runs since.',
  unixepoch() * 1000 - 86400000 * 3,
  9,
  unixepoch() * 1000 - 86400000 * 26,
  unixepoch() * 1000 - 86400000 * 4
);

-- FLAKE #1 (open half). Same signature, resurfaced on a feature branch.
INSERT INTO failures (
  id, repo, branch, provider, pipeline_id, job_name, run_url, commit_sha,
  signature_hash, signature_text, category, file_hint, excerpt, embedding,
  status, root_cause, suggested_fix, confidence, resolution_note, resolved_at,
  occurrence_count, created_at, last_seen_at
) VALUES (
  'seed-wa-002', 'acme/web-app', 'feat/payment-retries', 'github', '17902884', 'e2e (webkit)',
  'https://github.com/acme/web-app/actions/runs/17902884', '2b77e10',
  'c3a91e77b4d05f2681ac0e4b7d9f1236',
  'Timeout 30000ms exceeded waiting for selector [data-test=checkout-submit] in checkout.spec.ts',
  'test_failure', 'e2e/checkout.spec.ts',
  '  1) checkout.spec.ts:42:3 › completes a card payment' || char(10) ||
  '     TimeoutError: locator.click: Timeout 30000ms exceeded.' || char(10) ||
  '     waiting for locator(''[data-test=checkout-submit]'')',
  zeroblob(1536),
  'open', NULL, NULL, NULL, NULL, NULL,
  6,
  unixepoch() * 1000 - 86400000 * 5,
  unixepoch() * 1000 - 3600000 * 9
);

-- Jest heap exhaustion. Classic "worked locally, died on a 2-core runner".
INSERT INTO failures (
  id, repo, branch, provider, pipeline_id, job_name, run_url, commit_sha,
  signature_hash, signature_text, category, file_hint, excerpt, embedding,
  status, root_cause, suggested_fix, confidence, resolution_note, resolved_at,
  occurrence_count, created_at, last_seen_at
) VALUES (
  'seed-wa-003', 'acme/web-app', 'main', 'github', '17811902', 'unit',
  'https://github.com/acme/web-app/actions/runs/17811902', 'd40a8c1',
  '5e2b8daf01c94773ae6f1b0c8d33e957',
  'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory during jest run',
  'oom', 'jest.config.ts',
  '<--- Last few GCs --->' || char(10) ||
  '[1842:0x5e8f110]   214738 ms: Mark-sweep 2043.2 (2077.4) -> 2041.8 MB' || char(10) ||
  'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory' || char(10) ||
  ' 1: 0xb7a3e0 node::Abort() [node]',
  zeroblob(1536),
  'resolved',
  'jest was running with `maxWorkers` unset, so it spawned one worker per detected core and each worker inherited the default 2GB heap. The GitHub-hosted runner reports 4 cores but only has 7GB of RAM, so four workers plus the module registry exceeded it once the snapshot suite grew past ~900 files.',
  'Pin the worker count and cap the heap in CI: run jest with `--maxWorkers=2 --workerIdleMemoryLimit=1GB`, and set NODE_OPTIONS=--max-old-space-size=3072 in the workflow env. Longer term, split the snapshot suite into its own job.',
  0.88,
  'Fixed in #4098. Peak RSS now ~2.6GB.',
  unixepoch() * 1000 - 86400000 * 11,
  4,
  unixepoch() * 1000 - 86400000 * 19,
  unixepoch() * 1000 - 86400000 * 12
);

-- A genuine type error. One occurrence, fixed immediately — the boring case.
INSERT INTO failures (
  id, repo, branch, provider, pipeline_id, job_name, run_url, commit_sha,
  signature_hash, signature_text, category, file_hint, excerpt, embedding,
  status, root_cause, suggested_fix, confidence, resolution_note, resolved_at,
  occurrence_count, created_at, last_seen_at
) VALUES (
  'seed-wa-004', 'acme/web-app', 'main', 'github', '17795511', 'typecheck',
  'https://github.com/acme/web-app/actions/runs/17795511', '77ce0b3',
  'ab40c1d9e7f2568b03a4c7e1902d6f88',
  'TS2345 Argument of type string is not assignable to parameter of type CurrencyCode in src/checkout/total.ts',
  'compile_error', 'src/checkout/total.ts',
  'src/checkout/total.ts(64,29): error TS2345: Argument of type ''string'' is not assignable to parameter of type ''CurrencyCode''.' || char(10) ||
  '  Type ''string'' is not assignable to type ''"USD" | "EUR" | "GBP"''.',
  zeroblob(1536),
  'resolved',
  'PR #4102 widened the `currency` field on the cart DTO from the CurrencyCode union to plain `string` to accommodate an upstream API change, but did not add a narrowing guard at the boundary where it is handed to formatTotal().',
  'Validate at the edge rather than widening the type: add `assertCurrencyCode(cart.currency)` in src/checkout/parse-cart.ts before constructing the Cart, and revert the DTO field to CurrencyCode.',
  0.96,
  'Fixed in #4103.',
  unixepoch() * 1000 - 86400000 * 22,
  1,
  unixepoch() * 1000 - 86400000 * 23,
  unixepoch() * 1000 - 86400000 * 23
);

-- Still open, low value, exists to make the dashboard honest.
INSERT INTO failures (
  id, repo, branch, provider, pipeline_id, job_name, run_url, commit_sha,
  signature_hash, signature_text, category, file_hint, excerpt, embedding,
  status, root_cause, suggested_fix, confidence, resolution_note, resolved_at,
  occurrence_count, created_at, last_seen_at
) VALUES (
  'seed-wa-005', 'acme/web-app', 'chore/deps-bump', 'github', '17921033', 'lint',
  'https://github.com/acme/web-app/actions/runs/17921033', 'e1039fa',
  '1c7fd3e0a95b428d6ef0417ac2b95d31',
  'ESLint import/no-cycle reported a dependency cycle between src/store/cart.ts and src/store/pricing.ts',
  'lint_error', 'src/store/cart.ts',
  '/home/runner/work/web-app/src/store/cart.ts' || char(10) ||
  '  1:1  error  Dependency cycle via ./pricing:12 -> ./cart:3  import/no-cycle' || char(10) ||
  '2 problems (2 errors, 0 warnings)',
  zeroblob(1536),
  'open', NULL, NULL, NULL, NULL, NULL,
  2,
  unixepoch() * 1000 - 86400000 * 2,
  unixepoch() * 1000 - 3600000 * 30
);

/* ==================================================================== *
 * acme/api-gateway  —  Jenkins
 * ==================================================================== */

-- FLAKE #2 (resolved half). Expired registry token, the eternal classic.
INSERT INTO failures (
  id, repo, branch, provider, pipeline_id, job_name, run_url, commit_sha,
  signature_hash, signature_text, category, file_hint, excerpt, embedding,
  status, root_cause, suggested_fix, confidence, resolution_note, resolved_at,
  occurrence_count, created_at, last_seen_at
) VALUES (
  'seed-ag-001', 'acme/api-gateway', 'main', 'jenkins', 'build-2291', 'install',
  'https://jenkins.acme.internal/job/api-gateway/2291/', '5cc8d92',
  '9d61f0a4c8b3e7521f0d94ae6c1b78d0',
  'npm ERR! 403 Forbidden - GET https://registry.acme.internal/@acme%2fproto-types',
  'dependency_error', 'package-lock.json',
  'npm ERR! code E403' || char(10) ||
  'npm ERR! 403 403 Forbidden - GET https://registry.acme.internal/@acme%2fproto-types - Forbidden' || char(10) ||
  'npm ERR! 403 In most cases, you or one of your dependencies are requesting' || char(10) ||
  'npm ERR! 403 a package version that is forbidden by your security policy.',
  zeroblob(1536),
  'resolved',
  'The CI npm token for the internal registry is a 90-day Artifactory token and expired on the 12th. Every job that resolves @acme/* fails at install; nothing about the commit is wrong.',
  'Rotate NPM_TOKEN in the Jenkins credential store (id: acme-npm-ci) and re-run. To stop it recurring, switch the credential to a non-expiring service account or add a scheduled job that alerts 14 days before expiry — Artifactory exposes the expiry via /api/security/token.',
  0.94,
  'Token rotated 2 weeks ago; alerting added in INFRA-812.',
  unixepoch() * 1000 - 86400000 * 13,
  5,
  unixepoch() * 1000 - 86400000 * 15,
  unixepoch() * 1000 - 86400000 * 14
);

-- FLAKE #2 (open half). It recurred: the alert fired but nobody rotated.
INSERT INTO failures (
  id, repo, branch, provider, pipeline_id, job_name, run_url, commit_sha,
  signature_hash, signature_text, category, file_hint, excerpt, embedding,
  status, root_cause, suggested_fix, confidence, resolution_note, resolved_at,
  occurrence_count, created_at, last_seen_at
) VALUES (
  'seed-ag-002', 'acme/api-gateway', 'main', 'jenkins', 'build-2470', 'install',
  'https://jenkins.acme.internal/job/api-gateway/2470/', 'a0b34fe',
  '9d61f0a4c8b3e7521f0d94ae6c1b78d0',
  'npm ERR! 403 Forbidden - GET https://registry.acme.internal/@acme%2fproto-types',
  'dependency_error', 'package-lock.json',
  'npm ERR! code E403' || char(10) ||
  'npm ERR! 403 403 Forbidden - GET https://registry.acme.internal/@acme%2fproto-types - Forbidden',
  zeroblob(1536),
  'open', NULL, NULL, NULL, NULL, NULL,
  3,
  unixepoch() * 1000 - 86400000 * 1,
  unixepoch() * 1000 - 3600000 * 5
);

-- Service container race. High occurrence count, resolved.
INSERT INTO failures (
  id, repo, branch, provider, pipeline_id, job_name, run_url, commit_sha,
  signature_hash, signature_text, category, file_hint, excerpt, embedding,
  status, root_cause, suggested_fix, confidence, resolution_note, resolved_at,
  occurrence_count, created_at, last_seen_at
) VALUES (
  'seed-ag-003', 'acme/api-gateway', 'main', 'jenkins', 'build-2388', 'integration',
  'https://jenkins.acme.internal/job/api-gateway/2388/', 'bb27c04',
  '4f08ca19d7e6b2350c98af71e3d520bc',
  'psycopg2.OperationalError: connection to server at 127.0.0.1 port 5432 failed: Connection refused',
  'network_error', 'tests/conftest.py',
  'E   psycopg2.OperationalError: connection to server at "127.0.0.1", port 5432 failed:' || char(10) ||
  'E   Connection refused' || char(10) ||
  'E     Is the server running on that host and accepting TCP/IP connections?' || char(10) ||
  'tests/conftest.py:31: OperationalError',
  zeroblob(1536),
  'resolved',
  'The integration job starts the postgres:16 service container and the test process in the same stage. Postgres takes 3-6s to finish initdb on a cold volume, and conftest.py connects immediately, so roughly one run in five loses the race. Purely an infrastructure timing bug.',
  'Gate the test process on readiness rather than hope: add `until pg_isready -h 127.0.0.1 -p 5432; do sleep 1; done` (with a 60s ceiling) as a pre-step, or declare a healthcheck on the service container and depend on it. Do not add a bare sleep — it will rot.',
  0.93,
  'Healthcheck added in INFRA-799; no recurrence in 6 weeks.',
  unixepoch() * 1000 - 86400000 * 30,
  7,
  unixepoch() * 1000 - 86400000 * 44,
  unixepoch() * 1000 - 86400000 * 31
);

-- Open, unremarkable, one occurrence.
INSERT INTO failures (
  id, repo, branch, provider, pipeline_id, job_name, run_url, commit_sha,
  signature_hash, signature_text, category, file_hint, excerpt, embedding,
  status, root_cause, suggested_fix, confidence, resolution_note, resolved_at,
  occurrence_count, created_at, last_seen_at
) VALUES (
  'seed-ag-004', 'acme/api-gateway', 'feat/jwt-rotation', 'jenkins', 'build-2468', 'unit',
  'https://jenkins.acme.internal/job/api-gateway/2468/', 'cf5510b',
  '6b1e94dc3a07f582bd41e0c9a7f36e24',
  'AssertionError: expected token exp claim 3600 to equal 900 in test_jwt_rotation',
  'test_failure', 'tests/test_jwt_rotation.py',
  'FAILED tests/test_jwt_rotation.py::test_access_token_ttl' || char(10) ||
  'E   AssertionError: assert 3600 == 900' || char(10) ||
  'E    +  where 3600 = decode(token)[''exp''] - decode(token)[''iat'']',
  zeroblob(1536),
  'open', NULL, NULL, NULL, NULL, NULL,
  1,
  unixepoch() * 1000 - 3600000 * 20,
  unixepoch() * 1000 - 3600000 * 20
);

-- Registry auth on push. Resolved, moderate occurrence.
INSERT INTO failures (
  id, repo, branch, provider, pipeline_id, job_name, run_url, commit_sha,
  signature_hash, signature_text, category, file_hint, excerpt, embedding,
  status, root_cause, suggested_fix, confidence, resolution_note, resolved_at,
  occurrence_count, created_at, last_seen_at
) VALUES (
  'seed-ag-005', 'acme/api-gateway', 'main', 'jenkins', 'build-2301', 'docker-push',
  'https://jenkins.acme.internal/job/api-gateway/2301/', '31ffb7a',
  'e70c2b8514da96f3078b1cae4d95206f',
  'denied: requested access to the resource is denied while pushing acme/api-gateway to registry',
  'permission_error', 'Jenkinsfile',
  'The push refers to repository [registry.acme.internal/acme/api-gateway]' || char(10) ||
  'denied: requested access to the resource is denied' || char(10) ||
  'ERROR: script returned exit code 1',
  zeroblob(1536),
  'resolved',
  'The docker-push stage runs on the `arm-builders` agent label, which was added last month and never granted the `docker-registry-write` role. Builds that happened to schedule onto the older x86 agents succeeded, which is why it looked intermittent.',
  'Grant `docker-registry-write` to the arm-builders service account in the registry''s RBAC config, or pin the docker-push stage to `agent { label ''x86-builders'' }` as a stopgap. The intermittency is agent scheduling, not the registry.',
  0.89,
  'Role granted; verified on 3 arm builds.',
  unixepoch() * 1000 - 86400000 * 25,
  2,
  unixepoch() * 1000 - 86400000 * 28,
  unixepoch() * 1000 - 86400000 * 26
);

/* ==================================================================== *
 * acme/data-pipeline  —  GitLab CI
 * ==================================================================== */

-- FLAKE #3 (resolved half). The single worst offender in the corpus.
INSERT INTO failures (
  id, repo, branch, provider, pipeline_id, job_name, run_url, commit_sha,
  signature_hash, signature_text, category, file_hint, excerpt, embedding,
  status, root_cause, suggested_fix, confidence, resolution_note, resolved_at,
  occurrence_count, created_at, last_seen_at
) VALUES (
  'seed-dp-001', 'acme/data-pipeline', 'main', 'gitlab', '884102', 'spark-nightly',
  'https://gitlab.acme.dev/acme/data-pipeline/-/jobs/884102', '6ad0f13',
  '2fb7c9058ae641d3906ce2b8a7f04d19',
  'ERROR: Job failed: execution took longer than 1h0m0s seconds - runner lost connection during spark-submit',
  'infra_timeout', '.gitlab-ci.yml',
  'Running after_script' || char(10) ||
  'ERROR: Job failed: execution took longer than 1h0m0s seconds' || char(10) ||
  'WARNING: Failed to pull image with policy "always": context deadline exceeded' || char(10) ||
  '24/03/11 02:41:07 WARN TaskSetManager: Lost task 148.0 in stage 7.0',
  zeroblob(1536),
  'resolved',
  'The nightly job repartitions the events table to 2000 partitions before a broadcast join. Since the events volume crossed ~90GB the shuffle spills to disk on the 4-executor cluster and the stage takes 55-70 minutes, straddling the runner''s 1h timeout. It is not hanging — it is genuinely too slow, and the timeout merely reveals it.',
  'Two changes, in order: (1) raise `timeout` on the spark-nightly job to 2h so the signal stops being a timeout; (2) fix the actual cost — drop the explicit `.repartition(2000)` and enable AQE (`spark.sql.adaptive.enabled=true`, `spark.sql.adaptive.coalescePartitions.enabled=true`), which cut the stage to 18 minutes in staging.',
  0.87,
  'AQE enabled in !612; nightly now runs in ~22 min.',
  unixepoch() * 1000 - 86400000 * 8,
  11,
  unixepoch() * 1000 - 86400000 * 40,
  unixepoch() * 1000 - 86400000 * 9
);

-- FLAKE #3 (open half). Regressed after a data volume spike.
INSERT INTO failures (
  id, repo, branch, provider, pipeline_id, job_name, run_url, commit_sha,
  signature_hash, signature_text, category, file_hint, excerpt, embedding,
  status, root_cause, suggested_fix, confidence, resolution_note, resolved_at,
  occurrence_count, created_at, last_seen_at
) VALUES (
  'seed-dp-002', 'acme/data-pipeline', 'main', 'gitlab', '891677', 'spark-nightly',
  'https://gitlab.acme.dev/acme/data-pipeline/-/jobs/891677', '9c14e88',
  '2fb7c9058ae641d3906ce2b8a7f04d19',
  'ERROR: Job failed: execution took longer than 1h0m0s seconds - runner lost connection during spark-submit',
  'infra_timeout', '.gitlab-ci.yml',
  'ERROR: Job failed: execution took longer than 1h0m0s seconds' || char(10) ||
  '24/03/28 02:58:44 WARN TaskSetManager: Lost task 311.0 in stage 7.0',
  zeroblob(1536),
  'open', NULL, NULL, NULL, NULL, NULL,
  4,
  unixepoch() * 1000 - 86400000 * 4,
  unixepoch() * 1000 - 3600000 * 14
);

-- Schema drift. Resolved, single occurrence, a real defect.
INSERT INTO failures (
  id, repo, branch, provider, pipeline_id, job_name, run_url, commit_sha,
  signature_hash, signature_text, category, file_hint, excerpt, embedding,
  status, root_cause, suggested_fix, confidence, resolution_note, resolved_at,
  occurrence_count, created_at, last_seen_at
) VALUES (
  'seed-dp-003', 'acme/data-pipeline', 'main', 'gitlab', '879540', 'contract-tests',
  'https://gitlab.acme.dev/acme/data-pipeline/-/jobs/879540', '4e88b02',
  'd51a03c6b8f27e409ac1d7350be9126f',
  'AnalysisException: cannot resolve column user_tier given input columns from parquet schema',
  'test_failure', 'jobs/enrich_events.py',
  'pyspark.sql.utils.AnalysisException: cannot resolve ''user_tier'' given input columns:' || char(10) ||
  '[event_id, user_id, ts, payload, tier]' || char(10) ||
  '  at jobs/enrich_events.py:88 in build_enriched_frame',
  zeroblob(1536),
  'resolved',
  'The upstream identity service renamed `user_tier` to `tier` in its parquet export two days before this run, without a deprecation window. The enrichment job reads the column positionally-by-name and had no schema contract to fail loudly against at ingest time.',
  'Short term: accept both names in build_enriched_frame via `F.coalesce(F.col(''tier''), F.col(''user_tier''))`. Real fix: add the identity export to the schema registry and run the contract-tests job against it at ingest, so a rename fails at the boundary with a clear message instead of 80 lines into the job.',
  0.92,
  'Coalesce shipped in !598; schema contract tracked in DATA-341.',
  unixepoch() * 1000 - 86400000 * 17,
  1,
  unixepoch() * 1000 - 86400000 * 18,
  unixepoch() * 1000 - 86400000 * 18
);

-- Open dependency resolution failure, recurring enough to reach the flake list.
INSERT INTO failures (
  id, repo, branch, provider, pipeline_id, job_name, run_url, commit_sha,
  signature_hash, signature_text, category, file_hint, excerpt, embedding,
  status, root_cause, suggested_fix, confidence, resolution_note, resolved_at,
  occurrence_count, created_at, last_seen_at
) VALUES (
  'seed-dp-004', 'acme/data-pipeline', 'main', 'gitlab', '892014', 'build-image',
  'https://gitlab.acme.dev/acme/data-pipeline/-/jobs/892014', 'b7710cd',
  '83c4e0f1972ad6b508fe3c19d0a4726b',
  'ERROR: ResolutionImpossible - pyarrow 15.0.0 conflicts with pandas 2.2.1 requirement pyarrow<15',
  'dependency_error', 'requirements.txt',
  'ERROR: Cannot install -r requirements.txt (line 12) and pyarrow==15.0.0 because these have conflicting dependencies.' || char(10) ||
  'The conflict is caused by:' || char(10) ||
  '    The user requested pyarrow==15.0.0' || char(10) ||
  '    pandas 2.2.1 depends on pyarrow<15.0.0 and >=10.0.1',
  zeroblob(1536),
  'open', NULL, NULL, NULL, NULL, NULL,
  3,
  unixepoch() * 1000 - 86400000 * 6,
  unixepoch() * 1000 - 3600000 * 2
);

/* ==================================================================== *
 * A worked audit trail for one failure, so the run-detail view in the UI
 * has something to render before the first live triage.
 * ==================================================================== */

INSERT INTO triage_runs VALUES ('seed-run-01', 'seed-dp-001', 'seed-wf-dp-001', 'parse-log',       'ok',      'infra_timeout · 2fb7c9058ae641d3906ce2b8a7f04d19 · conf 0.84',  38, unixepoch() * 1000 - 86400000 * 9);
INSERT INTO triage_runs VALUES ('seed-run-02', 'seed-dp-001', 'seed-wf-dp-001', 'dedupe-check',    'ok',      'new',                                                          61, unixepoch() * 1000 - 86400000 * 9 + 100);
INSERT INTO triage_runs VALUES ('seed-run-03', 'seed-dp-001', 'seed-wf-dp-001', 'embed-signature', 'error',   'Error: AiError: 429 Too Many Requests',                       412, unixepoch() * 1000 - 86400000 * 9 + 300);
INSERT INTO triage_runs VALUES ('seed-run-04', 'seed-dp-001', 'seed-wf-dp-001', 'embed-signature', 'ok',      '384 dims',                                                    355, unixepoch() * 1000 - 86400000 * 9 + 5800);
INSERT INTO triage_runs VALUES ('seed-run-05', 'seed-dp-001', 'seed-wf-dp-001', 'persist-failure', 'ok',      'stored seed-dp-001 (infra_timeout) status=open',                74, unixepoch() * 1000 - 86400000 * 9 + 6300);
INSERT INTO triage_runs VALUES ('seed-run-06', 'seed-dp-001', 'seed-wf-dp-001', 'search-memory',   'ok',      'seed-dp-002:0.913:open',                                       88, unixepoch() * 1000 - 86400000 * 9 + 6500);
INSERT INTO triage_runs VALUES ('seed-run-07', 'seed-dp-001', 'seed-wf-dp-001', 'analyse',         'ok',      'Nightly Spark job exceeds the 1h runner timeout · conf 0.87 · flake=false · cited 1', 9140, unixepoch() * 1000 - 86400000 * 9 + 7000);
INSERT INTO triage_runs VALUES ('seed-run-08', 'seed-dp-001', 'seed-wf-dp-001', 'persist-triage',  'ok',      'status=triaged',                                               52, unixepoch() * 1000 - 86400000 * 9 + 16500);
INSERT INTO triage_runs VALUES ('seed-run-09', 'seed-dp-001', 'seed-wf-dp-001', 'post-back',       'ok',      'no_credentials (would POST triage to https://gitlab.acme.dev/acme/data-pipeline/-/jobs/884102)', 3, unixepoch() * 1000 - 86400000 * 9 + 16700);
INSERT INTO triage_runs VALUES ('seed-run-10', 'seed-dp-001', 'seed-wf-dp-001', 'release-claim',   'ok',      'claim released',                                               44, unixepoch() * 1000 - 86400000 * 9 + 16800);

-- ---------------------------------------------------------------------------
-- Triage state for the demo.
--
-- The corpus above is built as resolved/open PAIRS that share a signature_hash:
-- an open failure whose already-resolved twin carries a human-confirmed fix.
-- That is the whole premise of the product, so two of those pairs are wired up
-- here to their finished state, and the rest are left untriaged so a live
-- webhook has somewhere to land.
--
--   seed-wa-002  triaged           , cites seed-wa-001  -> citation panel
--   seed-ag-002  awaiting_approval , cites seed-ag-001  -> approval controls
-- ---------------------------------------------------------------------------

-- Parser confidence: high for the rows whose signatures came from a real
-- detector, lower for the two that fell back to trailing-line extraction.
UPDATE failures SET signature_confidence = 1.0;
UPDATE failures SET signature_confidence = 0.35 WHERE id IN ('seed-dp-004', 'seed-wa-005');

UPDATE failures SET
  headline = 'Checkout e2e times out waiting on the Stripe mock',
  is_likely_flake = 1
WHERE id = 'seed-wa-001';

UPDATE failures SET
  headline = 'Internal npm registry rejects the expired CI token',
  is_likely_flake = 0
WHERE id = 'seed-ag-001';

-- Answered entirely from precedent: same signature as seed-wa-001, whose fix a
-- human already confirmed. No new reasoning was required.
UPDATE failures SET
  status            = 'triaged',
  headline          = 'Same Stripe mock race as the fix confirmed on 12 Aug',
  root_cause        = 'Identical signature to seed-wa-001, which was resolved by awaiting the Stripe mock''s readiness probe. The webkit shard still uses the fixed 3s sleep in its global setup, so it races the same way the chromium shard used to.',
  suggested_fix     = 'Apply the seed-wa-001 fix to the webkit project as well: replace the fixed sleep in e2e/global-setup.ts with `await waitForPort(12111, { timeout: 20000 })`. The chromium shard has not flaked since that change landed.',
  confidence        = 0.93,
  is_likely_flake   = 1,
  cited_failure_ids = '["seed-wa-001"]'
WHERE id = 'seed-wa-002';

-- Waiting on a human: the suggested fix rotates a production credential, which
-- is exactly the case the workflow's waitForEvent pause exists for.
UPDATE failures SET
  status            = 'awaiting_approval',
  headline          = 'CI npm token expired again — same 403 as 12 Aug',
  root_cause        = 'Byte-identical 403 to seed-ag-001. That incident was caused by the 90-day Artifactory token expiring; it was rotated but not switched to a non-expiring credential, so it has lapsed again on schedule.',
  suggested_fix     = 'Rotate NPM_TOKEN (credential id: acme-npm-ci) and, this time, replace it with the non-expiring service account recommended when seed-ag-001 was closed. Otherwise this recurs every 90 days.',
  confidence        = 0.88,
  is_likely_flake   = 0,
  cited_failure_ids = '["seed-ag-001"]'
WHERE id = 'seed-ag-002';
