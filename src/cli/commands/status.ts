import type { Command } from 'commander';
import { RunStore } from '../../runs/store.ts';
import { collectOverview, schedulerLabel } from '../../web/collect.ts';
import { collectJobFacts } from '../../web/facts.ts';
import { listPipelineNames, loadPipeline, type RepoContext } from '../context.ts';
import { withContext, writeStdout } from '../shared.ts';
import { repoCostRuns, toStatusJson } from '../status-json.ts';

/**
 * The overview as JSON, from the same reads as the dashboard. Only reads.
 * An unknown name fails with `loadPipeline`'s own message and exit code 1
 * (the text output, unlike this, prints it with "(no runs)"): a script reading
 * the JSON must not mistake a typo for a pipeline that never ran. A pipeline
 * that can't be read is an entry with its `error`, not a failed command.
 * `costs` is always the whole repo's, like `/costs`.
 */
async function printStatusJson(ctx: RepoContext, name: string | undefined): Promise<void> {
  const all = await listPipelineNames(ctx);
  let names = all;
  if (name !== undefined) {
    if (!all.includes(name)) await loadPipeline(ctx, name);
    names = [name];
  }
  const now = new Date();
  const overview = await collectOverview(ctx, names, now, collectJobFacts);
  // With every pipeline the overview already read every run: `.runs/` is not
  // walked twice.
  const costs =
    name === undefined
      ? { runs: overview.costRuns, unreadable: overview.unreadableRuns }
      : await repoCostRuns(ctx);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const json = toStatusJson({ overview, costs, repo: ctx.root, scheduler: schedulerLabel(), timeZone, now });
  writeStdout(JSON.stringify(json, null, 2));
}

export function registerStatus(program: Command): void {
  program
    .command('status')
    .argument('[name]')
    .option('-n, --limit <n>', 'number of runs to show', '5')
    .option('--json', 'print the overview as JSON (verdict, next run, last run, month spend)', false)
    .description('Show the status and latest runs')
    .action(async (name: string | undefined, opts: { limit: string; json: boolean }) => {
      await withContext(async (ctx) => {
        if (opts.json) {
          await printStatusJson(ctx, name);
          return;
        }
        const store = new RunStore(ctx.root);
        const names = name ? [name] : await listPipelineNames(ctx);
        for (const current of names) {
          const runs = (await store.listRuns(current)).slice(0, Number(opts.limit));
          console.log(`\n${current}`);
          if (runs.length === 0) {
            console.log('  (no runs)');
            continue;
          }
          for (const run of runs) {
            const cost = run.totalCostUsd ? ` $${run.totalCostUsd.toFixed(2)}` : '';
            const reason = run.skipReason ? `  ${run.skipReason}` : '';
            // A forced `success` is not the same news as a `success` that
            // passed its guards: without this mark, the history confuses them.
            const forced = run.forced ? '  (guards skipped)' : '';
            console.log(`  ${run.id}  ${run.status.padEnd(8)}${cost}${forced}${reason}`);
          }
        }
      });
    });
}
