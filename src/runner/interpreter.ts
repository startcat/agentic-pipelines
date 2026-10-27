/**
 * Intérprete de los pasos `shell` y de las guardas `shell:`.
 *
 * En macOS `/bin/sh` es bash en modo POSIX y acepta `set -o pipefail`. En
 * Ubuntu `/bin/sh` es dash, que lo rechaza («Illegal option -o pipefail»), y
 * la regla R3 del linter exige `set -euo pipefail` al abrir todo `run:`
 * multilínea. Por eso en Linux se usa `bash --posix`, que reproduce la
 * semántica del `sh` de macOS; en macOS no cambia nada.
 */

/** `sh` en darwin, `bash` en cualquier otra plataforma. */
export function shellInterpreter(platform: NodeJS.Platform = process.platform): 'sh' | 'bash' {
  return platform === 'darwin' ? 'sh' : 'bash';
}

/** El argv con el que se lanza un comando de shell. */
export function shellArgv(command: string, platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'darwin' ? ['sh', '-c', command] : ['bash', '--posix', '-c', command];
}
