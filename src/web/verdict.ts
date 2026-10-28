/**
 * The crossing of the two axes, said in one sentence. PURE module:
 * `evaluateHealth` has already decided; here we only choose how to tell it.
 *
 * The underlying rule: the page NEVER shows the raw enum value, it shows the
 * sentence. And the vocabulary is ONE — `silent` is "silent" across the whole
 * interface, never "silence".
 */
import type { Health, TriggerHealth, WorkHealth } from '../health/evaluate.ts';

export type Tone = 'ok' | 'warn' | 'bad' | 'live' | 'neutral';
export type Verdict = { line: string; tone: Tone; trigger: string; work: string };
export type Summary = { line: string; tone: Tone; sub: string };

const TRIGGER: Record<TriggerHealth, string> = {
  'no-trigger': 'no cron',
  'not-installed': 'not installed',
  disabled: 'disabled',
  drifted: 'drifted',
  installed: 'loaded',
};

const WORK: Record<WorkHealth, string> = {
  'never-worked': 'never worked',
  working: 'working',
  failing: 'failing',
  stuck: 'stuck',
  silent: 'silent',
};

export const triggerLabel = (t: TriggerHealth): string => TRIGGER[t];
export const workLabel = (w: WorkHealth): string => WORK[w];

const nights = (n: number): string => `${n} ${n === 1 ? 'night' : 'nights'}`;

/** `scheduler` is the backend's name ("launchd" / "systemd"): the sentence names it. */
export function verdict(health: Health, totalSteps: number, scheduler: string): Verdict {
  const trigger = triggerLabel(health.trigger);
  const work = workLabel(health.work);
  const say = (line: string, tone: Tone): Verdict => ({ line, tone, trigger, work });

  // The alarm first, even above a running run: it is the one box that exists
  // to be seen before anything else. `contradiction` already covers
  // `installed` and `drifted` — both mean "the scheduler has it loaded".
  if (health.contradiction) return say('LOADED AND PRODUCING NOTHING', 'bad');

  // Then the trigger axis, when it says nobody triggers it: it doesn't matter
  // how well the last run went if nothing has launched it since.
  if (health.trigger === 'not-installed') {
    return say(`Not installed in ${scheduler}. Nothing triggers it.`, 'bad');
  }
  if (health.trigger === 'disabled') {
    return say(`Disabled in ${scheduler}. Nothing triggers it.`, 'bad');
  }

  const manual = health.trigger === 'no-trigger';

  if (health.lastRun?.status === 'running') {
    const done = Object.keys(health.lastRun.steps).length;
    return say(`Running now — ${done} of ${totalSteps} steps.`, 'live');
  }

  switch (health.work) {
    case 'silent':
      // UNREACHABLE by construction, and here only so the `switch` is
      // exhaustive: `silent` requires a window, the window requires a
      // cadence, and with a cadence the trigger can only be
      // `installed`/`drifted` (both already left through `contradiction`),
      // `not-installed` or `disabled` (both already left above). If it is ever
      // reached, the text doesn't lie.
      return say('Not a single run in the watch window.', 'bad');
    case 'stuck':
      return say(`Skipped ${nights(health.consecutiveSkips)} in a row without getting to work.`, 'warn');
    case 'failing':
      return say(manual ? 'Failed the last time it was run by hand.' : 'Failed the last run.', 'bad');
    case 'never-worked':
      return say(
        manual ? 'Never run yet. It is run by hand.' : 'Installed, but has not run yet.',
        'neutral',
      );
    case 'working':
      return say(manual ? 'Up to date. Run by hand; the last run went fine.' : 'Up to date.', 'ok');
  }
}

/**
 * The three-second answer, at the very top. It goes INSIDE `#live`: the health
 * stream replaces that whole node, and a headline outside it would be stale
 * from the first tick.
 */
export function panelSummary(healths: readonly Health[], broken: number): Summary {
  const sub = [
    `${healths.length + broken} pipelines`,
    ...(broken > 0 ? [`${broken} unreadable`] : []),
  ].join(' · ');

  if (healths.length === 0 && broken === 0) {
    return { line: 'This repo has no pipelines.', tone: 'neutral', sub: '' };
  }
  if (healths.length === 0) return { line: 'No pipeline can be read.', tone: 'bad', sub };

  const alarms = healths.filter((h) => h.contradiction).length;
  if (alarms > 0) {
    return {
      line:
        alarms === 1
          ? 'One pipeline is loaded and produces nothing.'
          : `${alarms} pipelines are loaded and produce nothing.`,
      tone: 'bad',
      sub: `${sub} · ${alarms} in alarm`,
    };
  }

  // `stuck` is not an alarm, but ten nights of skipping is not "all in order"
  // either: it is the neighbor of the box this dashboard exists to catch.
  const halted = healths.filter((h) => h.work === 'silent' || h.work === 'stuck').length;
  if (halted > 0) {
    return {
      line:
        halted === 1
          ? 'One pipeline has gone nights without working.'
          : `${halted} pipelines have gone nights without working.`,
      tone: 'warn',
      sub,
    };
  }

  const failing = healths.filter((h) => h.work === 'failing').length;
  if (failing > 0) {
    return {
      line:
        failing === 1
          ? 'One pipeline failed its last run.'
          : `${failing} pipelines failed their last run.`,
      tone: 'bad',
      sub,
    };
  }

  const running = healths.filter((h) => h.lastRun?.status === 'running').length;
  return {
    line: running > 0 ? 'All in order. A run is in progress right now.' : 'All in order.',
    tone: 'ok',
    sub: `${sub} · none silent`,
  };
}
