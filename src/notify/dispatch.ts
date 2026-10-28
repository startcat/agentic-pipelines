import { collectSecrets, type RepoContext } from '../cli/context.ts';
import { shellArgv } from '../runner/interpreter.ts';
import { composeEnv } from '../runner/shell.ts';
import type { Pipeline } from '../schema/pipeline.ts';
import { redactSecrets } from '../runs/store.ts';
import type { NotifyRecord, RunRecord } from '../runs/types.ts';

/**
 * Injectable signature for tests: runs the channel's command, returns its
 * exit code and its output (stdout+stderr, unredacted — redaction is done by
 * `dispatchNotify`, which is the one that knows the channel's secrets).
 */
export type SpawnChannelFn = (
  command: string,
  env: Record<string, string>,
  cwd: string,
) => Promise<{ code: number; log: string }>;

/** Cap on the tail of the channel output stored in run.json. */
const NOTIFY_LOG_MAX_CHARS = 2000;

/**
 * A channel that exits with a non-zero code throws this: the message for the
 * console, and the trace so the caller can persist it anyway — a failed send
 * is precisely the one you most need to be able to read afterwards.
 */
export class ChannelFailedError extends Error {
  constructor(message: string, readonly notify: NotifyRecord) {
    super(message);
    this.name = 'ChannelFailedError';
  }
}

// A notification must be fast; a hung channel (e.g. a `curl` against a stuck
// endpoint) must not hold the pipeline's lock indefinitely, because
// `dispatchNotify` runs inside the region that `withLock` protects in
// `cli/index.ts` — same kill-timer pattern as `runShellStep` in
// `runner/shell.ts`, with no per-channel config (there is no schema field for
// that), so here it is a fixed constant.
const NOTIFY_TIMEOUT_MS = 60_000;

async function defaultSpawnChannel(
  command: string,
  env: Record<string, string>,
  cwd: string,
): Promise<{ code: number; log: string }> {
  // stdout and stderr are captured, not discarded: they are the only proof
  // that the email went out (or why not), and they used to be lost — see
  // `NotifyRecord` in runs/types.ts.
  const proc = Bun.spawn(shellArgv(command), { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), NOTIFY_TIMEOUT_MS);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, log: stdout + stderr };
}

export type NotifyOptions = {
  /**
   * ISO instant of the pipeline's last successful run, if any — resolved by
   * the caller (`cli/index.ts`) because it has the `RunStore` at hand, and
   * that way this function is tested without touching disk. It must be
   * queried AFTER closing the current run, so that a run that just went well
   * counts as its own last success.
   */
  lastSuccessAt?: string;
  spawnChannel?: SpawnChannelFn;
};

/**
 * Cap on the derived reason. An error from an `agent` step can take thousands
 * of characters, and an email that can't be read informs of nothing.
 */
const MAX_REASON_LENGTH = 500;

/**
 * Reason for a failed run, derived from the steps that failed.
 *
 * The engine only filled in `PIPELINES_NOTIFY_REASON` for guard skips, so a
 * failure email arrived without saying what had failed and forced you to go
 * look at `.runs/` by hand. Each step's `error` is already redacted at the
 * source (`redactOutcome` in `runner/shell.ts`, `redactSecrets` in
 * `runner/orchestrate.ts`), so carrying them to the channel opens no new leak
 * path.
 *
 * Empty string if no step is `failed` — possible if something blows up before
 * or between steps. Returning it empty lets the channel use its own
 * fallback instead of inventing a reason.
 */
export function failureReason(run: RunRecord): string {
  const parts: string[] = [];
  for (const step of Object.values(run.steps)) {
    if (step.status !== 'failed') continue;
    parts.push(`${step.id}: ${step.error ?? '(no error message)'}`);
  }
  const reason = parts.join('; ');
  return reason.length > MAX_REASON_LENGTH
    ? `${reason.slice(0, MAX_REASON_LENGTH)}…`
    : reason;
}

/**
 * Decides whether the pipeline has gone too long without a single successful
 * run.
 *
 * A pipeline that has never had a success is considered stale as soon as it
 * declares the window: it is installed and has not produced anything yet,
 * which is exactly what you need to know.
 */
function isStale(pipeline: Pipeline, run: RunRecord, lastSuccessAt?: string): boolean {
  const window = pipeline.notify?.staleAfter;
  if (!window) return false;
  if (!lastSuccessAt) return true;
  const match = /^(\d+)(s|m|h)$/.exec(window);
  if (!match) return false; // the schema already validates it; here it only narrows the type
  const unitMs = match[2] === 's' ? 1000 : match[2] === 'm' ? 60_000 : 3_600_000;
  const elapsed = new Date(run.startedAt).getTime() - new Date(lastSuccessAt).getTime();
  return elapsed > Number(match[1]) * unitMs;
}

/**
 * Runs the channel declared in the pipeline's `notify:` when `run.status`
 * matches `notify.on`, or when the pipeline has gone more than
 * `notify.stale_after` without a single successful run. Best-effort: any
 * failure (channel missing in `pipelines.yaml`, a command that exits with a
 * non-zero code) propagates as an exception — it is up to the caller to
 * decide how to record it, and it never changes the result of the run itself,
 * which is already closed when this is invoked. Returns the channel's trace
 * (`NotifyRecord`) when it invokes it, so the caller can persist it; if the
 * channel fails, the trace travels inside `ChannelFailedError`.
 *
 * It is called from ALL the paths that close a run, including the guard-skip
 * and the lock-blocked in `cli/index.ts`. It wasn't before: that meant a
 * pipeline skipped night after night notified nobody, and a real pipeline
 * went ten days without running, silently. Whether a routine skip makes noise
 * is now decided by the pipeline with `on:`/`stale_after`, not by the absence
 * of the call.
 *
 * While it stays stale it warns on every run, with no deduplication state: the
 * warning turns itself off as soon as the pipeline runs green again.
 */
export async function dispatchNotify(
  pipeline: Pipeline,
  run: RunRecord,
  ctx: RepoContext,
  options: NotifyOptions = {},
): Promise<NotifyRecord | undefined> {
  if (!pipeline.notify) return undefined;
  if (run.status === 'running') return undefined; // should never get here; narrows the type
  const stale = isStale(pipeline, run, options.lastSuccessAt);
  if (!pipeline.notify.on.includes(run.status) && !stale) return undefined;

  const channel = ctx.config.channels[pipeline.notify.channel];
  if (!channel) {
    throw new Error(
      `Pipeline "${pipeline.name}" declares notify.channel "${pipeline.notify.channel}", ` +
        `which does not exist in pipelines.yaml.`,
    );
  }

  const secrets = collectSecrets(ctx, channel.env);
  // `composeEnv(secrets)` goes last: if a channel declared a secret with the
  // same name as one of the PIPELINES_NOTIFY_* variables, the declared value
  // must win — same convention that `composeAgentEnv` documents in
  // `runner/shell.ts`.
  const env = {
    PIPELINES_NOTIFY_NAME: pipeline.name,
    PIPELINES_NOTIFY_RUN_ID: run.id,
    PIPELINES_NOTIFY_STATUS: run.status,
    // `skipReason` wins when it exists: a skipped run has no failed steps to
    // look at, and its real reason is the guard that stopped it.
    PIPELINES_NOTIFY_REASON:
      run.skipReason ?? (run.status === 'failed' ? failureReason(run) : ''),
    // '1' or '' — a shell channel can branch with `[ -n "$..." ]` without
    // parsing anything. `LAST_SUCCESS` is empty if the pipeline has never had
    // a successful run.
    PIPELINES_NOTIFY_STALE: stale ? '1' : '',
    PIPELINES_NOTIFY_LAST_SUCCESS: options.lastSuccessAt ?? '',
    ...composeEnv(secrets),
  };
  const { code, log } = await (options.spawnChannel ?? defaultSpawnChannel)(channel.run, env, ctx.root);
  const record: NotifyRecord = {
    channel: pipeline.notify.channel,
    code,
    at: new Date().toISOString(),
    log: notifyLogTail(redactSecrets(log, Object.values(secrets))),
  };
  if (code !== 0) {
    throw new ChannelFailedError(
      `Channel "${pipeline.notify.channel}" (notify for "${pipeline.name}") exited with code ${code}.`,
      record,
    );
  }
  return record;
}

/** The tail of the channel output, without the trailing newline and capped. */
function notifyLogTail(log: string): string {
  const trimmed = log.trimEnd();
  return trimmed.length > NOTIFY_LOG_MAX_CHARS ? trimmed.slice(-NOTIFY_LOG_MAX_CHARS) : trimmed;
}
