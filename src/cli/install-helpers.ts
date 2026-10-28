import { realpathSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stableBunPath } from '../install/common.ts';

/**
 * The user's home: `$HOME` wins (as in the shell, and as in the systemd
 * backend) and `homedir()` is the fallback. Bun does not follow a changed
 * `HOME` on macOS, and the tests depend on being able to change it.
 */
export function userHome(): string {
  return process.env.HOME || homedir();
}

/**
 * The `bun` that goes into a job's plist. `install` writes it and the
 * dashboard (`web/facts.ts`) uses it to generate the expected plist: if each
 * computed it on its own, the dashboard would flag a freshly installed job as
 * `drifted`, which is exactly what happened when only `install` started using
 * `stableBunPath`.
 */
export function jobBunPath(): string {
  return stableBunPath(process.execPath, Bun.which('bun'), realpathSync);
}

/**
 * Merges THIS pipeline's params into `.params.local.json` without touching
 * the others'. Atomic write (temp file + rename) so an interruption does not
 * leave the JSON half-written and stop every pipeline in the repo from
 * starting.
 */
export async function writeLocalParams(
  repoRoot: string,
  pipeline: string,
  params: Record<string, string>,
): Promise<void> {
  const file = join(repoRoot, '.params.local.json');
  let raw: string | undefined;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    // Only "does not exist yet" is swallowed silently: a broken JSON (for
    // whatever reason) must throw, not be rewritten over entirely — that
    // would erase the params of ALL the other pipelines in the repo, not just
    // the one being installed now.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const all: Record<string, Record<string, string>> =
    raw === undefined ? {} : (JSON.parse(raw) as Record<string, Record<string, string>>);
  all[pipeline] = { ...all[pipeline], ...params };
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}
