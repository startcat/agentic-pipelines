import { join } from 'node:path';
import type { Command } from 'commander';
import { schedulerFor } from '../../install/backend.ts';
import { labelFor } from '../../install/common.ts';
import { userHome } from '../install-helpers.ts';
import { EXIT_FAILURE, OK, withContext } from '../shared.ts';

export function registerUninstall(program: Command): void {
  program
    .command('uninstall')
    .argument('<name>')
    .description('Desinstala el job programado de este pipeline (launchd en macOS, systemd en Linux)')
    .action(async (name: string) => {
      await withContext(async (ctx) => {
        const backend = schedulerFor();
        const label = labelFor(name);
        // Basta con UNO de los ficheros: en systemd, un .timer o un .service
        // sueltos (el otro borrado a mano) también se retiran, y decir «no está
        // instalado» sería falso. `facts().artifactOnDisk` exige los dos.
        const paths = backend.jobPaths(label, userHome());
        const existed = (await Promise.all(paths.map((p) => Bun.file(p).exists()))).some(Boolean);

        // Se llama SIEMPRE, exista o no el fichero del job: el job puede seguir
        // cargado aunque el fichero se haya borrado a mano por fuera de este
        // comando — es justo ese estado invisible el que `uninstall` existe
        // para eliminar. `deactivate` ya es idempotente por diseño (ver
        // `SchedulerBackend`), así que llamarlo de más no cuesta nada cuando de
        // verdad no había nada que descargar. También borra los ficheros.
        //
        // Nunca `launchctl disable` (ni `systemctl mask`): deja un override
        // persistente en el dominio del usuario que mordería en una
        // reinstalación meses después — la misma clase de estado invisible.
        const { warning } = await backend.deactivate(label);
        if (warning) {
          // Los ficheros ya no están, pero el job puede seguir cargado: no se
          // da por desinstalado.
          console.error(`${warning}\n"${name}" puede seguir cargado en ${backend.label}.`);
          process.exitCode = EXIT_FAILURE;
          return;
        }

        if (!existed) {
          console.log(
            `"${name}" no está instalado (no hay fichero del job ${label}); se ha comprobado ` +
              `igualmente que no quedara cargado en ${backend.label}.`,
          );
          return;
        }

        console.log(`${OK} desinstalado ${label}`);
        console.log(`  los params siguen en ${join(ctx.root, '.params.local.json')} y el log en ` +
          `${backend.logPath(userHome(), name)}`);
      });
    });
}
