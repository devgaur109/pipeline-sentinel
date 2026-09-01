/**
 * Deterministic, pre-LLM log fingerprinting.
 *
 * A CI log is megabytes of noise wrapped around a few interesting lines. This
 * module finds those lines, classifies them, strips everything that varies
 * between otherwise-identical runs (timestamps, absolute paths, build ids,
 * durations, pids, addresses) and hashes what is left. Two runs of the same
 * bug therefore collide on `ErrorSignature.hash`, which is what makes dedupe,
 * flake counting and embedding reuse possible without ever calling a model.
 *
 * CPU budget: this runs on the Workers free plan (10ms CPU / invocation), so
 * every regex here is anchored or bounded, there is no nested quantifier that
 * can backtrack catastrophically, and the expensive rule set only ever sees
 * lines that survive a single cheap pre-screen.
 */

import type { ErrorCategory, ErrorSignature } from '../types';

/* ------------------------------------------------------------------ *
 * Tunables
 * ------------------------------------------------------------------ */

/** Never look at more than this many lines from the end of the log. */
export const MAX_TAIL_LINES = 2000;
/** Hard safety valve: characters of tail we are willing to scan. */
const MAX_TAIL_CHARS = 512_000;
/**
 * Detailed rules only run on lines that pass the pre-screen, capped here.
 * This bounds the worst case (a log where *nothing* matches) at roughly
 * 200 x 95 short-string regex tests, which stays inside the CPU budget.
 */
const MAX_CANDIDATE_LINES = 200;
/** Contract-mandated excerpt cap. */
export const MAX_EXCERPT_CHARS = 4000;
/** Lines of raw context kept before / after the matched line in `excerpt`. */
const EXCERPT_BEFORE = 6;
const EXCERPT_AFTER = 34;
/** `text` is 1-5 lines, each clipped so one runaway line cannot dominate. */
const MAX_SIGNATURE_LINES = 5;
const MAX_SIGNATURE_LINE_CHARS = 240;
/** Length of the hex hash we keep (contract: first 32 chars of the SHA-256). */
const HASH_CHARS = 32;

/* ------------------------------------------------------------------ *
 * Tail extraction
 * ------------------------------------------------------------------ */

/**
 * Return the last `maxLines` lines of `logText`, scanning backwards from the
 * end so we never touch the (potentially huge) head of the log. CI runners
 * report failures at the bottom, so this is where the signal lives.
 */
export function tailLines(logText: string, maxLines: number = MAX_TAIL_LINES): string[] {
  if (!logText) return [];
  const floor = Math.max(0, logText.length - MAX_TAIL_CHARS);
  let seen = 0;
  let cut = floor;
  for (let i = logText.length - 1; i >= floor; i--) {
    if (logText.charCodeAt(i) === 10 /* \n */) {
      seen++;
      if (seen > maxLines) {
        cut = i + 1;
        break;
      }
    }
  }
  return logText.slice(cut).split('\n');
}

/* ------------------------------------------------------------------ *
 * Normalisation
 * ------------------------------------------------------------------ */

// CSI / SGR colour codes and the rarer OSC sequences some runners emit.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_CSI_RE = new RegExp(`${ESC}\\[[0-9;?]{0,24}[ -\\/]{0,4}[@-~]`, 'g');
const ANSI_OSC_RE = new RegExp(`${ESC}\\][^${BEL}${ESC}]{0,512}(?:${BEL}|${ESC}\\\\)`, 'g');
/** Any orphaned ESC left over from a truncated sequence. */
const ANSI_STRAY_RE = new RegExp(ESC, 'g');
const CARRIAGE_RE = /\r/g;

// Timestamps. ISO first (widest), then bare dates, then wall clocks.
const ISO_TS_RE =
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?/g;
const DATE_RE = /\d{4}-\d{2}-\d{2}/g;
const CLOCK_RE = /\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?\b/g;
/** Leading `<TS>` / `[<TS>]` / `[<TS>] [<TS>]` prefixes left by the above. */
const LEADING_TS_RE = /^(?:\s*(?:\[\s*)?<TS>(?:\s*\])?\s*){1,4}/;
/** GitHub Actions workflow-command markers. `##[error]` keeps a token so the
 *  rule set can still see that the runner flagged the line. */
const GH_ERROR_RE = /^\s*##\[error\]\s*/i;
const GH_MARKER_RE = /^\s*##\[(?:warning|notice|group|endgroup|debug|command|section)\]\s*/i;

// Paths. Bounded segment count and length so there is nothing to backtrack.
const POSIX_PATH_RE = /(?<![\w.$-])(?:\/[\w.+@%-]{1,64}){2,32}/g;
const WINDOWS_PATH_RE = /\b[A-Za-z]:(?:\\[\w.+@%-]{1,64}){1,32}/g;

// Identifiers that change every run.
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const ADDR_RE = /\b0[xX][0-9a-fA-F]{1,16}\b/g;
/** Hex-looking runs, but not ordinary all-letter words such as `defaced`. */
const HEX_RE = /\b(?![a-f]{7,64}\b)[0-9a-f]{7,64}\b/g;

// Source positions: `foo.ts:12:5`, `Foo.java:[42,17]`, `line 12`.
const FILE_LINE_COL_RE = /(\.[A-Za-z]{1,6}):\d{1,7}:\d{1,7}/g;
const FILE_LINE_RE = /(\.[A-Za-z]{1,6}):\d{1,7}/g;
const MAVEN_POS_RE = /:\[\d{1,7},\d{1,7}\]/g;
const TSC_POS_RE = /\((\d{1,7}),(\d{1,7})\):/g;
const LINE_WORD_RE = /\bline \d{1,7}\b/gi;

// Volatile scalars.
const SIZE_RE = /\b\d+(?:[.,]\d+)?\s?(?:[KMGT]i?B|bytes)\b/g;
const DURATION_RE =
  /\b\d+(?:[.,]\d+)?\s?(?:ms|us|ns|s|m|h|sec|secs|second|seconds|min|mins|minute|minutes|hr|hrs|hour|hours)\b/g;
const HOST_PORT_RE =
  /\b(localhost|\d{1,3}(?:\.\d{1,3}){3}|[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,6}):\d{2,5}\b/g;
const PID_RE = /\b(pid|PID|Pid)\s*[:=]?\s*\d{1,10}\b/g;
const BUILD_NUM_RE = /(?:^|\s)#\d{1,9}\b/g;
const BIG_NUM_RE = /\b\d{4,}\b/g;
const WS_RE = /[ \t]{2,}/g;

/**
 * Reduce one raw log line to its semantic core. Exception classes, assertion
 * text and missing-symbol names survive; everything run-specific does not.
 */
export function normaliseLine(raw: string): string {
  let s = raw.replace(CARRIAGE_RE, '');
  s = s.replace(ANSI_OSC_RE, '').replace(ANSI_CSI_RE, '').replace(ANSI_STRAY_RE, '');

  s = s.replace(ISO_TS_RE, '<TS>').replace(DATE_RE, '<TS>').replace(CLOCK_RE, '<TS>');
  s = s.replace(LEADING_TS_RE, '');
  s = s.replace(GH_ERROR_RE, '[ERROR] ').replace(GH_MARKER_RE, '');
  // A second pass: Jenkins prefixes its own clock after the pipeline marker.
  s = s.replace(LEADING_TS_RE, '');

  s = s.replace(POSIX_PATH_RE, shortenPosixPath).replace(WINDOWS_PATH_RE, shortenWindowsPath);

  s = s.replace(UUID_RE, '<UUID>').replace(ADDR_RE, '<ADDR>');

  s = s.replace(MAVEN_POS_RE, ':[<L>,<C>]').replace(TSC_POS_RE, '(<L>,<C>):');
  s = s.replace(FILE_LINE_COL_RE, '$1:<L>:<C>').replace(FILE_LINE_RE, '$1:<L>');
  s = s.replace(LINE_WORD_RE, 'line <L>');

  s = s.replace(SIZE_RE, '<SIZE>').replace(DURATION_RE, '<DUR>');
  s = s.replace(HOST_PORT_RE, '$1:<PORT>');
  s = s.replace(PID_RE, 'pid <PID>');
  s = s.replace(BUILD_NUM_RE, ' #<N>');

  // Numbers before hex, so a long decimal build id does not become `<HEX>`.
  s = s.replace(BIG_NUM_RE, '<N>');
  s = s.replace(HEX_RE, '<HEX>');

  return s.replace(WS_RE, ' ').trim();
}

/** `/home/runner/work/app/app/src/util/date.ts` -> `util/date.ts`. */
function shortenPosixPath(match: string): string {
  const parts = match.split('/').filter(Boolean);
  if (parts.length <= 2) return match;
  return parts.slice(-2).join('/');
}

function shortenWindowsPath(match: string): string {
  const parts = match.split('\\').filter(Boolean);
  if (parts.length <= 2) return match;
  return parts.slice(-2).join('/');
}

/* ------------------------------------------------------------------ *
 * Detection rules
 * ------------------------------------------------------------------ */

interface Detector {
  category: ErrorCategory;
  /** Lower wins. Ties are broken by the later (further down the log) line. */
  priority: number;
  confidence: number;
  re: RegExp;
}

/**
 * Cheap gate. A line must contain at least one of these tokens before we are
 * willing to spend the full rule set on it. One alternation pass per line is
 * far cheaper than ~100 individual `test()` calls, and in practice it rejects
 * well over 90% of a CI log.
 */
const PRESCREEN_RE =
  /error|fail|exception|kill|denied|refus|unable|cannot|could not|missing|timeout|timed out|not found|no matching|unauthori|forbidden|traceback|fatal|credential|memory|heap|exit code|cancel|exceed|deadline|reformat|problems|violation|ERR!|etimedout|enotfound|eai_again|eacces|eperm|econnreset|ehostunreach|enetunreach|[✕✖✗×●]|expect\(|assert/iu;

/**
 * Ordered by how specific the evidence is, not by how common the failure is.
 * Anything that positively identifies a category (an `OutOfMemoryError`, a
 * `TS2345`) outranks a generic marker (`[ERROR]`, `BUILD FAILURE`).
 *
 * Every pattern here is matched against a line that has already been through
 * {@link normaliseLine}, so they expect the placeholder tokens (`<TS>`, `<L>`,
 * `<DUR>`, `<N>`) rather than raw values, and never rely on run-lengths of
 * whitespace, which normalisation collapses.
 *
 * MUST stay sorted by ascending `priority` — the scan relies on it to stop early.
 */
const DETECTORS: Detector[] = [
  /* ---- OOM (10-13): unambiguous, and it masquerades as every other kind of
     failure further down the log, so it has to win outright. ---- */
  { category: 'oom', priority: 10, confidence: 1.0, re: /java\.lang\.OutOfMemoryError/ },
  { category: 'oom', priority: 10, confidence: 1.0, re: /JavaScript heap out of memory/i },
  { category: 'oom', priority: 10, confidence: 1.0, re: /FATAL ERROR: .{0,80}(?:heap|memory)/i },
  { category: 'oom', priority: 11, confidence: 0.95, re: /\bOOMKilled\b/ },
  { category: 'oom', priority: 11, confidence: 0.95, re: /Out of memory: Kill(?:ed)? process/i },
  { category: 'oom', priority: 11, confidence: 0.95, re: /\bmemory cgroup out of memory\b/i },
  { category: 'oom', priority: 11, confidence: 0.95, re: /Container .{0,60}(?:was )?OOM/i },
  {
    category: 'oom',
    priority: 12,
    confidence: 0.9,
    re: /(?:exit(?:ed)? (?:with )?(?:code|status)[: ]{1,3}137\b|exit code 137\b|code=137\b|status 137\b)/i,
  },
  { category: 'oom', priority: 13, confidence: 0.75, re: /(?:^|:\s)(?:<N> )?Killed\b/ },
  { category: 'oom', priority: 13, confidence: 0.75, re: /\bsignal: killed\b/i },

  /* ---- Infra / job-level timeouts and lost runners (15-17). Deliberately not
     matching in-test timeouts: a Jest "Async callback was not invoked" is a
     test failure, not an infrastructure failure. ---- */
  { category: 'infra_timeout', priority: 15, confidence: 1.0, re: /Build timed out \(after /i },
  {
    category: 'infra_timeout',
    priority: 15,
    confidence: 1.0,
    re: /has exceeded the maximum execution time/i,
  },
  { category: 'infra_timeout', priority: 15, confidence: 1.0, re: /^Cannot contact [\w.-]{1,64}:/ },
  {
    category: 'infra_timeout',
    priority: 15,
    confidence: 0.95,
    re: /lost communication with the server/i,
  },
  {
    category: 'infra_timeout',
    priority: 15,
    confidence: 0.95,
    re: /hudson\.remoting\.(?:ChannelClosedException|RequestAbortedException)/,
  },
  {
    category: 'infra_timeout',
    priority: 16,
    confidence: 0.9,
    re: /The runner has received a shutdown signal/i,
  },
  { category: 'infra_timeout', priority: 16, confidence: 0.9, re: /The operation was canceled/i },
  { category: 'infra_timeout', priority: 16, confidence: 0.9, re: /\bcontext deadline exceeded\b/ },
  { category: 'infra_timeout', priority: 16, confidence: 0.9, re: /\bexecutor .{0,40}\bwas removed\b/i },
  {
    category: 'infra_timeout',
    priority: 17,
    confidence: 0.85,
    re: /timeout: sending signal \w{1,10} to command/i,
  },
  {
    category: 'infra_timeout',
    priority: 17,
    confidence: 0.85,
    re: /(?:exit(?:ed)? (?:with )?(?:code|status)[: ]{1,3}124\b|exit code 124\b)/i,
  },
  { category: 'infra_timeout', priority: 17, confidence: 0.8, re: /^(?:\[ERROR\] )?FATAL: command execution failed/ },
  { category: 'infra_timeout', priority: 17, confidence: 0.8, re: /Aborted by .{0,40}Timeout/i },

  /* ---- Test failures. Detail lines (20-22) beat summary lines (25-26),
     because the detail names the actual assertion that broke. ---- */
  { category: 'test_failure', priority: 20, confidence: 1.0, re: /^●\s+(?!Console)\S/u },
  { category: 'test_failure', priority: 20, confidence: 1.0, re: /^[✕✗×]\s+\S/u },
  { category: 'test_failure', priority: 20, confidence: 1.0, re: /^FAILED\s+\S{1,200}::\S/ },
  { category: 'test_failure', priority: 20, confidence: 1.0, re: /<<< (?:FAILURE|ERROR)!/ },
  {
    category: 'test_failure',
    priority: 21,
    confidence: 0.95,
    re: /^E\s+\w{0,80}(?:Error|Exception|assert)/,
  },
  {
    category: 'test_failure',
    priority: 21,
    confidence: 0.95,
    re: /^(?:expect\(|AssertionError|assert\b|Expected:|AssertionFailedError)/,
  },
  {
    category: 'test_failure',
    priority: 21,
    confidence: 0.95,
    re: /Timeout - Async callback was not invoked/,
  },
  { category: 'test_failure', priority: 22, confidence: 0.9, re: /^FAIL\s+\S{1,200}/ },
  { category: 'test_failure', priority: 22, confidence: 0.9, re: /^\[ERROR\] Failures:/ },
  { category: 'test_failure', priority: 22, confidence: 0.9, re: /^\[ERROR\] Errors:/ },
  { category: 'test_failure', priority: 25, confidence: 0.85, re: /^Tests?:\s{0,4}\d{1,6} failed/ },
  {
    category: 'test_failure',
    priority: 25,
    confidence: 0.85,
    re: /Tests run: \d{1,6}, Failures: (?!0\b)\d{1,6}/,
  },
  {
    category: 'test_failure',
    priority: 25,
    confidence: 0.85,
    re: /Tests run: \d{1,6}, Failures: \d{1,6}, Errors: (?!0\b)\d{1,6}/,
  },
  { category: 'test_failure', priority: 25, confidence: 0.85, re: /^=+ \d{1,6} failed/ },
  { category: 'test_failure', priority: 25, confidence: 0.8, re: /\b\d{1,6} failed, \d{1,6} passed\b/ },
  { category: 'test_failure', priority: 25, confidence: 0.8, re: /There are test failures/i },
  {
    category: 'test_failure',
    priority: 26,
    confidence: 0.8,
    re: /^Test Suites?:\s{0,4}\d{1,6} failed/,
  },

  /* ---- Compile errors (30-33) ---- */
  { category: 'compile_error', priority: 30, confidence: 1.0, re: /\berror TS\d{4,5}\b/ },
  { category: 'compile_error', priority: 30, confidence: 1.0, re: /\berror: cannot find symbol\b/ },
  { category: 'compile_error', priority: 30, confidence: 1.0, re: /^\[ERROR\] COMPILATION ERROR/ },
  { category: 'compile_error', priority: 30, confidence: 1.0, re: /\bCompilation failed\b/i },
  {
    category: 'compile_error',
    priority: 31,
    confidence: 0.95,
    re: /^\[ERROR\] \S{1,200}\.(?:java|kt|scala|groovy):\[<L>,<C>\]/,
  },
  { category: 'compile_error', priority: 31, confidence: 0.95, re: /\.java:<L>: error:/ },
  { category: 'compile_error', priority: 31, confidence: 0.95, re: /^e: \S{1,200}\.kts?:/ },
  { category: 'compile_error', priority: 31, confidence: 0.95, re: /^error\[E\d{3,4}\]:/ },
  { category: 'compile_error', priority: 32, confidence: 0.9, re: /^SyntaxError:/ },
  { category: 'compile_error', priority: 32, confidence: 0.9, re: /\bTS\d{4,5}: / },
  {
    category: 'compile_error',
    priority: 32,
    confidence: 0.9,
    re: /Execution failed for task '\S{0,80}[Cc]ompile\w{0,40}'/,
  },
  { category: 'compile_error', priority: 33, confidence: 0.85, re: /^> Task \S{1,80} FAILED$/ },

  /* ---- Dependency resolution (40-42). Kept narrow on purpose: a bare
     `npm ERR!` shows up after *every* failing npm script. ---- */
  {
    category: 'dependency_error',
    priority: 40,
    confidence: 1.0,
    re: /npm ERR! code E(?:404|RESOLVE|INVALIDTAGNAME|NOVERSIONS)/,
  },
  {
    category: 'dependency_error',
    priority: 40,
    confidence: 1.0,
    re: /npm ERR! (?:notarget|404 Not Found - GET)/,
  },
  {
    category: 'dependency_error',
    priority: 40,
    confidence: 1.0,
    re: /Could not resolve dependencies for project/,
  },
  { category: 'dependency_error', priority: 40, confidence: 1.0, re: /Could not (?:find|resolve) artifact\b/ },
  {
    category: 'dependency_error',
    priority: 40,
    confidence: 1.0,
    re: /Could not find a version that satisfies the requirement/,
  },
  { category: 'dependency_error', priority: 40, confidence: 1.0, re: /No matching distribution found for/ },
  {
    category: 'dependency_error',
    priority: 41,
    confidence: 0.95,
    re: /Could not resolve all (?:files|dependencies|artifacts) for configuration/,
  },
  { category: 'dependency_error', priority: 41, confidence: 0.95, re: /^ERESOLVE\b/ },
  { category: 'dependency_error', priority: 41, confidence: 0.95, re: /ResolutionImpossible|version solving failed/i },
  { category: 'dependency_error', priority: 41, confidence: 0.95, re: /peer dep missing|conflicting peer dependency/i },
  { category: 'dependency_error', priority: 42, confidence: 0.85, re: /Cannot find module '\S{1,120}'/ },
  { category: 'dependency_error', priority: 42, confidence: 0.85, re: /ModuleNotFoundError: No module named/ },
  { category: 'dependency_error', priority: 42, confidence: 0.85, re: /^\[ERROR\] Failed to execute goal \S{0,120}dependency/ },

  /* ---- Lint / style (50-52) ---- */
  { category: 'lint_error', priority: 50, confidence: 0.95, re: /^[✖✗×]\s+\d{1,6} problems? \(\d{1,6} error/u },
  { category: 'lint_error', priority: 50, confidence: 0.95, re: /\[Checkstyle\]/ },
  { category: 'lint_error', priority: 50, confidence: 0.95, re: /Checkstyle rule violations were found/i },
  { category: 'lint_error', priority: 50, confidence: 0.95, re: /\bESLint found \d{1,6} error/ },
  { category: 'lint_error', priority: 51, confidence: 0.9, re: /^\d{1,6}:\d{1,6}\s+error\s+\S/ },
  { category: 'lint_error', priority: 51, confidence: 0.9, re: /:<L>:<C>: [EWF]\d{2,3} \S/ },
  { category: 'lint_error', priority: 52, confidence: 0.85, re: /would reformat |Prettier check failed/i },
  {
    category: 'lint_error',
    priority: 52,
    confidence: 0.85,
    re: /Execution failed for task '\S{0,80}(?:checkstyle|spotless|ktlint)\w{0,40}'/i,
  },

  /* ---- Permission / auth (60-62) ---- */
  { category: 'permission_error', priority: 60, confidence: 1.0, re: /\bEACCES\b|\bEPERM\b/ },
  { category: 'permission_error', priority: 60, confidence: 1.0, re: /\b(?:403 Forbidden|401 Unauthorized)\b/ },
  {
    category: 'permission_error',
    priority: 60,
    confidence: 1.0,
    re: /denied: (?:permission_denied|requested access to the resource is denied)/,
  },
  { category: 'permission_error', priority: 60, confidence: 1.0, re: /Permission (?:to \S{1,120} )?denied/ },
  {
    category: 'permission_error',
    priority: 61,
    confidence: 0.95,
    re: /Authentication failed|authentication required|invalid credentials/i,
  },
  {
    category: 'permission_error',
    priority: 61,
    confidence: 0.95,
    re: /Bad credentials|Resource not accessible by integration/,
  },
  { category: 'permission_error', priority: 61, confidence: 0.95, re: /\bstatus code 40[13]\b/ },
  { category: 'permission_error', priority: 62, confidence: 0.9, re: /not authorized to perform: \S/i },
  { category: 'permission_error', priority: 62, confidence: 0.9, re: /^sudo: .{0,80}password is required/ },

  /* ---- Network (70-72) ---- */
  {
    category: 'network_error',
    priority: 70,
    confidence: 1.0,
    re: /\bECONNREFUSED\b|\bECONNRESET\b|\bEHOSTUNREACH\b|\bENETUNREACH\b/,
  },
  { category: 'network_error', priority: 70, confidence: 1.0, re: /\bENOTFOUND\b|\bEAI_AGAIN\b/ },
  { category: 'network_error', priority: 70, confidence: 0.95, re: /\bETIMEDOUT\b/ },
  {
    category: 'network_error',
    priority: 71,
    confidence: 0.9,
    re: /Temporary failure in name resolution|Name or service not known/,
  },
  { category: 'network_error', priority: 71, confidence: 0.9, re: /Connection (?:refused|reset by peer|timed out)/i },
  {
    category: 'network_error',
    priority: 71,
    confidence: 0.9,
    re: /(?:curl|wget): \(\d{1,3}\) (?:Could not resolve|Failed to connect|Connection timed out|Operation timed out)/,
  },
  {
    category: 'network_error',
    priority: 72,
    confidence: 0.85,
    re: /CERTIFICATE_VERIFY_FAILED|certificate verify failed|SSLError/,
  },
  { category: 'network_error', priority: 72, confidence: 0.85, re: /Read timed out|ReadTimeoutError|ConnectTimeoutError/ },

  /* ---- Generic error markers (90-92). Something clearly went wrong, but we
     cannot say what; reported as `unknown` with modest confidence. ---- */
  { category: 'unknown', priority: 90, confidence: 0.45, re: /^\[ERROR\] Failed to execute goal \S/ },
  { category: 'unknown', priority: 91, confidence: 0.4, re: /^\[ERROR\] \S/ },
  { category: 'unknown', priority: 91, confidence: 0.4, re: /^(?:ERROR|FATAL|Error):\s+\S/ },
  { category: 'unknown', priority: 92, confidence: 0.35, re: /Process completed with exit code (?!0\b)\d{1,3}/ },
  { category: 'unknown', priority: 92, confidence: 0.35, re: /\bBUILD FAILURE\b|\bBUILD FAILED\b|FAILURE: Build failed/ },
];

/* ------------------------------------------------------------------ *
 * File hints
 * ------------------------------------------------------------------ */

const SOURCE_EXT =
  '(?:tsx?|jsx?|mjs|cjs|java|kt|kts|py|go|rb|scala|cs|php|rs|c|cc|cpp|h|hpp|swift|m|vue|svelte)';
const FILE_RE = new RegExp(
  `(?:^|[\\s'"(\\[<@])((?:[\\w.@-]{1,64}/){0,8}[\\w.@-]{1,64}\\.${SOURCE_EXT})\\b`,
);
/** `at com.acme.billing.InvoiceServiceTest.shouldSplit(InvoiceServiceTest.java)` */
const JAVA_CLASS_RE = /\b((?:[a-z][\w]{0,30}\.){1,8}[A-Z][\w$]{0,60}(?:Test|IT|Spec)?)\.[\w$<>]{1,60}\(/;
/** pytest node id: `tests/test_billing.py::test_split_invoice` */
const PYTEST_NODE_RE = /\b([\w./-]{1,160}\.py::[\w.:\[\]-]{1,120})/;
/** Jest/Vitest describe path on a `●` line. */
const BULLET_TITLE_RE = /^\s*●\s+(.{1,160})$/u;

/**
 * Best-guess implicated file for a window of **already normalised** lines
 * (absolute paths are therefore reduced to their repo-relative tail).
 * Preference order: pytest node id, test/spec file, JUnit-style class, any
 * source file, finally the Jest/Vitest test title from a `●` bullet.
 */
function pickFileHint(window: string[]): string | undefined {
  let firstFile: string | undefined;
  let testFile: string | undefined;

  for (const line of window) {
    const py = PYTEST_NODE_RE.exec(line);
    if (py) return py[1];
  }
  for (const line of window) {
    const m = FILE_RE.exec(line);
    if (!m) continue;
    const file = m[1];
    if (!file || file.includes('node_modules/')) continue;
    if (!firstFile) firstFile = file;
    if (!testFile && /(?:^|[./_-])(?:test|spec|Test|Spec|IT)/.test(file)) testFile = file;
  }
  if (testFile) return testFile;
  for (const line of window) {
    const jc = JAVA_CLASS_RE.exec(line);
    if (jc) return jc[1];
  }
  if (firstFile) return firstFile;
  for (const line of window) {
    const b = BULLET_TITLE_RE.exec(line);
    if (b && b[1]) return b[1].trim().slice(0, 160);
  }
  return undefined;
}

/** Categories where naming a source file is actually informative. */
const FILE_HINT_CATEGORIES: ReadonlySet<ErrorCategory> = new Set<ErrorCategory>([
  'test_failure',
  'compile_error',
  'lint_error',
]);

/* ------------------------------------------------------------------ *
 * Hashing
 * ------------------------------------------------------------------ */

const HEX_ALPHABET = '0123456789abcdef';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    out += HEX_ALPHABET[b >> 4] + HEX_ALPHABET[b & 0x0f];
  }
  return out;
}

/**
 * SHA-256 the canonical signature payload and keep the first 32 hex chars.
 * Uses `crypto.subtle`, which is why the whole parse path is async.
 */
export async function hashSignature(category: ErrorCategory, text: string): Promise<string> {
  const payload = `${category}\n${text}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return toHex(new Uint8Array(digest)).slice(0, HASH_CHARS);
}

/* ------------------------------------------------------------------ *
 * Main entry point
 * ------------------------------------------------------------------ */

interface Match {
  lineIndex: number;
  detector: Detector;
}

/**
 * Turn a raw CI log into a stable {@link ErrorSignature}.
 *
 * **This function is async** — the hash comes from `crypto.subtle.digest`,
 * which returns a Promise on the Workers runtime. Callers must `await` it.
 *
 * It never throws. A log it cannot classify still yields a signature with
 * `category: 'unknown'` and a low `confidence` built from the last non-empty
 * lines, so the caller always has something to embed and store.
 *
 * @param logText Raw job log. Only the last {@link MAX_TAIL_LINES} lines are
 *   examined, scanning backwards from the end.
 * @returns A promise resolving to the failure fingerprint.
 */
export async function parseFailure(logText: string): Promise<ErrorSignature> {
  try {
    return await parseFailureInner(logText);
  } catch {
    // The parser sits in front of every ingest; a bad log must never 500.
    const text = 'unparseable log';
    return {
      hash: await hashSignature('unknown', text).catch(() => '0'.repeat(HASH_CHARS)),
      text,
      category: 'unknown',
      excerpt: typeof logText === 'string' ? logText.slice(-MAX_EXCERPT_CHARS) : '',
      confidence: 0,
    };
  }
}

async function parseFailureInner(logText: string): Promise<ErrorSignature> {
  const raw = tailLines(logText);
  const nonEmptyCount = raw.reduce((n, l) => (l.trim() ? n + 1 : n), 0);

  if (nonEmptyCount === 0) {
    const text = 'empty log';
    return {
      hash: await hashSignature('unknown', text),
      text,
      category: 'unknown',
      excerpt: '',
      confidence: 0,
    };
  }

  // Pre-screen backwards; only interesting lines reach the rule set.
  const candidates: number[] = [];
  for (let i = raw.length - 1; i >= 0 && candidates.length < MAX_CANDIDATE_LINES; i--) {
    const line = raw[i] as string;
    if (line.length > 0 && line.length < 4000 && PRESCREEN_RE.test(line)) candidates.push(i);
  }

  // `candidates` is already ordered latest-first, so the first match at a given
  // priority is automatically the one furthest down the log.
  let best: Match | undefined;
  for (const i of candidates) {
    const line = normaliseLine(raw[i] as string);
    if (!line) continue;
    for (const detector of DETECTORS) {
      // DETECTORS is priority-sorted, so nothing after this point can win.
      if (best && detector.priority >= best.detector.priority) break;
      if (detector.re.test(line)) {
        best = { lineIndex: i, detector };
        break; // detectors are priority-ordered, so this is the best for this line
      }
    }
    if (best && best.detector.priority <= 10) break; // cannot be beaten
  }

  if (!best) return fallbackSignature(raw);

  const { lineIndex, detector } = best;
  const forward = raw
    .slice(lineIndex, Math.min(raw.length, lineIndex + EXCERPT_AFTER))
    .map(normaliseLine);
  let fileHint = pickFileHint(forward);
  if (!fileHint && FILE_HINT_CATEGORIES.has(detector.category)) {
    // Compilers and linters print the offending file *above* the summary line.
    fileHint = pickFileHint(raw.slice(Math.max(0, lineIndex - 20), lineIndex).map(normaliseLine));
  }

  const text = buildSignatureText(raw, lineIndex);
  const excerpt = buildExcerpt(raw, lineIndex);
  const hash = await hashSignature(detector.category, text);

  return {
    hash,
    text,
    category: detector.category,
    ...(fileHint ? { fileHint } : {}),
    excerpt,
    confidence: detector.confidence,
  };
}

/** Matched line plus up to four following informative normalised lines. */
function buildSignatureText(raw: string[], lineIndex: number): string {
  const out: string[] = [];
  const head = normaliseLine(raw[lineIndex] as string);
  if (head) out.push(clip(head));

  const limit = Math.min(raw.length, lineIndex + 24);
  for (let i = lineIndex + 1; i < limit && out.length < MAX_SIGNATURE_LINES; i++) {
    const n = normaliseLine(raw[i] as string);
    if (!n) continue;
    if (isNoise(n)) continue;
    if (out.includes(clip(n))) continue;
    out.push(clip(n));
  }
  return out.join('\n') || clip(head) || 'unclassified failure';
}

/** Separator bars, progress spinners and other lines with no identity value. */
function isNoise(n: string): boolean {
  if (n.length < 3) return true;
  if (/^[-=_*~#.\s]{3,}$/.test(n)) return true;
  if (/^\[INFO\]\s*[-=]{3,}/.test(n)) return true;
  // Jest/Babel code frames and their caret line: pure position noise.
  if (/^>?\s{0,4}\d{1,6} \|/.test(n)) return true;
  if (/^\|?\s{0,8}\^+$/.test(n)) return true;
  if (/^(?:Downloading|Downloaded|Progress|Collecting|Requirement already satisfied)\b/.test(n))
    return true;
  return false;
}

function clip(s: string): string {
  return s.length > MAX_SIGNATURE_LINE_CHARS ? `${s.slice(0, MAX_SIGNATURE_LINE_CHARS - 1)}…` : s;
}

/** Raw (un-normalised) slice around the match, hard-capped for the LLM. */
function buildExcerpt(raw: string[], lineIndex: number): string {
  const start = Math.max(0, lineIndex - EXCERPT_BEFORE);
  const end = Math.min(raw.length, lineIndex + EXCERPT_AFTER);
  const slice = raw.slice(start, end).join('\n');
  return slice.length > MAX_EXCERPT_CHARS ? slice.slice(0, MAX_EXCERPT_CHARS) : slice;
}

/** No rule fired: keep the last few non-empty lines so a human still gets a clue. */
async function fallbackSignature(raw: string[]): Promise<ErrorSignature> {
  const lines: string[] = [];
  for (let i = raw.length - 1; i >= 0 && lines.length < MAX_SIGNATURE_LINES; i--) {
    const n = normaliseLine(raw[i] as string);
    if (!n || isNoise(n)) continue;
    lines.unshift(clip(n));
  }
  const text = lines.join('\n') || 'unclassified failure';
  const lastIndex = Math.max(0, raw.length - 1);
  return {
    hash: await hashSignature('unknown', text),
    text,
    category: 'unknown',
    ...((): { fileHint?: string } => {
      const hint = pickFileHint(raw.slice(Math.max(0, raw.length - 40)).map(normaliseLine));
      return hint ? { fileHint: hint } : {};
    })(),
    excerpt: buildExcerpt(raw, Math.max(0, lastIndex - EXCERPT_AFTER + 1)),
    confidence: 0.2,
  };
}
