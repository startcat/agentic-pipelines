import { homedir } from 'node:os';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Directorio de LaunchAgents del usuario actual. */
export function launchAgentsDir(): string {
  return join(homedir(), 'Library', 'LaunchAgents');
}

/**
 * Los plists de LaunchAgents del usuario, con su contenido crudo, para el
 * escaneo de colisiones. Un directorio inexistente no es un error: significa
 * que no hay ningún job de usuario instalado.
 */
export async function readLaunchAgents(): Promise<{ label: string; contents: string }[]> {
  let entries: string[];
  try {
    entries = await readdir(launchAgentsDir());
  } catch {
    return [];
  }
  const agents: { label: string; contents: string }[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.plist')) continue;
    try {
      const contents = await readFile(join(launchAgentsDir(), entry), 'utf8');
      agents.push({ label: entry.slice(0, -'.plist'.length), contents });
    } catch {
      // Un plist ilegible (permisos) no debe tumbar la instalación: solo
      // significa que esa red de seguridad no lo cubre.
    }
  }
  return agents;
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
