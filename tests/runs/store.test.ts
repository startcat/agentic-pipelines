import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore, redactSecrets } from '../../src/runs/store.ts';

let root: string;
let store: RunStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ap-runs-'));
  store = new RunStore(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('RunStore', () => {
  test('creates a run and leaves it in running status', async () => {
    const run = await store.createRun('demo', 1, { root: '/tmp' });
    expect(run.status).toBe('running');
    expect(run.pipeline).toBe('demo');
    expect(run.pipelineVersion).toBe(1);
    expect(run.params).toEqual({ root: '/tmp' });

    const read = await store.readRun('demo', run.id);
    expect(read?.status).toBe('running');
  });

  test('writes a step and can read it back with its outputs', async () => {
    const run = await store.createRun('demo', 1, {});
    await store.writeStep(run, {
      id: 'scan',
      status: 'success',
      startedAt: new Date().toISOString(),
      durationMs: 1200,
      outputs: { stale_count: 7 },
      effects: [],
      attempts: 1,
    });

    const read = await store.readRun('demo', run.id);
    expect(read!.steps.scan!.status).toBe('success');
    expect(read!.steps.scan!.outputs).toEqual({ stale_count: 7 });
  });

  test('writeStepLog saves the transcript and it can be read back from disk', async () => {
    const run = await store.createRun('demo', 1, {});
    await store.writeStepLog(run, 'scan', 'line 1\nline 2\n');

    const logPath = join(root, '.runs', 'demo', run.id, 'scan.log');
    const contents = await readFile(logPath, 'utf8');
    expect(contents).toBe('line 1\nline 2\n');
  });

  test('state is persisted step by step, not when the run closes', async () => {
    const run = await store.createRun('demo', 1, {});
    await store.writeStep(run, {
      id: 'a',
      status: 'success',
      startedAt: new Date().toISOString(),
      durationMs: 5,
      outputs: {},
      effects: [],
      attempts: 1,
    });
    // Without calling finishRun: simulates a process that dies mid-run.
    const read = await store.readRun('demo', run.id);
    expect(read!.status).toBe('running');
    expect(read!.steps.a!.status).toBe('success');
  });

  test('finishRun sets the final status and the aggregate cost', async () => {
    const run = await store.createRun('demo', 1, {});
    await store.writeStep(run, {
      id: 'a', status: 'success', startedAt: new Date().toISOString(),
      durationMs: 5, outputs: {}, effects: [], attempts: 1, costUsd: 0.04,
    });
    await store.writeStep(run, {
      id: 'b', status: 'success', startedAt: new Date().toISOString(),
      durationMs: 5, outputs: {}, effects: [], attempts: 1, costUsd: 0.31,
    });
    await store.finishRun(run, 'success');

    const read = await store.readRun('demo', run.id);
    expect(read!.status).toBe('success');
    expect(read!.totalCostUsd).toBeCloseTo(0.35, 5);
  });

  test('writeNotify persists the channel trace in run.json', async () => {
    const run = await store.createRun('demo', 1, {});
    await store.finishRun(run, 'success');
    await store.writeNotify(run, {
      channel: 'email', code: 0, at: '2026-09-03T05:00:10.000Z',
      log: 'notify-resend: enviat (200)',
    });
    const read = await store.readRun('demo', run.id);
    expect(read!.notify).toEqual({
      channel: 'email', code: 0, at: '2026-09-03T05:00:10.000Z',
      log: 'notify-resend: enviat (200)',
    });
  });

  test('listRuns returns the runs from newest to oldest', async () => {
    const a = await store.createRun('demo', 1, {});
    await store.finishRun(a, 'success');
    await Bun.sleep(5);
    const b = await store.createRun('demo', 1, {});
    await store.finishRun(b, 'failed');

    const runs = await store.listRuns('demo');
    expect(runs.map((r) => r.id)).toEqual([b.id, a.id]);
  });

  test('lastSuccess ignores failed and skipped runs', async () => {
    const ok = await store.createRun('demo', 1, {});
    await store.finishRun(ok, 'success');
    await Bun.sleep(5);
    const bad = await store.createRun('demo', 1, {});
    await store.finishRun(bad, 'failed');
    await Bun.sleep(5);
    const skip = await store.createRun('demo', 1, {});
    await store.finishRun(skip, 'skipped', 'throttle');

    expect((await store.lastSuccess('demo'))?.id).toBe(ok.id);
  });

  test('lastSuccess returns undefined if there was never a successful run', async () => {
    expect(await store.lastSuccess('never-run')).toBeUndefined();
  });

  test('a skipped run stores the condition that caused it', async () => {
    const run = await store.createRun('demo', 1, {});
    await store.finishRun(run, 'skipped', 'throttle: 4h');
    const read = await store.readRun('demo', run.id);
    expect(read!.status).toBe('skipped');
    expect(read!.skipReason).toBe('throttle: 4h');
  });

  test('lastAttempt returns the most recent attempt even if it is not success, unlike lastSuccess', async () => {
    const ok = await store.createRun('demo', 1, {});
    await store.finishRun(ok, 'success');
    await Bun.sleep(5);
    const bad = await store.createRun('demo', 1, {});
    await store.finishRun(bad, 'failed');

    // The throttle is based on lastSuccess, not on lastAttempt: they
    // must be able to disagree when the most recent attempt was not successful.
    expect((await store.lastAttempt('demo'))?.id).toBe(bad.id);
    expect((await store.lastSuccess('demo'))?.id).toBe(ok.id);
  });

  test('lastAttempt ignores a run still in progress and returns the last finished one', async () => {
    const ok = await store.createRun('demo', 1, {});
    await store.finishRun(ok, 'success');
    await Bun.sleep(5);
    // Without calling finishRun: this run stays in 'running' status.
    await store.createRun('demo', 1, {});

    expect((await store.lastAttempt('demo'))?.id).toBe(ok.id);
  });

  // Before, `lastAttempt` also counted skipped runs, so a pipeline with
  // `throttle: { since: last_attempt }` pushed the anchor of its own window
  // with every tick it skipped itself, and the window never expired.
  // `since: last_attempt` exists to space out WORK — its difference from
  // `last_success` is that it also counts failed attempts —, and a skipped run
  // did no work at all.
  test('lastAttempt ignores a run skipped by a guard', async () => {
    const ok = await store.createRun('demo', 1, {});
    await store.finishRun(ok, 'success');
    await Bun.sleep(5);
    const skippedRun = await store.createRun('demo', 1, {});
    await store.finishRun(skippedRun, 'skipped', 'throttle: 46h');

    expect((await store.lastAttempt('demo'))?.id).toBe(ok.id);
  });

  test('lastAttempt ignores a run skipped by the lock', async () => {
    const ok = await store.createRun('demo', 1, {});
    await store.finishRun(ok, 'failed');
    await Bun.sleep(5);
    const blocked = await store.createRun('demo', 1, {});
    await store.finishRun(blocked, 'skipped', 'already_running');

    expect((await store.lastAttempt('demo'))?.id).toBe(ok.id);
  });

  // The full starvation scenario, which is what happened before the fix: a
  // streak of consecutive skipped ticks cannot move the anchor an inch.
  test('a streak of skips does not move the anchor: the anchor is still the last run that executed', async () => {
    const executed = await store.createRun('demo', 1, {});
    await store.finishRun(executed, 'success');
    for (let i = 0; i < 5; i += 1) {
      await Bun.sleep(2);
      const skippedRun = await store.createRun('demo', 1, {});
      await store.finishRun(skippedRun, 'skipped', 'throttle: 46h');
    }

    expect((await store.lastAttempt('demo'))?.id).toBe(executed.id);
  });

  test('lastAttempt returns undefined if all the runs were skipped', async () => {
    const skippedRun = await store.createRun('demo', 1, {});
    await store.finishRun(skippedRun, 'skipped', 'throttle: 46h');

    expect(await store.lastAttempt('demo')).toBeUndefined();
  });

  test('persist leaves no temporary files in the run directory after successful writes', async () => {
    const run = await store.createRun('demo', 1, {});
    await store.writeStep(run, {
      id: 'a', status: 'success', startedAt: new Date().toISOString(),
      durationMs: 5, outputs: {}, effects: [], attempts: 1,
    });
    await store.finishRun(run, 'success');

    const files = await readdir(join(root, '.runs', 'demo', run.id));
    expect(files).toEqual(['run.json']);
  });

  test('run.json is always complete, parseable JSON after each persist', async () => {
    const run = await store.createRun('demo', 1, {});
    await store.writeStep(run, {
      id: 'a', status: 'success', startedAt: new Date().toISOString(),
      durationMs: 5, outputs: {}, effects: [], attempts: 1,
    });

    const raw = await readFile(join(root, '.runs', 'demo', run.id, 'run.json'), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

describe('redactSecrets', () => {
  test('replaces each secret value with a marker', () => {
    expect(redactSecrets('token=abc123 end', ['abc123'])).toBe('token=[redacted] end');
  });
  test('replaces all occurrences', () => {
    expect(redactSecrets('abc abc', ['abc'])).toBe('[redacted] [redacted]');
  });
  test('ignores empty secrets so as not to wreck the text', () => {
    expect(redactSecrets('hello', [''])).toBe('hello');
  });
  test('does not alter the text if there are no matches', () => {
    expect(redactSecrets('hello', ['zzz'])).toBe('hello');
  });
});
