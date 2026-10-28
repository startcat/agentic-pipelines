import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobBunPath } from '../../src/cli/install-helpers.ts';
import { collectJobFacts, createJobFactsCache } from '../../src/web/facts.ts';

async function fakeLaunchctl(stdout: string, code: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'launchctl-'));
  const path = join(dir, 'launchctl');
  await writeFile(path, `#!/bin/sh\ncat <<'EOF'\n${stdout}\nEOF\nexit ${code}\n`);
  await chmod(path, 0o755);
  return path;
}

describe('createJobFactsCache', () => {
  // Decision 8: launchctl is not queried per tick. A subprocess per pipeline
  // per second is abusive for a datum that changes when you change it.
  test('within the TTL it does not ask launchctl again', async () => {
    process.env.PIPELINES_LAUNCHCTL_BIN = await fakeLaunchctl('', 0);
    const cache = createJobFactsCache(30_000);
    const ctx = { root: '/repo', config: { channels: {}, defaults: {} }, dotEnv: {} };
    const pipeline = { name: 'demo', triggers: [{ cron: '0 3 * * *' }], requires: { bin: [] }, mcpServers: {} } as never;

    const t0 = new Date('2026-08-29T12:00:00.000Z');
    const first = await cache.get(pipeline, ctx as never, t0);
    // At 10 s the datum must be literally the same object: there was no query.
    const second = await cache.get(pipeline, ctx as never, new Date(t0.getTime() + 10_000));
    expect(second).toBe(first);

    // Past the TTL, it does ask again: a new object.
    const third = await cache.get(pipeline, ctx as never, new Date(t0.getTime() + 31_000));
    expect(third).not.toBe(first);
  });
});

describe('collectJobFacts', () => {
  // With Homebrew, `process.execPath` is the versioned Cellar path and
  // `install` writes the stable link (`stableBunPath`). If the dashboard
  // generated its expected plist with the other path, every freshly installed
  // job would come out as `drifted`.
  test('the expected plist uses the same bun that install writes', async () => {
    process.env.PIPELINES_LAUNCHCTL_BIN = await fakeLaunchctl('', 0);
    const ctx = { root: '/repo', config: { channels: {}, defaults: {} }, dotEnv: {} };
    const pipeline = { name: 'demo', triggers: [{ cron: '0 3 * * *' }], requires: { bin: [] }, mcpServers: {}, when: [] } as never;

    // This is a launchd test: on Linux the default scheduler would be systemd.
    const saved = process.env.PIPELINES_SCHEDULER;
    process.env.PIPELINES_SCHEDULER = 'launchd';
    let facts;
    try {
      facts = await collectJobFacts(pipeline, ctx as never, new Date('2026-10-07T08:00:00.000Z'));
    } finally {
      if (saved === undefined) delete process.env.PIPELINES_SCHEDULER;
      else process.env.PIPELINES_SCHEDULER = saved;
    }

    expect(facts.artifactExpected).toContain(`<string>${jobBunPath()}</string>`);
  });
});
