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
  // Decisión 8: launchctl no se consulta por tick. Un subproceso por pipeline
  // y por segundo es abusivo para un dato que cambia cuando tú lo cambias.
  test('dentro del TTL no vuelve a preguntar a launchctl', async () => {
    process.env.PIPELINES_LAUNCHCTL_BIN = await fakeLaunchctl('', 0);
    const cache = createJobFactsCache(30_000);
    const ctx = { root: '/repo', config: { channels: {}, defaults: {} }, dotEnv: {} };
    const pipeline = { name: 'demo', triggers: [{ cron: '0 3 * * *' }], requires: { bin: [] }, mcpServers: {} } as never;

    const t0 = new Date('2026-08-29T12:00:00.000Z');
    const first = await cache.get(pipeline, ctx as never, t0);
    // A los 10 s el dato debe ser literalmente el mismo objeto: no hubo consulta.
    const second = await cache.get(pipeline, ctx as never, new Date(t0.getTime() + 10_000));
    expect(second).toBe(first);

    // Pasado el TTL, sí vuelve a preguntar: objeto nuevo.
    const third = await cache.get(pipeline, ctx as never, new Date(t0.getTime() + 31_000));
    expect(third).not.toBe(first);
  });
});

describe('collectJobFacts', () => {
  // Con Homebrew, `process.execPath` es la ruta versionada de la Cellar e
  // `install` escribe el enlace estable (`stableBunPath`). Si el panel generara
  // su plist esperado con la otra ruta, todo job recién instalado saldría como
  // `drifted`.
  test('el plist esperado usa el mismo bun que escribe install', async () => {
    process.env.PIPELINES_LAUNCHCTL_BIN = await fakeLaunchctl('', 0);
    const ctx = { root: '/repo', config: { channels: {}, defaults: {} }, dotEnv: {} };
    const pipeline = { name: 'demo', triggers: [{ cron: '0 3 * * *' }], requires: { bin: [] }, mcpServers: {}, when: [] } as never;

    const facts = await collectJobFacts(pipeline, ctx as never, new Date('2026-10-07T08:00:00.000Z'));

    expect(facts.plistExpected).toContain(`<string>${jobBunPath()}</string>`);
  });
});
