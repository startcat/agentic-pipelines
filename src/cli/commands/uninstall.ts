import { homedir } from 'node:os';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from 'commander';
import { bootout } from '../../install/launchctl.ts';
import { labelFor } from '../../install/launchd.ts';
import { launchAgentsDir } from '../install-helpers.ts';
import { OK, withContext } from '../shared.ts';

export function registerUninstall(program: Command): void {
  program
    .command('uninstall')
    .argument('<name>')
    .description('Desinstala el job de launchd de este pipeline')
    .action(async (name: string) => {
      await withContext(async (ctx) => {
        const label = labelFor(name);
        const plistPath = join(launchAgentsDir(), `${label}.plist`);
        const existed = await Bun.file(plistPath).exists();

        // Se llama SIEMPRE, exista o no el plist: el job puede seguir cargado
        // en launchd aunque el plist se haya borrado a mano por fuera de este
        // comando — es justo ese estado invisible el que `uninstall` existe
        // para eliminar. `bootout` ya es idempotente por diseño (ver su doc
        // comment en launchctl.ts), así que llamarlo de más no cuesta nada
        // cuando de verdad no había nada que descargar.
        //
        // Nunca `launchctl disable`: deja un override persistente en el
        // dominio del usuario que mordería en una reinstalación meses después
        // — la misma clase de estado invisible.
        await bootout(label);

        if (!existed) {
          console.log(
            `"${name}" no está instalado (no hay ${plistPath}); se ha comprobado igualmente que no ` +
              `quedara cargado en launchd.`,
          );
          return;
        }

        await unlink(plistPath);

        console.log(`${OK} desinstalado ${label}`);
        console.log(`  los params siguen en ${join(ctx.root, '.params.local.json')} y el log en ` +
          `${join(homedir(), 'Library', 'Logs', `pipelines-${name}.log`)}`);
      });
    });
}
