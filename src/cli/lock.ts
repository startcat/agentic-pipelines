import { join, relative } from 'node:path';
import { acquireLock, readLock, releaseLock, type LockHandle } from '../guards/lock.ts';
import { EXIT_ALREADY_RUNNING, EXIT_LOCK_ERROR, KO } from './shared.ts';

/**
 * Ruta del fichero de lock de un pipeline. `guards/lock.ts` no exporta este
 * cálculo (es un detalle interno de ese módulo), así que se reconstruye aquí solo para el mensaje de diagnóstico,
 * replicando exactamente su convención `.runs/.locks/<pipeline>.lock`.
 */
export function lockFilePath(repoRoot: string, pipeline: string): string {
  return join(repoRoot, '.runs', '.locks', `${pipeline}.lock`);
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Informa de quién sostiene el lock cuando `acquireLock` devuelve
 * `undefined` (otra ejecución legítima en curso). Se decidió aceptar el
 * riesgo residual de un PID
 * reciclado en vez de perseguirlo con timeouts de obsolescencia o
 * heurísticas de reclamación, y hacerlo diagnosticable en su lugar — así que
 * aquí se nombra el fichero (ruta relativa al repo, nunca absoluta), el pid
 * y desde cuándo, para que el operador pueda juzgar y borrarlo él mismo.
 */
export async function printAlreadyRunning(repoRoot: string, pipeline: string): Promise<void> {
  const relPath = relative(repoRoot, lockFilePath(repoRoot, pipeline));
  console.error(`${KO} Ya hay una ejecución en curso de ${pipeline}`);
  console.error(`  lock:      ${relPath}`);

  // readLock no debería fallar justo después de que acquireLock viera el
  // mismo fichero sin lanzar, pero es una lectura aparte (pequeña ventana de
  // carrera con otro proceso); si falla, el mensaje se degrada con
  // elegancia en vez de arrastrar la excepción hasta aquí.
  const info = await readLock(repoRoot, pipeline).catch(() => undefined);
  if (info) {
    const elapsedMs = Date.now() - new Date(info.startedAt).getTime();
    console.error(`  PID:       ${info.pid}`);
    console.error(`  desde:     ${info.startedAt} (hace ${formatElapsed(elapsedMs)})`);
  }
  console.error('');
  console.error('  Si ese proceso ya no existe, borra el fichero.');
}

/**
 * Distinto del caso anterior: aquí `acquireLock` ha LANZADO, no devuelto
 * `undefined`. Significa que el propio fichero de lock está roto (ilegible,
 * corrupto, un problema de permisos), no que otra ejecución lo sostenga.
 * No se colapsan ambas situaciones en el mismo mensaje ni el mismo código
 * de salida.
 */
export function printLockError(repoRoot: string, pipeline: string, err: Error): void {
  const relPath = relative(repoRoot, lockFilePath(repoRoot, pipeline));
  console.error(`${KO} No se pudo comprobar el lock de "${pipeline}"`);
  console.error(`  lock:  ${relPath}`);
  console.error(`  error: ${err.message}`);
  console.error('');
  console.error('  El fichero de lock parece dañado; revísalo antes de reintentar.');
}

/**
 * Libera el lock ante SIGINT/SIGTERM. `process.exit()` dentro de un `finally`
 * no se ejecutaría solo (esa señal termina el proceso sin desenrollar la
 * pila de JavaScript), así que hace falta un manejador explícito: sin él, un
 * `Ctrl-C` durante `pipelines run` dejaría el lock huérfano hasta que
 * `acquireLock` lo reclamara por PID muerto en la siguiente ejecución.
 */
export function installSignalHandlers(lock: LockHandle): () => void {
  const onInterrupt = (): void => {
    void releaseLock(lock).finally(() => process.exit(130)); // 128 + SIGINT
  };
  const onTerminate = (): void => {
    void releaseLock(lock).finally(() => process.exit(143)); // 128 + SIGTERM
  };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  return () => {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  };
}

/**
 * Adquiere el lock de un pipeline, ejecuta `fn` y lo libera siempre —
 * incluida una excepción dentro de `fn` o una señal de interrupción. Punto
 * único usado por `run` y `resume` (sin dárselo también a `resume`, dos
 * resumes, o un resume y un run, podrían ejecutar el mismo pipeline a la
 * vez, justo lo que el lock existe para impedir).
 *
 * Deliberadamente NO usa `process.exit()` dentro de la región protegida: una
 * versión anterior llamaba a `process.exit(1)` justo antes de su propio
 * `finally { releaseLock }`, lo que en la práctica salta ese `finally` por
 * completo (`process.exit` termina el proceso sin desenrollar la pila) y
 * deja el lock de una ejecución fallida sin liberar. Aquí `fn` marca el
 * resultado con `process.exitCode` y retorna con normalidad, así que el
 * `finally` de más abajo siempre llega a ejecutarse.
 *
 * `onBlocked`, si se pasa, se invoca cuando `acquireLock` devuelve
 * `undefined` (otra ejecución legítima en curso) — nunca cuando el propio
 * fichero de lock está roto (`EXIT_LOCK_ERROR`), que es un problema
 * distinto, sin run que registrar. Así un run bloqueado también queda
 * registrado, como `skipped(already_running)`, igual que cualquier otra
 * guarda. El exit
 * code 3 se mantiene: es una señal operativa aparte, no contradice que el
 * intento quede registrado.
 */
export async function withLock(
  repoRoot: string,
  pipeline: string,
  fn: (lock: LockHandle) => Promise<void>,
  onBlocked?: () => Promise<void>,
): Promise<void> {
  let lock: LockHandle | undefined;
  try {
    lock = await acquireLock(repoRoot, pipeline);
  } catch (err) {
    printLockError(repoRoot, pipeline, err as Error);
    process.exitCode = EXIT_LOCK_ERROR;
    return;
  }
  if (!lock) {
    await printAlreadyRunning(repoRoot, pipeline);
    // El exit code se fija ANTES de invocar `onBlocked`, no después: si
    // `onBlocked` lanza (p. ej. `store.createRun` falla por un problema de
    // disco o permisos), `process.exitCode` ya vale 3 en el momento en que
    // la excepción se propaga, en vez de quedarse sin asignar. (`withContext`
    // sigue forzando 1 con `process.exit(EXIT_FAILURE)` en ese camino de
    // fallo raro porque pasa un código explícito — cerrar eso del todo
    // requeriría que `withContext` respetara un `process.exitCode` ya
    // fijado, fuera del alcance de este arreglo puntual).
    process.exitCode = EXIT_ALREADY_RUNNING;
    if (onBlocked) await onBlocked();
    return;
  }

  const uninstallSignalHandlers = installSignalHandlers(lock);
  try {
    await fn(lock);
  } finally {
    uninstallSignalHandlers();
    await releaseLock(lock);
  }
}
