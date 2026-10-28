/**
 * What the two task schedulers (launchd and systemd) share: the translation
 * of triggers.cron into schedules, the job label, the PATH written into it,
 * the stable bun path, the RunAtLoad rule, the two collision nets and the
 * comparison that ignores the generated-file header.
 *
 * A PURE module on purpose, like `launchd.ts`: no I/O and no subprocesses.
 * Moved as-is from `launchd.ts` when the scheduler went behind
 * `SchedulerBackend` (`backend.ts`); that is why some comments still talk
 * about plists, which is where each rule was born.
 */

import { dirname } from 'node:path';
import { shellInterpreter } from '../runner/interpreter.ts';
import type { Guard } from '../schema/pipeline.ts';

export type CalendarInterval = {
  Minute?: number;
  Hour?: number;
  Day?: number;
  Month?: number;
  Weekday?: number;
};

/**
 * Cap on the schedules a single triggers.cron can generate. A bigger expansion
 * almost always means the author wanted a slash step, which this subset
 * deliberately does not support — better an error than a plist with forty
 * dictionaries nobody will review.
 */
export const MAX_CALENDAR_INTERVALS = 24;

type FieldSpec = { key: keyof CalendarInterval; min: number; max: number };

// The order is cron's: minute, hour, day of month, month, day of week.
const CRON_FIELDS: FieldSpec[] = [
  { key: 'Minute', min: 0, max: 59 },
  { key: 'Hour', min: 0, max: 23 },
  { key: 'Day', min: 1, max: 31 },
  { key: 'Month', min: 1, max: 12 },
  { key: 'Weekday', min: 0, max: 7 },
];

/** Values of a field, or null for an asterisk (which launchd expresses by omitting it). */
function parseField(raw: string, field: FieldSpec, cron: string): number[] | null {
  if (raw === '*') return null;

  if (raw.includes('/') || raw.includes('-')) {
    throw new Error(
      `triggers.cron "${cron}": field ${field.key} uses "${raw}". launchd cannot express ` +
        `ranges or steps; write it as a comma-separated list (e.g. "0,15,30,45").`,
    );
  }

  const values: number[] = [];
  for (const part of raw.split(',')) {
    const value = Number(part);
    if (!Number.isInteger(value) || value < field.min || value > field.max) {
      throw new Error(
        `triggers.cron "${cron}": field ${field.key} has "${part}", which is not an integer ` +
          `between ${field.min} and ${field.max}.`,
      );
    }
    // Sunday is 0 in cron and 0 (or 7) in launchd: normalize to 0 so that
    // "0" and "7" don't generate two schedules that are the same day.
    const normalized = field.key === 'Weekday' && value === 7 ? 0 : value;
    if (!values.includes(normalized)) values.push(normalized);
  }
  return values;
}

export function cronToCalendarIntervals(cron: string): CalendarInterval[] {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `triggers.cron "${cron}": expected 5 fields (minute hour day month day-of-week), ` +
        `found ${fields.length}.`,
    );
  }

  let intervals: CalendarInterval[] = [{}];
  fields.forEach((raw, index) => {
    const field = CRON_FIELDS[index]!;
    const values = parseField(raw, field, cron);
    if (values === null) return;

    const expanded: CalendarInterval[] = [];
    for (const base of intervals) {
      for (const value of values) expanded.push({ ...base, [field.key]: value });
    }
    if (expanded.length > MAX_CALENDAR_INTERVALS) {
      throw new Error(
        `triggers.cron "${cron}": the expansion gives ${expanded.length} schedules, more than the ` +
          `maximum of ${MAX_CALENDAR_INTERVALS}. Declare several simpler triggers.`,
      );
    }
    intervals = expanded;
  });
  return intervals;
}

/**
 * Job label prefix. A constant in one place on purpose: it is the same one the
 * job installed by hand on 2026-08-19 already uses, so the first real
 * `install` ADOPTS it (same label = replacement) instead of leaving two jobs
 * running in parallel on the same repo.
 */
export const LABEL_PREFIX = 'cat.start.pipelines';

export function labelFor(pipelineName: string): string {
  return `${LABEL_PREFIX}.${pipelineName}`;
}

export type WhichFn = (name: string, path?: string) => string | null;

/**
 * Floor of system directories, ALWAYS appended at the end of the generated
 * `PATH` (those derived from `requires.bin`/`mcp_servers` still win by order,
 * since they come first). macOS only has `sh` at `/bin/sh`; without this
 * floor, a pipeline whose declared binaries don't share a directory with
 * `/bin` generates a `PATH` that can't even launch `sh -c`, which is exactly
 * what `runner/shell.ts` and `guards/evaluate.ts` do for any `shell` step or
 * `shell:` guard. Verified live: "Executable not found in $PATH: sh" with the
 * PATH lacking this floor — the installed job would die at the first step.
 */
const SYSTEM_PATH_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/**
 * The job's `PATH`, COMPUTED from the declared binaries instead of copied from
 * elsewhere. The hand-written plist of 2026-08-19 carried a `PATH` inherited
 * from another job that didn't cover every binary the pipeline declares;
 * computing it makes that failure impossible.
 *
 * `extraDirs` goes first (the directory of `bun` itself, which the job needs
 * to start the engine and which doesn't come from `requires.bin`).
 */
export function computePath(
  binaries: string[],
  which: WhichFn,
  extraDirs: string[] = [],
): string {
  const dirs: string[] = [];
  const push = (dir: string): void => {
    if (!dirs.includes(dir)) dirs.push(dir);
  };

  for (const dir of extraDirs) push(dir);
  for (const binary of binaries) {
    const resolved = which(binary);
    if (resolved === null) {
      throw new Error(
        `The binary "${binary}" (requires.bin) is not on this machine's PATH, so the ` +
          `installed job wouldn't find it either.`,
      );
    }
    push(dirname(resolved));
  }
  for (const dir of SYSTEM_PATH_DIRS) push(dir);
  return dirs.join(':');
}

/**
 * Belt and braces, not just the floor above: checks that ALL the declared
 * binaries, PLUS the shell interpreter (`sh` on macOS, `bash` on Linux),
 * resolve against the ALREADY COMPUTED `PATH` — the one that will be written
 * into the job's files, not the PATH of the operator running `install`. This
 * is the general rule the original incident leaves behind: validate against
 * the target environment, not your own. The interpreter is ALWAYS checked,
 * even if it doesn't appear in `requires.bin`: it is the one any `shell` step
 * or `shell:` guard invokes, so its absence from the written PATH blows up the
 * installed job at the first step, even if `doctor` (which validates against
 * the operator's PATH) were green.
 *
 * Returns the names that do NOT resolve; empty if everything is covered.
 */
export function unresolvedInPath(
  path: string,
  binaries: string[],
  which: WhichFn,
  interpreter: string = shellInterpreter(),
): string[] {
  const mustResolve = [...binaries, interpreter];
  return mustResolve.filter((bin) => which(bin, path) === null);
}

/**
 * Path of `bun` written into the plist. `process.execPath` arrives already
 * resolved down to the real binary, and with Homebrew that is a versioned
 * folder (`/usr/local/Cellar/bun/1.4.2/bin/bun`) that disappears with the next
 * `brew upgrade`: the job would stop starting without any run recording it. If
 * the `bun` on the PATH (normally a stable link like `/usr/local/bin/bun`)
 * points to the same binary, that one is used; otherwise, the real one.
 */
export function stableBunPath(
  execPath: string,
  whichBun: string | null,
  realpath: (path: string) => string,
): string {
  if (!whichBun || whichBun === execPath) return execPath;
  try {
    return realpath(whichBun) === realpath(execPath) ? whichBun : execPath;
  } catch {
    return execPath;
  }
}

/**
 * Is `RunAtLoad` granted to a pipeline with these guards?
 *
 * The problem it solves: launchd does NOT repeat a `StartCalendarInterval`
 * that falls while the `gui/$UID` domain is not loaded, and that domain isn't
 * loaded until the user logs in. On Monday 2026-08-31 the machine rebooted at
 * 06:31 and nobody logged in until 09:41: the 07:30 job did not run, did not
 * write a byte, and nothing warned — `notify.stale_after` is only evaluated
 * when a run ENDS, so a job that doesn't start is invisible.
 *
 * `RunAtLoad` recovers that trigger at the next login. But on its own it would
 * run the pipeline on EVERY load of the domain, which is exactly the opposite
 * of what is wanted. So it is granted only to a pipeline that declares a
 * `throttle` guard: the guard decides whether it really is due, and the extra
 * trigger is skipped cleanly. It is the only guard that works — `shell`,
 * `changed` and `between` answer a different question and don't bound the
 * frequency.
 *
 * Safe for both forms of `throttle` and for both of its `since` values: a
 * skipped run does not count as an attempt (`RunStore.lastAttempt`), so a
 * login trigger that the guard skips does not push the window's anchor.
 */
export function grantsRunAtLoad(guards: Guard[]): boolean {
  return guards.some((guard) => 'throttle' in guard);
}

/**
 * FOREIGN scheduler jobs (launchd plists, systemd units) that mention any of
 * the paths this pipeline is going to touch. A safety net against the
 * 2026-08-29 collision (two jobs at the same time on the same repo), NOT a
 * guarantee: a job that computes the path inside its own script doesn't carry
 * it in its files and isn't detected.
 * That is why `install` warns and asks for `--force`, instead of blocking.
 *
 * Only absolute paths are searched for (the caller decides): searching for
 * arbitrary values would give absurd false positives with short strings.
 */
export function foreignJobsMentioning(
  paths: string[],
  agents: { label: string; contents: string }[],
  ownLabel: string,
): string[] {
  const hits: string[] = [];
  for (const agent of agents) {
    if (agent.label === ownLabel) continue;
    if (paths.some((path) => agent.contents.includes(path))) hits.push(agent.label);
  }
  return hits;
}

/**
 * Other LOADED scheduler jobs whose name ends in the pipeline's.
 *
 * It is the net that was missing when handing over an old job to a real
 * pipeline: `foreignJobsMentioning`, the other check in this module, compares
 * PATHS —the path-typed param values against the contents of the other
 * plists— and worked exactly as promised. It went blind for a reason worth
 * remembering: **the decision to give each pipeline its own workspace is what
 * removed the shared path** with the bash script it was taking over from. One
 * worked in the operator's checkout and the other in `workspaces/<pipeline>`:
 * zero file overlap, and yet the same work, the same email and the same three
 * people.
 *
 * That collision is SEMANTIC, and the only thing that gives it away from the
 * outside is the name. Hence this second net, deliberately different and not a
 * patch on the first.
 *
 * `disabled` jobs are left out, and this is not a detail: the predecessor's
 * plist is deliberately left ON DISK as a way back, and whatever reads the
 * candidates (`readLaunchAgents`) reads files, not loaded jobs. Without this
 * exclusion the warning would fire on every reinstall after a well-done
 * handover, forever — the noise that teaches people to ignore warnings. A
 * disabled job can't run, so it duplicates nothing.
 *
 * The boundary is a dot —the segment separator of a launchd label— and not a
 * bare `endsWith`: `com.example.other-<name>` is a different job that happens
 * to end the same way, and warning about it would be noise that teaches people
 * to ignore the warning.
 */
export function jobsNamedAfter(
  pipelineName: string,
  agents: { label: string; contents: string }[],
  ownLabel: string,
  disabledLabels: string[],
): string[] {
  const disabled = new Set(disabledLabels);
  return agents
    .filter((agent) => agent.label !== ownLabel)
    .filter((agent) => agent.label.endsWith(`.${pipelineName}`))
    .filter((agent) => !disabled.has(agent.label))
    .map((agent) => agent.label);
}

/**
 * Strips the timestamp from the header so two job files can be compared by
 * their CONTENT. Without this, the one on disk and the one `install` would
 * generate right now always differ, and the `drifted` verdict would be a
 * permanent false positive.
 *
 * It strips ALL the lines with a timestamp, not just the first: on systemd the
 * artifact is two concatenated units, each with its own `# Generated:`. It
 * also strips every comment (the XML comment in a plist, every `#` line in a
 * unit) and the " (schedule)" suffix of the timer's `Description=`: that text
 * is inert, and stripping it lets a file written before the translation
 * (Spanish header, "Generado:", "(horario)") compare equal to one generated
 * now.
 */
export function stripGeneratedAt(contents: string): string {
  return contents
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^#.*$/gm, '')
    // The Spanish variants are there for files written before the translation.
    .replace(/^.*(?:Generated|Generado):.*$/gm, '')
    .replace(/ \((?:schedule|horario)\)$/gm, '');
}
