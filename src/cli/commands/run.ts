import { homedir } from 'node:os';
import type { Command } from 'commander';
import { evaluateGuards } from '../../guards/evaluate.ts';
import { resolveParams } from '../../params/resolve.ts';
import { hasBlockingFailures, preflight } from '../../preflight/check.ts';
import { runPipeline } from '../../runner/orchestrate.ts';
import { RunStore } from '../../runs/store.ts';
import { collectAgentAuth, collectSecrets, loadLocalParams, loadPipeline } from '../context.ts';
import { withLock } from '../lock.ts';
import {
  collectSetFlag,
  EXIT_FAILURE,
  KO,
  notifyRunClosed,
  OK,
  parseSetFlags,
  printPreflight,
  withContext,
} from '../shared.ts';
import { unknownToolWarnings } from '../warnings.ts';

export function registerRun(program: Command): void {
  program
    .command('run')
    .argument('<name>')
    .option('--set <key=value>', 'value of a param (repeatable)', collectSetFlag, [] as string[])
    .option('--force', 'run even if a `when:` guard does not pass', false)
    .description('Run the pipeline now')
    .action(async (name: string, opts: { set: string[]; force: boolean }) => {
      await withContext(async (ctx) => {
        const pipeline = await loadPipeline(ctx, name);
        const store = new RunStore(ctx.root);

        const report = await preflight(pipeline, {
          repoRoot: ctx.root,
          userClaudeDir: `${homedir()}/.claude`,
          processEnv: process.env,
          dotEnv: ctx.dotEnv,
        });
        // `hasBlockingFailures`, not `report.ok`: an `mcp-schema` check is
        // purely informational for `doctor` (see its doc comment) — it must
        // never prevent a real run. `doctor`, further below, still uses
        // `report.ok` unchanged: there it SHOULD be as noisy as ever.
        if (hasBlockingFailures(report)) {
          printPreflight(report);
          console.error('\nMissing dependencies — nothing will run.');
          process.exitCode = EXIT_FAILURE;
          return;
        }
        if (!report.ok) {
          // Only advisory failures (mcp-schema): they do not block `run`, but
          // they are reported anyway — the operator should be able to see them
          // without having to remember to run `doctor` separately.
          for (const check of report.checks.filter((c) => !c.ok)) {
            console.error(`  warning: ${check.kind} ${check.name} — ${check.detail}`);
          }
        }

        // Resolved BEFORE taking the lock: a missing required param must not
        // make this process compete for (or block) a run that is never going
        // to start.
        const params = resolveParams(pipeline, {
          local: await loadLocalParams(ctx, name),
          overrides: parseSetFlags(opts.set),
        });

        await withLock(
          ctx.root,
          name,
          async () => {
            // `--force` does not touch preflight: that measures whether this
            // machine CAN run the pipeline (auth, binaries, secrets), and
            // skipping it would only bring the same failure forward by a few
            // seconds. What it skips are the `when:` guards, which are policy
            // — "not today" —, and that is the only kind a human in front of
            // it can knowingly overrule.
            const guards = opts.force
              ? ({ pass: true } as const)
              : await evaluateGuards(pipeline, { store, params, now: new Date() });
            if (opts.force) {
              console.error('warning: --force: skipping the `when:` guards.');
            }
            if (!guards.pass) {
              const run = await store.createRun(name, pipeline.version, params);
              // `finishRun` mutates `run` (it sets status and finishedAt), so
              // what gets notified is already the closed record, not the
              // starting one.
              await store.finishRun(run, 'skipped', guards.reason);
              console.log(`skipped: ${guards.reason}`);
              await notifyRunClosed(pipeline, run, ctx, store);
              return;
            }

            const record = await runPipeline({
              pipeline,
              repoRoot: ctx.root,
              store,
              params,
              secrets: collectSecrets(ctx, pipeline.requires.env),
              agentAuth: collectAgentAuth(ctx),
              forced: opts.force,
            });

            await notifyRunClosed(pipeline, record, ctx, store);

            for (const id of Object.keys(record.steps)) {
              const step = record.steps[id]!;
              const mark = step.status === 'success' ? OK : step.status === 'skipped' ? '○' : KO;
              console.log(`  ${mark} ${id.padEnd(20)} ${step.status}`);
            }
            for (const warning of unknownToolWarnings(record)) {
              console.error(warning);
            }
            console.log(`\n${record.status} — ${record.id}`);
            if (record.status === 'failed') process.exitCode = EXIT_FAILURE;
          },
          async () => {
            const blocked = await store.createRun(name, pipeline.version, params);
            await store.finishRun(blocked, 'skipped', 'already_running');
            await notifyRunClosed(pipeline, blocked, ctx, store);
          },
        );
      });
    });
}
