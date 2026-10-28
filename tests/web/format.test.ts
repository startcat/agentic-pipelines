import { describe, expect, test } from 'bun:test';
import { formatWhen, formatDuration, formatBytes, money, usd, describeCron, formatNext, formatFull } from '../../src/web/format.ts';

/**
 * Dates are built in LOCAL time, not as UTC strings: `formatWhen` speaks in
 * the time of whoever is looking at the screen, and pinning "13:42" for an ISO
 * in Z would tie this table to this machine's timezone.
 */
const local = (y: number, m: number, d: number, h: number, min = 0): Date => new Date(y, m - 1, d, h, min);
const NOW = local(2026, 8, 31, 13, 56);

describe('formatWhen', () => {
  test('the same day is "today" and the local time', () => {
    expect(formatWhen(local(2026, 8, 31, 13, 42).toISOString(), NOW)).toEqual({ day: 'today', time: '13:42' });
  });

  test('the time always has two digits', () => {
    expect(formatWhen(local(2026, 8, 31, 3, 0).toISOString(), NOW).time).toBe('03:00');
  });

  test('the previous day is "yesterday"', () => {
    expect(formatWhen(local(2026, 8, 30, 1, 0).toISOString(), NOW).day).toBe('yesterday');
  });

  // Within the week the weekday is said; further back, the date. A dashboard
  // looked at for thirty seconds shouldn't make you count days backwards.
  test('within the week it gives the weekday', () => {
    expect(formatWhen(local(2026, 8, 27, 1, 0).toISOString(), NOW).day).toBe('Thu');
  });

  test('further back it gives day and month', () => {
    expect(formatWhen(local(2026, 8, 19, 12, 9).toISOString(), NOW).day).toBe('Aug 19');
  });

  // 23 h earlier can fall on the same calendar day, and 25 h earlier on
  // "yesterday": the cut is by calendar day, not by dividing milliseconds.
  test('the cut is by calendar day, not by 24 hours', () => {
    expect(formatWhen(local(2026, 8, 31, 0, 30).toISOString(), NOW).day).toBe('today');
    expect(formatWhen(local(2026, 8, 30, 23, 30).toISOString(), NOW).day).toBe('yesterday');
  });

  test('with no date it makes nothing up', () => {
    expect(formatWhen(undefined, NOW)).toEqual({ day: '—', time: '' });
  });

  // `run.json` is not validated when read (RunStore.readRun does an `as`), so
  // a corrupt date is ordinary I/O, not an impossibility.
  test('an unreadable date does not blow up', () => {
    expect(formatWhen('not-a-date', NOW)).toEqual({ day: '—', time: '' });
  });
});

describe('formatDuration', () => {
  test('under a minute goes in seconds', () => {
    expect(formatDuration(14_000)).toBe('14s');
  });

  test('from a minute up, minutes and seconds', () => {
    expect(formatDuration(470_000)).toBe('7m 50s');
  });

  test('zero is zero, not empty', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  test('a negative duration does not print a minus', () => {
    expect(formatDuration(-5)).toBe('0s');
  });

  // A run stuck in "running" since last week would otherwise read "10081m 0s".
  test('from an hour up, hours and minutes; from a day up, days and hours', () => {
    expect(formatDuration(3_600_000 + 5 * 60_000 + 9_000)).toBe('1h 5m');
    expect(formatDuration(7 * 86_400_000 + 3 * 3_600_000)).toBe('7d 3h');
  });
});

describe('money', () => {
  test('two decimals with a dollar sign', () => {
    expect(money(4.492596500000001)).toBe('$4.49');
  });

  // A `shell` step costs nothing: the cell stays empty, it doesn't say "$0.00".
  test('no cost is the empty string', () => {
    expect(money(undefined)).toBe('');
    expect(money(0)).toBe('');
  });

  // `run.json` is read with no validation: a hand-edited cost reached
  // `toFixed` and took down every page that lists the run.
  test('a cost that is not a finite number is empty, never a throw', () => {
    for (const bad of ['x', '1.5', null, NaN, Infinity, {}, []]) {
      expect(money(bad)).toBe('');
      expect(usd(bad)).toBe('');
    }
    expect(usd(0)).toBe('$0.00');
  });
});

describe('describeCron', () => {
  test('the real cadence of docs is said in words', () => {
    expect(describeCron(['0 3 * * *'])).toBe('every night at 03:00');
  });

  test('a daytime hour is not "night"', () => {
    expect(describeCron(['30 14 * * *'])).toBe('every day at 14:30');
  });

  test('with a weekday it says so', () => {
    expect(describeCron(['0 9 * * 1'])).toBe('every Monday at 09:00');
  });

  test('Monday to Friday at one time is "every weekday", as a range or as a list', () => {
    expect(describeCron(['0 7 * * 1-5'])).toBe('every weekday at 07:00');
    expect(describeCron(['0 7 * * 1,2,3,4,5'])).toBe('every weekday at 07:00');
  });

  test('Saturday and Sunday at one time is "every weekend"', () => {
    expect(describeCron(['30 10 * * 6,0'])).toBe('every weekend at 10:30');
    expect(describeCron(['30 10 * * 0,6'])).toBe('every weekend at 10:30');
    expect(describeCron(['30 10 * * 6,7'])).toBe('every weekend at 10:30');
  });

  test('any other set of weekdays is listed, Monday first', () => {
    expect(describeCron(['0 7 * * 5,1,3'])).toBe('every Mon, Wed and Fri at 07:00');
    expect(describeCron(['0 7 * * 0,2'])).toBe('every Tue and Sun at 07:00');
  });

  test('all seven weekdays is every day, with the same night rule', () => {
    expect(describeCron(['0 3 * * 0-6'])).toBe('every night at 03:00');
    expect(describeCron(['0 9 * * 1-7'])).toBe('every day at 09:00');
  });

  // Several times of day, or a weekday set with a day of the month, are not
  // "every X at HH:MM": the cron is the only true sentence.
  test('weekdays at several times, or with a day of the month, stay raw', () => {
    expect(describeCron(['0 7,19 * * 1-5'])).toBe('0 7,19 * * 1-5');
    expect(describeCron(['0 7 1 * 1,3'])).toBe('0 7 1 * 1,3');
    expect(describeCron(['0 7 * * 5-1'])).toBe('0 7 * * 5-1');
    expect(describeCron(['0 7 * * */2'])).toBe('0 7 * * */2');
  });

  test('with no triggers there is no cadence', () => {
    expect(describeCron([])).toBe('none, run by hand');
  });

  // `cronToCalendarIntervals` throws on ranges and steps. Such a cron can't be
  // INSTALLED, but it can be written in a repo's pipeline.yaml, and the
  // dashboard is the one place meant so that nothing fails silently.
  test('a cron that cannot be translated is returned raw', () => {
    expect(describeCron(['*/5 * * * *'])).toBe('*/5 * * * *');
  });

  test('a cron with a day of the month is returned raw, without inventing a sentence', () => {
    expect(describeCron(['0 3 1 * *'])).toBe('0 3 1 * *');
  });

  test('several triggers are listed raw', () => {
    expect(describeCron(['0 3 * * *', '0 15 * * *'])).toBe('0 3 * * * · 0 15 * * *');
  });
});

describe('formatNext / formatFull', () => {
  // 2026-10-28 is a Wednesday.
  const now = local(2026, 10, 28, 9, 0);
  test('today, tomorrow, weekday, date', () => {
    expect(formatNext(local(2026, 10, 28, 18, 0), now)).toBe('today 18:00');
    expect(formatNext(local(2026, 10, 29, 8, 0), now)).toBe('tomorrow 08:00');
    expect(formatNext(local(2026, 11, 2, 7, 0), now)).toBe('Mon 07:00');
    expect(formatNext(local(2026, 11, 4, 7, 0), now)).toBe('Nov 4 07:00');
  });
  test('formatFull', () => {
    expect(formatFull(local(2026, 11, 2, 7, 0))).toBe('Mon Nov 2 · 07:00');
  });
});

describe('formatBytes', () => {
  test('bytes stay whole; from KB up, one decimal', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1_023)).toBe('1023 B');
    expect(formatBytes(1_126)).toBe('1.1 KB');
    expect(formatBytes(3 * 1024 * 1024 + 200_000)).toBe('3.2 MB');
  });
});
