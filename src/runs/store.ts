import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NotifyRecord, RunRecord, RunStatus, StepRecord } from './types.ts';

export type { NotifyRecord, RunRecord, RunStatus, StepRecord, StepStatus } from './types.ts';

/** Marker that replaces any secret value. */
export const REDACTION = '[redacted]';

/**
 * Replaces any secret values that appear in a text. Applied to everything that
 * is written to disk or shown on screen.
 */
export function redactSecrets(text: string, secrets: string[]): string {
  let output = text;
  for (const secret of secrets) {
    if (!secret) continue;
    output = output.split(secret).join(REDACTION);
  }
  return output;
}

/**
 * A readable run id, lexicographically sortable (the alphabetical order of
 * the ids matches the chronological order) and safe for file names (no `:`,
 * which is an illegal character in paths on some file systems). It keeps the
 * milliseconds: with only second resolution, two runs a few milliseconds
 * apart would produce the same id and the second would overwrite the first's
 * directory in `.runs/`. Two runs within the same millisecond still collide,
 * but that requires real concurrency and is covered by the lock of
 * `guards/lock.ts`, not here.
 */
function newRunId(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

/**
 * Checks whether an `fs` error is ENOENT (path doesn't exist), the only case
 * where "no data" is a valid answer. Any other error (permissions, full disk,
 * etc.) is allowed to propagate: mistaking a real infrastructure failure for a
 * run that never existed would lead `resume` to restart silently instead of
 * stopping at the real problem.
 */
function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * Persistence of runs in `<repoRoot>/.runs/<pipeline>/<runId>/`.
 * The state is written after each step, never only at the end: if the process
 * dies mid-run, what was already completed stays on disk and `resume` can pick
 * it up.
 */
export class RunStore {
  constructor(private readonly repoRoot: string) {}

  private runsDir(pipeline: string): string {
    return join(this.repoRoot, '.runs', pipeline);
  }

  private runDir(pipeline: string, runId: string): string {
    return join(this.runsDir(pipeline), runId);
  }

  async createRun(
    pipeline: string,
    pipelineVersion: number,
    params: Record<string, string>,
    now: Date = new Date(),
    forced = false,
  ): Promise<RunRecord> {
    const run: RunRecord = {
      id: newRunId(now),
      pipeline,
      pipelineVersion,
      status: 'running',
      startedAt: now.toISOString(),
      params,
      steps: {},
      // Only when true: that way the run.json of a normal run doesn't gain a
      // field that says nothing.
      ...(forced ? { forced: true } : {}),
    };
    await mkdir(this.runDir(pipeline, run.id), { recursive: true });
    await this.persist(run);
    return run;
  }

  /** Writes a step's result and updates run.json immediately. */
  async writeStep(run: RunRecord, step: StepRecord): Promise<void> {
    run.steps[step.id] = step;
    await this.persist(run);
  }

  /** Saves a step's transcript, already redacted by the caller. */
  async writeStepLog(run: RunRecord, stepId: string, contents: string): Promise<void> {
    await writeFile(join(this.runDir(run.pipeline, run.id), `${stepId}.log`), contents, 'utf8');
  }

  async finishRun(run: RunRecord, status: RunStatus, skipReason?: string): Promise<void> {
    run.status = status;
    run.finishedAt = new Date().toISOString();
    if (skipReason !== undefined) run.skipReason = skipReason;
    run.totalCostUsd = Object.values(run.steps).reduce(
      (sum, step) => sum + (step.costUsd ?? 0),
      0,
    );
    await this.persist(run);
  }

  /**
   * Saves the notify channel's trace in run.json. It is called AFTER
   * `finishRun`: the channel is only invoked once the run is closed.
   */
  async writeNotify(run: RunRecord, notify: NotifyRecord): Promise<void> {
    run.notify = notify;
    await this.persist(run);
  }

  async readRun(pipeline: string, runId: string): Promise<RunRecord | undefined> {
    try {
      const text = await readFile(join(this.runDir(pipeline, runId), 'run.json'), 'utf8');
      return JSON.parse(text) as RunRecord;
    } catch (err) {
      if (isEnoent(err)) return undefined;
      throw err;
    }
  }

  /** The pipeline's runs, from newest to oldest. */
  async listRuns(pipeline: string): Promise<RunRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(this.runsDir(pipeline));
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
    const runs: RunRecord[] = [];
    for (const id of entries.sort().reverse()) {
      const run = await this.readRun(pipeline, id);
      if (run) runs.push(run);
    }
    return runs;
  }

  /** Last run with status 'success'. Basis of the throttle: a failed run does not consume the window. */
  async lastSuccess(pipeline: string): Promise<RunRecord | undefined> {
    const runs = await this.listRuns(pipeline);
    return runs.find((r) => r.status === 'success');
  }

  /**
   * Last run that EXECUTED something, with success or failure. Anchor of
   * `throttle`/`changed` when they declare `since: last_attempt`.
   *
   * Skipped runs don't count, and that nuance is the fix for a real bug: it
   * used to return any finished run, so a pipeline with `since: last_attempt`
   * pushed the anchor of its own window with every tick it skipped itself — by
   * guard or by lock — and the window never expired. `since: last_attempt`
   * exists to space out WORK; its only difference from `last_success` is that
   * it also counts failed attempts, so that a failing pipeline doesn't keep
   * retrying back to back. A skipped run did no work at all, so anchoring on
   * it is a contradiction.
   */
  async lastAttempt(pipeline: string): Promise<RunRecord | undefined> {
    const runs = await this.listRuns(pipeline);
    return runs.find((r) => r.status === 'success' || r.status === 'failed');
  }

  /**
   * Writes `run.json` atomically: first it dumps the content to a temporary
   * file in the same directory as the run (same file system, so that the
   * `rename` below is truly atomic and doesn't degrade to a copy if the
   * temporary landed on another filesystem) and then renames it over the
   * target. Whoever reads `run.json` at any instant always sees either the
   * complete previous version or the complete new one, never a half-written
   * file — exactly the scenario this module exists to survive (a process that
   * dies mid-run). The temporary's name carries a UUID so that two concurrent
   * writes on the same run don't share a temporary file. If the write fails,
   * it tries to delete the temporary so as not to leave garbage in `.runs/`.
   */
  private async persist(run: RunRecord): Promise<void> {
    const targetPath = join(this.runDir(run.pipeline, run.id), 'run.json');
    const tmpPath = `${targetPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmpPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
      await rename(tmpPath, targetPath);
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      throw err;
    }
  }
}
