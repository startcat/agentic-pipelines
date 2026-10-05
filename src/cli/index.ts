#!/usr/bin/env bun
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

const program = new Command();
program
  .name('pipelines')
  .description('Motor de pipelines agénticos')
  .option(
    '--repo <path>',
    'ruta al repo de pipelines (o un subdirectorio suyo). Si no se indica, ' +
      'se usa PIPELINES_REPO; si tampoco está definida, se busca ascendiendo ' +
      'desde el directorio actual. Debe ir antes del subcomando.',
  );

/**
 * Punto de partida para `loadRepoContext`: independiente del directorio de
 * invocación. Precedencia
 * `--repo` > `PIPELINES_REPO` > cwd (la búsqueda ascendente en sí vive en
 * `loadRepoContext`, context.ts). Sin esto, un cron o launchd que no fije
 * `WorkingDirectory` arranca en un directorio sin relación con el repo y
 * `pipelines run` falla siempre.
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

await program.parseAsync(process.argv);
