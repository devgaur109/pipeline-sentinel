import { describe, expect, it } from 'vitest';

import {
  MAX_EXCERPT_CHARS,
  MAX_TAIL_LINES,
  hashSignature,
  normaliseLine,
  parseFailure,
  tailLines,
} from '../src/lib/log-parser';
import type { ErrorCategory, IncomingFailure } from '../src/types';

import ghJest from '../fixtures/gh-actions-jest-failure.json';
import jenkinsMaven from '../fixtures/jenkins-maven-failure.json';
import ghOom from '../fixtures/gh-actions-oom.json';
import jenkinsFlaky from '../fixtures/jenkins-flaky-timeout.json';

/**
 * The fixtures are plain JSON, so TypeScript widens `provider` to `string`.
 * A double assertion (not `any`) re-attaches the contract type; the shape is
 * asserted for real in the "fixtures match IncomingFailure" test below.
 */
const asFailure = (json: unknown): IncomingFailure => json as unknown as IncomingFailure;

/** ANSI escape, built at runtime so no control character lives in this file. */
const ESC = String.fromCharCode(27);

const JEST = asFailure(ghJest);
const MAVEN = asFailure(jenkinsMaven);
const OOM = asFailure(ghOom);
const FLAKY = asFailure(jenkinsFlaky);
const ALL_FIXTURES = [JEST, MAVEN, OOM, FLAKY];

/** Simulate the same failure on a later run: new clock, runner, ids, timings. */
function rerun(log: string): string {
  return log
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z/g, '2027-11-30T22:41:09.5550001Z')
    .replace(/\/home\/runner\/work\/[\w.-]+\/([\w.-]+)/g, '/opt/actions/_layout/checkout/$1')
    .replace(/\/var\/lib\/jenkins\/workspace\/[\w.-]+/g, '/data/agent-11/ws/job')
    .replace(/\(\d+ ms\)/g, '(913 ms)')
    .replace(/\b\d+\.\d+ s\b/g, '41.007 s')
    .replace(/\b1347289\d+\b/g, '13999888777')
    .replace(/ci-agent-linux-\d+/g, 'ci-agent-linux-42');
}

/** A tail-only log: `MAX_TAIL_LINES` of filler that matches no rule. */
function filler(count: number, width = 12): string[] {
  return Array.from({ length: count }, (_, i) => `step ${i} ${'.'.repeat(width)}`);
}

describe('fixtures', () => {
  it('match the IncomingFailure shape', () => {
    for (const f of ALL_FIXTURES) {
      expect(['github', 'jenkins', 'gitlab', 'manual']).toContain(f.provider);
      expect(f.repo).toMatch(/\S/);
      expect(f.branch).toMatch(/\S/);
      expect(f.pipelineId).toMatch(/\S/);
      expect(f.jobName).toMatch(/\S/);
      expect(typeof f.logText).toBe('string');
      expect(f.logText.split('\n').length).toBeGreaterThanOrEqual(40);
      expect(typeof f.occurredAt).toBe('number');
    }
  });
});

describe('parseFailure — category detection', () => {
  const cases: Array<[string, IncomingFailure, ErrorCategory]> = [
    ['gh-actions-jest-failure', JEST, 'test_failure'],
    ['jenkins-maven-failure', MAVEN, 'compile_error'],
    ['gh-actions-oom', OOM, 'oom'],
    ['jenkins-flaky-timeout', FLAKY, 'infra_timeout'],
  ];

  for (const [name, fixture, expected] of cases) {
    it(`classifies ${name} as ${expected}`, async () => {
      const sig = await parseFailure(fixture.logText);
      expect(sig.category).toBe(expected);
      expect(sig.confidence).toBeGreaterThanOrEqual(0.8);
    });
  }

  it('gives the jest and flaky-timeout fixtures different categories and hashes', async () => {
    const a = await parseFailure(JEST.logText);
    const b = await parseFailure(FLAKY.logText);
    expect(a.category).toBe('test_failure');
    expect(b.category).toBe('infra_timeout');
    expect(a.hash).not.toBe(b.hash);
  });

  it('gives all four fixtures distinct hashes', async () => {
    const hashes = await Promise.all(ALL_FIXTURES.map((f) => parseFailure(f.logText).then((s) => s.hash)));
    expect(new Set(hashes).size).toBe(4);
  });
});

describe('parseFailure — category detection from inline log shapes', () => {
  const cases: Array<[ErrorCategory, string]> = [
    [
      'test_failure',
      [
        '=================================== FAILURES ===================================',
        '____________________________ test_split_invoice ________________________________',
        'E   AssertionError: assert 3 == 4',
        'tests/test_billing.py:88: AssertionError',
        '=========================== 1 failed, 12 passed in 3.21s ==========================',
      ].join('\n'),
    ],
    [
      'test_failure',
      [
        '[ERROR] Tests run: 14, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 2.114 s <<< FAILURE! - in com.acme.InvoiceServiceTest',
        '[ERROR] com.acme.InvoiceServiceTest.shouldSplit  Time elapsed: 0.019 s  <<< FAILURE!',
        'java.lang.AssertionError: expected:<90> but was:<99>',
      ].join('\n'),
    ],
    [
      'compile_error',
      "src/app/main.ts(42,17): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.\nFound 1 error.",
    ],
    [
      'compile_error',
      '/ws/src/Foo.java:88: error: cannot find symbol\n    calculator.computeTaxRate(x);\n              ^\n  symbol: method computeTaxRate(String)',
    ],
    [
      'dependency_error',
      'npm ERR! code ERESOLVE\nnpm ERR! ERESOLVE unable to resolve dependency tree\nnpm ERR! Found: react@18.3.1',
    ],
    [
      'dependency_error',
      'ERROR: Could not find a version that satisfies the requirement pandas==9.9.9 (from versions: 1.0.0)\nERROR: No matching distribution found for pandas==9.9.9',
    ],
    [
      'dependency_error',
      '[ERROR] Failed to execute goal on project svc: Could not resolve dependencies for project com.acme:svc:jar:1.0',
    ],
    ['oom', 'The process was terminated.\n##[error]Process completed with exit code 137.'],
    ['oom', 'Running the heavy step\n/usr/bin/bash: line 5: 4211 Killed                  node ./build.js\n'],
    ['oom', 'Exception in thread "main" java.lang.OutOfMemoryError: Java heap space'],
    [
      'infra_timeout',
      '##[error]The operation was canceled.\nError: The runner has received a shutdown signal.',
    ],
    ['infra_timeout', 'timeout: sending signal TERM to command ‘npm’\nmake: *** [test] Error 124'],
    [
      'lint_error',
      '/ws/src/a.ts\n  12:5   error  Unexpected console statement  no-console\n  40:1   error  Missing return type  @typescript-eslint/explicit-function-return-type\n\n✖ 2 problems (2 errors, 0 warnings)',
    ],
    [
      'lint_error',
      '[ERROR] src/main/java/A.java:[10] (imports) UnusedImports: Unused import - java.util.List. [Checkstyle]',
    ],
    [
      'permission_error',
      'remote: Permission to acme-corp/app.git denied to github-actions[bot].\nfatal: unable to access https://github.com/acme-corp/app.git/: The requested URL returned error: 403',
    ],
    [
      'permission_error',
      "npm ERR! code EACCES\nnpm ERR! syscall mkdir\nnpm ERR! Error: EACCES: permission denied, mkdir '/usr/lib/node_modules/x'",
    ],
    ['network_error', 'Error: connect ECONNREFUSED 127.0.0.1:5432\n    at TCPConnectWrap.afterConnect'],
    [
      'network_error',
      'curl: (6) Could not resolve host: registry.internal.acme.com\ngetaddrinfo EAI_AGAIN registry.internal.acme.com',
    ],
  ];

  for (const [expected, log] of cases) {
    it(`detects ${expected}: ${log.split('\n')[0]?.slice(0, 52)}`, async () => {
      const sig = await parseFailure(log);
      expect(sig.category).toBe(expected);
      expect(sig.confidence).toBeGreaterThanOrEqual(0.75);
    });
  }

  it('prefers OOM over the test failure that the OOM caused', async () => {
    const log = [
      'FAIL src/big.test.ts',
      '  ● big suite › explodes',
      'Tests:       1 failed, 3 passed, 4 total',
      '',
      'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
      '##[error]Process completed with exit code 134.',
    ].join('\n');
    expect((await parseFailure(log)).category).toBe('oom');
  });

  it('does not mistake a failing npm test script for a dependency error', async () => {
    const log = [
      'FAIL src/cart.test.ts',
      '  ● cart › totals',
      '    expect(received).toBe(expected)',
      'Tests:       1 failed, 3 passed, 4 total',
      'npm ERR! Lifecycle script `test` failed with error:',
      'npm ERR! code 1',
      'npm ERR! workspace acme@1.0.0',
    ].join('\n');
    expect((await parseFailure(log)).category).toBe('test_failure');
  });
});

describe('parseFailure — hash stability', () => {
  it('is deterministic for the same input', async () => {
    for (const f of ALL_FIXTURES) {
      const [a, b] = await Promise.all([parseFailure(f.logText), parseFailure(f.logText)]);
      expect(a.hash).toBe(b.hash);
      expect(a.hash).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('collides across runs with different timestamps, paths, ids and durations', async () => {
    for (const f of ALL_FIXTURES) {
      const original = await parseFailure(f.logText);
      const later = await parseFailure(rerun(f.logText));
      expect(rerun(f.logText)).not.toBe(f.logText); // the mutation really fired
      expect(later.category).toBe(original.category);
      expect(later.hash).toBe(original.hash);
    }
  });

  it('survives a log being re-emitted with the whole tail re-indented and re-prefixed', async () => {
    const base = 'FAIL src/cart.test.ts\n  ● cart › totals\n    expect(received).toBe(expected)\n    Expected: 90\n    Received: 99';
    const prefixed = base
      .split('\n')
      .map((l) => `2026-04-02T08:11:09.1234567Z ${l}`)
      .join('\n');
    const a = await parseFailure(base);
    const b = await parseFailure(prefixed);
    expect(b.hash).toBe(a.hash);
  });

  it('diverges for genuinely different errors', async () => {
    const base = await parseFailure(JEST.logText);

    const otherAssertion = await parseFailure(
      JEST.logText.replace(/applies percentage discount before tax/g, 'applies flat rebate after tax'),
    );
    expect(otherAssertion.hash).not.toBe(base.hash);

    const differentCategory = await parseFailure(MAVEN.logText);
    expect(differentCategory.hash).not.toBe(base.hash);

    const a = await parseFailure('Error: connect ECONNREFUSED 10.0.0.4:5432');
    const b = await parseFailure('Error: connect ECONNREFUSED 10.0.0.4:6379');
    // Ports are normalised away, so the same refusal collides...
    expect(b.hash).toBe(a.hash);
    // ...but a different host does not.
    const c = await parseFailure('Error: getaddrinfo ENOTFOUND registry.internal.acme.com');
    expect(c.hash).not.toBe(a.hash);
  });

  it('separates identical text under different categories', async () => {
    const text = 'something broke';
    const [a, b] = await Promise.all([hashSignature('oom', text), hashSignature('test_failure', text)]);
    expect(a).not.toBe(b);
    expect(a).toHaveLength(32);
  });
});

describe('parseFailure — excerpt and text', () => {
  it('caps the excerpt at 4000 characters', async () => {
    const wide = 'context line with quite a lot of padding text '.repeat(7); // ~315 chars
    const log = [
      ...filler(20),
      ...Array.from({ length: 20 }, () => wide),
      'FAIL src/wide.test.ts',
      '  ● wide suite › fails loudly',
      '    expect(received).toBe(expected)',
      ...Array.from({ length: 40 }, () => wide),
    ].join('\n');

    const sig = await parseFailure(log);
    expect(sig.category).toBe('test_failure');
    expect(sig.excerpt.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
    expect(sig.excerpt.length).toBeGreaterThan(3000); // the cap actually bound
  });

  it('keeps every fixture excerpt within the cap and non-empty', async () => {
    for (const f of ALL_FIXTURES) {
      const sig = await parseFailure(f.logText);
      expect(sig.excerpt.length).toBeGreaterThan(0);
      expect(sig.excerpt.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
    }
  });

  it('leaves the excerpt raw (timestamps still present) but normalises the text', async () => {
    const sig = await parseFailure(MAVEN.logText);
    expect(sig.excerpt).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(sig.text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(sig.text).not.toMatch(/\/var\/lib\/jenkins/);
  });

  it('produces a 1-5 line signature text', async () => {
    for (const f of ALL_FIXTURES) {
      const sig = await parseFailure(f.logText);
      const lines = sig.text.split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(1);
      expect(lines.length).toBeLessThanOrEqual(5);
      expect(sig.text.trim()).not.toBe('');
    }
  });

  it('names the implicated file', async () => {
    expect((await parseFailure(JEST.logText)).fileHint).toBe('checkout/cart.test.ts');
    expect((await parseFailure(MAVEN.logText)).fileHint).toBe('billing/InvoiceService.java');
    expect((await parseFailure('FAILED tests/test_billing.py::test_split_invoice - AssertionError')).fileHint).toBe(
      'tests/test_billing.py::test_split_invoice',
    );
  });
});

describe('parseFailure — fallbacks and robustness', () => {
  it('returns a low-confidence unknown signature when nothing matches', async () => {
    const sig = await parseFailure('hello world\nnothing to see here\njust some output\n');
    expect(sig.category).toBe('unknown');
    expect(sig.confidence).toBeCloseTo(0.2, 5);
    expect(sig.text).toContain('hello world');
    expect(sig.hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('handles an empty log without throwing', async () => {
    for (const input of ['', '\n\n\n', '   \n\t\n']) {
      const sig = await parseFailure(input);
      expect(sig.category).toBe('unknown');
      expect(sig.confidence).toBe(0);
      expect(sig.hash).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('never throws on hostile input', async () => {
    const hostile = [
      'a'.repeat(200_000),
      `${ESC}[2K${ESC}[31m mangled control noise ${ESC}[0m`,
      '('.repeat(5000),
      `${'/very/deep/path'.repeat(400)} error TS2345: nope`,
      Array.from({ length: 500 }, () => 'error: '.repeat(60)).join('\n'),
    ];
    for (const input of hostile) {
      const sig = await parseFailure(input);
      expect(sig.hash).toMatch(/^[0-9a-f]{32}$/);
      expect(sig.excerpt.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
      expect(sig.confidence).toBeGreaterThanOrEqual(0);
      expect(sig.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe('tailLines', () => {
  it('returns at most MAX_TAIL_LINES + 1 lines', () => {
    const log = filler(6000).join('\n');
    expect(log.split('\n')).toHaveLength(6000);
    expect(tailLines(log).length).toBeLessThanOrEqual(MAX_TAIL_LINES + 1);
  });

  it('returns the tail, not the head', () => {
    const log = ['FIRST', ...filler(4000), 'LAST'].join('\n');
    const tail = tailLines(log);
    expect(tail[tail.length - 1]).toBe('LAST');
    expect(tail).not.toContain('FIRST');
  });

  it('ignores an error that only appears above the tail window', async () => {
    const log = [
      'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
      ...filler(3000),
    ].join('\n');
    const sig = await parseFailure(log);
    expect(sig.category).not.toBe('oom');
    expect(sig.category).toBe('unknown');
  });

  it('handles a log with no newline at all', () => {
    expect(tailLines('single line')).toEqual(['single line']);
    expect(tailLines('')).toEqual([]);
  });
});

describe('normaliseLine', () => {
  it('strips the noise that varies between runs', () => {
    expect(
      normaliseLine(
        '2026-02-17T11:04:26.1131138Z       at Object.<anonymous> (/home/runner/work/acme/acme/src/checkout/cart.test.ts:44:34)',
      ),
    ).toBe('at Object.<anonymous> (checkout/cart.test.ts:<L>:<C>)');

    expect(
      normaliseLine(
        '[2026-02-17T09:12:52.774Z] [ERROR] /var/lib/jenkins/workspace/x/src/main/java/com/acme/InvoiceService.java:[142,38] cannot find symbol',
      ),
    ).toBe('[ERROR] acme/InvoiceService.java:[<L>,<C>] cannot find symbol');

    expect(normaliseLine('[INFO] Total time:  11.204 s')).toBe('[INFO] Total time: <DUR>');
    expect(normaliseLine(`${ESC}[31mFAIL${ESC}[0m src/a.test.ts`)).toBe('FAIL src/a.test.ts');
    expect(normaliseLine('Heap dump written at 0x7f9c48001000 by pid 4211')).toBe(
      'Heap dump written at <ADDR> by pid <PID>',
    );
    expect(normaliseLine('run 3f7a91c0-2b44-4c1e-9a0d-8e5f61b2c703 build #1284')).toBe(
      'run <UUID> build #<N>',
    );
    expect(normaliseLine('##[error]Process completed with exit code 1.')).toBe(
      '[ERROR] Process completed with exit code 1.',
    );
  });

  it('keeps the semantic payload intact', () => {
    const n = normaliseLine("2026-01-02T03:04:05Z error TS2345: Argument of type 'string' is not assignable");
    expect(n).toContain('TS2345');
    expect(n).toContain("Argument of type 'string' is not assignable");
  });

  it('does not corrupt relative paths', () => {
    expect(normaliseLine('[ERROR] src/main/java/A.java:[10] UnusedImports [Checkstyle]')).toContain(
      'src/main/java/A.java',
    );
  });

  it('is idempotent', () => {
    const raw = '2026-02-17T11:04:26.113Z FAIL /home/runner/work/a/a/src/x.test.ts:12:4 after 3.5 s';
    const once = normaliseLine(raw);
    expect(normaliseLine(once)).toBe(once);
  });
});
