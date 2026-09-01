-- Pipeline Sentinel — long-term memory.
-- Every triaged failure is stored here WITH its embedding, so the system's
-- retrieval quality improves as the corpus grows. This is the "memory" component.

DROP TABLE IF EXISTS failures;
CREATE TABLE failures (
  id               TEXT PRIMARY KEY,
  repo             TEXT    NOT NULL,
  branch           TEXT    NOT NULL DEFAULT '',
  provider         TEXT    NOT NULL,
  pipeline_id      TEXT    NOT NULL DEFAULT '',
  job_name         TEXT    NOT NULL DEFAULT '',
  run_url          TEXT,
  commit_sha       TEXT,

  signature_hash   TEXT    NOT NULL,
  signature_text   TEXT    NOT NULL,
  category         TEXT    NOT NULL DEFAULT 'unknown',
  file_hint        TEXT,
  excerpt          TEXT    NOT NULL DEFAULT '',

  -- 384 float32 values, little-endian = 1536 bytes. Cosine search happens in
  -- the Worker; Vectorize is paid-plan only, and at this corpus size a linear
  -- scan over pre-normalised vectors is well inside the 10ms CPU budget.
  embedding        BLOB    NOT NULL,

  -- The PARSER's confidence in the fingerprint (0-1). Distinct from
  -- `confidence` below, which is the MODEL's confidence in its diagnosis.
  -- A low value here means the signature was a fallback, so both dedupe and
  -- retrieval against this row should be treated with suspicion.
  signature_confidence REAL NOT NULL DEFAULT 0,

  status           TEXT    NOT NULL DEFAULT 'open',
  root_cause       TEXT,
  suggested_fix    TEXT,
  confidence       REAL,
  -- One-line summary suitable for a PR comment title.
  headline         TEXT,
  -- 1 when the model judged this an infra flake rather than a real defect.
  is_likely_flake  INTEGER NOT NULL DEFAULT 0,
  -- JSON array of prior failure ids the model actually leaned on. This is the
  -- audit trail for the memory feature: it is what lets the UI show that an
  -- answer was recalled from a confirmed precedent rather than invented.
  cited_failure_ids TEXT   NOT NULL DEFAULT '[]',
  resolution_note  TEXT,
  resolved_at      INTEGER,

  occurrence_count INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL
);

CREATE INDEX idx_failures_repo_seen   ON failures (repo, last_seen_at DESC);
CREATE INDEX idx_failures_sig         ON failures (repo, signature_hash);
CREATE INDEX idx_failures_status      ON failures (repo, status);
CREATE INDEX idx_failures_resolved    ON failures (repo, status, resolved_at DESC);

-- Audit trail of workflow executions, so the UI can show what the agent did
-- and how long each step took. Also proves the retry behaviour in the demo.
DROP TABLE IF EXISTS triage_runs;
CREATE TABLE triage_runs (
  id            TEXT PRIMARY KEY,
  failure_id    TEXT NOT NULL,
  workflow_id   TEXT NOT NULL,
  step          TEXT NOT NULL,
  status        TEXT NOT NULL,          -- started | ok | error
  detail        TEXT,
  duration_ms   INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_runs_failure ON triage_runs (failure_id, created_at);
