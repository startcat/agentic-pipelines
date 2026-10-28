/**
 * Platform checks of `doctor`.
 * They are informational: they never block (`kind: 'platform'`).
 */
import { readlink } from 'node:fs/promises';
import type { PreflightCheck } from '../preflight/check.ts';
import type { SchedulerBackend } from './backend.ts';
import { systemctlUser, timedatectlTimezone, userBusError } from './systemctl.ts';

/** The machine's time zone. Never throws. */
export async function currentTimezone(): Promise<string> {
  const fromTimedatectl = await timedatectlTimezone();
  if (fromTimedatectl) return fromTimedatectl;
  try {
    const target = await readlink('/etc/localtime');
    const marker = 'zoneinfo/';
    const at = target.indexOf(marker);
    if (at !== -1) return target.slice(at + marker.length);
  } catch {
    // no /etc/localtime or it is not a link: carry on with Intl
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export async function platformChecks(
  backend: SchedulerBackend,
  which: (bin: string) => string | null = (bin) => Bun.which(bin),
): Promise<PreflightCheck[]> {
  if (backend.kind !== 'systemd') return [];

  const checks: PreflightCheck[] = [];

  // `is-system-running` exits non-zero on "degraded": that is not a failure.
  // Only the absence of the user bus and a systemctl that doesn't even start
  // count (code 127 from `systemctlUser`: binary missing or not executable).
  const running = await systemctlUser(['is-system-running']);
  const unavailable =
    running.code === 127
      ? `${running.stderr.trim()} — without systemctl nothing can be installed`
      : userBusError(running.stderr);
  checks.push({
    kind: 'platform',
    name: 'systemd',
    ok: unavailable === null,
    detail: unavailable ?? (running.stdout.trim() || 'available'),
  });

  for (const check of await backend.preInstallChecks()) {
    checks.push({
      kind: 'platform',
      name: check.name,
      ok: check.ok,
      detail: check.fix ? `${check.detail} — ${check.fix}` : check.detail,
    });
  }

  // `shell` steps run with `bash --posix` on Linux (see
  // runner/interpreter.ts): without bash on the PATH none of them could start.
  const hasBash = which('bash') !== null;
  checks.push({
    kind: 'platform',
    name: 'shell',
    ok: hasBash,
    detail: hasBash
      ? 'bash (shell steps run with bash --posix)'
      : 'bash is missing: shell steps will not be able to start — sudo apt install bash',
  });

  const zone = await currentTimezone();
  const utc = zone === 'UTC' || zone === 'Etc/UTC';
  checks.push({
    kind: 'platform',
    name: 'timezone',
    ok: true,
    detail: utc
      ? `${zone} — schedules will be read in UTC; for Barcelona time: sudo timedatectl set-timezone Europe/Madrid`
      : zone,
  });
  return checks;
}
