import { readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { Command } from 'commander';
import { buildGraph } from '../../graph/build.ts';
import {
  checkAlwaysReferences,
  checkEnvReferences,
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
 * The body of `validate` for ONE already-parsed pipeline, without depending on
 * a `RepoContext`: with `--file` there may be no repo.
 *
 * `draft` tells the two uses apart. On an installed pipeline, a missing prompt
 * is an error: the pipeline cannot run. On a draft it is normal to have the
 * YAML before the prompts, so it is a warning — but then that prompt's
 * references have NOT been checked, and the caller must say so out loud. A
 * partial validation that does not announce what it skipped is worse than
 * none: it makes you believe you are covered.
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
      const missing = `${step.id}: prompt "${step.prompt}" not found`;
      if (!opts.draft) throw new Error(missing);
      warnings.push(`${missing} — its references have NOT been checked`);
    }
  }

  issues.push(
    ...checkPromptReferences(pipeline, prompts),
    ...checkAlwaysReferences(pipeline),
    ...checkStepReferences(pipeline),
    ...checkGuardReferences(pipeline),
    ...checkEnvReferences(pipeline),
    ...lintPipeline(pipeline),
  );

  if (pipeline.notify) {
    if (opts.config) {
      if (!opts.config.channels[pipeline.notify.channel]) {
        issues.push(`notify.channel "${pipeline.notify.channel}" does not exist in pipelines.yaml`);
      }
    } else {
      warnings.push(
        `no repo found: did NOT check that channel ` +
          `"${pipeline.notify.channel}" exists in pipelines.yaml`,
      );
    }
  }

  return { issues, warnings };
}

/**
 * `validate --file`: validates a standalone YAML. Deliberately does NOT use
 * `withContext` — that helper exits the process if there is no
 * `pipelines.yaml` in sight, and a draft can live anywhere. The repo is only
 * tried so `notify.channel` can be checked, and not finding it is a warning.
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
    for (const warning of warnings) console.log(`  warning: ${warning}`);
  } catch (err) {
    console.error(`${KO} ${label}\n${(err as Error).message}`);
    process.exitCode = EXIT_FAILURE;
  }
}

export function registerValidate(program: Command): void {
  program
    .command('validate')
    .argument('[name]', 'pipeline to validate; with no argument, validate all of them')
    .option(
      '--file <path>',
      'validate a standalone pipeline.yaml (a draft) instead of an installed one; ' +
        'it doesn\'t need to live in pipelines/<name>/ and its prompts don\'t need to exist',
    )
    .description('Validate the schema, dependency graph, cycles, references and engine rules')
    .action(async (name: string | undefined, options: { file?: string }) => {
      if (options.file) {
        if (name) {
          console.error('validate: --file does not accept a pipeline name as well');
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
            for (const warning of warnings) console.log(`  warning: ${warning}`);
          } catch (err) {
            failed = true;
            console.error(`${KO} ${current}\n${(err as Error).message}`);
          }
        }
        if (failed) process.exitCode = EXIT_FAILURE;
      });
    });
}
