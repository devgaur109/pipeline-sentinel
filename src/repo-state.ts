/**
 * `RepoState` — one Durable Object instance per repository
 * (`env.REPO_STATE.idFromName(repo)`).
 *
 * A repo's DO is a single-threaded, strongly-consistent coordination point. It
 * owns three things that D1 is the wrong tool for:
 *
 *  1. DEDUPE. A matrix build fails on ten runners at once for one reason. Ten
 *     webhooks arrive within milliseconds. D1 is eventually consistent across
 *     replicas and has no compare-and-set, so "check then insert" races there.
 *     Inside the DO the check and the claim happen in one turn of one isolate,
 *     so exactly one of the ten wins and the other nine are told to stand down.
 *  2. CHAT SESSION MEMORY. Conversational context that belongs to a repo, read
 *     and written on every message. Keeping it colocated with the DO avoids a
 *     D1 round trip per turn.
 *  3. LIVE COUNTERS. Cheap running totals for the dashboard header.
 *
 * Storage is the DO's own SQLite (`new_sqlite_classes: ["RepoState"]` in
 * wrangler.jsonc). The surface is RPC methods, not a fetch handler — callers
 * do `stub.claimTriage(...)` and get a typed value back.
 */

import { DurableObject } from 'cloudflare:workers';
import type { ChatMessage, DedupeVerdict, Env } from './types';

/* ------------------------------------------------------------------ *
 * Policy constants
 * ------------------------------------------------------------------ */

/**
 * A claim still in flight after this long is presumed dead — the workflow
 * crashed, or the whole instance was evicted mid-run. The alarm reaps it so a
 * single lost workflow can't wedge a signature forever.
 */
const STALE_CLAIM_MS = 10 * 60 * 1000; // 10 minutes

/**
 * After a triage completes, suppress re-triage of the same signature for this
 * long. The build is still broken; re-running Llama 3.3 every 90 seconds while
 * someone pushes fix attempts is pure neuron burn for an identical answer.
 */
const RECENT_TRIAGE_MS = 15 * 60 * 1000; // 15 minutes

/** Completed claims older than this are pruned so the DO stays small. */
const CLAIM_RETENTION_MS = 24 * 60 * 60 * 1000; // 1 day

/** How often the reaper runs while there is anything to reap. */
const ALARM_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

/** Hard cap on retained chat history. Bounded storage, bounded prompt cost. */
const MAX_HISTORY = 50;

/** Chat messages are trimmed to this before storage. */
const MAX_MESSAGE_CHARS = 8000;

/* ------------------------------------------------------------------ *
 * RPC value types
 * ------------------------------------------------------------------ */

/** Cheap running totals — answerable without touching D1. */
export interface RepoCounters {
  repo: string;
  /** Failures ingested since this DO was created. */
  totalFailures: number;
  /** Failures marked resolved since this DO was created. */
  totalResolved: number;
  /** Signatures currently being triaged. */
  inFlight: number;
  /** Epoch ms of the most recent `noteFailure()`, or null. */
  lastFailureAt: number | null;
}

/**
 * Shapes of the DO's own SQLite rows.
 *
 * Declared as `type`, not `interface`: `SqlStorage.exec<T>()` constrains T to
 * `Record<string, SqlStorageValue>`, and only type aliases get TypeScript's
 * implicit index signature. An interface would fail the constraint.
 */
type ClaimRow = {
  signature_hash: string;
  failure_id: string;
  claimed_at: number;
  completed_at: number | null;
};

type MessageRow = {
  role: string;
  content: string;
  created_at: number;
};

export class RepoState extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Schema creation must finish before any RPC method observes the storage,
    // hence blockConcurrencyWhile: incoming calls queue behind it.
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS claims (
          signature_hash TEXT PRIMARY KEY,
          failure_id     TEXT NOT NULL,
          claimed_at     INTEGER NOT NULL,
          completed_at   INTEGER
        );
      `);
      ctx.storage.sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_claims_claimed ON claims (claimed_at);
      `);
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          role       TEXT NOT NULL,
          content    TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS counters (
          key   TEXT PRIMARY KEY,
          value INTEGER NOT NULL
        );
      `);
    });
  }

  /* ---------------------------------------------------------------- *
   * Dedupe
   * ---------------------------------------------------------------- */

  /**
   * Try to become the one caller that triages `signatureHash`.
   *
   * Returns `{shouldTriage: true, reason: 'new'}` to exactly one caller per
   * (signature, window). Everyone else is told why they lost:
   *   - `in_flight`       — someone is triaging it right now.
   *   - `recently_triaged`— it was answered within RECENT_TRIAGE_MS.
   *
   * A claim that has been in flight longer than STALE_CLAIM_MS is treated as
   * abandoned and taken over here as well as by `alarm()`; the inline check
   * means recovery doesn't have to wait for the next alarm tick.
   */
  async claimTriage(signatureHash: string, failureId: string): Promise<DedupeVerdict> {
    const now = Date.now();
    const existing = this.readClaim(signatureHash);

    if (existing) {
      if (existing.completed_at === null) {
        const age = now - existing.claimed_at;
        if (age < STALE_CLAIM_MS) {
          return {
            shouldTriage: false,
            reason: 'in_flight',
            existingFailureId: existing.failure_id,
          };
        }
        // Presumed dead: the previous holder never released. Take it over.
      } else if (now - existing.completed_at < RECENT_TRIAGE_MS) {
        return {
          shouldTriage: false,
          reason: 'recently_triaged',
          existingFailureId: existing.failure_id,
        };
      }
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO claims (signature_hash, failure_id, claimed_at, completed_at)
       VALUES (?, ?, ?, NULL)
       ON CONFLICT(signature_hash) DO UPDATE SET
         failure_id   = excluded.failure_id,
         claimed_at   = excluded.claimed_at,
         completed_at = NULL`,
      signatureHash,
      failureId,
      now,
    );

    await this.ensureAlarm(now + ALARM_INTERVAL_MS);
    return { shouldTriage: true, reason: 'new' };
  }

  /**
   * Release a claim taken by `claimTriage`. Idempotent, and safe to call on the
   * unhappy path — the workflow calls it from its equivalent of a `finally`.
   *
   * The row is not deleted: its `completed_at` is what powers the
   * `recently_triaged` suppression window. `alarm()` prunes it later.
   *
   * Guarded on `failure_id` so a workflow that lost its claim to the stale
   * reaper (and whose signature has since been re-claimed by a live workflow)
   * cannot complete somebody else's claim on its way out.
   */
  async releaseTriage(signatureHash: string, failureId: string): Promise<boolean> {
    const now = Date.now();
    const existing = this.readClaim(signatureHash);
    if (!existing || existing.failure_id !== failureId) return false;

    this.ctx.storage.sql.exec(
      `UPDATE claims SET completed_at = ? WHERE signature_hash = ? AND failure_id = ?`,
      now,
      signatureHash,
      failureId,
    );
    return true;
  }

  /** Inspect a claim without mutating it. Useful for the debug endpoint. */
  async peekClaim(
    signatureHash: string,
  ): Promise<{ failureId: string; claimedAt: number; completedAt: number | null } | null> {
    const row = this.readClaim(signatureHash);
    if (!row) return null;
    return {
      failureId: row.failure_id,
      claimedAt: row.claimed_at,
      completedAt: row.completed_at,
    };
  }

  /** Drop a claim outright, so the next webhook re-triages immediately. */
  async forgetClaim(signatureHash: string): Promise<void> {
    this.ctx.storage.sql.exec(`DELETE FROM claims WHERE signature_hash = ?`, signatureHash);
  }

  /* ---------------------------------------------------------------- *
   * Chat session memory
   * ---------------------------------------------------------------- */

  /** Append one turn, then trim to the newest MAX_HISTORY messages. */
  async appendMessage(msg: ChatMessage): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO messages (role, content, created_at) VALUES (?, ?, ?)`,
      msg.role,
      msg.content.slice(0, MAX_MESSAGE_CHARS),
      msg.createdAt || Date.now(),
    );

    // Bounded storage: keep only the newest MAX_HISTORY rows. AUTOINCREMENT ids
    // are monotonic, so "newest" is just the largest ids.
    this.ctx.storage.sql.exec(
      `DELETE FROM messages
        WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT ?)`,
      MAX_HISTORY,
    );
  }

  /**
   * The newest `limit` messages, returned OLDEST FIRST so the caller can drop
   * them straight into an LLM message array without re-sorting.
   */
  async getHistory(limit: number = MAX_HISTORY): Promise<ChatMessage[]> {
    const capped = Math.max(1, Math.min(Math.trunc(limit) || MAX_HISTORY, MAX_HISTORY));
    const rows = this.ctx.storage.sql
      .exec<MessageRow>(
        `SELECT role, content, created_at
           FROM messages
          ORDER BY id DESC
          LIMIT ?`,
        capped,
      )
      .toArray();

    return rows
      .map((row) => ({
        role: row.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        content: row.content,
        createdAt: row.created_at,
      }))
      .reverse();
  }

  async clearHistory(): Promise<void> {
    this.ctx.storage.sql.exec(`DELETE FROM messages`);
  }

  /* ---------------------------------------------------------------- *
   * Live counters
   * ---------------------------------------------------------------- */

  async noteFailure(): Promise<void> {
    const now = Date.now();
    this.increment('total_failures', 1);
    this.setCounter('last_failure_at', now);
  }

  async noteResolved(): Promise<void> {
    this.increment('total_resolved', 1);
  }

  async getCounters(): Promise<RepoCounters> {
    const inFlight = this.ctx.storage.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM claims WHERE completed_at IS NULL AND claimed_at >= ?`,
        Date.now() - STALE_CLAIM_MS,
      )
      .one().n;

    const lastFailureAt = this.readCounter('last_failure_at');

    return {
      repo: this.repoName(),
      totalFailures: this.readCounter('total_failures') ?? 0,
      totalResolved: this.readCounter('total_resolved') ?? 0,
      inFlight,
      lastFailureAt,
    };
  }

  /* ---------------------------------------------------------------- *
   * Alarm — the anti-wedge reaper
   * ---------------------------------------------------------------- */

  /**
   * Runs every ALARM_INTERVAL_MS while there is state worth reaping.
   *
   * Deletes (rather than completes) in-flight claims older than
   * STALE_CLAIM_MS. Deleting is deliberate: a dead workflow produced no answer,
   * so the next identical failure should trigger a real triage immediately
   * instead of being told `recently_triaged` for 15 minutes.
   *
   * Also prunes completed claims past their retention window, then reschedules
   * itself only if anything is left. An idle repo's DO costs nothing.
   */
  async alarm(): Promise<void> {
    const now = Date.now();

    this.ctx.storage.sql.exec(
      `DELETE FROM claims WHERE completed_at IS NULL AND claimed_at < ?`,
      now - STALE_CLAIM_MS,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM claims WHERE completed_at IS NOT NULL AND completed_at < ?`,
      now - CLAIM_RETENTION_MS,
    );

    const remaining = this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM claims`)
      .one().n;

    if (remaining > 0) {
      await this.ctx.storage.setAlarm(now + ALARM_INTERVAL_MS);
    }
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  private readClaim(signatureHash: string): ClaimRow | null {
    const rows = this.ctx.storage.sql
      .exec<ClaimRow>(
        `SELECT signature_hash, failure_id, claimed_at, completed_at
           FROM claims WHERE signature_hash = ?`,
        signatureHash,
      )
      .toArray();
    return rows.length > 0 ? rows[0] : null;
  }

  /** Set an alarm only when there isn't an earlier one already pending. */
  private async ensureAlarm(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) {
      await this.ctx.storage.setAlarm(at);
    }
  }

  private increment(key: string, by: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO counters (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = value + excluded.value`,
      key,
      by,
    );
  }

  private setCounter(key: string, value: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO counters (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  private readCounter(key: string): number | null {
    const rows = this.ctx.storage.sql
      .exec<{ value: number }>(`SELECT value FROM counters WHERE key = ?`, key)
      .toArray();
    return rows.length > 0 ? rows[0].value : null;
  }

  /**
   * The repo this instance represents. Stubs are created with
   * `idFromName(repo)`, and a name-derived id exposes it — but only for ids
   * created that way, so fall back to the hex id rather than throwing.
   */
  private repoName(): string {
    return this.ctx.id.name ?? this.ctx.id.toString();
  }
}
