import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { printDisabled, printJob } from '../../src/install/launchctl.ts';

// The fake launchctl must not outlive this file: bun runs every test file in
// one process, and a leftover one that answers "loaded" for any label makes
// later tests see jobs that do not exist.
const savedLaunchctl = process.env.PIPELINES_LAUNCHCTL_BIN;
afterEach(() => {
  if (savedLaunchctl === undefined) delete process.env.PIPELINES_LAUNCHCTL_BIN;
  else process.env.PIPELINES_LAUNCHCTL_BIN = savedLaunchctl;
});

/** Fake script that imitates launchctl: prints whatever we tell it and exits with the given code. */
async function fakeLaunchctl(stdout: string, code: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'launchctl-'));
  const path = join(dir, 'launchctl');
  await writeFile(path, `#!/bin/sh\ncat <<'EOF'\n${stdout}\nEOF\nexit ${code}\n`);
  await chmod(path, 0o755);
  return path;
}

describe('printJob', () => {
  test('code 0 when the job is loaded', async () => {
    process.env.PIPELINES_LAUNCHCTL_BIN = await fakeLaunchctl('', 0);
    expect((await printJob('cat.start.pipelines.demo')).code).toBe(0);
  });

  test('non-zero code when it is not', async () => {
    process.env.PIPELINES_LAUNCHCTL_BIN = await fakeLaunchctl('Could not find service', 113);
    expect((await printJob('cat.start.pipelines.demo')).code).toBe(113);
  });
});

describe('printDisabled', () => {
  test('returns the raw output, which printJob discards', async () => {
    const out = '\t"com.example.old" => disabled\n\t"cat.start.pipelines.demo" => enabled';
    process.env.PIPELINES_LAUNCHCTL_BIN = await fakeLaunchctl(out, 0);
    const result = await printDisabled();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('com.example.old');
  });
});
