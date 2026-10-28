/**
 * The task scheduler interface. `install`, `uninstall` and the dashboard talk
 * ONLY to this, never to launchd or systemd directly: that way one command
 * schedules a pipeline on macOS and on Linux, and whatever differs between the
 * two stays enclosed in one implementation per platform.
 */
import type { Guard } from '../schema/pipeline.ts';
import type { CalendarInterval } from './common.ts';
import { launchdBackend } from './launchd-backend.ts';
import { systemdBackend } from './systemd-backend.ts';

/** Everything needed to generate a job's files, as EXPLICIT inputs. */
export type JobSpecInput = {
  pipelineName: string;
  repoRoot: string;
  /** Path of the bun binary that runs the engine (see `stableBunPath`). */
  bunPath: string;
  /** Path of the CLI entry point (`src/cli/index.ts`). */
  cliEntry: string;
  home: string;
  path: string;
  calendarIntervals: CalendarInterval[];
  generatedAt: string;
  /** The pipeline's `when:` guards. They decide `RunAtLoad` — see `grantsRunAtLoad`. */
  guards: Guard[];
};

export type JobFile = { path: string; contents: string };

export type PlatformCheck = { name: string; ok: boolean; detail: string; fix?: string };

export type SchedulerBackend = {
  kind: 'launchd' | 'systemd';
  /** Name for messages: "launchd" / "systemd". */
  label: string;
  /** Files `install` would write now: one on launchd (plist), two on systemd (service, timer). */
  jobFiles(input: JobSpecInput): JobFile[];
  /** The paths of the job's files, whether or not they exist: one on launchd, two on systemd. */
  jobPaths(label: string, home: string): string[];
  logPath(home: string, pipelineName: string): string;
  /** The user's jobs with their raw contents, for the collision scan. */
  readUserJobs(): Promise<{ label: string; contents: string }[]>;
  /** Of `labels`, those that are disabled in the scheduler. */
  disabledLabels(labels: string[]): Promise<string[]>;
  /** Platform-specific gates before installing. None on launchd. */
  preInstallChecks(): Promise<PlatformCheck[]>;
  activate(label: string, files: JobFile[]): Promise<{ code: number; stderr: string }>;
  /**
   * Unloads the job and deletes its files if they exist. Idempotent. Returns a
   * `warning` when it could not guarantee the unload (systemd without a user
   * bus: the files are deleted, but the timer may still be loaded).
   */
  deactivate(label: string): Promise<{ warning?: string }>;
  facts(
    label: string,
    home: string,
  ): Promise<{ loaded: boolean; disabled: boolean; artifactOnDisk?: string }>;
  /** How to retire a same-named job by hand, for the collision warning. */
  retireHint(label: string): string;
};

/**
 * This machine's backend. `PIPELINES_SCHEDULER` wins if it is set — it is the
 * seam tests use to force a backend without depending on the platform —;
 * otherwise `process.platform` decides. It is not set in production.
 */
export function schedulerFor(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): SchedulerBackend {
  const forced = env.PIPELINES_SCHEDULER;
  if (forced !== undefined && forced !== 'launchd' && forced !== 'systemd') {
    throw new Error(
      `PIPELINES_SCHEDULER="${forced}" is not a known scheduler; use "launchd" or "systemd".`,
    );
  }
  const kind = forced ?? (platform === 'darwin' ? 'launchd' : platform === 'linux' ? 'systemd' : undefined);
  if (kind === 'launchd') return launchdBackend;
  if (kind === 'systemd') return systemdBackend;
  throw new Error(
    `Scheduling pipelines is only supported on macOS (launchd) and Linux (systemd); this machine is ${platform}.`,
  );
}
