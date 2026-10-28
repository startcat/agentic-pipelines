/**
 * Interpreter for `shell` steps and `shell:` guards.
 *
 * On macOS `/bin/sh` is bash in POSIX mode and accepts `set -o pipefail`. On
 * Ubuntu `/bin/sh` is dash, which rejects it ("Illegal option -o pipefail"),
 * and linter rule R3 requires `set -euo pipefail` at the top of every
 * multi-line `run:`. That is why Linux uses `bash --posix`, which reproduces
 * the semantics of macOS `sh`; on macOS nothing changes.
 */

/** `sh` on darwin, `bash` on any other platform. */
export function shellInterpreter(platform: NodeJS.Platform = process.platform): 'sh' | 'bash' {
  return platform === 'darwin' ? 'sh' : 'bash';
}

/** The argv used to launch a shell command. */
export function shellArgv(command: string, platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'darwin' ? ['sh', '-c', command] : ['bash', '--posix', '-c', command];
}
