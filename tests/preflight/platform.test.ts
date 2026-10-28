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

describe('non-blocking platform checks', () => {
  test('a red platform check does not bring down report.ok nor block', () => {
    const report: PreflightReport = {
      ok: true,
      checks: [{ kind: 'platform', name: 'linger', ok: false, detail: 'x' }],
    };
    expect(hasBlockingFailures(report)).toBe(false);
  });

  test('launchd has no platform checks', async () => {
    expect(await platformChecks(launchdBackend)).toEqual([]);
  });

  test('linger disabled: red check with the command in the detail', async () => {
    fakeAll({ linger: 'no' });
    const checks = await platformChecks(systemdBackend);
    const linger = checks.find((c) => c.name === 'linger')!;
    expect(linger.kind).toBe('platform');
    expect(linger.ok).toBe(false);
    expect(linger.detail).toContain('sudo loginctl enable-linger');
  });

  test('shell: green if bash is on the PATH', async () => {
    fakeAll({});
    const checks = await platformChecks(systemdBackend, () => '/usr/bin/bash');
    const shell = checks.find((c) => c.name === 'shell')!;
    expect(shell.kind).toBe('platform');
    expect(shell.ok).toBe(true);
    expect(shell.detail).toBe('bash (shell steps run with bash --posix)');
  });

  test('shell: red if bash is missing', async () => {
    fakeAll({});
    const checks = await platformChecks(systemdBackend, () => null);
    const shell = checks.find((c) => c.name === 'shell')!;
    expect(shell.ok).toBe(false);
    expect(shell.detail).toBe('bash is missing: shell steps will not be able to start — sudo apt install bash');
  });

  test('linger enabled: green check', async () => {
    fakeAll({ linger: 'yes' });
    const checks = await platformChecks(systemdBackend);
    expect(checks.find((c) => c.name === 'linger')!.ok).toBe(true);
  });

  test('systemd: ok even if is-system-running exits non-zero (degraded)', async () => {
    fakeAll({ systemctl: 'echo degraded; exit 1' });
    const checks = await platformChecks(systemdBackend);
    expect(checks.find((c) => c.name === 'systemd')!.ok).toBe(true);
  });

  test('systemd: red with the userBusError text if there is no user bus', async () => {
    fakeAll({ systemctl: 'echo "Failed to connect to bus: No medium found" >&2; exit 1' });
    const checks = await platformChecks(systemdBackend);
    const sd = checks.find((c) => c.name === 'systemd')!;
    expect(sd.ok).toBe(false);
    expect(sd.detail).toContain('ssh');
  });

  test('systemd: red if systemctl cannot be run', async () => {
    fakeAll({});
    process.env.PIPELINES_SYSTEMCTL_BIN = join(dir, 'does-not-exist');
    const checks = await platformChecks(systemdBackend);
    const sd = checks.find((c) => c.name === 'systemd')!;
    expect(sd.ok).toBe(false);
    expect(sd.detail).toContain('Could not run');
    expect(sd.detail).toContain('without systemctl nothing can be installed');
    expect(sd.detail).not.toContain('available');
  });

  test('UTC zone: always ok, with the Europe/Madrid advice', async () => {
    fakeAll({ tz: 'Etc/UTC' });
    const tz = (await platformChecks(systemdBackend)).find((c) => c.name === 'timezone')!;
    expect(tz.ok).toBe(true);
    expect(tz.detail).toContain('Etc/UTC');
    expect(tz.detail).toContain('set-timezone Europe/Madrid');
  });

  test('Europe/Madrid zone: no advice', async () => {
    fakeAll({ tz: 'Europe/Madrid' });
    const tz = (await platformChecks(systemdBackend)).find((c) => c.name === 'timezone')!;
    expect(tz.detail).toBe('Europe/Madrid');
  });
});

describe('currentTimezone', () => {
  test('uses timedatectl', async () => {
    process.env.PIPELINES_TIMEDATECTL_BIN = fake('td', 'echo Europe/Lisbon');
    expect(await currentTimezone()).toBe('Europe/Lisbon');
  });

  test('if timedatectl fails, it never throws and returns a zone', async () => {
    process.env.PIPELINES_TIMEDATECTL_BIN = join(dir, 'does-not-exist');
    const tz = await currentTimezone();
    expect(tz.length).toBeGreaterThan(0);
  });
});

describe('preflight with includePlatform on a platform without a scheduler', () => {
  test('does not throw: it skips the platform checks (FreeBSD)', async () => {
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
