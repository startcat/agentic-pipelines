import { homedir } from 'node:os';
import type { Command } from 'commander';
import { resolveParamsLenient } from '../../params/resolve.ts';
import { preflight } from '../../preflight/check.ts';
import { loadLocalParams, loadPipeline } from '../context.ts';
import { collectSetFlag, EXIT_FAILURE, parseSetFlags, printPreflight, withContext } from '../shared.ts';

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .argument('<name>')
    .option('--set <clave=valor>', 'valor de un param (repetible); lo necesitan los secretos cuyo nombre depende de params', collectSetFlag, [] as string[])
    .description('Comprueba si esta máquina puede ejecutar el pipeline')
    .action(async (name: string, opts: { set: string[] }) => {
      await withContext(async (ctx) => {
        const pipeline = await loadPipeline(ctx, name);
        // Leniente a propósito: un param ausente no corta `doctor`; aparece
        // como check en rojo en los secretos que dependen de él.
        const params = resolveParamsLenient(pipeline, {
          local: await loadLocalParams(ctx, name),
          overrides: parseSetFlags(opts.set),
        });
        const report = await preflight(pipeline, {
          repoRoot: ctx.root,
          userClaudeDir: `${homedir()}/.claude`,
          processEnv: process.env,
          dotEnv: ctx.dotEnv,
          params,
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
