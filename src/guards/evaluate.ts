import { interpolate, interpolateForShell } from '../params/resolve.ts';
import { shellArgv } from '../runner/interpreter.ts';
import { composeEnv } from '../runner/shell.ts';
import type { Guard, Pipeline } from '../schema/pipeline.ts';
import type { RunStore } from '../runs/store.ts';

export type GuardResult = { pass: true } | { pass: false; reason: string };

export type GuardContext = {
  store: RunStore;
  params: Record<string, string>;
  now: Date;
  runShell?: (command: string, env: Record<string, string>) => Promise<number>;
  gitChangedSince?: (path: string, sinceIso: string) => Promise<boolean>;
};

/** Converts "30s" | "5m" | "4h" to milliseconds. */
export function parseDuration(text: string): number {
  const match = /^(\d+)(s|m|h)$/.exec(text);
  if (!match) throw new Error(`Invalid duration: ${text}`);
  const value = Number(match[1]);
  const unit = match[2];
  if (unit === 's') return value * 1000;
  if (unit === 'm') return value * 60_000;
  return value * 3_600_000;
}

/** Minutes since midnight of an "HH:MM" time. */
function minutesOfDay(text: string): number {
  const [h, m] = text.split(':').map(Number);
  return h! * 60 + m!;
}

/**
 * `composeEnv({})` and not `{ ...process.env }`: a guard runs through the
 * same interpreter as a `run:` step (`sh -c` on macOS, `bash --posix -c` on
 * Linux), so it deserves the same narrow, deterministic environment — the
 * minimal base and the fixed locale, without dragging in whatever the
 * operator has exported in their shell (credentials of other projects
 * included). `{}` because a guard never receives secrets: `GuardContext`
 * does not carry them, and `interpolateForShell` only resolves
 * `{{params.x}}`. The `env` that arrives as an argument holds the
 * `__PIPELINES_REF_n` variables of the environment indirection, and goes
 * last so it always wins.
 */
async function defaultRunShell(command: string, env: Record<string, string>): Promise<number> {
  const proc = Bun.spawn(shellArgv(command), {
    env: { ...composeEnv({}), ...env },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return await proc.exited;
}

async function defaultGitChangedSince(path: string, sinceIso: string): Promise<boolean> {
  const proc = Bun.spawn(['git', 'log', '-1', '--format=%H', `--since=${sinceIso}`], {
    cwd: path,
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim().length > 0;
}

async function evaluateOne(
  guard: Guard,
  pipeline: Pipeline,
  ctx: GuardContext,
): Promise<GuardResult> {
  const scope = { params: ctx.params, steps: {} };

  if ('throttle' in guard) {
    const spec =
      typeof guard.throttle === 'string'
        ? { every: guard.throttle, since: 'last_success' as const }
        : guard.throttle;
    const reference =
      spec.since === 'last_success'
        ? await ctx.store.lastSuccess(pipeline.name)
        : await ctx.store.lastAttempt(pipeline.name);
    if (!reference) return { pass: true };

    const elapsed = ctx.now.getTime() - new Date(reference.startedAt).getTime();
    const window = parseDuration(spec.every);
    if (elapsed < window) {
      return {
        pass: false,
        reason: `throttle: ${spec.every} (last run ${Math.round(elapsed / 60_000)} min ago)`,
      };
    }
    return { pass: true };
  }

  if ('changed' in guard) {
    const reference =
      guard.changed.since === 'last_success'
        ? await ctx.store.lastSuccess(pipeline.name)
        : await ctx.store.lastAttempt(pipeline.name);
    if (!reference) return { pass: true };

    const path = interpolate(guard.changed.path, scope);
    const changed = await (ctx.gitChangedSince ?? defaultGitChangedSince)(
      path,
      reference.startedAt,
    );
    // The reason uses `guard.changed.path` exactly as declared in the YAML
    // (with its `{{params.x}}` intact), NOT the already interpolated `path`:
    // `path` may contain a param value that turns out to be a secret, and
    // this reason is exactly what `RunStore.finishRun` persists unredacted
    // in `.runs/` as `skipReason`. The
    // reason must name the guard, never a value.
    return changed
      ? { pass: true }
      : {
          pass: false,
          reason: `changed: no changes in ${guard.changed.path} since ${reference.startedAt}`,
        };
  }

  if ('shell' in guard) {
    const { command, env } = interpolateForShell(guard.shell, scope);
    const code = await (ctx.runShell ?? defaultRunShell)(command, env);
    // Same rationale as in 'changed' above: `guard.shell` is the command as
    // declared, not `command` already interpolated with the params.
    return code === 0
      ? { pass: true }
      : { pass: false, reason: `shell: "${guard.shell}" returned ${code}` };
  }

  const [from, to] = guard.between.split('-');
  const start = minutesOfDay(from!);
  const end = minutesOfDay(to!);
  const current = ctx.now.getHours() * 60 + ctx.now.getMinutes();
  const inside = start <= end
    ? current >= start && current <= end
    : current >= start || current <= end;
  return inside
    ? { pass: true }
    : { pass: false, reason: `between: outside the window ${guard.between}` };
}

/**
 * Evaluates all the start guards. All of them must pass.
 * A guard that is not met is NOT a failure: the caller records the run as
 * `skipped` and exits with code 0: skipping is a normal outcome.
 */
export async function evaluateGuards(
  pipeline: Pipeline,
  ctx: GuardContext,
): Promise<GuardResult> {
  for (const guard of pipeline.when) {
    const result = await evaluateOne(guard, pipeline, ctx);
    if (!result.pass) return result;
  }
  return { pass: true };
}
