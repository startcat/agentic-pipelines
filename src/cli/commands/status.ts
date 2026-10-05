import type { Command } from 'commander';
import { RunStore } from '../../runs/store.ts';
import { listPipelineNames } from '../context.ts';
import { withContext } from '../shared.ts';

export function registerStatus(program: Command): void {
  program
    .command('status')
    .argument('[name]')
    .option('-n, --limit <n>', 'número de runs a mostrar', '5')
    .description('Estado y últimas ejecuciones')
    .action(async (name: string | undefined, opts: { limit: string }) => {
      await withContext(async (ctx) => {
        const store = new RunStore(ctx.root);
        const names = name ? [name] : await listPipelineNames(ctx);
        for (const current of names) {
          const runs = (await store.listRuns(current)).slice(0, Number(opts.limit));
          console.log(`\n${current}`);
          if (runs.length === 0) {
            console.log('  (sin ejecuciones)');
            continue;
          }
          for (const run of runs) {
            const cost = run.totalCostUsd ? ` $${run.totalCostUsd.toFixed(2)}` : '';
            const reason = run.skipReason ? `  ${run.skipReason}` : '';
            // Un `success` forzado no es la misma noticia que un `success` que
            // pasó sus guardas: sin esta marca, el historial los confunde.
            const forced = run.forced ? '  (guardas omitidas)' : '';
            console.log(`  ${run.id}  ${run.status.padEnd(8)}${cost}${forced}${reason}`);
          }
        }
      });
    });
}
