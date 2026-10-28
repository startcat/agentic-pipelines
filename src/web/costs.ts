/**
 * What the pipelines cost, read off the `run.json` files. PURE module on
 * purpose, like `health/evaluate.ts` and `format.ts`: no I/O and no clock of
 * its own — the runs and the instant come in as parameters, so the whole table
 * of cases runs without a server and without depending on the machine's date.
 *
 * Everything is in LOCAL time. "October" is the October of whoever looks at
 * the page: a run at 00:30 on the 1st belongs to that month here, even if in
 * UTC it is still the 30th.
 *
 * The only source is `totalCostUsd`, which is what the SDK measures in the
 * `agent` steps. A shell step that calls `claude -p`, or what a subscription
 * covers, is invisible here — the page says so in its closing note.
 */
import type { RunRecord } from '../runs/types.ts';
import { DAYS_LONG, MONTHS, MONTHS_LONG } from './format.ts';

/**
 * The dashboard's spend strip: this month and the one before, and nothing
 * else. Its own type and its own pass (`spendOf`) because the strip is redrawn
 * on every tick of every open tab, and the full `CostReport` is work it throws away.
 */
export type Spend = {
  month: { label: string; total: number; runs: number; withAgent: number };
  previous: { label: string; total: number };
  /** Runs under `.runs/` that could not be read, and so are not in the sums. */
  unreadable?: number;
};

/** A run reduced to what the costs page needs, already validated. */
export type CostRun = {
  pipeline: string;
  id: string;
  startedAt: string;
  status: string;
  costUsd: number;
  withAgent: boolean;
};

export type CostReport = {
  month: { label: string; total: number; day: number; days: number; projected?: number; runs: number; withAgent: number };
  previous: { label: string; total: number };
  /** Oldest first; the last one is the current month. */
  lastSix: { label: string; total: number; current: boolean }[];
  byDay: { day: number; total: number; future: boolean }[];
  /** "Mondays weigh more: docs-drift". */
  heavyWeekday?: { weekday: string; pipeline: string };
  byPipeline: { name: string; runs: number; perRun?: number; total: number }[];
  /** At most five. */
  priciest: CostRun[];
};

/** Share of the month one weekday has to carry before the page calls it out. */
const HEAVY_WEEKDAY_SHARE = 0.4;
const PRICIEST = 5;

/**
 * `RunStore.readRun` parses `run.json` with an `as` and no validation, so
 * every field can be anything. A run without a readable `startedAt` can't be
 * placed in any month and is left out; a cost that is not a finite number
 * counts as nothing rather than turning every sum into `NaN`.
 */
export function costRunsOf(runs: RunRecord[]): CostRun[] {
  const out: CostRun[] = [];
  for (const run of runs) {
    const startedAt: unknown = run.startedAt;
    if (typeof startedAt !== 'string' || Number.isNaN(new Date(startedAt).getTime())) continue;
    const cost: unknown = run.totalCostUsd;
    const steps: unknown = run.steps;
    out.push({
      pipeline: String(run.pipeline),
      id: String(run.id),
      startedAt,
      status: typeof run.status === 'string' ? run.status : 'unknown',
      // Negative only comes from a corrupt file, and would draw a bar downwards.
      costUsd: typeof cost === 'number' && Number.isFinite(cost) ? Math.max(0, cost) : 0,
      // "With an agent" is a step that MEASURED a cost, even $0: that is what
      // tells an agent run that cost nothing from a shell-only one.
      withAgent:
        typeof steps === 'object' &&
        steps !== null &&
        Object.values(steps).some((s: unknown) => {
          const c = typeof s === 'object' && s !== null ? (s as { costUsd?: unknown }).costUsd : undefined;
          return typeof c === 'number' && Number.isFinite(c);
        }),
    });
  }
  return out;
}

/** Months since year 0: lets "the previous month" cross January without special cases. */
const monthIndex = (d: Date): number => d.getFullYear() * 12 + d.getMonth();
const sum = (runs: CostRun[]): number => runs.reduce((acc, r) => acc + r.costUsd, 0);
const label = (index: number, names: readonly string[]): string => names[((index % 12) + 12) % 12]!;

/** Pushes in place: growing a bucket by copying it made the grouping quadratic. */
function addTo<K, V>(groups: Map<K, V[]>, key: K, value: V): void {
  const group = groups.get(key);
  if (group === undefined) groups.set(key, [value]);
  else group.push(value);
}

/**
 * The strip's figures in one pass, with no grouping: this month's total, runs
 * and runs with an agent, and the previous month's total. The sums add in the
 * runs' order from zero, exactly as `costReport` does, so the strip and the
 * costs page print the same cents.
 */
export function spendOf(runs: CostRun[], now: Date): Spend {
  const current = monthIndex(now);
  let total = 0;
  let count = 0;
  let withAgent = 0;
  let previous = 0;
  for (const run of runs) {
    const index = monthIndex(new Date(run.startedAt));
    if (index === current) {
      total += run.costUsd;
      count++;
      if (run.withAgent) withAgent++;
    } else if (index === current - 1) {
      previous += run.costUsd;
    }
  }
  return {
    month: { label: label(current, MONTHS_LONG), total, runs: count, withAgent },
    previous: { label: label(current - 1, MONTHS_LONG), total: previous },
  };
}

export function costReport(runs: CostRun[], pipelines: string[], now: Date): CostReport {
  const current = monthIndex(now);
  const day = now.getDate();
  const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

  // Each `startedAt` is parsed once; the current month's runs keep their date
  // for the day and weekday buckets below.
  const byMonth = new Map<number, CostRun[]>();
  const month: CostRun[] = [];
  const dates: Date[] = [];
  for (const run of runs) {
    const at = new Date(run.startedAt);
    const key = monthIndex(at);
    addTo(byMonth, key, run);
    if (key === current) {
      month.push(run);
      dates.push(at);
    }
  }
  const ofMonth = (index: number): CostRun[] => byMonth.get(index) ?? [];
  const total = sum(month);

  const perDay = new Array<number>(days).fill(0);
  month.forEach((run, i) => {
    perDay[dates[i]!.getDate() - 1]! += run.costUsd;
  });
  const byDay = perDay.map((dayTotal, i) => ({ day: i + 1, total: dayTotal, future: i + 1 > day }));

  return {
    month: {
      label: label(current, MONTHS_LONG),
      total,
      day,
      days,
      // One day is not a pace.
      ...(day > 1 ? { projected: (total / day) * days } : {}),
      runs: month.length,
      withAgent: month.filter((r) => r.withAgent).length,
    },
    previous: { label: label(current - 1, MONTHS_LONG), total: sum(ofMonth(current - 1)) },
    lastSix: [5, 4, 3, 2, 1, 0].map((back) => ({
      label: label(current - back, MONTHS),
      total: sum(ofMonth(current - back)),
      current: back === 0,
    })),
    byDay,
    ...heavyWeekday(month, dates, total),
    byPipeline: byPipeline(month, pipelines),
    priciest: month
      .filter((r) => r.costUsd > 0)
      .sort((a, b) => b.costUsd - a.costUsd || b.startedAt.localeCompare(a.startedAt))
      .slice(0, PRICIEST),
  };
}

/**
 * The weekday that carries at least 40 % of the month, and the pipeline that
 * contributes most to it. Below that share the note would be noise: with seven
 * weekdays, an even month already puts about 14 % on each.
 */
function heavyWeekday(month: CostRun[], dates: Date[], total: number): Pick<CostReport, 'heavyWeekday'> {
  if (total <= 0) return {};
  const perWeekday = new Map<number, CostRun[]>();
  month.forEach((run, i) => addTo(perWeekday, dates[i]!.getDay(), run));
  const [heaviest] = [...perWeekday.entries()].sort((a, b) => sum(b[1]) - sum(a[1]) || a[0] - b[0]);
  if (heaviest === undefined || sum(heaviest[1]) < total * HEAVY_WEEKDAY_SHARE) return {};

  const perPipeline = new Map<string, number>();
  for (const run of heaviest[1]) perPipeline.set(run.pipeline, (perPipeline.get(run.pipeline) ?? 0) + run.costUsd);
  const [top] = [...perPipeline.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { heavyWeekday: { weekday: DAYS_LONG[heaviest[0]]!, pipeline: top![0] } };
}

/**
 * One row per pipeline, including the ones that didn't run this month: a
 * pipeline missing from the table reads as "forgotten", one at $0.00 reads as
 * "costs nothing". Sorted by total, then by runs (the busiest of the free
 * ones first), then by name so the order never flickers.
 */
function byPipeline(month: CostRun[], pipelines: string[]): CostReport['byPipeline'] {
  const perPipeline = new Map<string, CostRun[]>();
  for (const run of month) addTo(perPipeline, run.pipeline, run);
  const names = [...new Set([...pipelines, ...month.map((r) => r.pipeline)])];
  return names
    .map((name) => {
      const runs = perPipeline.get(name) ?? [];
      const paid = runs.filter((r) => r.costUsd > 0);
      const total = sum(runs);
      // The average is over the runs that cost something: a skipped run of an
      // agent pipeline would otherwise make it look cheaper than it is.
      return { name, runs: runs.length, ...(paid.length > 0 ? { perRun: sum(paid) / paid.length } : {}), total };
    })
    .sort((a, b) => b.total - a.total || b.runs - a.runs || a.name.localeCompare(b.name));
}
