import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadRepoContext } from '../../src/cli/context.ts';
import { repoCostRuns, toStatusJson, type StatusEntry, type StatusJson } from '../../src/cli/status-json.ts';
import type { JobFacts } from '../../src/health/evaluate.ts';
import { collectOverview, type FactsSource } from '../../src/web/collect.ts';
import { spendOf } from '../../src/web/costs.ts';
import { formatNext, formatWhen } from '../../src/web/format.ts';
import { addUnparseablePipeline, fixture, RUNNING_RUN_ID } from '../web/fixture.ts';

const NOW = new Date('2026-08-29T03:00:00.000Z');
const factsOf = (facts: JobFacts): FactsSource => async () => facts;
const LOADED = factsOf({ loaded: true, disabled: false });
const NO_JOB = factsOf({ loaded: false, disabled: false });

async function addPipeline(root: string, name: string, extra = ''): Promise<void> {
  await mkdir(join(root, 'pipelines', name), { recursive: true });
  await writeFile(
    join(root, 'pipelines', name, 'pipeline.yaml'),
    `name: ${name}\ndescription: ${name} pipeline\nversion: 1\n${extra}steps:\n  - id: one\n    type: shell\n    run: "true"\n`,
  );
}

async function addRun(root: string, name: string, id: string, extra: Record<string, unknown>): Promise<void> {
  const dir = join(root, '.runs', name, id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'run.json'),
    JSON.stringify({
      id, pipeline: name, pipelineVersion: 1, status: 'success',
      startedAt: `${id.slice(0, 10)}T${id.slice(11, 13)}:00:00.000Z`, params: {}, steps: {}, ...extra,
    }),
  );
}

async function statusOf(root: string, names: string[], facts: FactsSource = LOADED): Promise<StatusJson> {
  const ctx = await loadRepoContext(root);
  const overview = await collectOverview(ctx, names, NOW, facts);
  const costs = { runs: overview.costRuns, unreadable: overview.unreadableRuns };
  return toStatusJson({ overview, costs, repo: ctx.root, scheduler: 'launchd', timeZone: 'Europe/Madrid', now: NOW });
}

function healthy(json: StatusJson, name: string): Extract<StatusEntry, { verdict: unknown }> {
  const entry = json.pipelines.find((p) => p.name === name);
  if (entry === undefined || 'error' in entry) throw new Error(`expected a healthy ${name}, got ${JSON.stringify(entry)}`);
  return entry;
}

describe('toStatusJson', () => {
  test('a manual pipeline with a run in progress', async () => {
    const json = await statusOf(await fixture(), ['demo'], NO_JOB);
    const demo = healthy(json, 'demo');
    expect(demo.description).toBe('A test pipeline');
    expect(demo.verdict).toEqual({ line: 'Running now — 1 of 1 steps.', tone: 'live' });
    expect(demo.trigger).toBe('no-trigger');
    expect(demo.next).toBeNull();
    expect(demo.nextReason).toBe('manual');
    expect(demo.lastRun?.id).toBe(RUNNING_RUN_ID);
    expect(demo.lastRun?.status).toBe('running');
    expect(demo.lastRun?.costUsd).toBeNull();
    expect(demo.lastRun?.forced).toBe(false);
    expect(json.generatedAt).toBe(NOW.toISOString());
    expect(json.scheduler).toBe('launchd');
  });

  test('an installed weekly cron gets the next Monday at 07:00, local time', async () => {
    const root = await fixture();
    await addPipeline(root, 'weekly', 'triggers:\n  - cron: "0 7 * * 1"\n');
    const weekly = healthy(await statusOf(root, ['weekly']), 'weekly');
    expect(weekly.nextReason).toBeUndefined();
    const next = new Date(weekly.next!);
    expect(next.toISOString()).toBe(weekly.next!);
    expect(next.getDay()).toBe(1);
    expect(next.getHours()).toBe(7);
    expect(next.getMinutes()).toBe(0);
    expect(next.getTime()).toBeGreaterThan(NOW.getTime());
    expect(next.getTime() - NOW.getTime()).toBeLessThanOrEqual(7 * 24 * 3600 * 1000);
    // The dashboard's own words, in the machine's local time.
    expect(weekly.nextLabel).toBe(formatNext(next, NOW));
    expect(weekly.nextLabel).toBe('Mon 07:00');
    expect(weekly.triggers).toEqual(['0 7 * * 1']);
  });

  test('the machine time zone comes with the overview', async () => {
    const json = await statusOf(await fixture(), ['demo'], NO_JOB);
    expect(json.timeZone).toBe('Europe/Madrid');
  });

  test('a pipeline without a next run has no nextLabel', async () => {
    const demo = healthy(await statusOf(await fixture(), ['demo'], NO_JOB), 'demo');
    expect(demo).not.toHaveProperty('nextLabel');
  });

  test('triggers removed from an installed pipeline: the job still loaded shows as drifted', async () => {
    const demo = healthy(await statusOf(await fixture(), ['demo'], LOADED), 'demo');
    expect(demo.trigger).toBe('drifted');
    expect(demo.triggers).toEqual([]);
    expect(demo.next).toBeNull();
  });

  test('a cron nobody loaded has no next run: not-installed', async () => {
    const root = await fixture();
    await addPipeline(root, 'weekly', 'triggers:\n  - cron: "0 7 * * 1"\n');
    const weekly = healthy(await statusOf(root, ['weekly'], factsOf({ loaded: false, disabled: false })), 'weekly');
    expect(weekly.next).toBeNull();
    expect(weekly.nextReason).toBe('not-installed');
    expect(weekly.verdict.tone).toBe('bad');
  });

  test('a disabled job has no next run: disabled', async () => {
    const root = await fixture();
    await addPipeline(root, 'weekly', 'triggers:\n  - cron: "0 7 * * 1"\n');
    const weekly = healthy(await statusOf(root, ['weekly'], factsOf({ loaded: true, disabled: true })), 'weekly');
    expect(weekly.next).toBeNull();
    expect(weekly.nextReason).toBe('disabled');
  });

  test('a loaded cron that cannot be walked: unknown, never an invented date', async () => {
    const root = await fixture();
    await addPipeline(root, 'often', 'triggers:\n  - cron: "*/5 * * * *"\n');
    const often = healthy(await statusOf(root, ['often']), 'often');
    expect(often.next).toBeNull();
    expect(often.nextReason).toBe('unknown');
  });

  test('a half-written pipeline is an error entry and the summary counts it', async () => {
    const root = await fixture();
    await addUnparseablePipeline(root, 'half');
    const json = await statusOf(root, ['demo', 'half']);
    expect(json.pipelines.find((p) => p.name === 'half')).toEqual({ name: 'half', error: 'the folder has no pipeline.yaml' });
    expect(json.summary.sub).toContain('1 unreadable');
    healthy(json, 'demo');
  });

  test('the last run carries its cost, forced mark and skip reason', async () => {
    const root = await fixture();
    await addPipeline(root, 'paid');
    await addRun(root, 'paid', '2026-08-28T05-00-00-000Z', { totalCostUsd: 0.42, forced: true });
    const paid = healthy(await statusOf(root, ['paid']), 'paid');
    const when = formatWhen('2026-08-28T05:00:00.000Z', NOW);
    expect(paid.lastRun).toEqual({
      id: '2026-08-28T05-00-00-000Z', status: 'success', startedAt: '2026-08-28T05:00:00.000Z',
      startedLabel: `${when.day} ${when.time}`, costUsd: 0.42, forced: true,
    });
    const demo = healthy(await statusOf(root, ['demo'], NO_JOB), 'demo');
    expect(demo.lastRun).not.toHaveProperty('skipReason');
  });

  test('costs are the same sums as the costs page', async () => {
    const root = await fixture();
    await addPipeline(root, 'paid');
    await addRun(root, 'paid', '2026-08-28T05-00-00-000Z', { totalCostUsd: 0.42 });
    const ctx = await loadRepoContext(root);
    const overview = await collectOverview(ctx, ['demo', 'paid'], NOW, LOADED);
    const costs = { runs: overview.costRuns, unreadable: 3 };
    const json = toStatusJson({ overview, costs, repo: ctx.root, scheduler: 'launchd', timeZone: 'UTC', now: NOW });
    const spend = spendOf(costs.runs, NOW);
    expect(json.costs.month).toEqual(spend.month);
    expect(json.costs.month.total).toBe(0.42);
    expect(json.costs.previous).toEqual(spend.previous);
    expect(json.costs.unreadableRuns).toBe(3);
  });
});

describe('repoCostRuns', () => {
  test('brings the runs of every pipeline, whatever the overview was asked for', async () => {
    const root = await fixture();
    await addPipeline(root, 'paid');
    await addRun(root, 'paid', '2026-08-28T05-00-00-000Z', { totalCostUsd: 0.42 });
    const ctx = await loadRepoContext(root);
    const overview = await collectOverview(ctx, ['paid'], NOW, LOADED);
    expect(new Set(overview.costRuns.map((run) => run.pipeline))).toEqual(new Set(['paid']));
    const costs = await repoCostRuns(ctx);
    expect(new Set(costs.runs.map((run) => run.pipeline))).toEqual(new Set(['demo', 'paid']));
    expect(costs.runs).toHaveLength(3);
    expect(costs.unreadable).toBe(0);
  });
});
