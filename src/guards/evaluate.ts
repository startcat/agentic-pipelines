import { interpolate, interpolateForShell } from '../params/resolve.ts';
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

/** Convierte "30s" | "5m" | "4h" a milisegundos. */
export function parseDuration(text: string): number {
  const match = /^(\d+)(s|m|h)$/.exec(text);
  if (!match) throw new Error(`Duración inválida: ${text}`);
  const value = Number(match[1]);
  const unit = match[2];
  if (unit === 's') return value * 1000;
  if (unit === 'm') return value * 60_000;
  return value * 3_600_000;
}

/** Minutos desde medianoche de una hora "HH:MM". */
function minutesOfDay(text: string): number {
  const [h, m] = text.split(':').map(Number);
  return h! * 60 + m!;
}

/**
 * `composeEnv({})` y no `{ ...process.env }`: una guarda corre por el mismo
 * `sh -c` que un paso `run:`, así que merece el mismo entorno estrecho y
 * determinista — la base mínima y el locale fijo, sin arrastrar lo que el
 * operador tenga exportado en su shell (credenciales de otros proyectos
 * incluidas). `{}` porque una guarda nunca recibe secretos: `GuardContext`
 * no los lleva, y `interpolateForShell` solo resuelve `{{params.x}}`.
 * El `env` que llega como argumento son las variables `__PIPELINES_REF_n`
 * de la indirección por entorno, y va al final para que gane siempre.
 */
async function defaultRunShell(command: string, env: Record<string, string>): Promise<number> {
  const proc = Bun.spawn(['sh', '-c', command], {
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
        reason: `throttle: ${spec.every} (última ejecución hace ${Math.round(elapsed / 60_000)} min)`,
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
    // El motivo usa `guard.changed.path` tal cual está declarado en el YAML
    // (con sus `{{params.x}}` intactos), NO `path` ya interpolado: `path`
    // puede contener un valor de un param que resulte ser un secreto, y este
    // motivo es justo lo que `RunStore.finishRun` persiste sin redactar en
    // `.runs/` como `skipReason`. El
    // motivo debe nombrar la guarda, nunca un valor.
    return changed
      ? { pass: true }
      : {
          pass: false,
          reason: `changed: sin cambios en ${guard.changed.path} desde ${reference.startedAt}`,
        };
  }

  if ('shell' in guard) {
    const { command, env } = interpolateForShell(guard.shell, scope);
    const code = await (ctx.runShell ?? defaultRunShell)(command, env);
    // Mismo motivo que en 'changed' arriba: `guard.shell` es el comando tal
    // cual está declarado, no `command` ya interpolado con los params.
    return code === 0
      ? { pass: true }
      : { pass: false, reason: `shell: "${guard.shell}" devolvió ${code}` };
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
    : { pass: false, reason: `between: fuera de la ventana ${guard.between}` };
}

/**
 * Evalúa todas las guardas de arranque. Todas deben cumplirse.
 * Una guarda no cumplida NO es un fallo: el llamante registra el run como
 * `skipped` y sale con código 0: saltar es un resultado normal.
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
