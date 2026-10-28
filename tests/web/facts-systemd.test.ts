import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobBunPath } from '../../src/cli/install-helpers.ts';
import { evaluateHealth } from '../../src/health/evaluate.ts';
import { labelFor } from '../../src/install/common.ts';
import { collectJobFacts } from '../../src/web/facts.ts';

// The real systemctl is never called: `PIPELINES_SYSTEMCTL_BIN` points to a
// script that answers what each test needs, and $HOME is a fake directory.
const KEYS = ['PIPELINES_SCHEDULER', 'PIPELINES_SYSTEMCTL_BIN', 'HOME', 'XDG_CONFIG_HOME'] as const;
const saved: Record<string, string | undefined> = {};
let home: string;

const ctx = { root: '/repo', config: { channels: {}, defaults: {} }, dotEnv: {} } as never;
const pipeline = {
  name: 'demo', triggers: [{ cron: '0 3 * * *' }], requires: { bin: [] }, mcpServers: {}, when: [],
} as never;
const NOW = new Date('2026-10-07T08:00:00.000Z');

function fakeSystemctl(isEnabled: string): void {
  const path = join(home, 'systemctl');
  writeFileSync(path, `#!/bin/sh\ncase "$2" in is-enabled) echo ${isEnabled};; esac\nexit 0\n`);
  chmodSync(path, 0o755);
  process.env.PIPELINES_SYSTEMCTL_BIN = path;
}

/** Installs into the fake $HOME what `install` would write, with whatever edit is asked for. */
async function writeUnits(edit: (s: string) => string = (s) => s): Promise<void> {
  const expected = (await collectJobFacts(pipeline, ctx, NOW)).artifactExpected as string;
  const text = edit(expected);
  // The artifact is service + "\n" + timer; the timer opens its own [Unit].
  const cut = text.indexOf('[Unit]', 1);
  const dir = join(home, '.config', 'systemd', 'user');
  mkdirSync(dir, { recursive: true });
  const label = labelFor('demo');
  writeFileSync(join(dir, `${label}.service`), text.slice(0, cut - 1));
  writeFileSync(join(dir, `${label}.timer`), text.slice(cut));
}

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  home = mkdtempSync(join(tmpdir(), 'facts-systemd-'));
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
  process.env.PIPELINES_SCHEDULER = 'systemd';
  fakeSystemctl('enabled');
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(home, { recursive: true, force: true });
});

describe('collectJobFacts with systemd', () => {
  test('the expected artifact carries the ExecStart with the same bun that install writes', async () => {
    const facts = await collectJobFacts(pipeline, ctx, NOW);
    expect(facts.artifactExpected).toContain(`ExecStart="${jobBunPath()}"`);
  });

  test('with the units on disk equal to the expected ones, it is installed', async () => {
    await writeUnits();
    const facts = await collectJobFacts(pipeline, ctx, new Date(NOW.getTime() + 86_400_000));
    expect(facts.artifactOnDisk).toBeDefined();
    expect(evaluateHealth(pipeline, [], facts, NOW).trigger).toBe('installed');
  });

  test('with a hand-edited line, it is drifted', async () => {
    await writeUnits((s) => s.replace('Description=', 'Description=EDITED BY HAND '));
    const facts = await collectJobFacts(pipeline, ctx, NOW);
    expect(evaluateHealth(pipeline, [], facts, NOW).trigger).toBe('drifted');
  });

  test('with the timer disabled, it is disabled', async () => {
    await writeUnits();
    fakeSystemctl('disabled');
    const facts = await collectJobFacts(pipeline, ctx, NOW);
    expect(evaluateHealth(pipeline, [], facts, NOW).trigger).toBe('disabled');
  });
});
