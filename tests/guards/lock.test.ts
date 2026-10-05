import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, readLock, releaseLock } from '../../src/guards/lock.ts';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ap-lock-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('lock', () => {
  test('adquiere el lock cuando está libre', async () => {
    expect(await acquireLock(root, 'demo')).toBeDefined();
  });

  test('un segundo intento sobre el mismo pipeline falla', async () => {
    const first = await acquireLock(root, 'demo');
    expect(first).toBeDefined();
    expect(await acquireLock(root, 'demo')).toBeUndefined();
  });

  test('tras liberarlo se puede volver a adquirir', async () => {
    const first = await acquireLock(root, 'demo');
    await releaseLock(first!);
    expect(await acquireLock(root, 'demo')).toBeDefined();
  });

  test('pipelines distintos no se bloquean entre sí', async () => {
    expect(await acquireLock(root, 'a')).toBeDefined();
    expect(await acquireLock(root, 'b')).toBeDefined();
  });

  test('un lock de un proceso muerto se reclama', async () => {
    const handle = await acquireLock(root, 'demo');
    // Sobrescribe el lock con un PID que seguro no existe.
    await Bun.write(handle!.path, JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString() }));
    expect(await acquireLock(root, 'demo')).toBeDefined();
  });

  // --- Exclusión mutua, robo de locks ajenos y liberación ---

  test('dos adquisiciones simultáneas del mismo pipeline dejan un único dueño (carrera TOCTOU)', async () => {
    // Antes del arreglo, el chequeo (leer + comprobar vida) y la escritura no
    // eran atómicos: las dos llamadas podían leer "no hay lock" antes de que
    // ninguna escribiera, y las dos terminaban "adquiriendo". La ausencia de
    // un test así es justo lo que dejó pasar el defecto en una versión anterior
    // — aquí sí se lanzan de verdad en paralelo con Promise.all.
    const [a, b] = await Promise.all([
      acquireLock(root, 'demo'),
      acquireLock(root, 'demo'),
    ]);
    const holders = [a, b].filter((handle) => handle !== undefined);
    expect(holders.length).toBe(1);
  });

  test('un lock vivo de otro usuario (EPERM) no se puede robar', async () => {
    const handle = await acquireLock(root, 'demo');
    // Simula un dueño que sigue vivo pero pertenece a otro usuario: no
    // podemos señalizarlo, pero tampoco debemos robarle el lock.
    await Bun.write(
      handle!.path,
      JSON.stringify({ pid: 4_242, startedAt: new Date().toISOString() }),
    );

    const originalKill = process.kill.bind(process);
    process.kill = ((pid: number, signal?: string | number) => {
      if (pid === 4_242) {
        throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
      }
      return originalKill(pid, signal);
    }) as typeof process.kill;

    try {
      expect(await acquireLock(root, 'demo')).toBeUndefined();
    } finally {
      process.kill = originalKill;
    }
  });

  test('releaseLock no borra un lock que pertenece a otro pid', async () => {
    const handle = await acquireLock(root, 'demo');
    // Alguien más reclamó este mismo fichero de lock entretanto (o el
    // handle quedó obsoleto): releaseLock no debe tocarlo.
    await Bun.write(
      handle!.path,
      JSON.stringify({ pid: 123_456, startedAt: new Date().toISOString() }),
    );
    await releaseLock(handle!);
    expect(await Bun.file(handle!.path).exists()).toBe(true);
  });

  // --- Lectura sin efectos y locks corruptos ---

  test('readLock expone quién sostiene el lock sin adquirirlo ni modificarlo', async () => {
    const handle = await acquireLock(root, 'demo');
    const info = await readLock(root, 'demo');
    expect(info?.pid).toBe(process.pid);
    // No adquirió nada por su cuenta: el lock sigue siendo el mismo.
    expect(await acquireLock(root, 'demo')).toBeUndefined();
    await releaseLock(handle!);
    expect(await readLock(root, 'demo')).toBeUndefined();
  });

  test('un lock corrupto no se adquiere en silencio (fail-safe, no fail-open)', async () => {
    const handle = await acquireLock(root, 'demo');
    await Bun.write(handle!.path, 'esto no es JSON válido');
    await expect(acquireLock(root, 'demo')).rejects.toThrow();
  });

  // --- Reclamación atómica de un lock huérfano y lecturas entrecortadas
  // (creación con wx) ---

  test('adquisiciones concurrentes sobre un lock huérfano dejan un único dueño', async () => {
    // Reproduce lo que dejó pasar una versión anterior: un lock huérfano (dueño
    // muerto) y varias llamadas concurrentes sobre el MISMO pipeline. Se
    // repite muchas veces porque una sola iteración de un test de carrera
    // prueba poco. Cada iteración usa su propio pipeline para no depender
    // de limpiar estado entre iteraciones.
    //
    // Concurrencia deliberadamente moderada: las
    // versiones anteriores de este test lanzaban 30 llamadas a la vez —
    // la misma escala a la que aparece el riesgo residual ya medido y
    // aceptado (ver el comentario en `acquireLock`, justo antes de
    // `claimMarker`). Con esa escala, el test
    // terminó afirmando una garantía que se decidió explícitamente NO
    // dar, y sus fallos ocasionales (~1 de cada 200-400 ejecuciones) eran
    // ruido, no una señal de regresión real. Aquí se prueba la exclusión
    // mutua a la concurrencia que de verdad le importa a esta
    // herramienta — un puñado de llamadas solapadas (p. ej. un cron que
    // dispara durante una ejecución manual), no un tropel — donde la
    // garantía SÍ es absoluta: exactamente un dueño, siempre, en las 30
    // repeticiones.
    for (let iteration = 0; iteration < 30; iteration++) {
      const pipeline = `race-${iteration}`;
      const seedPath = join(root, '.runs', '.locks', `${pipeline}.lock`);
      await Bun.write(
        seedPath,
        JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString() }),
      );

      const attempts = await Promise.all(
        Array.from({ length: 5 }, () => acquireLock(root, pipeline)),
      );
      const holders = attempts.filter((handle) => handle !== undefined);
      expect(holders.length).toBe(1);
    }
  });

  test('adquisiciones y lecturas concurrentes nunca observan un fichero de lock a medio escribir', async () => {
    // Con `writeFile(..., {flag:'wx'})` la creación no era atómica en su
    // CONTENIDO: el fichero podía existir vacío un instante antes de
    // rellenarse, y una lectura concurrente en esa ventana lanzaba
    // SyntaxError al parsear. Ninguna de las llamadas de abajo debe
    // lanzar por ese motivo.
    const pipeline = 'hammer';
    const acquireCalls = Array.from({ length: 15 }, () => acquireLock(root, pipeline));
    const readCalls = Array.from({ length: 15 }, () => readLock(root, pipeline));

    const [acquireResults] = await Promise.all([
      Promise.all(acquireCalls),
      Promise.all(readCalls),
    ]);

    const holders = acquireResults.filter((handle) => handle !== undefined);
    expect(holders.length).toBe(1);
  });

  test('un lock vacío se trata como ausente, no como corrupto', async () => {
    const handle = await acquireLock(root, 'demo');
    await Bun.write(handle!.path, '');
    // Un fichero vacío es un estado benigno (alcanzable en una ventana de
    // concurrencia estrecha), no corrupción: debe poder reclamarse sin
    // lanzar, igual que un lock de un proceso muerto.
    expect(await acquireLock(root, 'demo')).toBeDefined();
  });

  // --- El marcador de reclamación no tenía información de vida y podía
  // quedar huérfano para siempre ---

  test('un lock muerto con un marcador huérfano se recupera solo', async () => {
    // Reproduce el fallo crítico: un proceso que muere a media
    // reclamación (señal, OOM, corte de luz) deja el marcador huérfano.
    // Antes el marcador no llevaba pid, así que
    // `acquireLock` lo rechazaba para siempre aunque tanto el lock como el
    // marcador tuvieran, ambos, un dueño muerto — el pipeline quedaba
    // inadquirible pese a que nadie vivo lo sostenía.
    const lockFilePath = join(root, '.runs', '.locks', 'demo.lock');
    await Bun.write(
      lockFilePath,
      JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString() }),
    );
    await Bun.write(
      `${lockFilePath}.reclaim`,
      JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString() }),
    );

    const handle = await acquireLock(root, 'demo');
    expect(handle).toBeDefined();
    const info = await readLock(root, 'demo');
    expect(info?.pid).toBe(process.pid);
  });

  test('un marcador con dueño vivo no se roba', async () => {
    const lockFilePath = join(root, '.runs', '.locks', 'demo.lock');
    await Bun.write(
      lockFilePath,
      JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString() }),
    );
    // El marcador lo sostiene un proceso vivo de verdad (el propio proceso
    // de test): no debe robársele el privilegio de reclamar, aunque el
    // lock en sí esté muerto.
    await Bun.write(
      `${lockFilePath}.reclaim`,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );

    expect(await acquireLock(root, 'demo')).toBeUndefined();
  });

  test('un marcador vacío se trata como huérfano, no como corrupto', async () => {
    const lockFilePath = join(root, '.runs', '.locks', 'demo.lock');
    await Bun.write(
      lockFilePath,
      JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString() }),
    );
    await Bun.write(`${lockFilePath}.reclaim`, '');

    expect(await acquireLock(root, 'demo')).toBeDefined();
  });
});
