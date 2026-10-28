/**
 * Translation into human language of what the engine stores raw. PURE module
 * on purpose, like `health/evaluate.ts`: no I/O and no clock of its own — the
 * instant comes in as a parameter. That way the whole case table runs without
 * starting a server or depending on the machine's time.
 *
 * Nothing here decides ANYTHING about health: it only changes vocabulary.
 */
import { cronToCalendarIntervals } from '../install/common.ts';

/** The name tables, Sunday first as `Date.getDay()` counts. The costs page reads them from here too. */
export const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const twoDigits = (n: number): string => String(n).padStart(2, '0');
const clock = (d: Date): string => `${twoDigits(d.getHours())}:${twoDigits(d.getMinutes())}`;

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

  const time = clock(d);
  const days = calendarDays(d, now);
  if (days === 0) return { day: 'today', time };
  if (days === 1) return { day: 'yesterday', time };
  if (days < 7) return { day: DAYS_SHORT[d.getDay()]!, time };
  return { day: `${MONTHS[d.getMonth()]} ${d.getDate()}`, time };
}

/** A FUTURE instant, short: "today 08:00", "tomorrow 08:00", "Mon 07:00", "Nov 2 07:00". */
export function formatNext(at: Date, now: Date): string {
  const days = calendarDays(now, at);
  const time = clock(at);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  if (days < 7) return `${DAYS_SHORT[at.getDay()]!} ${time}`;
  return `${MONTHS[at.getMonth()]} ${at.getDate()} ${time}`;
}

/** The unabridged form for a tooltip: "Mon Nov 2 · 07:00". */
export function formatFull(at: Date): string {
  return `${DAYS_SHORT[at.getDay()]!} ${MONTHS[at.getMonth()]} ${at.getDate()} · ${clock(at)}`;
}

/** A run's start to the second, in local time: "07:00:04". */
export function formatClock(at: Date): string {
  return `${clock(at)}:${twoDigits(at.getSeconds())}`;
}

/**
 * Two units at most, the largest first. Hours and days exist for a run stuck
 * in "running": the dashboard counts its time live, and a week of it would
 * otherwise read "10081m 0s".
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  if (total < 3_600) return `${Math.floor(total / 60)}m ${total % 60}s`;
  if (total < 86_400) return `${Math.floor(total / 3_600)}h ${Math.floor((total % 3_600) / 60)}m`;
  return `${Math.floor(total / 86_400)}d ${Math.floor((total % 86_400) / 3_600)}h`;
}

/**
 * A size in bytes the way a person reads it: whole bytes below a kilobyte,
 * one decimal from there up ("1.1 KB", "3.2 MB"). Binary units, as `ls -lh`
 * counts them. The step page's live client repeats these three lines in the
 * browser (`SSE_CLIENT`, render.ts); a change here goes there too.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A run's or a step's cost: empty when there is none, so a shell step's cell
 * stays blank. It takes `unknown` because the costs it is handed come straight
 * from `run.json`, read with an `as` and no validation: a hand-edited
 * `"totalCostUsd": "x"` is empty here, not a 500 on every page that lists the run.
 */
export function money(cost: unknown): string {
  if (cost === 0) return '';
  return usd(cost);
}

/**
 * Always a figure for a number, `$0.00` included. `money()` returns '' for zero because in
 * a run's row an empty cell reads better than a column of zeros; in a total
 * (the costs page, the dashboard's spend strip) the figure is the point, and
 * an empty one would read as "unknown".
 */
export function usd(amount: unknown): string {
  // Anything that is not a finite number is empty, never "$NaN" or a throw:
  // callers that need a mark put their own dash after it (`|| '—'`).
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '';
  return `$${amount.toFixed(2)}`;
}

/**
 * A weekday RANGE ("1-5") rewritten as the list it means ("1,2,3,4,5").
 * `cronToCalendarIntervals` rejects ranges because launchd can't express
 * them, so the engine won't install such a cron; the page still has to say
 * what it means. Only the day-of-week field, and only a plain ascending
 * `a-b`: everything else goes to the engine's reader as written, so it is
 * still read in one place.
 */
function weekdayRangeAsList(cron: string): string {
  const fields = cron.trim().split(/\s+/);
  const range = fields.length === 5 ? /^([0-7])-([0-7])$/.exec(fields[4]!) : null;
  if (range === null) return cron;
  const [from, to] = [Number(range[1]), Number(range[2])];
  if (from > to) return cron;
  fields[4] = Array.from({ length: to - from + 1 }, (_, i) => from + i).join(',');
  return fields.join(' ');
}

/** "Mon", "Mon and Thu", "Mon, Wed and Fri". */
const listOfDays = (days: string[]): string =>
  days.length === 1 ? days[0]! : `${days.slice(0, -1).join(', ')} and ${days.at(-1)!}`;

/**
 * The cadence in words. It leans on `cronToCalendarIntervals` instead of
 * interpreting cron again: in this project cron is read in ONE place only, and
 * duplicating that parser here is exactly how you end up with two truths about
 * when a pipeline fires.
 *
 * It only translates the forms that read at a glance: one time of day, every
 * day or on a set of weekdays. Any other —several triggers, several times, a
 * day of the month, a cron the translator doesn't support— is returned RAW:
 * an invented sentence about when something runs is worse than the original
 * string, because the original string at least is true.
 */
export function describeCron(crons: readonly string[]): string {
  if (crons.length === 0) return 'none, run by hand';
  if (crons.length > 1) return crons.join(' · ');

  const cron = crons[0]!;
  let intervals;
  try {
    intervals = cronToCalendarIntervals(weekdayRangeAsList(cron));
  } catch {
    return cron;
  }

  // One time of day for every interval; they may differ only in the weekday.
  const [first] = intervals;
  if (first === undefined) return cron;
  const { Minute, Hour } = first;
  if (Minute === undefined || Hour === undefined) return cron;
  const sameTime = intervals.every(
    (i) => i.Minute === Minute && i.Hour === Hour && i.Day === undefined && i.Month === undefined,
  );
  if (!sameTime) return cron;

  const hour = `${twoDigits(Hour)}:${twoDigits(Minute)}`;
  // Before six it is not "every day": it is the small hours, and whoever opens
  // the dashboard in the morning thinks of that run as "last night's".
  const daily = Hour < 6 ? `every night at ${hour}` : `every day at ${hour}`;
  if (intervals.length === 1 && first.Weekday === undefined) return daily;
  if (intervals.some((i) => i.Weekday === undefined)) return cron;

  // Monday first, the way a week is read; Sunday (0) goes last.
  const days = [...new Set(intervals.map((i) => i.Weekday! % 7))].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  const key = days.join(',');
  if (days.length === 7) return daily;
  if (key === '1,2,3,4,5') return `every weekday at ${hour}`;
  if (key === '6,0') return `every weekend at ${hour}`;
  if (days.length === 1) return `every ${DAYS_LONG[days[0]!]!} at ${hour}`;
  return `every ${listOfDays(days.map((d) => DAYS_SHORT[d]!))} at ${hour}`;
}
