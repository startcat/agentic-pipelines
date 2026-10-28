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
    .description('Uninstall this pipeline\'s scheduled job (launchd on macOS, systemd on Linux)')
    .action(async (name: string) => {
      await withContext(async (ctx) => {
        const backend = schedulerFor();
        const label = labelFor(name);
        // ONE of the files is enough: in systemd, a lone .timer or .service
        // (the other deleted by hand) is also removed, and saying "not
        // installed" would be false. `facts().artifactOnDisk` requires both.
        const paths = backend.jobPaths(label, userHome());
        const existed = (await Promise.all(paths.map((p) => Bun.file(p).exists()))).some(Boolean);

        // Always called, whether or not the job file exists: the job can still
        // be loaded even if the file was deleted by hand outside this command
        // — that invisible state is exactly what `uninstall` exists to remove.
        // `deactivate` is already idempotent by design (see
        // `SchedulerBackend`), so calling it needlessly costs nothing when
        // there really was nothing to unload. It also deletes the files.
        //
        // Never `launchctl disable` (nor `systemctl mask`): it leaves a
        // persistent override in the user's domain that would bite on a
        // reinstall months later — the same class of invisible state.
        const { warning } = await backend.deactivate(label);
        if (warning) {
          // The files are gone, but the job may still be loaded: it is not
          // considered uninstalled.
          console.error(`${warning}\n"${name}" may still be loaded in ${backend.label}.`);
          process.exitCode = EXIT_FAILURE;
          return;
        }

        if (!existed) {
          console.log(
            `"${name}" is not installed (there is no job file ${label})); checked anyway ` +
              `that it is not still loaded in ${backend.label}.`,
          );
          return;
        }

        console.log(`${OK} uninstalled ${label}`);
        console.log(`  params are still in ${join(ctx.root, '.params.local.json')} and the log is in ` +
          `${backend.logPath(userHome(), name)}`);
      });
    });
}
