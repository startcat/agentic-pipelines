import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchdBackend } from '../../src/install/launchd-backend.ts';
import { currentTimezone, platformChecks } from '../../src/install/platform-checks.ts';
import { schedulerFor } from '../../src/install/backend.ts';
import { systemdBackend } from '../../src/install/systemd-backend.ts';
import { parsePipeline } from '../../src/schema/pipeline.ts';
import { hasBlockingFailures, preflight, type PreflightReport } from '../../src/preflight/check.ts';

const VARS = ['PIPELINES_SYSTEMCTL_BIN', 'PIPELINES_LOGINCTL_BIN', 'PIPELINES_TIMEDATECTL_BIN'] as const;
const saved: Record<string, string | undefined> = {};
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'platform-'));
  for (const v of VARS) saved[v] = process.env[v];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

function fake(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function fakeAll(opts: { linger?: string; tz?: string; systemctl?: string }) {
  process.env.PIPELINES_SYSTEMCTL_BIN = fake('sc', opts.systemctl ?? 'echo running');
  process.env.PIPELINES_LOGINCTL_BIN = fake('lc', `echo ${opts.linger ?? 'yes'}`);
  process.env.PIPELINES_TIMEDATECTL_BIN = fake('td', `echo ${opts.tz ?? 'Europe/Madrid'}`);
}

describe('checks de plataforma no bloqueantes', () => {
  test('un check platform en rojo no tumba report.ok ni bloquea', () => {
    const report: PreflightReport = {
      ok: true,
      checks: [{ kind: 'platform', name: 'linger', ok: false, detail: 'x' }],
    };
    expect(hasBlockingFailures(report)).toBe(false);
  });

  test('launchd no tiene checks de plataforma', async () => {
    expect(await platformChecks(launchdBackend)).toEqual([]);
  });

  test('linger desactivado: check rojo con el comando en el detalle', async () => {
    fakeAll({ linger: 'no' });
    const checks = await platformChecks(systemdBackend);
    const linger = checks.find((c) => c.name === 'linger')!;
    expect(linger.kind).toBe('platform');
    expect(linger.ok).toBe(false);
    expect(linger.detail).toContain('sudo loginctl enable-linger');
  });

  test('shell: verde si bash está en el PATH', async () => {
    fakeAll({});
    const checks = await platformChecks(systemdBackend, () => '/usr/bin/bash');
    const shell = checks.find((c) => c.name === 'shell')!;
    expect(shell.kind).toBe('platform');
    expect(shell.ok).toBe(true);
    expect(shell.detail).toBe('bash (los pasos shell se ejecutan con bash --posix)');
  });

  test('shell: rojo si falta bash', async () => {
    fakeAll({});
    const checks = await platformChecks(systemdBackend, () => null);
    const shell = checks.find((c) => c.name === 'shell')!;
    expect(shell.ok).toBe(false);
    expect(shell.detail).toBe('falta bash: los pasos shell no podrán arrancar — sudo apt install bash');
  });

  test('linger activado: check verde', async () => {
    fakeAll({ linger: 'yes' });
    const checks = await platformChecks(systemdBackend);
    expect(checks.find((c) => c.name === 'linger')!.ok).toBe(true);
  });

  test('systemd: ok aunque is-system-running salga con código distinto de 0 (degraded)', async () => {
    fakeAll({ systemctl: 'echo degraded; exit 1' });
    const checks = await platformChecks(systemdBackend);
    expect(checks.find((c) => c.name === 'systemd')!.ok).toBe(true);
  });

  test('systemd: rojo con el texto de userBusError si no hay bus de usuario', async () => {
    fakeAll({ systemctl: 'echo "Failed to connect to bus: No medium found" >&2; exit 1' });
    const checks = await platformChecks(systemdBackend);
    const sd = checks.find((c) => c.name === 'systemd')!;
    expect(sd.ok).toBe(false);
    expect(sd.detail).toContain('ssh');
  });

  test('systemd: rojo si systemctl no se puede ejecutar', async () => {
    fakeAll({});
    process.env.PIPELINES_SYSTEMCTL_BIN = join(dir, 'no-existe');
    const checks = await platformChecks(systemdBackend);
    const sd = checks.find((c) => c.name === 'systemd')!;
    expect(sd.ok).toBe(false);
    expect(sd.detail).toContain('No se pudo ejecutar');
    expect(sd.detail).toContain('sin systemctl no se puede instalar');
    expect(sd.detail).not.toContain('disponible');
  });

  test('zona UTC: siempre ok, con el consejo de Europe/Madrid', async () => {
    fakeAll({ tz: 'Etc/UTC' });
    const tz = (await platformChecks(systemdBackend)).find((c) => c.name === 'timezone')!;
    expect(tz.ok).toBe(true);
    expect(tz.detail).toContain('Etc/UTC');
    expect(tz.detail).toContain('set-timezone Europe/Madrid');
  });

  test('zona Europe/Madrid: sin consejo', async () => {
    fakeAll({ tz: 'Europe/Madrid' });
    const tz = (await platformChecks(systemdBackend)).find((c) => c.name === 'timezone')!;
    expect(tz.detail).toBe('Europe/Madrid');
  });
});

describe('currentTimezone', () => {
  test('usa timedatectl', async () => {
    process.env.PIPELINES_TIMEDATECTL_BIN = fake('td', 'echo Europe/Lisbon');
    expect(await currentTimezone()).toBe('Europe/Lisbon');
  });

  test('si timedatectl falla, nunca lanza y devuelve una zona', async () => {
    process.env.PIPELINES_TIMEDATECTL_BIN = join(dir, 'no-existe');
    const tz = await currentTimezone();
    expect(tz.length).toBeGreaterThan(0);
  });
});

describe('preflight con includePlatform en una plataforma sin programador', () => {
  test('no lanza: se salta los checks de plataforma (FreeBSD)', async () => {
    const pipeline = parsePipeline(
      'name: demo\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );
    const report = await preflight(pipeline, {
      repoRoot: dir,
      userClaudeDir: join(dir, '.claude'),
      processEnv: {},
      dotEnv: {},
      includePlatform: true,
      scheduler: () => schedulerFor('freebsd', {}),
    });
    expect(report.checks.filter((c) => c.kind === 'platform')).toEqual([]);
  });
});
