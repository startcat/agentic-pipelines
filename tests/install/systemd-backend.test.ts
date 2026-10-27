import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { schedulerFor } from '../../src/install/backend.ts';
import { systemdBackend } from '../../src/install/systemd-backend.ts';

const LABEL = 'cat.start.pipelines.demo';
let home: string;
let log: string;
const keys = ['HOME', 'XDG_CONFIG_HOME', 'PIPELINES_SYSTEMCTL_BIN', 'PIPELINES_LOGINCTL_BIN'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of keys) saved[k] = process.env[k];
  home = mkdtempSync(join(tmpdir(), 'sdb-'));
  log = join(home, 'calls.log');
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
});
afterEach(() => {
  for (const k of keys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(home, { recursive: true, force: true });
});

function fake(name: string, body: string): string {
  const path = join(home, name);
  writeFileSync(path, `#!/bin/sh\necho "$@" >> ${log}\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
const calls = (): string[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
const unitDir = (): string => join(home, '.config', 'systemd', 'user');

describe('systemdBackend', () => {
  test('schedulerFor linux elige systemd', () => {
    expect(schedulerFor('linux', {})).toBe(systemdBackend);
    expect(systemdBackend.kind).toBe('systemd');
  });

  test('activate: daemon-reload y luego enable --now del timer', async () => {
    process.env.PIPELINES_SYSTEMCTL_BIN = fake('sc', 'exit 0');
    expect(await systemdBackend.activate(LABEL, [])).toEqual({ code: 0, stderr: '' });
    expect(calls()).toEqual(['--user daemon-reload', `--user enable --now ${LABEL}.timer`]);
  });

  test('activate: sin bus de usuario devuelve el texto de userBusError', async () => {
    process.env.PIPELINES_SYSTEMCTL_BIN = fake('sc', 'echo "Failed to connect to bus: No medium found" >&2; exit 1');
    const result = await systemdBackend.activate(LABEL, []);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Entra por ssh como el propio usuario');
    expect(calls()).toEqual(['--user daemon-reload']);
  });

  test('activate: otro fallo devuelve su stderr', async () => {
    process.env.PIPELINES_SYSTEMCTL_BIN = fake('sc', 'if [ "$2" = enable ]; then echo boom >&2; exit 5; fi');
    expect(await systemdBackend.activate(LABEL, [])).toEqual({ code: 5, stderr: 'boom' });
  });

  test('deactivate sin ficheros no lanza y nunca hace mask', async () => {
    process.env.PIPELINES_SYSTEMCTL_BIN = fake('sc', 'exit 1');
    await systemdBackend.deactivate(LABEL);
    expect(calls()).toEqual([`--user disable --now ${LABEL}.timer`, '--user daemon-reload']);
    expect(calls().join('\n')).not.toContain('mask');
  });

  test('deactivate borra service y timer', async () => {
    process.env.PIPELINES_SYSTEMCTL_BIN = fake('sc', 'exit 0');
    mkdirSync(unitDir(), { recursive: true });
    writeFileSync(join(unitDir(), `${LABEL}.service`), 's');
    writeFileSync(join(unitDir(), `${LABEL}.timer`), 't');
    await systemdBackend.deactivate(LABEL);
    expect(existsSync(join(unitDir(), `${LABEL}.service`))).toBe(false);
    expect(existsSync(join(unitDir(), `${LABEL}.timer`))).toBe(false);
  });

  test('facts: cargado y habilitado', async () => {
    process.env.PIPELINES_SYSTEMCTL_BIN = fake('sc', 'if [ "$2" = is-enabled ]; then echo enabled; fi');
    mkdirSync(unitDir(), { recursive: true });
    writeFileSync(join(unitDir(), `${LABEL}.service`), 'S');
    writeFileSync(join(unitDir(), `${LABEL}.timer`), 'T');
    expect(await systemdBackend.facts(LABEL, home)).toEqual({
      loaded: true,
      disabled: false,
      artifactOnDisk: 'S\nT',
    });
  });

  test('facts: deshabilitado, sin ficheros no hay artifactOnDisk', async () => {
    process.env.PIPELINES_SYSTEMCTL_BIN = fake('sc', 'if [ "$2" = is-enabled ]; then echo disabled; exit 1; fi\nif [ "$2" = is-active ]; then exit 3; fi');
    expect(await systemdBackend.facts(LABEL, home)).toEqual({ loaded: false, disabled: false });
    mkdirSync(unitDir(), { recursive: true });
    writeFileSync(join(unitDir(), `${LABEL}.timer`), 'T');
    const facts = await systemdBackend.facts(LABEL, home);
    expect(facts.disabled).toBe(true);
    expect(facts.artifactOnDisk).toBeUndefined();
  });

  test('disabledLabels', async () => {
    process.env.PIPELINES_SYSTEMCTL_BIN = fake('sc', 'case "$3" in a.timer) echo disabled; exit 1;; *) echo enabled;; esac');
    expect(await systemdBackend.disabledLabels(['a', 'b'])).toEqual(['a']);
  });

  test('readUserJobs lee los .service', async () => {
    expect(await systemdBackend.readUserJobs()).toEqual([]);
    mkdirSync(unitDir(), { recursive: true });
    writeFileSync(join(unitDir(), 'x.service'), 'X');
    writeFileSync(join(unitDir(), 'x.timer'), 'T');
    expect(await systemdBackend.readUserJobs()).toEqual([{ label: 'x', contents: 'X' }]);
  });

  test('preInstallChecks: linger no → ok:false con fix', async () => {
    process.env.PIPELINES_LOGINCTL_BIN = fake('lc', 'echo no');
    const [check] = await systemdBackend.preInstallChecks();
    expect(check!.name).toBe('linger');
    expect(check!.ok).toBe(false);
    expect(check!.fix).toBe(`sudo loginctl enable-linger ${userInfo().username}`);
  });

  test('preInstallChecks: linger yes → ok:true', async () => {
    process.env.PIPELINES_LOGINCTL_BIN = fake('lc', 'echo yes');
    expect((await systemdBackend.preInstallChecks())[0]!.ok).toBe(true);
  });

  test('retireHint', () => {
    expect(systemdBackend.retireHint(LABEL)).toBe(`Retíralo con "systemctl --user disable --now ${LABEL}.timer".`);
  });
});

describe('deactivate sin bus de usuario', () => {
  test('devuelve un aviso cuando disable falla por falta de bus', async () => {
    process.env.PIPELINES_SYSTEMCTL_BIN = fake(
      'sc-nobus',
      'if [ "$2" = disable ]; then echo "Failed to connect to bus: No medium found" >&2; exit 1; fi',
    );
    const result = await systemdBackend.deactivate(LABEL);
    expect(result.warning).toContain('sesión de systemd de usuario');
  });
});
