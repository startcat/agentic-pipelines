import { readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { Command } from 'commander';
import { buildGraph } from '../../graph/build.ts';
import {
  checkAlwaysReferences,
  checkGuardReferences,
  checkPromptReferences,
  checkStepReferences,
} from '../../graph/prompts.ts';
import { lintPipeline } from '../../lint/rules.ts';
import type { RepoConfig } from '../../schema/config.ts';
import { parsePipeline, type Pipeline } from '../../schema/pipeline.ts';
import { listPipelineNames, loadPipeline, loadRepoContext } from '../context.ts';
import { EXIT_FAILURE, KO, OK, withContext } from '../shared.ts';

type ValidationOutcome = { issues: string[]; warnings: string[] };

/**
 * El cuerpo de `validate` para UN pipeline ya parseado, sin depender de un
 * `RepoContext`: con `--file` puede no haber repo a la vista.
 *
 * `draft` distingue los dos usos. Sobre un pipeline instalado, un prompt que
 * falta es un error: el pipeline no puede correr. Sobre un borrador es
 * normal tener el YAML antes que los prompts, así que es un aviso — pero
 * entonces las referencias de ese prompt NO se han mirado, y quien llama
 * debe decirlo en voz alta. Una validación parcial que no anuncia lo que se
 * saltó es peor que ninguna: hace creer que se está cubierto.
 */
async function validatePipeline(
  pipeline: Pipeline,
  opts: { promptsDir: string; config?: RepoConfig; draft: boolean },
): Promise<ValidationOutcome> {
  const issues: string[] = [];
  const warnings: string[] = [];

  buildGraph(pipeline);

  const prompts: Record<string, string> = {};
  for (const step of pipeline.steps) {
    if (step.type !== 'agent') continue;
    try {
      prompts[step.id] = await readFile(join(opts.promptsDir, step.prompt), 'utf8');
    } catch {
      const missing = `${step.id}: no se encuentra el prompt "${step.prompt}"`;
      if (!opts.draft) throw new Error(missing);
      warnings.push(`${missing} — sus referencias NO se han comprobado`);
    }
  }

  issues.push(
    ...checkPromptReferences(pipeline, prompts),
    ...checkAlwaysReferences(pipeline),
    ...checkStepReferences(pipeline),
    ...checkGuardReferences(pipeline),
    ...lintPipeline(pipeline),
  );

  if (pipeline.notify) {
    if (opts.config) {
      if (!opts.config.channels[pipeline.notify.channel]) {
        issues.push(`notify.channel "${pipeline.notify.channel}" no existe en pipelines.yaml`);
      }
    } else {
      warnings.push(
        `sin repo a la vista: NO se ha comprobado que el canal ` +
          `"${pipeline.notify.channel}" exista en pipelines.yaml`,
      );
    }
  }

  return { issues, warnings };
}

/**
 * `validate --file`: valida un YAML suelto. NO usa `withContext` a
 * propósito — ese helper sale del proceso si no hay `pipelines.yaml` a la
 * vista, y un borrador puede vivir en cualquier sitio. El repo se intenta
 * solo para poder mirar `notify.channel`, y no encontrarlo es un aviso.
 */
async function validateDraft(file: string): Promise<void> {
  const label = relative(process.cwd(), file) || file;
  try {
    const pipeline = parsePipeline(await readFile(file, 'utf8'));
    let config: RepoConfig | undefined;
    try {
      config = (await loadRepoContext(dirname(file))).config;
    } catch {
      config = undefined;
    }
    const { issues, warnings } = await validatePipeline(pipeline, {
      promptsDir: dirname(file),
      config,
      draft: true,
    });
    if (issues.length > 0) throw new Error(issues.join('\n'));
    console.log(`${OK} ${pipeline.name} (${label})`);
    for (const warning of warnings) console.log(`  aviso: ${warning}`);
  } catch (err) {
    console.error(`${KO} ${label}\n${(err as Error).message}`);
    process.exitCode = EXIT_FAILURE;
  }
}

export function registerValidate(program: Command): void {
  program
    .command('validate')
    .argument('[name]', 'pipeline a validar; sin argumento valida todos')
    .option(
      '--file <ruta>',
      'valida un pipeline.yaml suelto (un borrador) en vez de uno instalado: ' +
        'no exige que viva en pipelines/<nombre>/ ni que existan sus prompts',
    )
    .description('Valida esquema, grafo de dependencias, ciclos, referencias y las reglas del motor')
    .action(async (name: string | undefined, options: { file?: string }) => {
      if (options.file) {
        if (name) {
          console.error('validate: --file no admite además un nombre de pipeline');
          process.exitCode = EXIT_FAILURE;
          return;
        }
        await validateDraft(options.file);
        return;
      }
      await withContext(async (ctx) => {
        const names = name ? [name] : await listPipelineNames(ctx);
        let failed = false;
        for (const current of names) {
          try {
            const pipeline = await loadPipeline(ctx, current);
            const { issues, warnings } = await validatePipeline(pipeline, {
              promptsDir: join(ctx.root, 'pipelines', current),
              config: ctx.config,
              draft: false,
            });
            if (issues.length > 0) throw new Error(issues.join('\n'));
            console.log(`${OK} ${current}`);
            for (const warning of warnings) console.log(`  aviso: ${warning}`);
          } catch (err) {
            failed = true;
            console.error(`${KO} ${current}\n${(err as Error).message}`);
          }
        }
        if (failed) process.exitCode = EXIT_FAILURE;
      });
    });
}
