import { describe, expect, test } from 'bun:test';
import { triggerPeriodMs, evaluateTrigger, evaluateHealth } from '../../src/health/evaluate.ts';
import type { RunRecord } from '../../src/runs/types.ts';
import type { Pipeline } from '../../src/schema/pipeline.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('triggerPeriodMs', () => {
  test('a daily schedule is a 24 h period', () => {
    expect(triggerPeriodMs([{ Minute: 0, Hour: 3 }])).toBe(DAY);
  });

  test('two daily schedules split the day', () => {
    expect(triggerPeriodMs([{ Minute: 0, Hour: 3 }, { Minute: 0, Hour: 15 }])).toBe(DAY / 2);
  });

  test('with no hour pinned, it fires every hour', () => {
    expect(triggerPeriodMs([{ Minute: 0 }])).toBe(HOUR);
  });

  test('with no minute pinned, it fires every minute', () => {
    expect(triggerPeriodMs([{}])).toBe(60_000);
  });

  test('a pinned weekday stretches the period to a week', () => {
    expect(triggerPeriodMs([{ Minute: 0, Hour: 3, Weekday: 1 }])).toBe(7 * DAY);
  });

  test('a pinned day of the month stretches it to an approximate month', () => {
    expect(triggerPeriodMs([{ Minute: 0, Hour: 3, Day: 1 }])).toBe(30 * DAY);
  });
});

const loaded = { loaded: true, disabled: false, artifactOnDisk: 'X', artifactExpected: 'X' };

describe('evaluateTrigger', () => {
  // A manual pipeline is not broken: painting it red would be noise, and noise
  // is what makes nobody look at the dashboard.
  test('with no declared triggers it is no-trigger, not a failure', () => {
    expect(evaluateTrigger(false, { loaded: false, disabled: false })).toBe('no-trigger');
  });

  test('declares cron and there is no job: not-installed', () => {
    expect(evaluateTrigger(true, { loaded: false, disabled: false })).toBe('not-installed');
  });

  // Actionable beats generic: "disabled" says what to do.
  test('disabled rules over not-loaded', () => {
    expect(evaluateTrigger(true, { loaded: false, disabled: true })).toBe('disabled');
  });

  test('loaded and matching: installed', () => {
    expect(evaluateTrigger(true, loaded)).toBe('installed');
  });

  test('loaded but the plist is not the one install would generate today: drifted', () => {
    expect(evaluateTrigger(true, { ...loaded, artifactExpected: 'OTRO' })).toBe('drifted');
  });

  // Only the timestamp differs: that is NOT a drift.
  test('the timestamp does not count as drift', () => {
    expect(
      evaluateTrigger(true, {
        loaded: true,
        disabled: false,
        artifactOnDisk: 'a\n  Generado:  2026-01-01T00:00:00.000Z\nb',
        artifactExpected: 'a\n  Generado:  2026-08-29T00:00:00.000Z\nb',
      }),
    ).toBe('installed');
  });

  // Loaded with no plist on disk is odd but not a provable drift: claiming
  // `drifted` without being able to compare would be making up a diagnosis.
  test('with no plist on disk no drift is claimed', () => {
    expect(evaluateTrigger(true, { loaded: true, disabled: false })).toBe('installed');
  });
});

const NOW = new Date('2026-08-29T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

function run(status: RunRecord['status'], startedAt: string, skipReason?: string): RunRecord {
  return {
    id: startedAt, pipeline: 'demo', pipelineVersion: 1, status,
    startedAt, params: {}, steps: {}, ...(skipReason ? { skipReason } : {}),
  };
}

/** Minimal pipeline: only `triggers` and `name` are read. */
function pipe(cron?: string): Pipeline {
  return { name: 'demo', triggers: cron ? [{ cron }] : [] } as unknown as Pipeline;
}

const installed = { loaded: true, disabled: false };
const nightly = '0 3 * * *'; // window = 48 h

describe('evaluateHealth — work axis', () => {
  test('with no runs it is never-worked, not silent', () => {
    expect(evaluateHealth(pipe(nightly), [], installed, NOW).work).toBe('never-worked');
  });

  test('recent successful work is working', () => {
    const runs = [run('success', hoursAgo(9))];
    expect(evaluateHealth(pipe(nightly), runs, installed, NOW).work).toBe('working');
  });

  test('the last real work failed: failing', () => {
    const runs = [run('failed', hoursAgo(9))];
    expect(evaluateHealth(pipe(nightly), runs, installed, NOW).work).toBe('failing');
  });

  // The ten-nights case: the trigger works, the work doesn't.
  //
  // The guilty guard is no longer read from `health.skipReason` (removed:
  // nobody in production consumed it — the viewer reads `lastRun.skipReason`,
  // the RunRecord's own field, which `evaluateHealth` doesn't need to repeat).
  // This case still tests what gives it its name: that consecutive skips are
  // counted and that the verdict is `stuck`.
  test('it triggers and always skips: stuck, with the skip count', () => {
    const runs = [
      run('skipped', hoursAgo(9), 'shell: tracker guard returned 1'),
      run('skipped', hoursAgo(33), 'shell: tracker guard returned 1'),
      run('success', hoursAgo(240)),
    ];
    const health = evaluateHealth(pipe(nightly), runs, installed, NOW);
    expect(health.work).toBe('stuck');
    expect(health.consecutiveSkips).toBe(2);
  });

  // The case stale_after can't see: not a single run, not even a skipped one.
  test('nothing inside the window: silent', () => {
    const runs = [run('success', hoursAgo(100))];
    expect(evaluateHealth(pipe(nightly), runs, installed, NOW).work).toBe('silent');
  });

  test('a manual pipeline is never stuck or silent', () => {
    const runs = [run('success', hoursAgo(500))];
    const health = evaluateHealth(pipe(), runs, { loaded: false, disabled: false }, NOW);
    expect(health.work).toBe('working');
    expect(health.windowMs).toBeUndefined();
  });

  // Neither launchd nor .runs/ detects this on its own.
  test('installed + silent is the contradiction that must be shouted', () => {
    const runs = [run('success', hoursAgo(100))];
    expect(evaluateHealth(pipe(nightly), runs, installed, NOW).contradiction).toBe(true);
  });

  // A DRIFTED plist is STILL loaded in launchd: the drift says it is not the
  // one `install` would generate today, not that it doesn't fire. Requiring
  // exactly `installed` left this box without an alarm and, worse, without the
  // job log's tail — which `server.ts` only reads when `contradiction` is true,
  // and which is the only trace of an engine that dies before writing
  // `run.json`.
  test('drifted + silent is the same contradiction: the drifted plist also fires', () => {
    const runs = [run('success', hoursAgo(100))];
    const drifted = { loaded: true, disabled: false, artifactOnDisk: 'X', artifactExpected: 'OTRO' };
    const health = evaluateHealth(pipe(nightly), runs, drifted, NOW);
    expect(health.trigger).toBe('drifted');
    expect(health.work).toBe('silent');
    expect(health.contradiction).toBe(true);
  });

  // The alarm belongs to the CROSSING, not to a single axis: a drifted plist
  // that works normally is a drift, not a contradiction.
  test('drifted and working is not a contradiction', () => {
    const runs = [run('success', hoursAgo(9))];
    const drifted = { loaded: true, disabled: false, artifactOnDisk: 'X', artifactExpected: 'OTRO' };
    const health = evaluateHealth(pipe(nightly), runs, drifted, NOW);
    expect(health.trigger).toBe('drifted');
    expect(health.contradiction).toBe(false);
  });

  test('disabled and silent is not a contradiction: it is coherent', () => {
    const runs = [run('success', hoursAgo(100))];
    const health = evaluateHealth(pipe(nightly), runs, { loaded: false, disabled: true }, NOW);
    expect(health.trigger).toBe('disabled');
    expect(health.contradiction).toBe(false);
  });

  test('not-installed and silent is not a contradiction: it is coherent', () => {
    const runs = [run('success', hoursAgo(100))];
    const health = evaluateHealth(pipe(nightly), runs, { loaded: false, disabled: false }, NOW);
    expect(health.work).toBe('silent');
    expect(health.contradiction).toBe(false);
  });

  // `cronToCalendarIntervals` throws on syntax that launchd's subset doesn't
  // support (here, the "/15" step). Such a pipeline.yaml can't be installed,
  // but it can exist in the repo — and an exception here would take down the
  // whole dashboard, the one place meant so that nothing fails silently.
  test('a cron with syntax launchd does not support does not blow up the dashboard', () => {
    const runs = [run('success', hoursAgo(9))];
    const health = evaluateHealth(pipe('*/15 * * * *'), runs, installed, NOW);
    expect(health.windowMs).toBeUndefined();
    expect(health.work).toBe('working');
  });
});
