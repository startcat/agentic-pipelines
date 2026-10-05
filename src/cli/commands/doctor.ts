import { homedir } from 'node:os';
import type { Command } from 'commander';
import { preflight } from '../../preflight/check.ts';
import { loadPipeline } from '../context.ts';
import { EXIT_FAILURE, printPreflight, withContext } from '../shared.ts';

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .argument('<name>')
    .description('Comprueba si esta máquina puede ejecutar el pipeline')
    .action(async (name: string) => {
      await withContext(async (ctx) => {
        const pipeline = await loadPipeline(ctx, name);
        const report = await preflight(pipeline, {
          repoRoot: ctx.root,
          userClaudeDir: `${homedir()}/.claude`,
          processEnv: process.env,
          dotEnv: ctx.dotEnv,
        });
        printPreflight(report);
        if (!report.ok) {
          const bad = report.checks.filter((c) => !c.ok).length;
          console.error(`\n${bad} problema(s) — no se ejecutará.`);
          process.exitCode = EXIT_FAILURE;
          return;
        }
        console.log('\nTodo listo.');
      });
    });
}
