import { join, relative } from 'node:path';
import { acquireLock, readLock, releaseLock, type LockHandle } from '../guards/lock.ts';
import { EXIT_ALREADY_RUNNING, EXIT_LOCK_ERROR, KO } from './shared.ts';

/**
 * Path of a pipeline's lock file. `guards/lock.ts` does not export this
 * computation (it is an internal detail of that module), so it is rebuilt
 * here only for the diagnostic message, mirroring its exact
 * `.runs/.locks/<pipeline>.lock` convention.
 */
export function lockFilePath(repoRoot: string, pipeline: string): string {
  return join(repoRoot, '.runs', '.locks', `${pipeline}.lock`);
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Reports who holds the lock when `acquireLock` returns `undefined` (another
 * legitimate run in progress). The residual risk of a recycled PID was
 * accepted rather than chased with staleness timeouts or reclaim heuristics,
 * and made diagnosable instead — so this names the file (path relative to
 * the repo, never absolute), the pid and since when, so the operator can
 * judge and delete it themselves.
 */
export async function printAlreadyRunning(repoRoot: string, pipeline: string): Promise<void> {
  const relPath = relative(repoRoot, lockFilePath(repoRoot, pipeline));
  console.error(`${KO} A run of ${pipeline} is already in progress`);
  console.error(`  lock:      ${relPath}`);

  // readLock should not fail right after acquireLock saw the same file
  // without throwing, but it is a separate read (small race window with
  // another process); if it fails, the message degrades gracefully instead
  // of dragging the exception up to here.
  const info = await readLock(repoRoot, pipeline).catch(() => undefined);
  if (info) {
    const elapsedMs = Date.now() - new Date(info.startedAt).getTime();
    console.error(`  PID:       ${info.pid}`);
    console.error(`  since:     ${info.startedAt} (${formatElapsed(elapsedMs)} ago)`);
  }
  console.error('');
  console.error('  If that process no longer exists, delete the file.');
}

/**
 * Different from the case above: here `acquireLock` THREW, it did not return
 * `undefined`. It means the lock file itself is broken (unreadable, corrupt,
 * a permissions problem), not that another run holds it. The two situations
 * are not collapsed into the same message or the same exit code.
 */
export function printLockError(repoRoot: string, pipeline: string, err: Error): void {
  const relPath = relative(repoRoot, lockFilePath(repoRoot, pipeline));
  console.error(`${KO} Could not check the lock for "${pipeline}"`);
  console.error(`  lock:  ${relPath}`);
  console.error(`  error: ${err.message}`);
  console.error('');
  console.error('  The lock file looks damaged; check it before retrying.');
}

/**
 * Releases the lock on SIGINT/SIGTERM. `process.exit()` inside a `finally`
 * would not run on its own (that signal ends the process without unwinding
 * the JavaScript stack), so an explicit handler is needed: without it, a
 * `Ctrl-C` during `pipelines run` would leave the lock orphaned until
 * `acquireLock` reclaimed it for a dead PID on the next run.
 */
export function installSignalHandlers(lock: LockHandle): () => void {
  const onInterrupt = (): void => {
    void releaseLock(lock).finally(() => process.exit(130)); // 128 + SIGINT
  };
  const onTerminate = (): void => {
    void releaseLock(lock).finally(() => process.exit(143)); // 128 + SIGTERM
  };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  return () => {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  };
}

/**
 * Acquires a pipeline's lock, runs `fn` and always releases it — including an
 * exception inside `fn` or an interrupt signal. Single point used by `run`
 * and `resume` (without giving it to `resume` too, two resumes, or a resume
 * and a run, could execute the same pipeline at once, exactly what the lock
 * exists to prevent).
 *
 * Deliberately does NOT use `process.exit()` inside the protected region: an
 * earlier version called `process.exit(1)` right before its own
 * `finally { releaseLock }`, which in practice skips that `finally` entirely
 * (`process.exit` ends the process without unwinding the stack) and leaves
 * the lock of a failed run unreleased. Here `fn` sets the result through
 * `process.exitCode` and returns normally, so the `finally` below always gets
 * to run.
 *
 * `onBlocked`, if passed, is invoked when `acquireLock` returns `undefined`
 * (another legitimate run in progress) — never when the lock file itself is
 * broken (`EXIT_LOCK_ERROR`), which is a different problem, with no run to
 * record. This way a blocked run is also recorded, as
 * `skipped(already_running)`, like any other guard. Exit code 3 stays: it is
 * a separate operational signal, it does not contradict the attempt being
 * recorded.
 */
export async function withLock(
  repoRoot: string,
  pipeline: string,
  fn: (lock: LockHandle) => Promise<void>,
  onBlocked?: () => Promise<void>,
): Promise<void> {
  let lock: LockHandle | undefined;
  try {
    lock = await acquireLock(repoRoot, pipeline);
  } catch (err) {
    printLockError(repoRoot, pipeline, err as Error);
    process.exitCode = EXIT_LOCK_ERROR;
    return;
  }
  if (!lock) {
    await printAlreadyRunning(repoRoot, pipeline);
    // The exit code is set BEFORE invoking `onBlocked`, not after: if
    // `onBlocked` throws (e.g. `store.createRun` fails because of a disk or
    // permissions problem), `process.exitCode` is already 3 when the
    // exception propagates, instead of being left unset. (`withContext`
    // still forces 1 with `process.exit(EXIT_FAILURE)` on that rare failure
    // path because it passes an explicit code — closing that completely
    // would require `withContext` to respect an already-set
    // `process.exitCode`, out of scope for this targeted fix.)
    process.exitCode = EXIT_ALREADY_RUNNING;
    if (onBlocked) await onBlocked();
    return;
  }

  const uninstallSignalHandlers = installSignalHandlers(lock);
  try {
    await fn(lock);
  } finally {
    uninstallSignalHandlers();
    await releaseLock(lock);
  }
}
