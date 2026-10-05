import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseRepoConfig, type RepoConfig } from '../schema/config.ts';
import { parsePipeline, type Pipeline } from '../schema/pipeline.ts';

export type RepoContext = {
  root: string;
  config: RepoConfig;
  dotEnv: Record<string, string>;
};

/** Parsea un fichero .env: pares KEY=value, comentarios con # y comillas opcionales. */
export function parseDotEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2]!;
    result[key] = value;
  }
  return result;
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Sube directorios desde `cwd` hasta encontrar el `pipelines.yaml` del repo. */
export async function loadRepoContext(cwd: string): Promise<RepoContext> {
  let dir = resolve(cwd);
  for (;;) {
    const configText = await readIfExists(join(dir, 'pipelines.yaml'));
    if (configText !== undefined) {
      const dotEnvText = await readIfExists(join(dir, '.env'));
      return {
        root: dir,
        config: parseRepoConfig(configText),
        dotEnv: dotEnvText ? parseDotEnv(dotEnvText) : {},
      };
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `No se encontró un repo de pipelines (falta pipelines.yaml) desde ${cwd}.\n` +
          `Crea un fichero pipelines.yaml en la raíz del repo de datos (puede estar ` +
          `vacío, basta con \`touch pipelines.yaml\`) o sitúate dentro de un repo existente.`,
      );
    }
    dir = parent;
  }
}

export async function listPipelineNames(ctx: RepoContext): Promise<string[]> {
  try {
    const entries = await readdir(join(ctx.root, 'pipelines'), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

/**
 * Carga y valida un pipeline por nombre de directorio. Exige que el `name:`
 * declarado en el YAML coincida exactamente con ese directorio: no es solo
 * cosmético — `evaluateGuards` (guards/evaluate.ts) consulta el store de
 * runs por `pipeline.name`, mientras que `withLock`/`store.createRun`
 * (cli/index.ts) indexan por este mismo `name` de directorio. Si divergen,
 * `throttle`/`changed` consultan una clave que nunca se escribe y su
 * guarda deja de frenar nada.
 */
export async function loadPipeline(ctx: RepoContext, name: string): Promise<Pipeline> {
  const path = join(ctx.root, 'pipelines', name, 'pipeline.yaml');
  const text = await readIfExists(path);
  if (text === undefined) {
    const available = await listPipelineNames(ctx);
    throw new Error(
      `No existe el pipeline "${name}".\n` + `Disponibles: ${available.join(', ') || '(ninguno)'}`,
    );
  }
  const pipeline = parsePipeline(text);
  if (pipeline.name !== name) {
    throw new Error(
      `pipelines/${name}/pipeline.yaml declara name: "${pipeline.name}", que no ` +
        `coincide con su directorio ("${name}"). Locks, throttle y el historial de ` +
        `ejecuciones se indexan por nombre: un desajuste hace que las guardas consulten ` +
        `runs que nunca se escriben. Corrige el campo "name" o renombra el directorio.`,
    );
  }
  return pipeline;
}

/** Lee los params guardados por `pipelines install`. */
export async function loadLocalParams(
  ctx: RepoContext,
  pipeline: string,
): Promise<Record<string, string>> {
  const text = await readIfExists(join(ctx.root, '.params.local.json'));
  if (!text) return {};
  const all = JSON.parse(text) as Record<string, Record<string, string>>;
  return all[pipeline] ?? {};
}

/** Secretos declarados por un pipeline o un canal de notify, tomados del .env o del entorno. */
export function collectSecrets(ctx: RepoContext, names: string[]): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const name of names) {
    const value = ctx.dotEnv[name] ?? process.env[name];
    if (value !== undefined) secrets[name] = value;
  }
  return secrets;
}
