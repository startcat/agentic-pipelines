import { ChannelFailedError, dispatchNotify } from '../notify/dispatch.ts';
import type { PreflightReport } from '../preflight/check.ts';
import type { RunStore } from '../runs/store.ts';
import type { NotifyRecord, RunRecord } from '../runs/types.ts';
import type { Pipeline } from '../schema/pipeline.ts';
import { loadRepoContext, type RepoContext } from './context.ts';

export const OK = '✓';
export const KO = '✗';

/**
 * Códigos de salida: pensados para que un cron o un script puedan actuar sin
 * tener que interpretar la salida por pantalla.
 *   0   éxito. Incluye una guarda `when`/`throttle` que decide saltar la
 *       ejecución: es un resultado normal del pipeline, no un error — se deja el valor por defecto, sin constante.
 *   1   fallo genérico: pipeline.yaml inválido, dependencia ausente
 *       (preflight/doctor), params obligatorios ausentes o un paso que
 *       falló tras agotar sus reintentos.
 *   2   el propio fichero de lock está dañado o es ilegible — no es que
 *       otra ejecución lo tenga, algo va mal con el fichero en sí
 *       (`acquireLock` lanzó en vez de devolver `undefined`).
 *   3   ya hay otra ejecución legítima en curso sobre este pipeline
 *       (`acquireLock` devolvió `undefined`).
 *   130/143  el propio proceso fue interrumpido (SIGINT/SIGTERM) mientras
 *       sostenía el lock — convención Unix habitual (128 + señal).
 */
export const EXIT_FAILURE = 1;
export const EXIT_LOCK_ERROR = 2;
export const EXIT_ALREADY_RUNNING = 3;

export function collectSetFlag(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function parseSetFlags(values: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const value of values) {
    const index = value.indexOf('=');
    if (index === -1) throw new Error(`--set espera clave=valor, se recibió "${value}"`);
    result[value.slice(0, index)] = value.slice(index + 1);
  }
  return result;
}

export function printPreflight(report: PreflightReport): void {
  for (const check of report.checks) {
    const mark = check.ok ? OK : KO;
    console.log(`  ${mark} ${check.kind.padEnd(6)} ${check.name.padEnd(32)} ${check.detail}`);
  }
}

/**
 * Directorio de arranque resuelto UNA SOLA VEZ por el hook `preAction` del
 * entrypoint (`index.ts`), antes de que cualquier acción de subcomando
 * arranque. Ningún comando debe calcular esto por su cuenta ni tocar
 * Commander para conseguirlo — sustituye a la antigua `resolveStartDir()`,
 * que leía `program.opts().repo` desde fuera del módulo que declara
 * `program`.
 */
let resolvedStartDir: string | undefined;

export function setResolvedStartDir(dir: string): void {
  resolvedStartDir = dir;
}

export function getResolvedStartDir(): string {
  if (resolvedStartDir === undefined) {
    throw new Error(
      'getResolvedStartDir(): se llamó antes de que el hook preAction del entrypoint lo resolviera',
    );
  }
  return resolvedStartDir;
}

export async function withContext<T>(fn: (ctx: RepoContext) => Promise<T>): Promise<T> {
  try {
    return await fn(await loadRepoContext(getResolvedStartDir()));
  } catch (err) {
    // Seguro llamar a process.exit aquí: cualquier lock que se hubiera
    // adquirido dentro de `fn` ya se liberó en el `finally` de `withLock`
    // antes de que la excepción llegara hasta este catch (ver `withLock`).
    console.error((err as Error).message);
    process.exit(EXIT_FAILURE);
  }
}

/**
 * Guarda el rastro del canal en run.json sin que un fallo al escribirlo
 * (un run que no vive en `.runs/`, disco lleno) tape el aviso original.
 */
async function persistNotify(store: RunStore, record: RunRecord, notify: NotifyRecord): Promise<void> {
  try {
    await store.writeNotify(record, notify);
  } catch (err) {
    console.error(`aviso: no se pudo guardar el rastro del notify: ${(err as Error).message}`);
  }
}

/**
 * Notifica el cierre de un run, sea cual sea el camino por el que se cerró
 * (fin normal, guarda que lo salta, lock ocupado). Best-effort a propósito:
 * un canal roto no cambia el resultado del run, solo se avisa por
 * stderr.
 *
 * `lastSuccess` se consulta DESPUÉS de cerrar el run — así un run que acaba
 * de ir bien cuenta como su propio último éxito y nunca se anuncia stale —, y
 * solo si el pipeline declara `stale_after`, para no pagar el listado de
 * `.runs/` en el caso normal.
 */
export async function notifyRunClosed(
  pipeline: Pipeline,
  record: RunRecord,
  ctx: RepoContext,
  store: RunStore,
): Promise<void> {
  try {
    const lastSuccess = pipeline.notify?.staleAfter
      ? await store.lastSuccess(pipeline.name)
      : undefined;
    const notify = await dispatchNotify(pipeline, record, ctx, { lastSuccessAt: lastSuccess?.startedAt });
    if (notify) await persistNotify(store, record, notify);
  } catch (err) {
    // El rastro de un canal que falla se guarda igual: es el envío que más
    // falta hace poder leer después.
    if (err instanceof ChannelFailedError) await persistNotify(store, record, err.notify);
    console.error(`aviso: notify falló: ${(err as Error).message}`);
  }
}
