import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePipeline, type ShellStep } from '../../src/schema/pipeline.ts';
import {
  composeAgentEnv,
  composeEnv,
  ContractError,
  runShellStep,
  validateOutputs,
} from '../../src/runner/shell.ts';
import { REDACTION } from '../../src/runs/store.ts';

// FAKE credentials shaped like real ones, assembled at runtime so the literal
// does not appear in the source code: secret scanners (push protection
// included) can't tell a test key from a real one.
const FAKE_STRIPE_KEY = ['sk', 'live', '51H8AbCdEfGhIjKlMnOpQrSt'].join('_');
const FAKE_STRIPE_KEY_2 = ['sk', 'live', 'ANOTHERSECRETKEYVALUE99'].join('_');
const STRIPE_PREFIX = ['sk', 'live', ''].join('_');
const FAKE_JWT = [
  'eyJhbGciOiJIUzI1NiJ9',
  'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
  'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PYE4Vg',
].join('.');

/** Signal 0: kills nothing, only checks whether the process is still alive. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks that a process dies within a bounded time, without requiring it to
 * be dead at the exact instant `runShellStep` resolves. A child just finished
 * off with SIGKILL can linger for a moment as a reparented zombie — it keeps
 * answering signal 0 until its new parent (launchd/init) reaps it — and that
 * window grows under the load of the full suite running in parallel. What the
 * engine guarantees is that it dies soon, not that it dies synchronously.
 */
async function waitUntilDead(pid: number, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !isPidAlive(pid);
}

function shellStep(yaml: string): ShellStep {
  const p = parsePipeline(`
name: demo
description: d
version: 1
steps:
${yaml}
`);
  return p.steps[0] as ShellStep;
}

// Like the rest of the repo's tests that touch the filesystem
// (tests/runs/store.test.ts, tests/guards/lock.test.ts,
// tests/guards/evaluate.test.ts, tests/preflight/check.test.ts): a directory
// of its own per test under the OS tmpdir, not the shared tmpdir directly.
// Today this file's commands (echo, exit, sleep, true) write nothing, but a
// future test that does write must not share a folder with the rest of the
// suite.
let defaultCwd: string;

beforeEach(() => {
  defaultCwd = mkdtempSync(join(tmpdir(), 'ap-shell-'));
});
afterEach(() => rmSync(defaultCwd, { recursive: true, force: true }));

function baseCtx() {
  return {
    scope: { params: {}, steps: {} },
    secrets: {},
    defaultCwd,
    timeoutMs: 5000,
  };
}

describe('composeEnv', () => {
  test('includes an inherited PATH so sh and the binaries resolve', () => {
    expect(composeEnv({}).PATH).toBeTruthy();
  });
  test('adds the declared secrets', () => {
    expect(composeEnv({ MY_TOKEN: 's' }).MY_TOKEN).toBe('s');
  });
  test('does not carry over process variables that are not in the base list', () => {
    process.env.AP_TEST_VARIABLE = 'should-not-pass';
    expect(composeEnv({}).AP_TEST_VARIABLE).toBeUndefined();
    delete process.env.AP_TEST_VARIABLE;
  });
});

// The SDK's `Options.env` REPLACES the whole subprocess environment (it does
// not merge it with `process.env`), so without this variant of `composeEnv` an
// agent step on a machine authenticated via `ANTHROPIC_API_KEY` always failed
// to authenticate.
describe('composeAgentEnv', () => {
  test('includes an authentication variable present in the process environment', () => {
    process.env.ANTHROPIC_API_KEY = 'ap-test-not-a-real-key';
    expect(composeAgentEnv({}).ANTHROPIC_API_KEY).toBe('ap-test-not-a-real-key');
    delete process.env.ANTHROPIC_API_KEY;
  });
  test('does not carry over a process variable outside the base and the authentication/network list', () => {
    process.env.AP_TEST_VARIABLE = 'should-not-pass';
    expect(composeAgentEnv({}).AP_TEST_VARIABLE).toBeUndefined();
    delete process.env.AP_TEST_VARIABLE;
  });
  // Under launchd the environment does not carry the key: the one from `.env`
  // (agentAuth) is the one that counts, and it wins over the environment's if
  // both are present.
  test('the .env credential (agentAuth) wins over the one from the process environment', () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'ap-test-from-environment';
    try {
      expect(composeAgentEnv({}, { ANTHROPIC_API_KEY: 'ap-test-from-env' }).ANTHROPIC_API_KEY).toBe('ap-test-from-env');
      expect(composeAgentEnv({}).ANTHROPIC_API_KEY).toBe('ap-test-from-environment');
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });
});

describe('validateOutputs', () => {
  test('accepts an object that meets the contract', () => {
    const result = validateOutputs({ n: 7, s: 'x', b: true, arr: ['a'] }, {
      n: 'number', s: 'string', b: 'boolean', arr: 'string[]',
    }, 'step-1');
    expect(result).toEqual({ n: 7, s: 'x', b: true, arr: ['a'] });
  });

  test('rejects a wrong type naming the field', () => {
    expect(() => validateOutputs({ n: 'seven' }, { n: 'number' }, 'step-1')).toThrow(/n/);
  });

  test('rejects a contract field that is missing', () => {
    expect(() => validateOutputs({}, { n: 'number' }, 'step-1')).toThrow(ContractError);
  });

  test('drops fields not declared in the contract', () => {
    expect(validateOutputs({ n: 1, extra: 'x' }, { n: 'number' }, 'step-1')).toEqual({ n: 1 });
  });

  test('rejects an array with elements of the wrong type', () => {
    expect(() => validateOutputs({ arr: [1, 2] }, { arr: 'string[]' }, 'step-1')).toThrow(ContractError);
  });

  test('rejects a root that is not an object', () => {
    expect(() => validateOutputs('i am not an object', { n: 'number' }, 'step-1')).toThrow(ContractError);
  });

  // The message has to say what failed, not just "Contract not met" — step,
  // field, expected type, received type and an excerpt of the value, so it
  // reaches the email readable (the step's `error`).
  test('the message names the step, the field, both types and the received value', () => {
    expect(() => validateOutputs({ enqueued: 0 }, { enqueued: 'string' }, 'enqueue-covers')).toThrow(
      'Contract not met in "enqueue-covers": enqueued expected string, received number (0)',
    );
  });

  test('accumulates all the violations of the step on a single line, not just the first', () => {
    expect(() =>
      validateOutputs({ a: 1, b: 'x' }, { a: 'string', b: 'number', c: 'boolean' }, 'step-multi'),
    ).toThrow(
      'Contract not met in "step-multi": a expected string, received number (1); ' +
        'b expected number, received string (1 characters); missing field "c" (boolean)',
    );
  });

  test('describes an array with the received element type, never its values', () => {
    expect(() => validateOutputs({ arr: [1, 2] }, { arr: 'string[]' }, 'step-1')).toThrow(
      'arr expected string[], received number[] (length 2)',
    );
  });

  test('an object only says how many keys it has: no values and no key names', () => {
    let message = '';
    try {
      validateOutputs({ o: { user: 'ana', password: 'hunter2' } }, { o: 'string' }, 'step-1');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('o expected string, received object (2 keys)');
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain('password');
  });

  test('the KEYS of an object do not show: a map indexed by token or by email', () => {
    const payloads = {
      byToken: { [FAKE_STRIPE_KEY]: 100, [FAKE_STRIPE_KEY_2]: 50 },
      byEmail: { 'persona.test@example.com': 1 },
    };
    for (const [name, value] of Object.entries(payloads)) {
      let message = '';
      try {
        validateOutputs({ balances: value }, { balances: 'string' }, 'step-attack');
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message, name).toContain('balances expected string, received object');
      expect(message, name).not.toContain(STRIPE_PREFIX);
      expect(message, name).not.toContain('@example.com');
    }
  });

  test('an object with many keys does not lengthen the line', () => {
    const big = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`key_${i}`, i]));
    let message = '';
    try {
      validateOutputs({ g: big }, { g: 'string' }, 'step-1');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('g expected string, received object (5000 keys)');
    expect(message.length).toBeLessThan(200);
  });

  test('null adds nothing to the excerpt: the type already says it all', () => {
    expect(() => validateOutputs({ n: null }, { n: 'string' }, 'step-1')).toThrow(
      'n expected string, received null',
    );
  });

  // By CONCEPT, not by heuristic: a number or a boolean cannot carry
  // arbitrary text, so they are shown whole even if the field name sounds like
  // a credential. Hiding is by TYPE (string), not by name.
  test('a numeric value is shown even if the field name sounds like a credential', () => {
    let message = '';
    try {
      validateOutputs({ api_key: 12345 }, { api_key: 'string' }, 'step-1');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('api_key expected string, received number (12345)');
  });

  test('a string never shows its content, even if it looks like a credential (JWT)', () => {
    const jwt = FAKE_JWT;
    let message = '';
    try {
      validateOutputs({ enqueued: jwt }, { enqueued: 'number' }, 'step-1');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('enqueued expected number, received string');
    expect(message).not.toContain(jwt);
  });

  test('a long string declares its length, never its content', () => {
    const long = 'x'.repeat(80);
    let message = '';
    try {
      validateOutputs({ s: long }, { s: 'number' }, 'step-1');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('string (80 characters)');
    expect(message).not.toContain('x'.repeat(10));
  });

  // A secret in the middle of a sentence, under an innocent-looking field name
  // (summary/detail/message), went through whole in the 40-character excerpt
  // because the "looks like a secret" heuristic only recognized the WHOLE
  // string as a secret. Now a string never shows content, so there is no
  // heuristic to dodge.
  test('a secret in the middle of a sentence in "summary" does not reach the excerpt', () => {
    let message = '';
    try {
      validateOutputs(
        { summary: `Payment created with key ${FAKE_STRIPE_KEY}` },
        { summary: 'number' },
        'step-1',
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain(STRIPE_PREFIX);
    expect(message).toContain('summary expected number, received string');
  });

  test('a secret in the middle of a sentence in "detail" does not reach the excerpt', () => {
    let message = '';
    try {
      validateOutputs(
        { detail: 'Connection failed to postgres://svc_user:hunter2@db.internal:5432/prod' },
        { detail: 'number' },
        'step-1',
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain('postgres://');
    expect(message).not.toContain('hunter2');
    expect(message).toContain('detail expected number, received string');
  });

  test('a secret in the middle of a sentence in "message" does not reach the excerpt', () => {
    const jwt = FAKE_JWT;
    let message = '';
    try {
      validateOutputs({ message: `token received: ${jwt}` }, { message: 'number' }, 'step-1');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain('eyJ');
    expect(message).toContain('message expected number, received string');
  });
});

describe('runShellStep', () => {
  test('a correct command with no contract ends ok', async () => {
    const outcome = await runShellStep(shellStep("  - id: a\n    type: shell\n    run: echo hello"), baseCtx());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.log).toContain('hello');
  });

  test('a non-zero exit code is a NON-transient failure', async () => {
    const outcome = await runShellStep(shellStep("  - id: a\n    type: shell\n    run: exit 3"), baseCtx());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.transient).toBe(false);
      expect(outcome.error).toContain('3');
    }
  });

  test('a non-zero exit code carries the stderr tail in the error', async () => {
    // Without this, the email of a failed run said "verdict: exit code 1" and
    // the lines the step had written to stderr lived only in the log (it
    // happened in a trial when migrating a real pipeline).
    const outcome = await runShellStep(
      shellStep("  - id: a\n    type: shell\n    run: |\n      echo first >&2\n      echo boom >&2\n      exit 3"),
      baseCtx(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('exit code 3 — first / boom');
  });

  test('the stderr tail of the error is limited to the last five non-empty lines', async () => {
    const lines = Array.from({ length: 8 }, (_, i) => `echo l${i + 1} >&2`).join('\n      ');
    const outcome = await runShellStep(
      shellStep(`  - id: a\n    type: shell\n    run: |\n      ${lines}\n      echo >&2\n      exit 1`),
      baseCtx(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('exit code 1 — l4 / l5 / l6 / l7 / l8');
  });

  test('with nothing on stderr, the error is just the exit code', async () => {
    const outcome = await runShellStep(shellStep("  - id: a\n    type: shell\n    run: exit 2"), baseCtx());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('exit code 2');
  });

  test('parses stdout as JSON when the step declares outputs', async () => {
    // Note: the double quotes must go inside shell single quotes
    // (`echo '{"count":7}'`), or `sh -c` treats them as string delimiters and
    // drops them, leaving a stdout that is no longer valid JSON (`{count:7}`).
    // Checked in bash and deterministic in any POSIX shell: it is not a quirk
    // of this machine.
    const step = shellStep(
      "  - id: a\n    type: shell\n    run: \"echo '{\\\"count\\\":7}'\"\n    outputs: { count: number }",
    );
    const outcome = await runShellStep(step, baseCtx());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.outputs).toEqual({ count: 7 });
  });

  test('non-JSON stdout with a declared contract is a contract failure', async () => {
    const step = shellStep(
      "  - id: a\n    type: shell\n    run: echo not-json\n    outputs: { count: number }",
    );
    const outcome = await runShellStep(step, baseCtx());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.transient).toBe(false);
  });

  test('interpolates params and outputs of earlier steps into the command', async () => {
    const step = shellStep("  - id: a\n    type: shell\n    run: echo {{params.greeting}}-{{prev.n}}");
    const outcome = await runShellStep(step, {
      ...baseCtx(),
      scope: { params: { greeting: 'hello' }, steps: { prev: { n: 3 } } },
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.log).toContain('hello-3');
  });

  test('an interpolated value with shell metacharacters is not executed (indirection via environment)', async () => {
    const step = shellStep("  - id: a\n    type: shell\n    run: echo {{prev.payload}}");
    const outcome = await runShellStep(step, {
      ...baseCtx(),
      scope: { params: {}, steps: { prev: { payload: '$(touch pwned.txt)' } } },
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.log.trim()).toBe('$(touch pwned.txt)');
    expect(await Bun.file(join(defaultCwd, 'pwned.txt')).exists()).toBe(false);
  });

  test('the step sees its declared secrets and nothing else from the environment', async () => {
    process.env.AP_UNDECLARED = 'should-not-be-seen';
    const step = shellStep("  - id: a\n    type: shell\n    run: 'echo [$MY_TOKEN][$AP_UNDECLARED]'");
    const outcome = await runShellStep(step, { ...baseCtx(), secrets: { MY_TOKEN: 'secret' } });
    delete process.env.AP_UNDECLARED;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.log).toContain(`[${REDACTION}]`); // it saw its declared secret
      expect(outcome.log).toContain('[]'); // it did not see the undeclared variable
      expect(outcome.log).not.toContain('secret'); // and the value does not leak
    }
  });

  test('a timeout is a transient failure', async () => {
    const step = shellStep("  - id: a\n    type: shell\n    run: sleep 5");
    const outcome = await runShellStep(step, { ...baseCtx(), timeoutMs: 100 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.transient).toBe(true);
      expect(outcome.error).toContain('timed out');
    }
  });

  // Reproduces a real failure: `proc.kill()` only kills the step's `sh`, not a
  // background child that inherits its pipes (the real case is `caffeinate -i
  // claude -p ...` from a headless step). Without killing the whole group, the
  // orphan child stays alive after the timeout and `runShellStep` takes as long
  // to resolve as the child takes, not what `timeoutMs` says.
  test('a timeout also kills the background children of the step, not just the shell', async () => {
    const pidFile = join(defaultCwd, 'child.pid');
    const step = shellStep(
      `  - id: a\n    type: shell\n    run: |\n      sleep 5 &\n      echo $! > '${pidFile}'`,
    );
    const started = Date.now();
    const outcome = await runShellStep(step, { ...baseCtx(), timeoutMs: 100 });
    const elapsed = Date.now() - started;

    expect(outcome.ok).toBe(false);
    // Well below the child's 5s: if the engine keeps waiting for the orphan to
    // close the pipe, this test takes ~5s instead of <1s.
    expect(elapsed).toBeLessThan(1000);

    const childPid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(await waitUntilDead(childPid)).toBe(true);
  });

  // The orphan child may ignore SIGTERM (the real case: `claude` stuck in
  // network work). The engine must escalate to SIGKILL instead of waiting for
  // it forever.
  test('a timeout escalates to SIGKILL if the process group ignores SIGTERM', async () => {
    const pidFile = join(defaultCwd, 'child.pid');
    const step = shellStep(
      `  - id: a\n    type: shell\n    run: |\n      trap '' TERM\n      sleep 5 &\n      echo $! > '${pidFile}'\n      wait`,
    );
    const outcome = await runShellStep(step, { ...baseCtx(), timeoutMs: 100 });
    expect(outcome.ok).toBe(false);

    const childPid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(await waitUntilDead(childPid)).toBe(true);
  });

  test('measures the step duration', async () => {
    const outcome = await runShellStep(shellStep("  - id: a\n    type: shell\n    run: 'true'"), baseCtx());
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('a secret echoed into a declared output is also redacted', async () => {
    // outputs is built from the raw stdout, not from `log` (which is already
    // redacted), so this is a different leak path from `log`/`error` and needs
    // its own check.
    const step = shellStep(
      "  - id: a\n    type: shell\n    run: \"echo '{\\\"token\\\":\\\"'$MY_TOKEN'\\\"}'\"\n    outputs: { token: string }",
    );
    const outcome = await runShellStep(step, { ...baseCtx(), secrets: { MY_TOKEN: 'secret' } });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.outputs.token).toBe(REDACTION);
      expect(JSON.stringify(outcome.outputs)).not.toContain('secret');
    }
  });

  test('a secret echoed into a numeric output fails the step instead of exposing it', async () => {
    // A number cannot be replaced by REDACTION without ceasing to be a
    // number, so here the only honest way out is to fail the step - just like
    // a wrong type in the contract.
    const step = shellStep(
      "  - id: a\n    type: shell\n    run: \"echo '{\\\"code\\\":'$MY_CODE'}'\"\n    outputs: { code: number }",
    );
    const outcome = await runShellStep(step, { ...baseCtx(), secrets: { MY_CODE: '424242' } });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.transient).toBe(false);
      expect(outcome.error).toContain('code');
      expect(outcome.error).not.toContain('424242');
      expect(outcome.log).not.toContain('424242');
    }
  });

  test('a secret echoed inside an array of numbers also fails the step', async () => {
    const step = shellStep(
      "  - id: a\n    type: shell\n    run: \"echo '{\\\"codes\\\":[1,'$MY_CODE',3]}'\"\n    outputs: { codes: \"number[]\" }",
    );
    const outcome = await runShellStep(step, { ...baseCtx(), secrets: { MY_CODE: '424242' } });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.transient).toBe(false);
      expect(outcome.error).toContain('codes');
      expect(outcome.error).not.toContain('424242');
      expect(outcome.log).not.toContain('424242');
    }
  });
});

// Regression of a real production failure: under launchd only the variables
// the plist declares (`PATH`, `HOME`) arrive — never `LANG`/`LC_ALL`.
// Inheriting the locale made subprocesses run in the C locale, where the `.`
// of an ERE matches ONE BYTE; an accented character in UTF-8 is two, so any
// pattern with `.` over accented text failed ONLY under cron and passed by
// hand. The engine fixes the locale instead of inheriting it — same criterion
// as `settingSources: []` and `strictMcpConfig: true`: behavior does not
// depend on the configuration of the machine that runs it.
describe('deterministic locale', () => {
  let previous: { lang?: string; lcAll?: string };

  beforeEach(() => {
    previous = { lang: process.env.LANG, lcAll: process.env.LC_ALL };
  });
  afterEach(() => {
    if (previous.lang === undefined) delete process.env.LANG;
    else process.env.LANG = previous.lang;
    if (previous.lcAll === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = previous.lcAll;
  });

  test('composeEnv fixes C.UTF-8 even if the process carries another locale', () => {
    process.env.LANG = 'ca_ES.UTF-8';
    process.env.LC_ALL = 'ca_ES.UTF-8';
    const env = composeEnv({});
    expect(env.LANG).toBe('C.UTF-8');
    expect(env.LC_ALL).toBe('C.UTF-8');
  });

  test('composeEnv fixes C.UTF-8 even if the process carries none (the launchd case)', () => {
    delete process.env.LANG;
    delete process.env.LC_ALL;
    const env = composeEnv({});
    expect(env.LANG).toBe('C.UTF-8');
    expect(env.LC_ALL).toBe('C.UTF-8');
  });

  test('composeAgentEnv fixes the same locale as composeEnv', () => {
    delete process.env.LANG;
    delete process.env.LC_ALL;
    const env = composeAgentEnv({});
    expect(env.LANG).toBe('C.UTF-8');
    expect(env.LC_ALL).toBe('C.UTF-8');
  });

  // The failure exactly as it happened: `grep -qE` with a `.` where the file has
  // a `Ú` (the Spanish text below is deliberate multibyte test data). Without
  // `LANG` in the process (as under launchd) this returned 1 and skipped the
  // whole pipeline, night after night, without telling anyone.
  test('a shell step matches `.` against a multibyte character with no locale in the process', async () => {
    delete process.env.LANG;
    delete process.env.LC_ALL;
    const outcome = await runShellStep(
      shellStep("  - id: a\n    type: shell\n    run: printf 'Última revisió\\n' | grep -qE '^.ltima revisi.$'"),
      baseCtx(),
    );
    expect(outcome.ok).toBe(true);
  });
});

// Found while validating the notify channel on 2026-08-31: a run with a
// nonexistent `docs_repo` failed with "could not launch the command: ENOENT:
// no such file or directory, posix_spawn 'sh'". The cwd did not exist, but the
// message blames `sh`, and that sends whoever reads it looking for a PATH
// problem that does not exist. The alert email carries that text as is, so it
// is the first thing seen of a nightly failure.
describe('runShellStep with a cwd that does not exist', () => {
  const step = () => shellStep(`
  - id: demo
    type: shell
    cwd: /tmp/ap-cwd-that-never-exists
    run: echo hello
`);

  test('the error names the missing directory', async () => {
    const outcome = await runShellStep(step(), baseCtx());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error).toContain('/tmp/ap-cwd-that-never-exists');
  });

  // The raw system text is NOT thrown away: it is still useful for diagnosis.
  // What is fixed is the ORDER — the first thing read should be the real
  // diagnosis and not the accusation against `sh`, which is the misleading one.
  test('the diagnosis comes first and the system text stays as a quote', async () => {
    const outcome = await runShellStep(step(), baseCtx());
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error.startsWith('the working directory does not exist:')).toBe(true);
    expect(outcome.error).toContain('the system reported');
  });
});
