/**
 * La contraparte CON EFECTOS de `health/evaluate.ts`: lee el plist de disco,
 * pregunta a launchctl y genera el plist que `install` produciría ahora, para
 * que el módulo puro pueda comparar. Aquí vive el TTL.
 */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { RepoContext } from '../cli/context.ts';
import { jobBunPath } from '../cli/install-helpers.ts';
import type { JobFacts } from '../health/evaluate.ts';
import {
  buildPlistSpec, computePath, cronToCalendarIntervals, labelFor,
  parseDisabledLabels, renderPlist,
} from '../install/launchd.ts';
import { printDisabled, printJob } from '../install/launchctl.ts';
import type { Pipeline } from '../schema/pipeline.ts';

async function readIfExists(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  return (await file.exists()) ? file.text() : undefined;
}

/**
 * El plist que `install` escribiría ahora mismo. Devuelve `undefined` si no se
 * puede calcular —típicamente porque un binario de `requires.bin` no está en
 * esta máquina—: sin el lado esperado no hay comparación, y `evaluateTrigger`
 * no afirma desviación. Es lo correcto: `doctor` ya cuenta esa historia mejor.
 */
function expectedPlist(pipeline: Pipeline, ctx: RepoContext, now: Date): string | undefined {
  if (pipeline.triggers.length === 0) return undefined;
  try {
    const binaries = [
      ...pipeline.requires.bin,
      ...Object.values(pipeline.mcpServers).map((server) => server.command),
    ];
    const bunPath = jobBunPath();
    const path = computePath(binaries, (bin) => Bun.which(bin), [dirname(bunPath)]);
    return renderPlist(
      buildPlistSpec({
        pipelineName: pipeline.name,
        repoRoot: ctx.root,
        bunPath,
        cliEntry: join(import.meta.dir, '..', 'cli', 'index.ts'),
        home: homedir(),
        path,
        calendarIntervals: pipeline.triggers.flatMap((t) => cronToCalendarIntervals(t.cron)),
        generatedAt: now.toISOString(),
        guards: pipeline.when,
      }),
    );
  } catch {
    return undefined;
  }
}

export async function collectJobFacts(
  pipeline: Pipeline,
  ctx: RepoContext,
  now: Date,
): Promise<JobFacts> {
  const label = labelFor(pipeline.name);
  const [job, disabled] = await Promise.all([printJob(label), printDisabled()]);
  return {
    loaded: job.code === 0,
    disabled: parseDisabledLabels(disabled.stdout).includes(label),
    plistOnDisk: await readIfExists(join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`)),
    plistExpected: expectedPlist(pipeline, ctx, now),
  };
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
