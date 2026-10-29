/**
 * The reads behind the dashboard, shared with `pipelines status --json`: the
 * runs under `.runs/`, read one at a time, and each pipeline's health and next
 * run worked out from them. Only reads, like the viewer. Both surfaces call the
 * same functions, so the JSON and the page cannot contradict each other.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadPipeline, type RepoContext } from '../cli/context.ts';
import { evaluateHealth, type Health, type JobFacts } from '../health/evaluate.ts';
import { schedulerFor } from '../install/backend.ts';
import { RunStore } from '../runs/store.ts';
import type { RunRecord } from '../runs/types.ts';
import type { Pipeline } from '../schema/pipeline.ts';
import { costRunsOf, type CostRun } from './costs.ts';
import type { UnreadableRun } from './render.ts';
import { nextRun, type NextRun } from './schedule.ts';

/**
 * Where a pipeline's scheduler facts come from: the viewer passes its cached
 * `collectJobFacts`, the CLI the uncached one, the tests a fake. On a platform
 * without a scheduler it throws, and that costs the pipeline's entry only.
 */
export type FactsSource = (pipeline: Pipeline, ctx: RepoContext, now: Date) => Promise<JobFacts>;

export type OverviewEntry =
  | { name: string; pipeline: Pipeline; runs: RunRecord[]; ids: string[]; health: Health; next: NextRun }
  | { name: string; error: string };

export type Overview = { entries: OverviewEntry[]; costRuns: CostRun[]; unreadableRuns: number };

export const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The run ids of a pipeline: the directory names under `.runs/<name>/`.
 * Read here and not through `RunStore.listRuns`, because that one parses every
 * `run.json` and throws on the first broken one — right for the CLI, which
 * must not act on a history it can't read, but on these pages one truncated
 * file would take the whole pipeline down with a 500. The names are only ever
 * compared against a URL, never joined from it.
 *
 * Only directories (or links to them) are runs: a stray file such as Finder's
 * `.DS_Store` is not a run that failed to read, and counting it as one hid a
 * whole pipeline's spend.
 */
export async function runIds(ctx: RepoContext, name: string): Promise<string[]> {
  try {
    const entries = await readdir(join(ctx.root, '.runs', name), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * `JSON.parse` of a `run.json` can give anything: `null`, a number, an array.
 * Only an object can be drawn as a run; the rest is unreadable, with a reason.
 */
export const isRunObject = (run: unknown): run is RunRecord =>
  typeof run === 'object' && run !== null && !Array.isArray(run);

/**
 * Every run of a pipeline that can be read, newest first, and the ones that
 * can't with the reason — one at a time, so a single broken `run.json` costs
 * its own row and not the page. Same order as `RunStore.listRuns`. `ids` runs
 * parallel to `runs`: the directory each one was read from.
 */
export async function readRuns(
  ctx: RepoContext,
  store: RunStore,
  name: string,
): Promise<{ runs: RunRecord[]; ids: string[]; unreadable: UnreadableRun[] }> {
  const runs: RunRecord[] = [];
  const ids: string[] = [];
  const unreadable: UnreadableRun[] = [];
  let entries: string[];
  try {
    entries = await runIds(ctx, name);
  } catch (err) {
    return { runs, ids, unreadable: [{ reason: reasonOf(err) }] };
  }
  for (const id of entries) {
    try {
      const run = await store.readRun(name, id);
      if (run === undefined) continue;
      if (isRunObject(run)) {
        runs.push(run);
        ids.push(id);
      } else unreadable.push({ id, reason: 'run.json is not a run record' });
    } catch (err) {
      unreadable.push({ id, reason: reasonOf(err) });
    }
  }
  return { runs, ids, unreadable };
}

/**
 * A pipeline's runs as the costs see them. Named by their DIRECTORIES, not by
 * what the file says: those are what the links are built from, so a run.json
 * with a missing or stale `id` or `pipeline` still links to its own page.
 */
export const costRunsFor = (name: string, runs: RunRecord[], ids: string[]): CostRun[] =>
  costRunsOf(runs.map((run, i) => ({ ...run, pipeline: name, id: ids[i]! })));

/**
 * Why a pipeline couldn't be read, said for THIS surface.
 *
 * `loadPipeline` is written for the CLI, where a person types the name and
 * getting it wrong is the normal case: "Pipeline "broken" does not exist.
 * Available: good, broken" is useful there. Here the name comes from walking
 * the disk, so the sentence contradicts itself —it names `broken` as absent
 * and as available at once— and reads as if the tool is broken.
 *
 * On the web the fact is different and simple: the folder is there, the file
 * is not. Any other failure (an unreadable YAML, a `name` that doesn't match
 * its directory) keeps its message: there the original text is the only thing
 * that says what needs fixing.
 *
 * Returns PLAIN TEXT, no tags: `renderHealthPanel` runs it through
 * `escapeHtml` like everything else.
 */
export async function unreadableReason(ctx: RepoContext, name: string, err: unknown): Promise<string> {
  const yaml = join(ctx.root, 'pipelines', name, 'pipeline.yaml');
  if (!(await Bun.file(yaml).exists())) return 'the folder has no pipeline.yaml';
  return reasonOf(err);
}

/**
 * The scheduler's name for the footer. `schedulerFor()` throws on a platform
 * it doesn't support; the rows of the dashboard already say so one by one, so
 * the footer just says it doesn't know instead of turning every page into a 500.
 */
export function schedulerLabel(): string {
  try {
    return schedulerFor().label;
  } catch {
    return '—';
  }
}

/**
 * Each pipeline's health and next run and, from the very same reads, the runs
 * the spend adds up: `.runs/` is walked once, not once for the verdicts and
 * again for the money.
 */
export async function collectOverview(
  ctx: RepoContext,
  names: readonly string[],
  now: Date,
  facts: FactsSource,
): Promise<Overview> {
  const store = new RunStore(ctx.root);
  const entries: OverviewEntry[] = [];
  const costRuns: CostRun[] = [];
  let unreadableRuns = 0;
  for (const name of names) {
    // Per-pipeline containment: `loadPipeline` throws under ORDINARY
    // conditions (a half-authored `pipelines/<x>/` with no `pipeline.yaml`
    // — exactly when this overview is most useful), and so does a history
    // with a `run.json` truncated mid-write. Without this try/catch, a single
    // broken pipeline took down the whole overview for all the others. The
    // facts source is inside for the same reason: on a platform without a
    // scheduler each entry carries the error, but the overview still answers.
    try {
      // The runs first, read one at a time (`readRuns`, as /costs does): a
      // pipeline whose YAML broke after it ran, or with one unreadable run,
      // still spent the money of the runs that can be read, and the spend
      // has to agree with the costs page.
      const { runs, ids, unreadable } = await readRuns(ctx, store, name);
      for (const run of costRunsFor(name, runs, ids)) costRuns.push(run);
      unreadableRuns += unreadable.length;
      // Health, though, is not judged on a partial history: the CLI's
      // `status` refuses one (`RunStore.listRuns` throws), and the entry says
      // why with the same message instead of a verdict on what is left, and
      // which run it is, so nobody has to list `.runs/` to find it.
      const broken = unreadable[0];
      if (broken !== undefined) {
        throw new Error(broken.id === undefined ? broken.reason : `run ${broken.id}: ${broken.reason}`);
      }
      const pipeline = await loadPipeline(ctx, name);
      const health = evaluateHealth(pipeline, runs, await facts(pipeline, ctx, now), now);
      const next = nextRun(health.trigger, pipeline.triggers.map((t) => t.cron), now);
      entries.push({ name, pipeline, runs, ids, health, next });
    } catch (err) {
      entries.push({ name, error: await unreadableReason(ctx, name, err) });
    }
  }
  return { entries, costRuns, unreadableRuns };
}
