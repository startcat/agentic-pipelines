/**
 * launchd detrás de `SchedulerBackend`: une el módulo puro (`launchd.ts`) con
 * los efectos (`launchctl.ts`) y las rutas de `~/Library`. Es lo que hacían
 * hasta ahora `install`, `uninstall` y el panel por su cuenta, reunido en un
 * solo sitio y sin cambiar un byte del plist (lo fija el test de oro).
 */
import { homedir } from 'node:os';
import { readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { SchedulerBackend } from './backend.ts';
import { bootout, bootstrap, printDisabled, printJob } from './launchctl.ts';
import { buildPlistSpec, logPathFor, parseDisabledLabels, renderPlist } from './launchd.ts';

function launchAgentsDir(home: string): string {
  return join(home, 'Library', 'LaunchAgents');
}

function plistPathFor(home: string, label: string): string {
  return join(launchAgentsDir(home), `${label}.plist`);
}

async function readIfExists(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  return (await file.exists()) ? file.text() : undefined;
}

/**
 * Los plists de LaunchAgents del usuario, con su contenido crudo, para el
 * escaneo de colisiones. Un directorio inexistente no es un error: significa
 * que no hay ningún job de usuario instalado.
 */
async function readLaunchAgents(): Promise<{ label: string; contents: string }[]> {
  const dir = launchAgentsDir(homedir());
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const agents: { label: string; contents: string }[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.plist')) continue;
    try {
      const contents = await readFile(join(dir, entry), 'utf8');
      agents.push({ label: entry.slice(0, -'.plist'.length), contents });
    } catch {
      // Un plist ilegible (permisos) no debe tumbar la instalación: solo
      // significa que esa red de seguridad no lo cubre.
    }
  }
  return agents;
}

export const launchdBackend: SchedulerBackend = {
  kind: 'launchd',
  label: 'launchd',

  jobFiles(input) {
    const spec = buildPlistSpec(input);
    return [{ path: plistPathFor(input.home, spec.label), contents: renderPlist(spec) }];
  },

  jobPaths: (label, home) => [plistPathFor(home, label)],

  logPath: logPathFor,

  readUserJobs: readLaunchAgents,

  async disabledLabels(labels) {
    const disabled = new Set(parseDisabledLabels((await printDisabled()).stdout));
    return labels.filter((label) => disabled.has(label));
  },

  async preInstallChecks() {
    return [];
  },

  // El bootout previo puede fallar legítimamente ("no estaba cargado"): se
  // ignora su código a propósito. Mismo label = reemplazo, no duplicado.
  async activate(label, files) {
    await bootout(label);
    return bootstrap(files[0]!.path);
  },

  // Nunca `launchctl disable`: deja un override persistente en el dominio del
  // usuario que mordería en una reinstalación meses después. `bootout` ya es
  // idempotente, así que se llama aunque el plist no exista: el job puede
  // seguir cargado aunque alguien lo haya borrado a mano.
  async deactivate(label) {
    await bootout(label);
    await unlink(plistPathFor(homedir(), label)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
    return {};
  },

  async facts(label, home) {
    const [job, disabled] = await Promise.all([printJob(label), printDisabled()]);
    return {
      loaded: job.code === 0,
      disabled: parseDisabledLabels(disabled.stdout).includes(label),
      artifactOnDisk: await readIfExists(plistPathFor(home, label)),
    };
  },

  retireHint() {
    return 'Retíralos con "launchctl bootout" Y "launchctl disable" — sin el disable vuelven al siguiente arranque.';
  },
};
