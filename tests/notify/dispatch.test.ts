import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePipeline } from '../../src/schema/pipeline.ts';
import { parseRepoConfig } from '../../src/schema/config.ts';
import type { RepoContext } from '../../src/cli/context.ts';
import type { RunRecord } from '../../src/runs/types.ts';
import { dispatchNotify, failureReason } from '../../src/notify/dispatch.ts';

function repoCtx(configYaml: string, dotEnv: Record<string, string> = {}): RepoContext {
  return { root: mkdtempSync(join(tmpdir(), 'ap-notify-')), config: parseRepoConfig(configYaml), dotEnv };
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: '2026-08-17T00-00-00-000Z',
    pipeline: 'demo',
    pipelineVersion: 1,
    status: 'success',
    startedAt: '2026-08-17T00:00:00.000Z',
    params: {},
    steps: {},
    ...overrides,
  };
}

const PIPELINE_WITH_NOTIFY = parsePipeline(`
name: demo
description: d
version: 1
notify:
  on: [success, failed]
  channel: email
steps:
  - id: a
    type: shell
    run: 'true'
`);

const PIPELINE_NO_NOTIFY = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: 'true'
`);

describe('dispatchNotify', () => {
  test('does nothing if the pipeline does not declare notify', async () => {
    let called = false;
    const ctx = repoCtx('channels: {}\n');
    await dispatchNotify(PIPELINE_NO_NOTIFY, run(), ctx, { spawnChannel: async () => { called = true; return { code: 0, log: '' }; } });
    expect(called).toBe(false);
  });

  test('does nothing if run.status is not in notify.on', async () => {
    let called = false;
    const ctx = repoCtx('channels:\n  email:\n    type: shell\n    run: notify.sh\n');
    await dispatchNotify(PIPELINE_WITH_NOTIFY, run({ status: 'skipped' }), ctx, { spawnChannel: async () => { called = true; return { code: 0, log: '' }; } });
    expect(called).toBe(false);
  });

  test('invokes the channel when run.status is in notify.on', async () => {
    let receivedCommand = '';
    const ctx = repoCtx('channels:\n  email:\n    type: shell\n    run: notify.sh\n');
    await dispatchNotify(PIPELINE_WITH_NOTIFY, run({ status: 'success' }), ctx, {
      spawnChannel: async (command) => {
        receivedCommand = command;
        return { code: 0, log: '' };
      },
    });
    expect(receivedCommand).toBe('notify.sh');
  });

  test('passes name, run-id, status and reason as environment variables', async () => {
    let receivedEnv: Record<string, string> = {};
    const ctx = repoCtx('channels:\n  email:\n    type: shell\n    run: notify.sh\n');
    await dispatchNotify(
      PIPELINE_WITH_NOTIFY,
      run({ status: 'failed', skipReason: undefined }),
      ctx,
      { spawnChannel: async (_cmd, env) => { receivedEnv = env; return { code: 0, log: '' }; } },
    );
    expect(receivedEnv.PIPELINES_NOTIFY_NAME).toBe('demo');
    expect(receivedEnv.PIPELINES_NOTIFY_RUN_ID).toBe('2026-08-17T00-00-00-000Z');
    expect(receivedEnv.PIPELINES_NOTIFY_STATUS).toBe('failed');
    expect(receivedEnv.PIPELINES_NOTIFY_REASON).toBe('');
  });

  test('a skipped run with a reason passes it in PIPELINES_NOTIFY_REASON', async () => {
    let receivedEnv: Record<string, string> = {};
    const pipeline = parsePipeline(`
name: demo
description: d
version: 1
notify:
  on: [skipped]
  channel: email
steps:
  - id: a
    type: shell
    run: 'true'
`);
    const ctx = repoCtx('channels:\n  email:\n    type: shell\n    run: notify.sh\n');
    await dispatchNotify(
      pipeline,
      run({ status: 'skipped', skipReason: 'throttle: 4h' }),
      ctx,
      { spawnChannel: async (_cmd, env) => { receivedEnv = env; return { code: 0, log: '' }; } },
    );
    expect(receivedEnv.PIPELINES_NOTIFY_REASON).toBe('throttle: 4h');
  });

  test('resolves the secrets declared in the env: of the channel', async () => {
    let receivedEnv: Record<string, string> = {};
    const ctx = repoCtx(
      'channels:\n  email:\n    type: shell\n    run: notify.sh\n    env: [RESEND_API_KEY]\n',
      { RESEND_API_KEY: 're_test_123' },
    );
    await dispatchNotify(
      PIPELINE_WITH_NOTIFY,
      run({ status: 'success' }),
      ctx,
      { spawnChannel: async (_cmd, env) => { receivedEnv = env; return { code: 0, log: '' }; } },
    );
    expect(receivedEnv.RESEND_API_KEY).toBe('re_test_123');
  });

  test('throws if the channel declared in notify.channel does not exist in pipelines.yaml', async () => {
    const ctx = repoCtx('channels: {}\n');
    await expect(
      dispatchNotify(PIPELINE_WITH_NOTIFY, run({ status: 'success' }), ctx, { spawnChannel: async () => ({ code: 0, log: '' }) }),
    ).rejects.toThrow(/email/);
  });

  test('throws if the channel exits with a non-zero code', async () => {
    const ctx = repoCtx('channels:\n  email:\n    type: shell\n    run: notify.sh\n');
    await expect(
      dispatchNotify(PIPELINE_WITH_NOTIFY, run({ status: 'success' }), ctx, { spawnChannel: async () => ({ code: 1, log: '' }) }),
    ).rejects.toThrow(/email/);
  });
});

// `stale_after`: the signal that was missing. A bare `notify.on: [skipped]` is
// noise — with `throttle: 46h` on a daily cron, half the nights skip by
// design. What you need to know is not "it skipped", it is "it has gone too
// long without really running", which is what went unnoticed for ten nights
// with docs-review.
const PIPELINE_STALE = parsePipeline(`
name: demo
description: d
version: 1
notify:
  on: [success, failed]
  stale_after: 72h
  channel: email
steps:
  - id: a
    type: shell
    run: 'true'
`);

const CHANNEL_CONFIG = 'channels:\n  email:\n    type: shell\n    run: "true"\n';

describe('dispatchNotify — stale_after', () => {
  test('a skipped run fires the channel if there is no success within the window', async () => {
    let called = false;
    const ctx = repoCtx(CHANNEL_CONFIG);
    await dispatchNotify(
      PIPELINE_STALE,
      run({ status: 'skipped', skipReason: 'throttle: 46h' }),
      ctx,
      {
        lastSuccessAt: '2026-08-10T00:00:00.000Z', // 7 days before the run
        spawnChannel: async () => { called = true; return { code: 0, log: '' }; },
      },
    );
    expect(called).toBe(true);
  });

  test('a skipped run does NOT fire the channel if there was a success within the window', async () => {
    let called = false;
    const ctx = repoCtx(CHANNEL_CONFIG);
    await dispatchNotify(
      PIPELINE_STALE,
      run({ status: 'skipped', skipReason: 'throttle: 46h' }),
      ctx,
      {
        lastSuccessAt: '2026-08-16T12:00:00.000Z', // 12 h before the run
        spawnChannel: async () => { called = true; return { code: 0, log: '' }; },
      },
    );
    expect(called).toBe(false);
  });

  test('a skipped run fires the channel if the pipeline has never had a success', async () => {
    let called = false;
    const ctx = repoCtx(CHANNEL_CONFIG);
    await dispatchNotify(
      PIPELINE_STALE,
      run({ status: 'skipped', skipReason: 'already_running' }),
      ctx,
      { spawnChannel: async () => { called = true; return { code: 0, log: '' }; } },
    );
    expect(called).toBe(true);
  });

  test('without a declared stale_after, a skipped run never fires the channel', async () => {
    let called = false;
    const ctx = repoCtx(CHANNEL_CONFIG);
    await dispatchNotify(
      PIPELINE_WITH_NOTIFY,
      run({ status: 'skipped', skipReason: 'throttle: 46h' }),
      ctx,
      { spawnChannel: async () => { called = true; return { code: 0, log: '' }; } },
    );
    expect(called).toBe(false);
  });

  test('the channel receives STALE and LAST_SUCCESS so it can write the warning', async () => {
    let received: Record<string, string> = {};
    const ctx = repoCtx(CHANNEL_CONFIG);
    await dispatchNotify(
      PIPELINE_STALE,
      run({ status: 'skipped', skipReason: 'throttle: 46h' }),
      ctx,
      {
        lastSuccessAt: '2026-08-10T00:00:00.000Z',
        spawnChannel: async (_cmd, env) => { received = env; return { code: 0, log: '' }; },
      },
    );
    expect(received.PIPELINES_NOTIFY_STALE).toBe('1');
    expect(received.PIPELINES_NOTIFY_LAST_SUCCESS).toBe('2026-08-10T00:00:00.000Z');
  });

  test('a normal successful run carries an empty STALE and its own success as LAST_SUCCESS', async () => {
    let received: Record<string, string> = {};
    const ctx = repoCtx(CHANNEL_CONFIG);
    await dispatchNotify(
      PIPELINE_STALE,
      run({ status: 'success' }),
      ctx,
      {
        lastSuccessAt: '2026-08-17T00:00:00.000Z', // the run itself
        spawnChannel: async (_cmd, env) => { received = env; return { code: 0, log: '' }; },
      },
    );
    expect(received.PIPELINES_NOTIFY_STALE).toBe('');
    expect(received.PIPELINES_NOTIFY_LAST_SUCCESS).toBe('2026-08-17T00:00:00.000Z');
  });
});

// Until now, an email for a failed run said "(sense motiu registrat)" ("no
// reason recorded", in Catalan): the engine only filled in REASON for guard
// skips, and the channel tried to derive the reason by calling `pipelines
// show`, which is not installed as a binary. The warning arrived, but it did
// not say enough to act without going to look at `.runs/` by hand.
describe('dispatchNotify: channel trace', () => {
  const CTX_YAML = 'channels:\n  email:\n    type: shell\n    run: ./notify.sh\n    env: [RESEND_API_KEY]\n';

  test('returns channel, code, instant and the channel output', async () => {
    const ctx = repoCtx(CTX_YAML);
    const result = await dispatchNotify(PIPELINE_WITH_NOTIFY, run(), ctx, {
      spawnChannel: async () => ({ code: 0, log: 'notify-resend: enviat (200): [pipelines] demo OK\n' }),
    });
    expect(result).toMatchObject({
      channel: 'email',
      code: 0,
      log: 'notify-resend: enviat (200): [pipelines] demo OK',
    });
    expect(typeof result?.at).toBe('string');
    expect(Number.isNaN(Date.parse(result!.at))).toBe(false);
  });

  test('returns undefined when the channel is not invoked', async () => {
    const ctx = repoCtx('channels: {}\n');
    const result = await dispatchNotify(PIPELINE_NO_NOTIFY, run(), ctx, {
      spawnChannel: async () => ({ code: 0, log: 'should not get here' }),
    });
    expect(result).toBeUndefined();
  });

  test('redacts the channel secrets in the stored output', async () => {
    const ctx = repoCtx(CTX_YAML, { RESEND_API_KEY: 're_very_secret' });
    const result = await dispatchNotify(PIPELINE_WITH_NOTIFY, run(), ctx, {
      spawnChannel: async () => ({ code: 0, log: 'curl -H Bearer re_very_secret\n' }),
    });
    expect(result!.log).not.toContain('re_very_secret');
    expect(result!.log).toContain('[redacted]');
  });

  test('keeps only the tail of an oversized output', async () => {
    const ctx = repoCtx(CTX_YAML);
    const result = await dispatchNotify(PIPELINE_WITH_NOTIFY, run(), ctx, {
      spawnChannel: async () => ({ code: 0, log: 'x'.repeat(5000) + 'FINAL' }),
    });
    expect(result!.log.length).toBeLessThanOrEqual(2000);
    expect(result!.log.endsWith('FINAL')).toBe(true);
  });

  test('a channel that exits with an error throws, but the exception carries the trace', async () => {
    const ctx = repoCtx(CTX_YAML);
    let thrown: unknown;
    try {
      await dispatchNotify(PIPELINE_WITH_NOTIFY, run(), ctx, {
        spawnChannel: async () => ({ code: 1, log: 'notify-resend: FALLIT (422)\n' }),
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('code 1');
    expect((thrown as { notify?: { code: number; log: string } }).notify).toMatchObject({
      code: 1,
      log: 'notify-resend: FALLIT (422)',
    });
  });
});

describe('failureReason', () => {
  const withSteps = (steps: RunRecord['steps']): RunRecord => run({ status: 'failed', steps });

  test('names the step that failed and its error', () => {
    const reason = failureReason(
      withSteps({
        build: { id: 'build', status: 'failed', startedAt: '', durationMs: 0, outputs: {}, effects: [], attempts: 1, error: 'yarn build failed' },
      }),
    );
    expect(reason).toBe('build: yarn build failed');
  });

  test('with several failed steps it names them all', () => {
    const reason = failureReason(
      withSteps({
        build: { id: 'build', status: 'failed', startedAt: '', durationMs: 0, outputs: {}, effects: [], attempts: 1, error: 'a' },
        push: { id: 'push', status: 'failed', startedAt: '', durationMs: 0, outputs: {}, effects: [], attempts: 1, error: 'b' },
      }),
    );
    expect(reason).toBe('build: a; push: b');
  });

  test('ignores the successful and skipped steps', () => {
    const reason = failureReason(
      withSteps({
        ok: { id: 'ok', status: 'success', startedAt: '', durationMs: 0, outputs: {}, effects: [], attempts: 1 },
        skipped_step: { id: 'skipped_step', status: 'skipped', startedAt: '', durationMs: 0, outputs: {}, effects: [], attempts: 0 },
        build: { id: 'build', status: 'failed', startedAt: '', durationMs: 0, outputs: {}, effects: [], attempts: 1, error: 'x' },
      }),
    );
    expect(reason).toBe('build: x');
  });

  test('a failed step with no error message is named anyway', () => {
    const reason = failureReason(
      withSteps({
        build: { id: 'build', status: 'failed', startedAt: '', durationMs: 0, outputs: {}, effects: [], attempts: 1 },
      }),
    );
    expect(reason).toBe('build: (no error message)');
  });

  // An error from an agent step can take thousands of characters. An email that
  // can't be read informs of nothing.
  test('truncates an oversized reason instead of sending it whole', () => {
    const reason = failureReason(
      withSteps({
        redact: { id: 'redact', status: 'failed', startedAt: '', durationMs: 0, outputs: {}, effects: [], attempts: 1, error: 'x'.repeat(2000) },
      }),
    );
    expect(reason.length).toBeLessThanOrEqual(503);
    expect(reason.endsWith('…')).toBe(true);
  });

  // A run can end `failed` with no step in `failed` (something that blows up
  // before or between steps). Returning an empty string lets the channel fall
  // back to its own fallback instead of inventing a reason.
  test('with no failed step returns an empty string', () => {
    expect(failureReason(withSteps({}))).toBe('');
  });
});

describe('dispatchNotify — reason of a failed run', () => {
  test('the channel receives the step that failed in REASON', async () => {
    let received: Record<string, string> = {};
    const ctx = repoCtx(CHANNEL_CONFIG);
    await dispatchNotify(
      PIPELINE_WITH_NOTIFY,
      run({
        status: 'failed',
        steps: {
          build: { id: 'build', status: 'failed', startedAt: '', durationMs: 0, outputs: {}, effects: [], attempts: 1, error: 'yarn build failed' },
        },
      }),
      ctx,
      { spawnChannel: async (_cmd, env) => { received = env; return { code: 0, log: '' }; } },
    );
    expect(received.PIPELINES_NOTIFY_REASON).toBe('build: yarn build failed');
  });

  // The guard's reason still wins: a skipped run has no failed steps to look
  // at, and its real reason is the guard.
  test('an existing skipReason takes precedence over the steps', async () => {
    let received: Record<string, string> = {};
    const ctx = repoCtx(CHANNEL_CONFIG);
    await dispatchNotify(
      parsePipeline(`
name: demo
description: d
version: 1
notify:
  on: [skipped]
  channel: email
steps:
  - id: a
    type: shell
    run: 'true'
`),
      run({ status: 'skipped', skipReason: 'throttle: 46h' }),
      ctx,
      { spawnChannel: async (_cmd, env) => { received = env; return { code: 0, log: '' }; } },
    );
    expect(received.PIPELINES_NOTIFY_REASON).toBe('throttle: 46h');
  });
});
