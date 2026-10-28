import { describe, expect, test } from 'bun:test';
import { shellArgv, shellInterpreter } from '../../src/runner/interpreter.ts';
import { unresolvedInPath } from '../../src/install/common.ts';

async function run(command: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(shellArgv(command, 'linux'), { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  return { code: await proc.exited, out };
}

describe('shell step interpreter', () => {
  test('on darwin it is still sh -c', () => {
    expect(shellInterpreter('darwin')).toBe('sh');
    expect(shellArgv('x', 'darwin')).toEqual(['sh', '-c', 'x']);
  });

  test('on linux it is bash --posix -c', () => {
    expect(shellInterpreter('linux')).toBe('bash');
    expect(shellArgv('x', 'linux')).toEqual(['bash', '--posix', '-c', 'x']);
  });

  test('pipefail is on: a failing pipeline stops the script', async () => {
    const { code, out } = await run('set -euo pipefail; false | true; echo NO');
    expect(code).not.toBe(0);
    expect(out).not.toContain('NO');
  });

  test('a healthy pipeline reaches the end', async () => {
    const { code, out } = await run('set -euo pipefail; true | true; echo OK');
    expect(code).toBe(0);
    expect(out).toContain('OK');
  });
});

describe('unresolvedInPath with interpreter', () => {
  test('checks the given interpreter instead of sh', () => {
    expect(unresolvedInPath('/nothing', [], () => null, 'bash')).toEqual(['bash']);
  });
});
