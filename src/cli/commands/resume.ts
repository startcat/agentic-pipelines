import type { Command } from 'commander';
import { runPipeline } from '../../runner/orchestrate.ts';
import { RunStore } from '../../runs/store.ts';
import { collectAgentAuth, collectSecrets, loadPipeline } from '../context.ts';
import { withLock } from '../lock.ts';
import { EXIT_FAILURE, notifyRunClosed, withContext } from '../shared.ts';
import { unknownToolWarnings } from '../warnings.ts';

export function registerResume(program: Command): void {
  program
    .command('resume')
    .argument('<name>')
    .argument('<run-id>')
    .description('Resume a failed run where it left off')
    .action(async (name: string, runId: string) => {
      await withContext(async (ctx) => {
        const pipeline = await loadPipeline(ctx, name);
        const store = new RunStore(ctx.root);
        const previous = await store.readRun(name, runId);
        if (!previous) {
          console.error(`Run ${runId} of "${name}" does not exist.`);
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
              agentAuth: collectAgentAuth(ctx),
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
            // `previous.pipelineVersion`, NOT `pipeline.version`: this block
            // records the attempt to RESUME that specific run, so it must be
            // anchored to the pipeline version that run had when it ran, not
            // to the freshly loaded pipeline.yaml (which may have changed
            // between the original run and this resume attempt).
            const blocked = await store.createRun(name, previous.pipelineVersion, previous.params);
            await store.finishRun(blocked, 'skipped', 'already_running');
            await notifyRunClosed(pipeline, blocked, ctx, store);
          },
        );
      });
    });
}
