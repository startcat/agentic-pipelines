import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lingerEnabled, systemctlUser, userBusError } from '../../src/install/systemctl.ts';

let dir: string;
const saved = { s: process.env.PIPELINES_SYSTEMCTL_BIN, l: process.env.PIPELINES_LOGINCTL_BIN };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'systemctl-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (saved.s === undefined) delete process.env.PIPELINES_SYSTEMCTL_BIN;
  else process.env.PIPELINES_SYSTEMCTL_BIN = saved.s;
  if (saved.l === undefined) delete process.env.PIPELINES_LOGINCTL_BIN;
  else process.env.PIPELINES_LOGINCTL_BIN = saved.l;
});

function fake(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('systemctlUser', () => {
  test('prepends --user and returns code, stdout and stderr', async () => {
    process.env.PIPELINES_SYSTEMCTL_BIN = fake('sc', 'echo "$@"; echo err >&2; exit 3');
    expect(await systemctlUser(['is-active', 'x.timer'])).toEqual({
      code: 3,
      stdout: '--user is-active x.timer\n',
      stderr: 'err\n',
    });
  });

  test('a missing binary does not throw: non-zero code and a message', async () => {
    process.env.PIPELINES_SYSTEMCTL_BIN = join(dir, 'does-not-exist');
    const result = await systemctlUser(['daemon-reload']);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('systemctl');
  });
});

describe('lingerEnabled', () => {
  test('yes → true, no → false', async () => {
    process.env.PIPELINES_LOGINCTL_BIN = fake('lc', 'echo yes');
    expect(await lingerEnabled('user')).toBe(true);
    process.env.PIPELINES_LOGINCTL_BIN = fake('lc2', 'echo no');
    expect(await lingerEnabled('user')).toBe(false);
  });

  test('if the command fails → null', async () => {
    process.env.PIPELINES_LOGINCTL_BIN = fake('lc', 'exit 1');
    expect(await lingerEnabled('user')).toBeNull();
    process.env.PIPELINES_LOGINCTL_BIN = join(dir, 'does-not-exist');
    expect(await lingerEnabled('user')).toBeNull();
  });
});

describe('userBusError', () => {
  test('recognizes the two symptoms of a missing bus', () => {
    expect(userBusError('Failed to connect to bus: No medium found')).toContain('sudo -u');
    expect(userBusError('... $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR ...')).toContain('sudo -u');
  });
  test('another error → null', () => {
    expect(userBusError('Unit not found')).toBeNull();
  });
});
