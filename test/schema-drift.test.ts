import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { FAILURE_SELECT_COLUMNS } from '../src/lib/d1';

/**
 * `FAILURE_COLUMNS` in d1.ts is a hand-maintained SQL string, while `FailureRow`
 * is a TypeScript interface describing what we *claim* that query returns.
 * Nothing type-checks the two against each other or against schema.sql, so a
 * column added to the table but forgotten in the SELECT compiles cleanly and
 * then reads back as `undefined` at runtime.
 *
 * That is not hypothetical: adding signature_confidence, headline,
 * is_likely_flake and cited_failure_ids silently dropped all four from every
 * read path, and only a live request surfaced it.
 */
describe('schema drift', () => {
  const schema = readFileSync(resolve(__dirname, '../schema.sql'), 'utf8');

  /** Column names declared on the `failures` table, in declaration order. */
  const schemaColumns = (() => {
    const body = schema.slice(
      schema.indexOf('CREATE TABLE failures ('),
      schema.indexOf('CREATE INDEX idx_failures_repo_seen'),
    );
    return body
      .split('\n')
      .map((line) => line.replace(/--.*$/, '').trim())
      .filter((line) => /^[a-z_]+\s+(TEXT|INTEGER|REAL|BLOB)/.test(line))
      .map((line) => line.split(/\s+/)[0]!);
  })();

  const selectedColumns = FAILURE_SELECT_COLUMNS.split(',')
    .map((c) => c.trim())
    .filter(Boolean);

  it('parses a plausible set of columns from schema.sql', () => {
    expect(schemaColumns.length).toBeGreaterThan(20);
    expect(schemaColumns).toContain('id');
    expect(schemaColumns).toContain('embedding');
  });

  it('selects every failures column except the embedding blob', () => {
    // `embedding` is excluded deliberately: 1.5KB of binary that no reader needs.
    const expected = schemaColumns.filter((c) => c !== 'embedding');
    expect([...selectedColumns].sort()).toEqual([...expected].sort());
  });

  it('selects no column that does not exist on the table', () => {
    for (const col of selectedColumns) {
      expect(schemaColumns, `SELECT names unknown column "${col}"`).toContain(col);
    }
  });
});
