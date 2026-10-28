import { homedir } from 'node:os';
import type { Command } from 'commander';
import { preflight } from '../../preflight/check.ts';
import { loadPipeline } from '../context.ts';
import { EXIT_FAILURE, printPreflight, withContext } from '../shared.ts';

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .argument('<name>')
    .description('Check whether this machine can run the pipeline')
    .action(async (name: string) => {
      await withContext(async (ctx) => {
        const pipeline = await loadPipeline(ctx, name);
        const report = await preflight(pipeline, {
          repoRoot: ctx.root,
          userClaudeDir: `${homedir()}/.claude`,
          processEnv: process.env,
          dotEnv: ctx.dotEnv,
          includePlatform: true,
        });
        printPreflight(report);
        if (!report.ok) {
          const bad = report.checks.filter((c) => !c.ok).length;
          console.error(`\n${bad} problem(s) — it will not run.`);
          process.exitCode = EXIT_FAILURE;
          return;
        }
        // Platform checks do not block `run`, but they do say that `install`
        // would not work yet: "All set" would be a lie.
        const platformRed = report.checks.filter((c) => c.kind === 'platform' && !c.ok).map((c) => c.name);
        if (platformRed.length > 0) {
          console.log(`\nReady to run; to install, still missing: ${platformRed.join(', ')}.`);
          return;
        }
        console.log('\nAll set.');
      });
    });
}
