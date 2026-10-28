import { ChannelFailedError, dispatchNotify } from '../notify/dispatch.ts';
import type { PreflightReport } from '../preflight/check.ts';
import type { RunStore } from '../runs/store.ts';
import type { NotifyRecord, RunRecord } from '../runs/types.ts';
import type { Pipeline } from '../schema/pipeline.ts';
import { loadRepoContext, type RepoContext } from './context.ts';

export const OK = '✓';
export const KO = '✗';

/**
 * Exit codes: meant so that a cron or a script can act without having to
 * interpret the on-screen output.
 *   0   success. Includes a `when`/`throttle` guard that decides to skip the
 *       run: that is a normal pipeline result, not an error — the default
 *       value is kept, no constant.
 *   1   generic failure: invalid pipeline.yaml, missing dependency
 *       (preflight/doctor), missing required params or a step that
 *       failed after exhausting its retries.
 *   2   the lock file itself is damaged or unreadable — it is not that
 *       another run holds it, something is wrong with the file itself
 *       (`acquireLock` threw instead of returning `undefined`).
 *   3   another legitimate run is already in progress on this pipeline
 *       (`acquireLock` returned `undefined`).
 *   130/143  the process itself was interrupted (SIGINT/SIGTERM) while
 *       holding the lock — usual Unix convention (128 + signal).
 */
export const EXIT_FAILURE = 1;
export const EXIT_LOCK_ERROR = 2;
export const EXIT_ALREADY_RUNNING = 3;

export function collectSetFlag(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function parseSetFlags(values: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const value of values) {
    const index = value.indexOf('=');
    if (index === -1) throw new Error(`--set expects key=value, got "${value}"`);
    result[value.slice(0, index)] = value.slice(index + 1);
  }
  return result;
}

export function printPreflight(report: PreflightReport): void {
  for (const check of report.checks) {
    const mark = check.ok ? OK : KO;
    console.log(`  ${mark} ${check.kind.padEnd(6)} ${check.name.padEnd(32)} ${check.detail}`);
  }
}

/**
 * Start directory resolved ONLY ONCE by the entrypoint's `preAction` hook
 * (`index.ts`), before any subcommand action starts. No command should
 * compute this on its own or touch Commander to get it — it replaces the old
 * `resolveStartDir()`, which read `program.opts().repo` from outside the
 * module that declares `program`.
 */
let resolvedStartDir: string | undefined;

export function setResolvedStartDir(dir: string): void {
  resolvedStartDir = dir;
}

export function getResolvedStartDir(): string {
  if (resolvedStartDir === undefined) {
    throw new Error(
      "getResolvedStartDir(): called before the entrypoint's preAction hook resolved it",
    );
  }
  return resolvedStartDir;
}

export async function withContext<T>(fn: (ctx: RepoContext) => Promise<T>): Promise<T> {
  try {
    return await fn(await loadRepoContext(getResolvedStartDir()));
  } catch (err) {
    // Safe to call process.exit here: any lock acquired inside `fn` was
    // already released in `withLock`'s `finally` before the exception
    // reached this catch (see `withLock`).
    console.error((err as Error).message);
    process.exit(EXIT_FAILURE);
  }
}

/**
 * Saves the channel's trace in run.json without letting a failure to write it
 * (a run that does not live in `.runs/`, full disk) hide the original warning.
 */
async function persistNotify(store: RunStore, record: RunRecord, notify: NotifyRecord): Promise<void> {
  try {
    await store.writeNotify(record, notify);
  } catch (err) {
    console.error(`warning: could not save the notify trace: ${(err as Error).message}`);
  }
}

/**
 * Notifies the closing of a run, whichever way it was closed (normal end,
 * guard that skips it, busy lock). Best-effort on purpose: a broken channel
 * does not change the run's result, it only warns on stderr.
 *
 * `lastSuccess` is queried AFTER closing the run — so a run that just
 * succeeded counts as its own last success and is never announced as stale —,
 * and only if the pipeline declares `stale_after`, to avoid paying for the
 * `.runs/` listing in the normal case.
 */
export async function notifyRunClosed(
  pipeline: Pipeline,
  record: RunRecord,
  ctx: RepoContext,
  store: RunStore,
): Promise<void> {
  try {
    const lastSuccess = pipeline.notify?.staleAfter
      ? await store.lastSuccess(pipeline.name)
      : undefined;
    const notify = await dispatchNotify(pipeline, record, ctx, { lastSuccessAt: lastSuccess?.startedAt });
    if (notify) await persistNotify(store, record, notify);
  } catch (err) {
    // The trace of a failing channel is saved anyway: it is the delivery that
    // most needs to be readable later.
    if (err instanceof ChannelFailedError) await persistNotify(store, record, err.notify);
    console.error(`warning: notify failed: ${(err as Error).message}`);
  }
}
