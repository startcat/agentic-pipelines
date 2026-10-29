/**
 * `pipelines status --json`: the dashboard's overview as data. Every figure
 * comes from the same functions the viewer draws with (`collectOverview`,
 * `verdict`, `panelSummary`, `spendOf`), so the JSON and the page cannot say
 * different things. `toStatusJson` is pure; the reads live in `collect.ts`.
 */
import { listPipelineNames, type RepoContext } from './context.ts';
import type { Health, TriggerHealth, WorkHealth } from '../health/evaluate.ts';
import { RunStore } from '../runs/store.ts';
import { costRunsFor, readRuns, type Overview } from '../web/collect.ts';
import { spendOf, type CostRun } from '../web/costs.ts';
import type { NextRun } from '../web/schedule.ts';
import { panelSummary, verdict, type Tone } from '../web/verdict.ts';

/**
 * Why `next` is `null`. `not-installed` and `disabled` are the trigger axis
 * (a cron nobody loaded fires nothing); `manual`: there is no cron at all;
 * `unknown`: the job is loaded but its cron can't be walked, and an invented
 * time would be worse than none.
 */
export type NextReason = 'not-installed' | 'disabled' | 'manual' | 'unknown';

export type StatusEntry =
  | {
      name: string;
      description: string;
      verdict: { line: string; tone: Tone };
      trigger: TriggerHealth;
      work: WorkHealth;
      contradiction: boolean;
      consecutiveSkips: number;
      lastRun: {
        id: string;
        status: string;
        startedAt: string;
        costUsd: number | null;
        forced: boolean;
        skipReason?: string;
      } | null;
      next: string | null;
      nextReason?: NextReason;
    }
  | { name: string; error: string };

export type StatusJson = {
  generatedAt: string;
  repo: string;
  scheduler: string;
  summary: { line: string; tone: Tone; sub: string };
  pipelines: StatusEntry[];
  costs: {
    month: { label: string; total: number; runs: number; withAgent: number };
    previous: { label: string; total: number };
    unreadableRuns: number;
  };
};

export type RepoCosts = { runs: CostRun[]; unreadable: number };

/**
 * The runs of every pipeline in the repo, as the costs page reads them: one
 * `run.json` at a time, so a truncated one costs only itself. Used when the
 * overview was asked for one pipeline: the month's spend is still the repo's.
 */
export async function repoCostRuns(ctx: RepoContext): Promise<RepoCosts> {
  const store = new RunStore(ctx.root);
  const runs: CostRun[] = [];
  let unreadable = 0;
  for (const name of await listPipelineNames(ctx)) {
    const read = await readRuns(ctx, store, name);
    for (const run of costRunsFor(name, read.runs, read.ids)) runs.push(run);
    unreadable += read.unreadable.length;
  }
  return { runs, unreadable };
}

/**
 * `NextRun` said as data: an ISO instant, or `null` with the reason. `none`
 * only happens on the trigger axis's `not-installed` and `disabled`, so the
 * reason is that axis.
 */
function nextOf(next: NextRun, trigger: TriggerHealth): { next: string | null; nextReason?: NextReason } {
  switch (next.kind) {
    case 'at':
      return next.at !== '' ? { next: next.at } : { next: null, nextReason: 'unknown' };
    case 'manual':
      return { next: null, nextReason: 'manual' };
    case 'none':
      return { next: null, nextReason: trigger === 'disabled' ? 'disabled' : 'not-installed' };
  }
}

const finiteOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export function toStatusJson(input: {
  overview: Overview;
  costs: RepoCosts;
  repo: string;
  scheduler: string;
  now: Date;
}): StatusJson {
  const { overview, costs, repo, scheduler, now } = input;
  const healths: Health[] = [];
  let broken = 0;
  const pipelines: StatusEntry[] = [];
  for (const entry of overview.entries) {
    if ('error' in entry) {
      broken++;
      pipelines.push({ name: entry.name, error: entry.error });
      continue;
    }
    const { name, pipeline, runs, ids, health, next } = entry;
    healths.push(health);
    const said = verdict(health, pipeline.steps.length, scheduler);
    const last = runs[0];
    pipelines.push({
      name,
      description: pipeline.description,
      verdict: { line: said.line, tone: said.tone },
      trigger: health.trigger,
      work: health.work,
      contradiction: health.contradiction,
      consecutiveSkips: health.consecutiveSkips,
      lastRun:
        last === undefined
          ? null
          : {
              // The directory, not what the file says: it is what
              // `pipelines show <name> <run-id>` takes.
              id: ids[0]!,
              status: last.status,
              startedAt: last.startedAt,
              costUsd: finiteOrNull(last.totalCostUsd),
              forced: last.forced === true,
              ...(typeof last.skipReason === 'string' ? { skipReason: last.skipReason } : {}),
            },
      ...nextOf(next, health.trigger),
    });
  }
  const spend = spendOf(costs.runs, now);
  return {
    generatedAt: now.toISOString(),
    repo,
    scheduler,
    summary: panelSummary(healths, broken),
    pipelines,
    costs: { month: spend.month, previous: spend.previous, unreadableRuns: costs.unreadable },
  };
}
