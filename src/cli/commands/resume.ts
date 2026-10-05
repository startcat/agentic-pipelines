import type { Command } from 'commander';
import { runPipeline } from '../../runner/orchestrate.ts';
import { RunStore } from '../../runs/store.ts';
import { collectSecrets, loadPipeline } from '../context.ts';
import { withLock } from '../lock.ts';
import { EXIT_FAILURE, notifyRunClosed, withContext } from '../shared.ts';
import { unknownToolWarnings } from '../warnings.ts';

export function registerResume(program: Command): void {
  program
    .command('resume')
    .argument('<name>')
    .argument('<run-id>')
    .description('Retoma un run fallido donde se quedó')
    .action(async (name: string, runId: string) => {
      await withContext(async (ctx) => {
        const pipeline = await loadPipeline(ctx, name);
        const store = new RunStore(ctx.root);
        const previous = await store.readRun(name, runId);
        if (!previous) {
          console.error(`No existe el run ${runId} de "${name}".`);
          process.exitCode = EXIT_FAILURE;
          return;
        }

        await withLock(
          ctx.root,
          name,
          async () => {
            const record = await runPipeline({
              pipeline,
              repoRoot: ctx.root,
              store,
              params: previous.params,
              secrets: collectSecrets(ctx, pipeline.requires.env),
              resumeFrom: previous,
            });

            await notifyRunClosed(pipeline, record, ctx, store);

            for (const warning of unknownToolWarnings(record)) {
              console.error(warning);
            }
            console.log(`${record.status} — ${record.id}`);
            if (record.status === 'failed') process.exitCode = EXIT_FAILURE;
          },
          async () => {
            // `previous.pipelineVersion`, NO `pipeline.version`: este bloque
            // registra el intento de RETOMAR ese run concreto, así que debe
            // anclarse a la versión del pipeline que ese run tenía cuando
            // corrió, no a la del pipeline.yaml recién cargado (que puede
            // haber cambiado entre el run original y este intento de resume).
            const blocked = await store.createRun(name, previous.pipelineVersion, previous.params);
            await store.finishRun(blocked, 'skipped', 'already_running');
            await notifyRunClosed(pipeline, blocked, ctx, store);
          },
        );
      });
    });
}
