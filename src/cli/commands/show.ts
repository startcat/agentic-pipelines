import type { Command } from 'commander';
import { RunStore } from '../../runs/store.ts';
import { EXIT_FAILURE, withContext, writeStdout } from '../shared.ts';

export function registerShow(program: Command): void {
  program
    .command('show')
    .argument('<name>')
    .argument('<run-id>')
    .argument('[step]')
    .description('Show the detail of a run or of one of its steps')
    .action(async (name: string, runId: string, step: string | undefined) => {
      await withContext(async (ctx) => {
        const run = await new RunStore(ctx.root).readRun(name, runId);
        if (!run) {
          console.error(`Run ${runId} of "${name}" does not exist.`);
          process.exitCode = EXIT_FAILURE;
          return;
        }
        if (step) {
          writeStdout(JSON.stringify(run.steps[step] ?? {}, null, 2));
          return;
        }
        writeStdout(JSON.stringify(run, null, 2));
      });
    });
}
