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
          includePlatform: true,
        });
        printPreflight(report);
        if (!report.ok) {
          const bad = report.checks.filter((c) => !c.ok).length;
          console.error(`\n${bad} problema(s) — no se ejecutará.`);
          process.exitCode = EXIT_FAILURE;
          return;
        }
        // Los checks de plataforma no bloquean `run`, pero sí dicen que
        // `install` no funcionaría todavía: «Todo listo» sería mentira.
        const platformRed = report.checks.filter((c) => c.kind === 'platform' && !c.ok).map((c) => c.name);
        if (platformRed.length > 0) {
          console.log(`\nListo para ejecutar; para instalar falta: ${platformRed.join(', ')}.`);
          return;
        }
        console.log('\nTodo listo.');
      });
    });
}
