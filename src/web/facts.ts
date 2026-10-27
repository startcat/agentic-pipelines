/**
 * La contraparte CON EFECTOS de `health/evaluate.ts`: lee los ficheros del job
 * de disco, pregunta al programador y genera los que `install` produciría
 * ahora, para que el módulo puro pueda comparar. Aquí vive el TTL.
 */
import { dirname, join } from 'node:path';
import type { RepoContext } from '../cli/context.ts';
import { jobBunPath, userHome } from '../cli/install-helpers.ts';
import type { JobFacts } from '../health/evaluate.ts';
import { schedulerFor, type SchedulerBackend } from '../install/backend.ts';
import { computePath, cronToCalendarIntervals, labelFor } from '../install/common.ts';
import type { Pipeline } from '../schema/pipeline.ts';

/**
 * Los ficheros del job que `install` escribiría ahora mismo, concatenados en
 * su orden fijo (en launchd hay uno solo, así que es el plist tal cual).
 * Devuelve `undefined` si no se puede calcular —típicamente porque un binario
 * de `requires.bin` no está en esta máquina—: sin el lado esperado no hay
 * comparación, y `evaluateTrigger` no afirma desviación. Es lo correcto:
 * `doctor` ya cuenta esa historia mejor.
 */
function expectedArtifact(
  backend: SchedulerBackend,
  pipeline: Pipeline,
  ctx: RepoContext,
  now: Date,
): string | undefined {
  if (pipeline.triggers.length === 0) return undefined;
  try {
    const binaries = [
      ...pipeline.requires.bin,
      ...Object.values(pipeline.mcpServers).map((server) => server.command),
    ];
    const bunPath = jobBunPath();
    const path = computePath(binaries, (bin) => Bun.which(bin), [dirname(bunPath)]);
    return backend
      .jobFiles({
        pipelineName: pipeline.name,
        repoRoot: ctx.root,
        bunPath,
        cliEntry: join(import.meta.dir, '..', 'cli', 'index.ts'),
        home: userHome(),
        path,
        calendarIntervals: pipeline.triggers.flatMap((t) => cronToCalendarIntervals(t.cron)),
        generatedAt: now.toISOString(),
        guards: pipeline.when,
      })
      .map((file) => file.contents)
      .join('\n');
  } catch {
    return undefined;
  }
}

export async function collectJobFacts(
  pipeline: Pipeline,
  ctx: RepoContext,
  now: Date,
): Promise<JobFacts> {
  const backend = schedulerFor();
  const label = labelFor(pipeline.name);
  const facts = await backend.facts(label, userHome());
  return { ...facts, artifactExpected: expectedArtifact(backend, pipeline, ctx, now) };
}

/** Caché por pipeline con caducidad: launchctl no se consulta en cada tick. */
export function createJobFactsCache(ttlMs: number) {
  const entries = new Map<string, { at: number; facts: JobFacts }>();
  return {
    async get(pipeline: Pipeline, ctx: RepoContext, now: Date): Promise<JobFacts> {
      const cached = entries.get(pipeline.name);
      if (cached && now.getTime() - cached.at < ttlMs) return cached.facts;
      const facts = await collectJobFacts(pipeline, ctx, now);
      entries.set(pipeline.name, { at: now.getTime(), facts });
      return facts;
    },
  };
}
