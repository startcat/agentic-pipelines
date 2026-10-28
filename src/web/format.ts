/**
 * Translation into human language of what the engine stores raw. PURE module
 * on purpose, like `health/evaluate.ts`: no I/O and no clock of its own — the
 * instant comes in as a parameter. That way the whole case table runs without
 * starting a server or depending on the machine's time.
 *
 * Nothing here decides ANYTHING about health: it only changes vocabulary.
 */
import { cronToCalendarIntervals } from '../install/common.ts';

const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const twoDigits = (n: number): string => String(n).padStart(2, '0');

/**
 * Calendar days between two instants, in LOCAL time. Not `(a - b) / 86400000`:
 * that count calls "today" something from 23 h ago that is already yesterday,
 * and "yesterday" something from 25 h ago that is the day before. Whoever looks
 * at the dashboard thinks in nights, not in multiples of twenty-four hours.
 */
function calendarDays(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

export function formatWhen(iso: string | undefined, now: Date): { day: string; time: string } {
  if (iso === undefined) return { day: '—', time: '' };
  const d = new Date(iso);
  // `run.json` is read with an `as` and no validation (RunStore.readRun), so a
  // corrupt date reaches this point. `Invalid Date` formats as "NaN:NaN".
  if (Number.isNaN(d.getTime())) return { day: '—', time: '' };

  const time = `${twoDigits(d.getHours())}:${twoDigits(d.getMinutes())}`;
  const days = calendarDays(d, now);
  if (days === 0) return { day: 'today', time };
  if (days === 1) return { day: 'yesterday', time };
  if (days < 7) return { day: DAYS_SHORT[d.getDay()]!, time };
  return { day: `${MONTHS[d.getMonth()]} ${d.getDate()}`, time };
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

export function money(usd: number | undefined): string {
  if (usd === undefined || usd === 0) return '';
  return `$${usd.toFixed(2)}`;
}

/**
 * The cadence in words. It leans on `cronToCalendarIntervals` instead of
 * interpreting cron again: in this project cron is read in ONE place only, and
 * duplicating that parser here is exactly how you end up with two truths about
 * when a pipeline fires.
 *
 * It only translates the forms that read at a glance. Any other —several
 * triggers, a day of the month, a cron the translator doesn't support— is
 * returned RAW: an invented sentence about when something runs is worse than
 * the original string, because the original string at least is true.
 */
export function describeCron(crons: readonly string[]): string {
  if (crons.length === 0) return 'none, run by hand';
  if (crons.length > 1) return crons.join(' · ');

  const cron = crons[0]!;
  let intervals;
  try {
    intervals = cronToCalendarIntervals(cron);
  } catch {
    return cron;
  }
  if (intervals.length !== 1) return cron;

  const { Minute, Hour, Day, Month, Weekday } = intervals[0]!;
  if (Minute === undefined || Hour === undefined) return cron;
  if (Day !== undefined || Month !== undefined) return cron;

  const hour = `${twoDigits(Hour)}:${twoDigits(Minute)}`;
  if (Weekday !== undefined) return `every ${DAYS_LONG[Weekday % 7]!} at ${hour}`;
  // Before six it is not "every day": it is the small hours, and whoever opens
  // the dashboard in the morning thinks of that run as "last night's".
  return Hour < 6 ? `every night at ${hour}` : `every day at ${hour}`;
}
