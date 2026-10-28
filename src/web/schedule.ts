/**
 * When a pipeline's cron fires next. PURE, like `format.ts`: the instant comes
 * in as a parameter. Cron itself is read by `cronToCalendarIntervals` and only
 * there; this module just walks the calendar over what it returns.
 */
import type { TriggerHealth } from '../health/evaluate.ts';
import { cronToCalendarIntervals, type CalendarInterval } from '../install/common.ts';

/**
 * What the dashboard says about a pipeline's future. `at` is an ISO instant —
 * empty when the trigger is loaded but its cron can't be walked, which the
 * renderer draws as a dash. `none`: a cron nobody loaded fires nothing.
 * `manual`: there is no cron at all.
 */
export type NextRun = { kind: 'at'; at: string } | { kind: 'none' } | { kind: 'manual' };

/** Days ahead we are willing to look: a yearly cron plus a leap-year margin. */
const MAX_DAYS_AHEAD = 400;

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
const ALL_HOURS = range(24);
const ALL_MINUTES = range(60);

/**
 * First instant strictly after `now` at which `interval` fires, in LOCAL time.
 * `undefined` in a field means "any". Walks days, not minutes: the dashboard
 * asks once per pipeline per second.
 */
function nextForInterval(interval: CalendarInterval, now: Date): Date | undefined {
  const hours = interval.Hour === undefined ? ALL_HOURS : [interval.Hour];
  const minutes = interval.Minute === undefined ? ALL_MINUTES : [interval.Minute];

  for (let ahead = 0; ahead <= MAX_DAYS_AHEAD; ahead++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead);
    if (interval.Day !== undefined && interval.Day !== day.getDate()) continue;
    if (interval.Month !== undefined && interval.Month !== day.getMonth() + 1) continue;
    if (interval.Weekday !== undefined && interval.Weekday % 7 !== day.getDay()) continue;

    for (const h of hours) {
      for (const m of minutes) {
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
        if (at.getTime() > now.getTime()) return at;
      }
    }
  }
  return undefined;
}

/**
 * The soonest firing among all the crons, or `undefined` when there are none
 * or any of them can't be translated: an invented time is worse than none.
 */
export function nextRunAt(crons: readonly string[], now: Date): Date | undefined {
  if (crons.length === 0) return undefined;

  let best: Date | undefined;
  for (const cron of crons) {
    let intervals: CalendarInterval[];
    try {
      intervals = cronToCalendarIntervals(cron);
    } catch {
      return undefined;
    }
    for (const interval of intervals) {
      const at = nextForInterval(interval, now);
      if (at !== undefined && (best === undefined || at < best)) best = at;
    }
  }
  return best;
}

/**
 * The trigger axis decides first, the cron only after: a cron in the YAML of
 * a job that is not installed, or is disabled, fires nothing, and giving it a
 * time would be the dashboard promising a run that will not happen. `drifted`
 * still fires, so it gets a time too: the one in the YAML, which is the only
 * cron this module reads — the loaded job may carry an older one, and the row
 * already says "drifted" next to it.
 */
export function nextRun(trigger: TriggerHealth, crons: readonly string[], now: Date): NextRun {
  switch (trigger) {
    case 'installed':
    case 'drifted':
      return { kind: 'at', at: nextRunAt(crons, now)?.toISOString() ?? '' };
    case 'not-installed':
    case 'disabled':
      return { kind: 'none' };
    case 'no-trigger':
      return { kind: 'manual' };
  }
}
