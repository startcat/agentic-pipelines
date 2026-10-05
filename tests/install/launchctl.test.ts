import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { printDisabled, printJob } from '../../src/install/launchctl.ts';

/** Script de mentira que imita a launchctl: imprime lo que le digamos y sale con el código dado. */
async function fakeLaunchctl(stdout: string, code: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'launchctl-'));
  const path = join(dir, 'launchctl');
  await writeFile(path, `#!/bin/sh\ncat <<'EOF'\n${stdout}\nEOF\nexit ${code}\n`);
  await chmod(path, 0o755);
  return path;
}

describe('printJob', () => {
  test('código 0 cuando el job está cargado', async () => {
    process.env.PIPELINES_LAUNCHCTL_BIN = await fakeLaunchctl('', 0);
    expect((await printJob('cat.start.pipelines.demo')).code).toBe(0);
  });

  test('código distinto de 0 cuando no lo está', async () => {
    process.env.PIPELINES_LAUNCHCTL_BIN = await fakeLaunchctl('Could not find service', 113);
    expect((await printJob('cat.start.pipelines.demo')).code).toBe(113);
  });
});

describe('printDisabled', () => {
  test('devuelve la salida cruda, que printJob descarta', async () => {
    const out = '\t"com.example.viejo" => disabled\n\t"cat.start.pipelines.demo" => enabled';
    process.env.PIPELINES_LAUNCHCTL_BIN = await fakeLaunchctl(out, 0);
    const result = await printDisabled();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('com.example.viejo');
  });
});
