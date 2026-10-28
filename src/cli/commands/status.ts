import type { Command } from 'commander';
import { RunStore } from '../../runs/store.ts';
import { listPipelineNames } from '../context.ts';
import { withContext } from '../shared.ts';

export function registerStatus(program: Command): void {
  program
    .command('status')
    .argument('[name]')
    .option('-n, --limit <n>', 'number of runs to show', '5')
    .description('Show the status and latest runs')
    .action(async (name: string | undefined, opts: { limit: string }) => {
      await withContext(async (ctx) => {
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
