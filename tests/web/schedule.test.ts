import { describe, expect, test } from 'bun:test';
import { nextRun, nextRunAt } from '../../src/web/schedule.ts';

// Local-time constructor, so the table passes in any timezone.
const local = (y: number, m: number, d: number, h = 0, min = 0): Date => new Date(y, m - 1, d, h, min);
// 2026-10-28 is a Wednesday.
const same = (a: Date | undefined, b: Date) => expect(a?.getTime()).toBe(b.getTime());

describe('nextRunAt', () => {
  test('daily, already passed today: tomorrow', () => {
    same(nextRunAt(['0 8 * * *'], local(2026, 10, 28, 9)), local(2026, 10, 29, 8));
  });
  test('daily, not yet today: today', () => {
    same(nextRunAt(['0 8 * * *'], local(2026, 10, 28, 7, 59)), local(2026, 10, 28, 8));
  });
  test('strictly after now', () => {
    same(nextRunAt(['0 8 * * *'], local(2026, 10, 28, 8)), local(2026, 10, 29, 8));
  });
  test('weekday: next Monday', () => {
    same(nextRunAt(['0 7 * * 1'], local(2026, 10, 28, 9)), local(2026, 11, 2, 7));
  });
  test('weekday 7 is Sunday', () => {
    same(nextRunAt(['0 7 * * 7'], local(2026, 10, 28, 9)), local(2026, 11, 1, 7));
  });
  test('day of month rolls over the year', () => {
    same(nextRunAt(['30 4 1 * *'], local(2026, 12, 31, 10)), local(2027, 1, 1, 4, 30));
  });
  test('several crons: the nearest', () => {
    same(nextRunAt(['0 8 * * *', '0 12 * * *'], local(2026, 10, 28, 9)), local(2026, 10, 28, 12));
  });
  test('any minute and hour: the next minute', () => {
    same(nextRunAt(['* * * * *'], local(2026, 10, 28, 9, 5)), local(2026, 10, 28, 9, 6));
  });
  test('none or untranslatable: undefined', () => {
    expect(nextRunAt([], local(2026, 10, 28))).toBeUndefined();
    expect(nextRunAt(['bad'], local(2026, 10, 28))).toBeUndefined();
    expect(nextRunAt(['0 8 * * *', 'bad'], local(2026, 10, 28))).toBeUndefined();
  });
  test('impossible date gives undefined, not a hang', () => {
    expect(nextRunAt(['0 0 31 2 *'], local(2026, 10, 28))).toBeUndefined();
  });
});

// What the dashboard's right column says about the future depends on the
// trigger axis first and on the cron only after: a cron nobody loaded fires
// nothing, so it gets no time.
describe('nextRun', () => {
  const NOW = local(2026, 10, 28, 9);

  test('loaded or drifted: the next firing, as ISO', () => {
    for (const trigger of ['installed', 'drifted'] as const) {
      expect(nextRun(trigger, ['0 8 * * *'], NOW)).toEqual({ kind: 'at', at: local(2026, 10, 29, 8).toISOString() });
    }
  });

  test('not installed or disabled: none, whatever the cron says', () => {
    expect(nextRun('not-installed', ['0 8 * * *'], NOW)).toEqual({ kind: 'none' });
    expect(nextRun('disabled', ['0 8 * * *'], NOW)).toEqual({ kind: 'none' });
  });

  test('no cron: run by hand', () => {
    expect(nextRun('no-trigger', [], NOW)).toEqual({ kind: 'manual' });
  });

  // Loaded, but the cron can't be walked: an empty instant the renderer draws
  // as a dash, never an invented time.
  test('loaded with a cron that cannot be walked: an empty instant', () => {
    expect(nextRun('installed', ['0 0 31 2 *'], NOW)).toEqual({ kind: 'at', at: '' });
  });
});
