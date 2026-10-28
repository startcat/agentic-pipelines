/**
 * The counterpart WITH EFFECTS of `health/evaluate.ts`: reads the job files
 * from disk, asks the scheduler and generates the ones `install` would produce
 * now, so the pure module can compare. The TTL lives here.
 */
import { dirname, join } from 'node:path';
import type { RepoContext } from '../cli/context.ts';
import { jobBunPath, userHome } from '../cli/install-helpers.ts';
import type { JobFacts } from '../health/evaluate.ts';
import { schedulerFor, type SchedulerBackend } from '../install/backend.ts';
import { computePath, cronToCalendarIntervals, labelFor } from '../install/common.ts';
import type { Pipeline } from '../schema/pipeline.ts';

/**
 * The job files `install` would write right now, concatenated in their fixed
 * order (launchd has just one, so it is the plist as is). Returns `undefined`
 * if it can't be computed — typically because a `requires.bin` binary is not
 * on this machine —: without the expected side there is no comparison, and
 * `evaluateTrigger` does not claim drift. That is right: `doctor` already
 * tells that story better.
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

/** Per-pipeline cache with expiry: launchctl is not queried on every tick. */
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
