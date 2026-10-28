import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePipeline } from '../../src/schema/pipeline.ts';
import { RunStore } from '../../src/runs/store.ts';
import { evaluateGuards, parseDuration } from '../../src/guards/evaluate.ts';

let root: string;
let store: RunStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ap-guards-'));
  store = new RunStore(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const withGuards = (guards: string) =>
  parsePipeline(`
name: demo
description: d
version: 1
when:
${guards}
steps:
  - id: a
    type: shell
    run: 'true'
`);

describe('parseDuration', () => {
  test('converts seconds, minutes and hours to milliseconds', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('4h')).toBe(14_400_000);
  });
});

describe('evaluateGuards — throttle', () => {
  test('passes when there has never been a successful run', async () => {
    const result = await evaluateGuards(withGuards('  - throttle: 4h'), {
      store, params: {}, now: new Date(),
    });
    expect(result.pass).toBe(true);
  });

  test('blocks if the last successful run is more recent than the window', async () => {
    const run = await store.createRun('demo', 1, {}, new Date('2026-08-05T10:00:00Z'));
    await store.finishRun(run, 'success');
    const result = await evaluateGuards(withGuards('  - throttle: 4h'), {
      store, params: {}, now: new Date('2026-08-05T12:00:00Z'),
    });
    expect(result.pass).toBe(false);
    if (!result.pass) expect(result.reason).toContain('throttle');
  });

  test('passes if the last successful run is older than the window', async () => {
    const run = await store.createRun('demo', 1, {}, new Date('2026-08-05T02:00:00Z'));
    await store.finishRun(run, 'success');
    const result = await evaluateGuards(withGuards('  - throttle: 4h'), {
      store, params: {}, now: new Date('2026-08-05T12:00:00Z'),
    });
    expect(result.pass).toBe(true);
  });

  test('a FAILED run does not consume the window', async () => {
    const run = await store.createRun('demo', 1, {}, new Date('2026-08-05T11:00:00Z'));
    await store.finishRun(run, 'failed');
    const result = await evaluateGuards(withGuards('  - throttle: 4h'), {
      store, params: {}, now: new Date('2026-08-05T12:00:00Z'),
    });
    expect(result.pass).toBe(true);
  });

  test('with since: last_attempt a failed run DOES consume the window', async () => {
    const run = await store.createRun('demo', 1, {}, new Date('2026-08-05T11:00:00Z'));
    await store.finishRun(run, 'failed');
    const result = await evaluateGuards(
      withGuards('  - throttle: { every: 4h, since: last_attempt }'),
      { store, params: {}, now: new Date('2026-08-05T12:00:00Z') },
    );
    expect(result.pass).toBe(false);
  });
});

describe('evaluateGuards — shell', () => {
  test('passes with exit code 0', async () => {
    // NOTE: quoted on purpose. An unquoted `shell: true` is a YAML boolean,
    // not the string "true", and the schema requires
    // `shell: z.string()` — without quotes, parsePipeline would throw before
    // reaching evaluateGuards (the same quotes are already used further down,
    // in the "combination" block).
    const result = await evaluateGuards(withGuards('  - shell: "true"'), {
      store, params: {}, now: new Date(), runShell: async () => 0,
    });
    expect(result.pass).toBe(true);
  });

  test('blocks with a non-zero exit code', async () => {
    const result = await evaluateGuards(withGuards('  - shell: "false"'), {
      store, params: {}, now: new Date(), runShell: async () => 1,
    });
    expect(result.pass).toBe(false);
  });

  test('interpolates params into the command via an environment variable', async () => {
    let receivedCommand = '';
    let receivedEnv: Record<string, string> = {};
    await evaluateGuards(withGuards('  - shell: test -d {{params.root}}'), {
      store, params: { root: '/srv' }, now: new Date(),
      runShell: async (cmd, env) => { receivedCommand = cmd; receivedEnv = env; return 0; },
    });
    expect(receivedCommand).toBe('test -d ${__PIPELINES_REF_0}');
    expect(receivedEnv.__PIPELINES_REF_0).toBe('/srv');
  });

  test('a param value with shell metacharacters is not executed (environment indirection)', async () => {
    let receivedCommand = '';
    const result = await evaluateGuards(withGuards('  - shell: "echo {{params.text}}"'), {
      store, params: { text: '$(touch pwned.txt)' }, now: new Date(),
      runShell: async (cmd) => { receivedCommand = cmd; return 0; },
    });
    expect(result.pass).toBe(true);
    expect(receivedCommand).not.toContain('touch');
  });

  test('the failure reason uses the guard\'s declared text, not the interpolated value', async () => {
    const result = await evaluateGuards(
      withGuards('  - shell: test -d {{params.secret}}'),
      {
        store, params: { secret: 'super-secret' }, now: new Date(),
        runShell: async () => 1,
      },
    );
    expect(result.pass).toBe(false);
    if (!result.pass) {
      expect(result.reason).toContain('{{params.secret}}');
      expect(result.reason).not.toContain('super-secret');
    }
  });

  // Unlike all the previous tests in this describe, here NO test `runShell`
  // is injected: without that option, `evaluateGuards` falls back to the real
  // `defaultRunShell` (`src/guards/evaluate.ts`), which really does
  // `Bun.spawn(['sh', '-c', command], { env: { ...composeEnv({}), ...env } })`.
  // No other test in this file exercises that real plumbing — they all
  // stubbed the entry point with a test `runShell`. The param value contains
  // `$(...)` (shell metacharacters): if the engine fell back to raw text
  // substitution instead of environment indirection, `sh` would evaluate
  // `$(echo BBB)` BEFORE `grep` saw anything and the fixed pattern (`-F`)
  // would stop finding the literal — the guard would fail instead of
  // passing. Same pattern as the injection test in
  // `tests/runner/shell.test.ts` (`shell` step), applied here to the real
  // production path of the `shell:` guard.
  test('without a runShell stub, the real defaultRunShell passes the value through env, not through text substitution (integration)', async () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
when:
  - shell: "echo {{params.text}} | grep -qF 'AAA$(echo BBB)CCC'"
steps:
  - id: a
    type: shell
    run: 'true'
`);
    const result = await evaluateGuards(p, {
      store,
      params: { text: 'AAA$(echo BBB)CCC' },
      now: new Date(),
      // No `runShell`: the real production `defaultRunShell` is exercised.
    });
    expect(result.pass).toBe(true);
  });
});

describe('evaluateGuards — between', () => {
  test('passes inside the time window', async () => {
    const result = await evaluateGuards(withGuards('  - between: "07:00-23:00"'), {
      store, params: {}, now: new Date('2026-08-05T12:00:00'),
    });
    expect(result.pass).toBe(true);
  });

  test('blocks outside the time window', async () => {
    const result = await evaluateGuards(withGuards('  - between: "07:00-23:00"'), {
      store, params: {}, now: new Date('2026-08-05T03:00:00'),
    });
    expect(result.pass).toBe(false);
  });

  test('supports windows that cross midnight', async () => {
    const result = await evaluateGuards(withGuards('  - between: "22:00-06:00"'), {
      store, params: {}, now: new Date('2026-08-05T02:00:00'),
    });
    expect(result.pass).toBe(true);
  });
});

describe('evaluateGuards — changed', () => {
  test('passes when there are changes since the last successful run', async () => {
    const run = await store.createRun('demo', 1, {}, new Date('2026-08-05T02:00:00Z'));
    await store.finishRun(run, 'success');
    const result = await evaluateGuards(
      withGuards('  - changed: { path: "{{params.root}}" }'),
      {
        store, params: { root: '/srv/docs' }, now: new Date(),
        gitChangedSince: async () => true,
      },
    );
    expect(result.pass).toBe(true);
  });

  test('blocks when there are no changes', async () => {
    const run = await store.createRun('demo', 1, {}, new Date('2026-08-05T02:00:00Z'));
    await store.finishRun(run, 'success');
    const result = await evaluateGuards(
      withGuards('  - changed: { path: "{{params.root}}" }'),
      {
        store, params: { root: '/srv/docs' }, now: new Date(),
        gitChangedSince: async () => false,
      },
    );
    expect(result.pass).toBe(false);
  });

  test('passes when there has never been a successful run to compare against', async () => {
    const result = await evaluateGuards(
      withGuards('  - changed: { path: "/srv" }'),
      { store, params: {}, now: new Date(), gitChangedSince: async () => false },
    );
    expect(result.pass).toBe(true);
  });

  test('the failure reason uses the guard\'s declared text, not the interpolated value', async () => {
    const run = await store.createRun('demo', 1, {}, new Date('2026-08-05T02:00:00Z'));
    await store.finishRun(run, 'success');
    const result = await evaluateGuards(
      withGuards('  - changed: { path: "{{params.secret}}" }'),
      {
        store, params: { secret: 'super-secret' }, now: new Date(),
        gitChangedSince: async () => false,
      },
    );
    expect(result.pass).toBe(false);
    if (!result.pass) {
      expect(result.reason).toContain('{{params.secret}}');
      expect(result.reason).not.toContain('super-secret');
    }
  });
});

describe('evaluateGuards — combination', () => {
  test('all guards must pass', async () => {
    const result = await evaluateGuards(
      withGuards('  - throttle: 4h\n  - shell: "false"'),
      { store, params: {}, now: new Date(), runShell: async () => 1 },
    );
    expect(result.pass).toBe(false);
  });

  test('a pipeline without guards always passes', async () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: 'true'
`);
    expect((await evaluateGuards(p, { store, params: {}, now: new Date() })).pass).toBe(true);
  });
});

// Guards run through the same `sh -c` as a `run:` step, so they carried the
// same inherited-locale defect — and in fact it was a guard, not a step,
// that skipped a pipeline ten nights in a row in production. These two
// tests exercise the REAL `defaultRunShell` (without injecting `runShell`),
// which is where the fix lives.
describe('evaluateGuards — subprocess environment (integration)', () => {
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

  test('a guard matches `.` against a multibyte character with no locale in the process', async () => {
    delete process.env.LANG;
    delete process.env.LC_ALL;
    const result = await evaluateGuards(
      withGuards(`  - shell: "printf 'Última revisió\\\\n' | grep -qE '^.ltima revisi.$'"`),
      { store, params: {}, now: new Date() },
    );
    expect(result.pass).toBe(true);
  });

  test('a guard does not see a process variable outside the minimal base', async () => {
    process.env.AP_TEST_VARIABLE = 'should-not-pass';
    const result = await evaluateGuards(withGuards('  - shell: "test -n \\"$AP_TEST_VARIABLE\\""'), {
      store,
      params: {},
      now: new Date(),
    });
    delete process.env.AP_TEST_VARIABLE;
    expect(result.pass).toBe(false);
  });
});
