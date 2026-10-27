import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root: string;
let fakeHome: string;
let sysLog: string;
let loginLog: string;
const CLI = join(import.meta.dir, '..', '..', 'src', 'cli', 'index.ts');
const LABEL = 'cat.start.pipelines.demo';

function fakeBin(name: string, body: string): string {
  const path = join(fakeHome, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** `systemctl` de mentira: registra los argumentos; `isEnabled` es lo que responde a `is-enabled`. */
function fakeSystemctl(opts: { isEnabled?: string; extra?: string } = {}): string {
  return fakeBin(
    'fake-systemctl',
    `echo "$@" >> ${sysLog}\n${opts.extra ?? ''}\n` +
      `if [ "$2" = is-enabled ]; then echo "${opts.isEnabled ?? 'enabled'}"; fi\nexit 0`,
  );
}

function fakeLoginctl(linger: 'yes' | 'no'): string {
  return fakeBin('fake-loginctl', `echo "$@" >> ${loginLog}\necho ${linger}`);
}

async function cli(
  args: string[],
  opts: { linger?: 'yes' | 'no'; systemctl?: string } = {},
): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['bun', CLI, ...args], {
    cwd: root,
    env: {
      ...process.env,
      HOME: fakeHome,
      XDG_CONFIG_HOME: '',
      XDG_STATE_HOME: '',
      ANTHROPIC_API_KEY: 'sk-test',
      PIPELINES_SCHEDULER: 'systemd',
      PIPELINES_SYSTEMCTL_BIN: opts.systemctl ?? fakeSystemctl(),
      PIPELINES_LOGINCTL_BIN: fakeLoginctl(opts.linger ?? 'yes'),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out: stdout + stderr };
}

const unitDir = () => join(fakeHome, '.config', 'systemd', 'user');
const logDir = () => join(fakeHome, '.local', 'state', 'pipelines', 'logs');
const sysCalls = () => (existsSync(sysLog) ? readFileSync(sysLog, 'utf8').trim().split('\n') : []);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ap-sd-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'ap-sdhome-'));
  sysLog = join(fakeHome, 'systemctl.log');
  loginLog = join(fakeHome, 'loginctl.log');
  writeFileSync(join(root, 'pipelines.yaml'), 'channels: {}\n');
  mkdirSync(join(root, 'pipelines', 'demo'), { recursive: true });
  writeFileSync(join(root, 'pipelines', 'demo', 'pipeline.yaml'), DEMO);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

const DEMO = `name: demo
description: d
version: 1
params:
  docs_repo:
    description: ruta
    required: true
requires:
  bin: [git]
triggers:
  - cron: "0 3 * * *"
steps:
  - id: build
    type: shell
    run: 'true'
`;

describe('pipelines install (systemd)', () => {
  test('sin linger y sin --force: código 1, nada escrito ni systemctl', async () => {
    const { code, out } = await cli(['install', 'demo', '--set', 'docs_repo=/r'], { linger: 'no' });
    expect(code).toBe(1);
    expect(out).toContain('sudo loginctl enable-linger');
    expect(existsSync(unitDir())).toBe(false);
    expect(sysCalls()).toEqual([]);
  });

  test('sin linger y con --force: instala y avisa', async () => {
    const { code, out } = await cli(['install', 'demo', '--set', 'docs_repo=/r', '--force'], {
      linger: 'no',
    });
    expect(code).toBe(0);
    expect(out).toContain('--force: se instala igualmente');
    expect(existsSync(join(unitDir(), `${LABEL}.timer`))).toBe(true);
  });

  test('con linger: escribe las unidades, crea el directorio del log y activa', async () => {
    const { code, out } = await cli(['install', 'demo', '--set', 'docs_repo=/r']);
    expect(code).toBe(0);
    expect(existsSync(join(unitDir(), `${LABEL}.service`))).toBe(true);
    expect(existsSync(join(unitDir(), `${LABEL}.timer`))).toBe(true);
    expect(existsSync(logDir())).toBe(true);
    expect(sysCalls().filter((c) => c !== `--user is-enabled ${LABEL}.timer`)).toEqual([
      '--user daemon-reload',
      `--user enable --now ${LABEL}.timer`,
    ]);
    expect(out).toContain('horarios');
    expect(out).toContain('PATH');
    expect(out).toContain('log');
  });

  test('--dry-run: imprime las dos unidades, no escribe ni invoca systemctl, sí loginctl', async () => {
    const { code, out } = await cli(['install', 'demo', '--set', 'docs_repo=/r', '--dry-run'], {
      linger: 'no',
    });
    expect(code).toBe(0);
    expect(out).toContain(`# ${join(unitDir(), `${LABEL}.service`)}`);
    expect(out).toContain(`# ${join(unitDir(), `${LABEL}.timer`)}`);
    expect(out).toContain('sudo loginctl enable-linger');
    expect(existsSync(unitDir())).toBe(false);
    expect(sysCalls()).toEqual([]);
    expect(existsSync(loginLog)).toBe(true);
  });

  test('reinstalar con el timer disabled vuelve a hacer enable --now', async () => {
    const systemctl = fakeSystemctl({ isEnabled: 'disabled' });
    await cli(['install', 'demo', '--set', 'docs_repo=/r'], { systemctl });
    writeFileSync(sysLog, '');
    const { code, out } = await cli(['install', 'demo'], { systemctl });
    expect(code).toBe(0);
    expect(sysCalls()).toContain(`--user enable --now ${LABEL}.timer`);
    expect(out).toContain('reemplazado el job que ya existía');
  });

  test('un .service ajeno que menciona una ruta de un param: colisión y código 1', async () => {
    mkdirSync(unitDir(), { recursive: true });
    writeFileSync(join(unitDir(), 'ajeno.service'), '[Service]\nExecStart=/bin/true /repos/docs\n');
    const { code, out } = await cli(['install', 'demo', '--set', 'docs_repo=/repos/docs']);
    expect(code).toBe(1);
    expect(out).toContain('ajeno');
    expect(out).toContain('mencionan rutas');
    expect(existsSync(join(unitDir(), `${LABEL}.timer`))).toBe(false);
  });

  test('un .service homónimo habilitado: aviso con el retireHint', async () => {
    mkdirSync(unitDir(), { recursive: true });
    writeFileSync(join(unitDir(), 'otra.cosa.demo.service'), '[Service]\nExecStart=/bin/true\n');
    const { code, out } = await cli(['install', 'demo', '--set', 'docs_repo=/r']);
    expect(code).toBe(1);
    expect(out).toContain('otra.cosa.demo');
    expect(out).toContain('systemctl --user disable --now otra.cosa.demo.timer');
  });
});

describe('pipelines uninstall (systemd)', () => {
  test('descarga, borra las unidades y dice dónde siguen los params y el log', async () => {
    await cli(['install', 'demo', '--set', 'docs_repo=/r']);
    writeFileSync(sysLog, '');
    const { code, out } = await cli(['uninstall', 'demo']);
    expect(code).toBe(0);
    const calls = sysCalls();
    expect(calls).toContain(`--user disable --now ${LABEL}.timer`);
    expect(calls).toContain('--user daemon-reload');
    expect(existsSync(join(unitDir(), `${LABEL}.service`))).toBe(false);
    expect(existsSync(join(unitDir(), `${LABEL}.timer`))).toBe(false);
    expect(out).toContain('.params.local.json');
    expect(out).toContain(join(logDir(), 'pipelines-demo.log'));
  });

  test('con solo el .timer en disco: lo retira y no dice «no está instalado»', async () => {
    await cli(['install', 'demo', '--set', 'docs_repo=/r']);
    rmSync(join(unitDir(), `${LABEL}.service`));
    const { code, out } = await cli(['uninstall', 'demo']);
    expect(code).toBe(0);
    expect(existsSync(join(unitDir(), `${LABEL}.timer`))).toBe(false);
    expect(out).not.toContain('no está instalado');
    expect(out).toContain(`desinstalado ${LABEL}`);
  });

  test('sin ficheros del job: dice que no está instalado', async () => {
    const { code, out } = await cli(['uninstall', 'demo']);
    expect(code).toBe(0);
    expect(out).toContain('no está instalado');
  });

  test('sin bus de usuario: avisa por stderr y sale con código 1', async () => {
    await cli(['install', 'demo', '--set', 'docs_repo=/r']);
    const systemctl = fakeSystemctl({
      extra: 'if [ "$2" = disable ]; then echo "Failed to connect to bus" >&2; exit 1; fi',
    });
    const { code, out } = await cli(['uninstall', 'demo'], { systemctl });
    expect(code).toBe(1);
    expect(out).toContain('sesión de systemd de usuario');
    expect(existsSync(join(unitDir(), `${LABEL}.timer`))).toBe(false);
  });
});
