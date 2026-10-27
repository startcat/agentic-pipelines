import { realpathSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stableBunPath } from '../install/common.ts';

/**
 * El home del usuario: `$HOME` manda (como en la shell, y como en el backend de
 * systemd) y `homedir()` es el respaldo. Bun no sigue un `HOME` cambiado en
 * macOS, y los tests dependen de poder cambiarlo.
 */
export function userHome(): string {
  return process.env.HOME || homedir();
}

/**
 * El `bun` que va al plist de un job. `install` lo escribe y el panel
 * (`web/facts.ts`) lo usa para generar el plist esperado: si cada uno lo
 * calculara por su cuenta, el panel marcaría como `drifted` un job recién
 * instalado, que es justo lo que pasó cuando solo `install` empezó a usar
 * `stableBunPath`.
 */
export function jobBunPath(): string {
  return stableBunPath(process.execPath, Bun.which('bun'), realpathSync);
}

/**
 * Fusiona los params de ESTE pipeline en `.params.local.json` sin tocar los de
 * los demás. Escritura atómica (temporal + rename) para que una interrupción
 * no deje el JSON a medias y deje sin arrancar a todos los pipelines del repo.
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
    // Solo "no existe todavía" se traga en silencio: un JSON roto (por la
    // razón que sea) debe lanzar, no reescribirse entero por encima —
    // borraría los params de TODOS los demás pipelines del repo, no solo el
    // que se está instalando ahora.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const all: Record<string, Record<string, string>> =
    raw === undefined ? {} : (JSON.parse(raw) as Record<string, Record<string, string>>);
  all[pipeline] = { ...all[pipeline], ...params };
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}
