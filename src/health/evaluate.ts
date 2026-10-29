/**
 * A pipeline's health verdict: two independent axes that watch each other.
 *
 * PURE module on purpose, like `install/common.ts` and `runner/fs-guard.ts`:
 * no I/O, no subprocesses and no clock of its own — the instant comes in as a
 * parameter. That way the whole case table runs without starting a server or
 * depending on macOS.
 */
import { cronToCalendarIntervals, stripGeneratedAt, type CalendarInterval } from '../install/common.ts';
import type { RunRecord } from '../runs/types.ts';
import type { Pipeline } from '../schema/pipeline.ts';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Period between triggers, derived from launchd's schedules — NOT by
 * interpreting cron again, which only `cronToCalendarIntervals` does.
 *
 * The rule: the coarsest granularity the schedules don't pin is the one that
 * rules (if they don't pin the minute, it fires every minute), divided among
 * the number of schedules. It is a deliberate approximation: it feeds a watch
 * WINDOW, not a plan — nobody decides when to run with this.
 */
export function triggerPeriodMs(intervals: CalendarInterval[]): number {
  if (intervals.length === 0) return DAY_MS;
  const someMissing = (key: keyof CalendarInterval): boolean =>
    intervals.some((interval) => interval[key] === undefined);

  const base = someMissing('Minute')
    ? MINUTE_MS
    : someMissing('Hour')
      ? HOUR_MS
      : !someMissing('Weekday')
        ? 7 * DAY_MS
        : !someMissing('Day') || !someMissing('Month')
          ? 30 * DAY_MS
          : DAY_MS;

  return Math.round(base / intervals.length);
}

export type TriggerHealth = 'no-trigger' | 'not-installed' | 'disabled' | 'drifted' | 'installed';

export type JobFacts = {
  loaded: boolean;
  disabled: boolean;
  /**
   * Contents of the job files on disk, if they exist: the plist in launchd;
   * in systemd, the `.service` and the `.timer` joined by a newline.
   */
  artifactOnDisk?: string;
  /** The same, as `install` would generate it right now. */
  artifactExpected?: string;
};

/**
 * Axis 1: does anyone trigger it?
 *
 * `disabled` is evaluated BEFORE `not-installed` because a disabled job is
 * usually also unloaded, and of the two diagnoses the actionable one is the
 * first: it says what to do. With the second, the operator would reinstall and
 * the domain's override would keep biting.
 */
export function evaluateTrigger(hasTriggers: boolean, job: JobFacts): TriggerHealth {
  // No cron in the YAML, but a job still loaded: the triggers were removed
  // after an install, and the old job keeps firing on the old cadence. That
  // is the YAML and the scheduler disagreeing, which is what `drifted` says;
  // calling it manual would hide a job that still runs (and spends).
  if (!hasTriggers) return job.loaded && !job.disabled ? 'drifted' : 'no-trigger';
  if (job.disabled) return 'disabled';
  if (!job.loaded) return 'not-installed';
  // Without both sides no comparison is possible, and claiming a drift that
  // couldn't be measured would be making up a diagnosis.
  if (job.artifactOnDisk === undefined || job.artifactExpected === undefined) return 'installed';
  return stripGeneratedAt(job.artifactOnDisk) === stripGeneratedAt(job.artifactExpected)
    ? 'installed'
    : 'drifted';
}

export type WorkHealth = 'never-worked' | 'working' | 'failing' | 'stuck' | 'silent';

export type Health = {
  trigger: TriggerHealth;
  work: WorkHealth;
  /** Watch window in ms; undefined if the pipeline declares no cadence. */
  windowMs?: number;
  lastRun?: RunRecord;
  lastWork?: RunRecord;
  consecutiveSkips: number;
  /** `installed` + `silent`: launchd says it triggers and there is no trace of anything. */
  contradiction: boolean;
};

/** A run that EXECUTED something, with success or failure. Same criterion as `RunStore.lastAttempt`. */
function isWork(run: RunRecord): boolean {
  return run.status === 'success' || run.status === 'failed';
}

/**
 * launchd schedules for `triggers`, or `[]` if the cron uses syntax that
 * `cronToCalendarIntervals` doesn't support (ranges, steps). That pipeline
 * couldn't be INSTALLED, but it can exist in a repo's pipeline.yaml — letting
 * the exception propagate would take down the whole dashboard, which is one
 * place designed so that nothing fails silently. The result is the same path
 * as a pipeline without triggers: no window, the work axis can only be
 * `never-worked`, `failing` or `working`.
 */
function safeIntervals(pipeline: Pipeline): CalendarInterval[] {
  try {
    return pipeline.triggers.flatMap((t) => cronToCalendarIntervals(t.cron));
  } catch {
    return [];
  }
}

/**
 * Full verdict. `runs` arrives from newest to oldest, as returned by
 * `RunStore.listRuns()`.
 *
 * The window is TWICE the declared period. The margin is deliberate: one lost
 * night —a closed laptop— must not paint anything red; two in a row is no
 * longer chance.
 */
export function evaluateHealth(
  pipeline: Pipeline,
  runs: RunRecord[],
  job: JobFacts,
  now: Date,
): Health {
  const hasTriggers = pipeline.triggers.length > 0;
  const trigger = evaluateTrigger(hasTriggers, job);

  const lastRun = runs[0];
  const lastWork = runs.find(isWork);

  let consecutiveSkips = 0;
  for (const run of runs) {
    if (run.status !== 'skipped') break;
    consecutiveSkips += 1;
  }

  const intervals = hasTriggers ? safeIntervals(pipeline) : [];
  const windowMs = hasTriggers && intervals.length > 0 ? 2 * triggerPeriodMs(intervals) : undefined;
  const inWindow = (run: RunRecord): boolean =>
    windowMs !== undefined && now.getTime() - new Date(run.startedAt).getTime() <= windowMs;

  let work: WorkHealth;
  if (windowMs === undefined) {
    // Without a declared cadence (or without one we know how to translate) there is no trigger
    // to miss: a manual pipeline can't be `stuck` or `silent`.
    work = lastWork === undefined ? 'never-worked' : lastWork.status === 'failed' ? 'failing' : 'working';
  } else if (lastRun === undefined) {
    // `never-worked`, not `silent`: `silent` means "it was running and
    // stopped running", and saying that of a just-installed pipeline would be
    // lying.
    work = 'never-worked';
  } else if (!inWindow(lastRun)) {
    work = 'silent';
  } else if (lastWork !== undefined && inWindow(lastWork)) {
    work = lastWork.status === 'failed' ? 'failing' : 'working';
  } else {
    work = 'stuck';
  }

  return {
    trigger,
    work,
    windowMs,
    lastRun,
    lastWork,
    consecutiveSkips,
    // launchd claims it triggers; the record claims nothing started.
    // Neither source detects it alone.
    //
    // `drifted` counts the same as `installed`: a drifted plist is STILL loaded
    // in launchd — the drift says it is not the one `install` would generate
    // today, not that it doesn't fire. Requiring exactly `installed` left that
    // box without an alarm and, worse, without the job log's tail: `server.ts`
    // only reads it when this field is true, and it is the only trace of an
    // engine that dies before writing `run.json`.
    contradiction: (trigger === 'installed' || trigger === 'drifted') && work === 'silent',
  };
}
