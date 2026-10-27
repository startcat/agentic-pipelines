/**
 * Checks de plataforma de `doctor`.
 * Son informativos: nunca bloquean (`kind: 'platform'`).
 */
import { readlink } from 'node:fs/promises';
import type { PreflightCheck } from '../preflight/check.ts';
import type { SchedulerBackend } from './backend.ts';
import { systemctlUser, timedatectlTimezone, userBusError } from './systemctl.ts';

/** La zona horaria de la máquina. Nunca lanza. */
export async function currentTimezone(): Promise<string> {
  const fromTimedatectl = await timedatectlTimezone();
  if (fromTimedatectl) return fromTimedatectl;
  try {
    const target = await readlink('/etc/localtime');
    const marker = 'zoneinfo/';
    const at = target.indexOf(marker);
    if (at !== -1) return target.slice(at + marker.length);
  } catch {
    // sin /etc/localtime o no es un enlace: se sigue con Intl
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export async function platformChecks(
  backend: SchedulerBackend,
  which: (bin: string) => string | null = (bin) => Bun.which(bin),
): Promise<PreflightCheck[]> {
  if (backend.kind !== 'systemd') return [];

  const checks: PreflightCheck[] = [];

  // `is-system-running` sale distinto de 0 en "degraded": eso no es un fallo.
  // Solo cuentan la ausencia del bus de usuario y un systemctl que ni arranca
  // (código 127 de `systemctlUser`: binario ausente o no ejecutable).
  const running = await systemctlUser(['is-system-running']);
  const unavailable =
    running.code === 127
      ? `${running.stderr.trim()} — sin systemctl no se puede instalar`
      : userBusError(running.stderr);
  checks.push({
    kind: 'platform',
    name: 'systemd',
    ok: unavailable === null,
    detail: unavailable ?? (running.stdout.trim() || 'disponible'),
  });

  for (const check of await backend.preInstallChecks()) {
    checks.push({
      kind: 'platform',
      name: check.name,
      ok: check.ok,
      detail: check.fix ? `${check.detail} — ${check.fix}` : check.detail,
    });
  }

  // Los pasos `shell` se ejecutan con `bash --posix` en Linux (ver
  // runner/interpreter.ts): sin bash en el PATH ninguno podría arrancar.
  const hasBash = which('bash') !== null;
  checks.push({
    kind: 'platform',
    name: 'shell',
    ok: hasBash,
    detail: hasBash
      ? 'bash (los pasos shell se ejecutan con bash --posix)'
      : 'falta bash: los pasos shell no podrán arrancar — sudo apt install bash',
  });

  const zone = await currentTimezone();
  const utc = zone === 'UTC' || zone === 'Etc/UTC';
  checks.push({
    kind: 'platform',
    name: 'timezone',
    ok: true,
    detail: utc
      ? `${zone} — los horarios se leerán en UTC; para hora de Barcelona: sudo timedatectl set-timezone Europe/Madrid`
      : zone,
  });
  return checks;
}
