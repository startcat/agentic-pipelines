import { describe, expect, test } from 'bun:test';
import { shellArgv, shellInterpreter } from '../../src/runner/interpreter.ts';
import { unresolvedInPath } from '../../src/install/common.ts';

async function run(command: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(shellArgv(command, 'linux'), { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  return { code: await proc.exited, out };
}

describe('intérprete de los pasos shell', () => {
  test('en darwin sigue siendo sh -c', () => {
    expect(shellInterpreter('darwin')).toBe('sh');
    expect(shellArgv('x', 'darwin')).toEqual(['sh', '-c', 'x']);
  });

  test('en linux es bash --posix -c', () => {
    expect(shellInterpreter('linux')).toBe('bash');
    expect(shellArgv('x', 'linux')).toEqual(['bash', '--posix', '-c', 'x']);
  });

  test('pipefail activo: una tubería que falla corta el script', async () => {
    const { code, out } = await run('set -euo pipefail; false | true; echo NO');
    expect(code).not.toBe(0);
    expect(out).not.toContain('NO');
  });

  test('una tubería sana llega al final', async () => {
    const { code, out } = await run('set -euo pipefail; true | true; echo OK');
    expect(code).toBe(0);
    expect(out).toContain('OK');
  });
});

describe('unresolvedInPath con intérprete', () => {
  test('comprueba el intérprete indicado en vez de sh', () => {
    expect(unresolvedInPath('/nada', [], () => null, 'bash')).toEqual(['bash']);
  });
});
