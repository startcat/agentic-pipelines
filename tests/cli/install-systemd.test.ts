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

/** Fake `systemctl`: records the arguments; `isEnabled` is what it answers to `is-enabled`. */
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
    description: path
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
  test('without linger and without --force: code 1, nothing written and no systemctl', async () => {
    const { code, out } = await cli(['install', 'demo', '--set', 'docs_repo=/r'], { linger: 'no' });
    expect(code).toBe(1);
    expect(out).toContain('sudo loginctl enable-linger');
    expect(existsSync(unitDir())).toBe(false);
    expect(sysCalls()).toEqual([]);
  });

  test('without linger and with --force: installs and warns', async () => {
    const { code, out } = await cli(['install', 'demo', '--set', 'docs_repo=/r', '--force'], {
      linger: 'no',
    });
    expect(code).toBe(0);
    expect(out).toContain('--force: installing anyway');
    expect(existsSync(join(unitDir(), `${LABEL}.timer`))).toBe(true);
  });

  test('with linger: writes the units, creates the log directory and activates', async () => {
    const { code, out } = await cli(['install', 'demo', '--set', 'docs_repo=/r']);
    expect(code).toBe(0);
    expect(existsSync(join(unitDir(), `${LABEL}.service`))).toBe(true);
    expect(existsSync(join(unitDir(), `${LABEL}.timer`))).toBe(true);
    expect(existsSync(logDir())).toBe(true);
    expect(sysCalls().filter((c) => c !== `--user is-enabled ${LABEL}.timer`)).toEqual([
      '--user daemon-reload',
      `--user enable --now ${LABEL}.timer`,
    ]);
    expect(out).toContain('times');
    expect(out).toContain('PATH');
    expect(out).toContain('log');
  });

  test('--dry-run: prints both units, writes nothing and does not invoke systemctl, but does loginctl', async () => {
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

  test('reinstalling with the timer disabled does enable --now again', async () => {
    const systemctl = fakeSystemctl({ isEnabled: 'disabled' });
    await cli(['install', 'demo', '--set', 'docs_repo=/r'], { systemctl });
    writeFileSync(sysLog, '');
    const { code, out } = await cli(['install', 'demo'], { systemctl });
    expect(code).toBe(0);
    expect(sysCalls()).toContain(`--user enable --now ${LABEL}.timer`);
    expect(out).toContain('replaced the job that already existed');
  });

  test('a foreign .service that mentions a param path: collision and code 1', async () => {
    mkdirSync(unitDir(), { recursive: true });
    writeFileSync(join(unitDir(), 'foreign.service'), '[Service]\nExecStart=/bin/true /repos/docs\n');
    const { code, out } = await cli(['install', 'demo', '--set', 'docs_repo=/repos/docs']);
    expect(code).toBe(1);
    expect(out).toContain('foreign');
    expect(out).toContain('mention paths');
    expect(existsSync(join(unitDir(), `${LABEL}.timer`))).toBe(false);
  });

  test('an enabled homonym .service: warning with the retireHint', async () => {
    mkdirSync(unitDir(), { recursive: true });
    writeFileSync(join(unitDir(), 'other.thing.demo.service'), '[Service]\nExecStart=/bin/true\n');
    const { code, out } = await cli(['install', 'demo', '--set', 'docs_repo=/r']);
    expect(code).toBe(1);
    expect(out).toContain('other.thing.demo');
    expect(out).toContain('systemctl --user disable --now other.thing.demo.timer');
  });
});

describe('pipelines uninstall (systemd)', () => {
  test('unloads, deletes the units and says where the params and the log still are', async () => {
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

  test('with only the .timer on disk: removes it and does not say "is not installed"', async () => {
    await cli(['install', 'demo', '--set', 'docs_repo=/r']);
    rmSync(join(unitDir(), `${LABEL}.service`));
    const { code, out } = await cli(['uninstall', 'demo']);
    expect(code).toBe(0);
    expect(existsSync(join(unitDir(), `${LABEL}.timer`))).toBe(false);
    expect(out).not.toContain('is not installed');
    expect(out).toContain(`uninstalled ${LABEL}`);
  });

  test('with no job files: says it is not installed', async () => {
    const { code, out } = await cli(['uninstall', 'demo']);
    expect(code).toBe(0);
    expect(out).toContain('is not installed');
  });

  test('with no user bus: warns on stderr and exits with code 1', async () => {
    await cli(['install', 'demo', '--set', 'docs_repo=/r']);
    const systemctl = fakeSystemctl({
      extra: 'if [ "$2" = disable ]; then echo "Failed to connect to bus" >&2; exit 1; fi',
    });
    const { code, out } = await cli(['uninstall', 'demo'], { systemctl });
    expect(code).toBe(1);
    expect(out).toContain('systemd user session');
    expect(existsSync(join(unitDir(), `${LABEL}.timer`))).toBe(false);
  });
});
