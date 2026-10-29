/**
 * The CLI's commands and options, without parsing anything: `index.ts` runs it,
 * and the plugin's tests read its surface to check every command a skill cites.
 */
import { Command } from 'commander';
import { registerDoctor } from './commands/doctor.ts';
import { registerInstall } from './commands/install.ts';
import { registerResume } from './commands/resume.ts';
import { registerRun } from './commands/run.ts';
import { registerShow } from './commands/show.ts';
import { registerStatus } from './commands/status.ts';
import { registerUninstall } from './commands/uninstall.ts';
import { registerValidate } from './commands/validate.ts';
import { registerWeb } from './commands/web.ts';
import { setResolvedStartDir } from './shared.ts';

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('pipelines')
    .description('Agentic pipelines engine')
    .option(
      '--repo <path>',
      'path to the data repo (or a subdirectory of it). If not given, ' +
        'PIPELINES_REPO is used; if that is not set either, it is searched ' +
        'upward from the current directory. Must come before the subcommand.',
    );

  /**
   * Starting point for `loadRepoContext`: independent of the invocation
   * directory. Precedence
   * `--repo` > `PIPELINES_REPO` > cwd (the upward search itself lives in
   * `loadRepoContext`, context.ts). Without this, a cron or launchd that does
   * not set `WorkingDirectory` starts in a directory unrelated to the repo and
   * `pipelines run` always fails.
   */
  program.hook('preAction', () => {
    setResolvedStartDir(program.opts().repo ?? process.env.PIPELINES_REPO ?? process.cwd());
  });

  registerValidate(program);
  registerDoctor(program);
  registerRun(program);
  registerInstall(program);
  registerUninstall(program);
  registerResume(program);
  registerStatus(program);
  registerShow(program);
  registerWeb(program);
  return program;
}
