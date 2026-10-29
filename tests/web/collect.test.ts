import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadRepoContext } from '../../src/cli/context.ts';
import type { JobFacts } from '../../src/health/evaluate.ts';
import { collectOverview, type FactsSource, type OverviewEntry } from '../../src/web/collect.ts';
import { addUnparseablePipeline, fixture, RUNNING_RUN_ID, SKIPPED_RUN_ID } from './fixture.ts';

const NOW = new Date('2026-08-29T03:00:00.000Z');
const loaded: FactsSource = async (): Promise<JobFacts> => ({ loaded: true, disabled: false });
const byName = (entries: OverviewEntry[], name: string): OverviewEntry | undefined =>
  entries.find((entry) => entry.name === name);

describe('collectOverview', () => {
  test('a healthy pipeline comes with its runs, ids, health and next run', async () => {
    const ctx = await loadRepoContext(await fixture());
    const { entries, unreadableRuns } = await collectOverview(ctx, ['demo'], NOW, loaded);
    const demo = byName(entries, 'demo');
    if (demo === undefined || 'error' in demo) throw new Error(`expected a healthy entry, got ${JSON.stringify(demo)}`);
    expect(demo.pipeline.name).toBe('demo');
    expect(demo.health.trigger).toBe('no-trigger');
    expect(demo.next.kind).toBe('manual');
    expect(demo.ids).toEqual([RUNNING_RUN_ID, SKIPPED_RUN_ID]);
    expect(demo.runs).toHaveLength(2);
    expect(unreadableRuns).toBe(0);
  });

  test('a folder with no pipeline.yaml is an error entry and the others stay whole', async () => {
    const root = await fixture();
    await addUnparseablePipeline(root, 'half');
    const ctx = await loadRepoContext(root);
    const { entries } = await collectOverview(ctx, ['demo', 'half'], NOW, loaded);
    expect(byName(entries, 'half')).toEqual({ name: 'half', error: 'the folder has no pipeline.yaml' });
    expect(byName(entries, 'demo')).toHaveProperty('health');
  });

  test('a truncated run.json makes the pipeline an error but its readable runs still count', async () => {
    const root = await fixture();
    const dir = join(root, '.runs', 'demo', '2026-08-29T00-00-00-000Z');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'run.json'), '{"id":');
    const ctx = await loadRepoContext(root);
    const { entries, costRuns, unreadableRuns } = await collectOverview(ctx, ['demo'], NOW, loaded);
    expect(byName(entries, 'demo')).toHaveProperty('error');
    expect(unreadableRuns).toBe(1);
    expect(costRuns.map((run) => run.id).sort()).toEqual([SKIPPED_RUN_ID, RUNNING_RUN_ID]);
  });

  test('a facts source that throws costs that pipeline only', async () => {
    const root = await fixture();
    await addUnparseablePipeline(root, 'half');
    const ctx = await loadRepoContext(root);
    const throwing: FactsSource = async () => {
      throw new Error('no scheduler on this platform');
    };
    const { entries } = await collectOverview(ctx, ['demo', 'half'], NOW, throwing);
    expect(byName(entries, 'demo')).toEqual({ name: 'demo', error: 'no scheduler on this platform' });
    expect(entries).toHaveLength(2);
  });

  test('names filters the pipelines', async () => {
    const root = await fixture();
    await addUnparseablePipeline(root, 'half');
    const ctx = await loadRepoContext(root);
    const { entries } = await collectOverview(ctx, ['demo'], NOW, loaded);
    expect(entries.map((entry) => entry.name)).toEqual(['demo']);
  });
});
