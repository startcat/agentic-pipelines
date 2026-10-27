/**
 * systemd (temporizadores de usuario) detrás de `SchedulerBackend`: une el
 * módulo puro (`systemd.ts`) con los efectos (`systemctl.ts`).
 */
import { homedir, userInfo } from 'node:os';
import { readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { SchedulerBackend } from './backend.ts';
import { lingerEnabled, systemctlUser, userBusError } from './systemctl.ts';
import { systemdJobFiles, systemdLogPath, userUnitDir } from './systemd.ts';

/** $HOME manda (como en la shell); `homedir()` es el respaldo. */
function userHome(): string {
  return process.env.HOME || homedir();
}

async function readIfExists(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  return (await file.exists()) ? file.text() : undefined;
}

async function removeIfExists(path: string): Promise<void> {
  await unlink(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
  });
}

async function isDisabled(label: string): Promise<boolean> {
  const { stdout } = await systemctlUser(['is-enabled', `${label}.timer`]);
  return stdout.trim() === 'disabled';
}

function failure(result: { code: number; stderr: string }): { code: number; stderr: string } {
  const stderr = result.stderr.trim();
  return { code: result.code, stderr: userBusError(stderr) ?? stderr };
}

export const systemdBackend: SchedulerBackend = {
  kind: 'systemd',
  label: 'systemd',

  jobFiles: (input) => systemdJobFiles(input),

  jobPaths(label, home) {
    const dir = userUnitDir(home, process.env);
    return [join(dir, `${label}.service`), join(dir, `${label}.timer`)];
  },

  logPath: (home, pipelineName) => systemdLogPath(home, pipelineName),

  async readUserJobs() {
    const dir = userUnitDir(userHome(), process.env);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }
    const jobs: { label: string; contents: string }[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.service')) continue;
      try {
        jobs.push({
          label: entry.slice(0, -'.service'.length),
          contents: await readFile(join(dir, entry), 'utf8'),
        });
      } catch {
        // Una unidad ilegible no debe tumbar la instalación.
      }
    }
    return jobs;
  },

  async disabledLabels(labels) {
    const flags = await Promise.all(labels.map(isDisabled));
    return labels.filter((_, i) => flags[i]);
  },

  async preInstallChecks() {
    const user = userInfo().username;
    const linger = await lingerEnabled(user);
    return [
      {
        name: 'linger',
        ok: linger === true,
        detail:
          linger === true
            ? 'activado'
            : 'desactivado: sin sesión abierta, el temporizador no se dispara',
        ...(linger === true ? {} : { fix: `sudo loginctl enable-linger ${user}` }),
      },
    ];
  },

  // Los ficheros ya los ha escrito `install`; aquí solo se registran y arrancan.
  async activate(label) {
    const reload = await systemctlUser(['daemon-reload']);
    if (reload.code !== 0) return failure(reload);
    const enable = await systemctlUser(['enable', '--now', `${label}.timer`]);
    if (enable.code !== 0) return failure(enable);
    return { code: 0, stderr: '' };
  },

  // Nunca `mask`: dejaría la unidad bloqueada para una reinstalación posterior.
  // El código de `disable` se ignora: puede no estar cargado.
  async deactivate(label) {
    const disable = await systemctlUser(['disable', '--now', `${label}.timer`]);
    const dir = userUnitDir(userHome(), process.env);
    await removeIfExists(join(dir, `${label}.service`));
    await removeIfExists(join(dir, `${label}.timer`));
    await systemctlUser(['daemon-reload']);
    // Sin bus de usuario `disable` no pudo hablar con systemd: los ficheros
    // ya no están, pero el temporizador puede seguir cargado en memoria.
    const warning = disable.code !== 0 ? userBusError(disable.stderr.trim()) : null;
    return warning ? { warning } : {};
  },

  async facts(label, home) {
    const dir = userUnitDir(home, process.env);
    const [active, disabledFlag, service, timer] = await Promise.all([
      systemctlUser(['is-active', `${label}.timer`]),
      isDisabled(label),
      readIfExists(join(dir, `${label}.service`)),
      readIfExists(join(dir, `${label}.timer`)),
    ]);
    return {
      loaded: active.code === 0,
      disabled: timer !== undefined && disabledFlag,
      ...(service !== undefined && timer !== undefined
        ? { artifactOnDisk: `${service}\n${timer}` }
        : {}),
    };
  },

  retireHint(label) {
    return `Retíralo con "systemctl --user disable --now ${label}.timer".`;
  },
};
