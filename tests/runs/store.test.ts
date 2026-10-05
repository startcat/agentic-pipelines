import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore, redactSecrets } from '../../src/runs/store.ts';

let root: string;
let store: RunStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ap-runs-'));
  store = new RunStore(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('RunStore', () => {
  test('crea un run y lo deja en estado running', async () => {
    const run = await store.createRun('demo', 1, { root: '/tmp' });
    expect(run.status).toBe('running');
    expect(run.pipeline).toBe('demo');
    expect(run.pipelineVersion).toBe(1);
    expect(run.params).toEqual({ root: '/tmp' });

    const read = await store.readRun('demo', run.id);
    expect(read?.status).toBe('running');
  });

  test('escribe un paso y lo puede releer con sus outputs', async () => {
    const run = await store.createRun('demo', 1, {});
    await store.writeStep(run, {
      id: 'scan',
      status: 'success',
      startedAt: new Date().toISOString(),
      durationMs: 1200,
      outputs: { stale_count: 7 },
      effects: [],
      attempts: 1,
    });

    const read = await store.readRun('demo', run.id);
    expect(read!.steps.scan!.status).toBe('success');
    expect(read!.steps.scan!.outputs).toEqual({ stale_count: 7 });
  });

  test('writeStepLog guarda la transcripción y se puede releer del disco', async () => {
    const run = await store.createRun('demo', 1, {});
    await store.writeStepLog(run, 'scan', 'línea 1\nlínea 2\n');

    const logPath = join(root, '.runs', 'demo', run.id, 'scan.log');
    const contents = await readFile(logPath, 'utf8');
    expect(contents).toBe('línea 1\nlínea 2\n');
  });

  test('el estado se persiste paso a paso, no al cerrar el run', async () => {
    const run = await store.createRun('demo', 1, {});
    await store.writeStep(run, {
      id: 'a',
      status: 'success',
      startedAt: new Date().toISOString(),
      durationMs: 5,
      outputs: {},
      effects: [],
      attempts: 1,
    });
    // Sin llamar a finishRun: simula un proceso que muere a media ejecución.
    const read = await store.readRun('demo', run.id);
    expect(read!.status).toBe('running');
    expect(read!.steps.a!.status).toBe('success');
  });

  test('finishRun fija el estado final y el coste agregado', async () => {
    const run = await store.createRun('demo', 1, {});
    await store.writeStep(run, {
      id: 'a', status: 'success', startedAt: new Date().toISOString(),
      durationMs: 5, outputs: {}, effects: [], attempts: 1, costUsd: 0.04,
    });
    await store.writeStep(run, {
      id: 'b', status: 'success', startedAt: new Date().toISOString(),
      durationMs: 5, outputs: {}, effects: [], attempts: 1, costUsd: 0.31,
    });
    await store.finishRun(run, 'success');

    const read = await store.readRun('demo', run.id);
    expect(read!.status).toBe('success');
    expect(read!.totalCostUsd).toBeCloseTo(0.35, 5);
  });

  test('writeNotify persiste el rastro del canal en run.json', async () => {
    const run = await store.createRun('demo', 1, {});
    await store.finishRun(run, 'success');
    await store.writeNotify(run, {
      channel: 'email', code: 0, at: '2026-09-03T05:00:10.000Z',
      log: 'notify-resend: enviat (200)',
    });
    const read = await store.readRun('demo', run.id);
    expect(read!.notify).toEqual({
      channel: 'email', code: 0, at: '2026-09-03T05:00:10.000Z',
      log: 'notify-resend: enviat (200)',
    });
  });

  test('listRuns devuelve los runs del más reciente al más antiguo', async () => {
    const a = await store.createRun('demo', 1, {});
    await store.finishRun(a, 'success');
    await Bun.sleep(5);
    const b = await store.createRun('demo', 1, {});
    await store.finishRun(b, 'failed');

    const runs = await store.listRuns('demo');
    expect(runs.map((r) => r.id)).toEqual([b.id, a.id]);
  });

  test('lastSuccess ignora runs fallidos y saltados', async () => {
    const ok = await store.createRun('demo', 1, {});
    await store.finishRun(ok, 'success');
    await Bun.sleep(5);
    const bad = await store.createRun('demo', 1, {});
    await store.finishRun(bad, 'failed');
    await Bun.sleep(5);
    const skip = await store.createRun('demo', 1, {});
    await store.finishRun(skip, 'skipped', 'throttle');

    expect((await store.lastSuccess('demo'))?.id).toBe(ok.id);
  });

  test('lastSuccess devuelve undefined si nunca hubo un run correcto', async () => {
    expect(await store.lastSuccess('nunca-ejecutado')).toBeUndefined();
  });

  test('un run saltado guarda la condición que lo causó', async () => {
    const run = await store.createRun('demo', 1, {});
    await store.finishRun(run, 'skipped', 'throttle: 4h');
    const read = await store.readRun('demo', run.id);
    expect(read!.status).toBe('skipped');
    expect(read!.skipReason).toBe('throttle: 4h');
  });

  test('lastAttempt devuelve el intento más reciente aunque no sea success, a diferencia de lastSuccess', async () => {
    const ok = await store.createRun('demo', 1, {});
    await store.finishRun(ok, 'success');
    await Bun.sleep(5);
    const bad = await store.createRun('demo', 1, {});
    await store.finishRun(bad, 'failed');

    // El throttle se basa en lastSuccess, no en lastAttempt: deben
    // poder discrepar cuando el intento más reciente no fue exitoso.
    expect((await store.lastAttempt('demo'))?.id).toBe(bad.id);
    expect((await store.lastSuccess('demo'))?.id).toBe(ok.id);
  });

  test('lastAttempt ignora un run que sigue en curso y devuelve el último terminado', async () => {
    const ok = await store.createRun('demo', 1, {});
    await store.finishRun(ok, 'success');
    await Bun.sleep(5);
    // Sin llamar a finishRun: este run queda en estado 'running'.
    await store.createRun('demo', 1, {});

    expect((await store.lastAttempt('demo'))?.id).toBe(ok.id);
  });

  // Antes `lastAttempt` contaba también los runs saltados,
  // así que un pipeline con `throttle: { since: last_attempt }` empujaba el
  // ancla de su propia ventana con cada tick que él mismo saltaba, y la ventana
  // no vencía nunca. `since: last_attempt` existe para espaciar TRABAJO — su
  // diferencia con `last_success` es que cuenta también los intentos fallidos —,
  // y un run saltado no hizo trabajo alguno.
  test('lastAttempt ignora un run saltado por una guarda', async () => {
    const ok = await store.createRun('demo', 1, {});
    await store.finishRun(ok, 'success');
    await Bun.sleep(5);
    const saltado = await store.createRun('demo', 1, {});
    await store.finishRun(saltado, 'skipped', 'throttle: 46h');

    expect((await store.lastAttempt('demo'))?.id).toBe(ok.id);
  });

  test('lastAttempt ignora un run saltado por el lock', async () => {
    const ok = await store.createRun('demo', 1, {});
    await store.finishRun(ok, 'failed');
    await Bun.sleep(5);
    const bloqueado = await store.createRun('demo', 1, {});
    await store.finishRun(bloqueado, 'skipped', 'already_running');

    expect((await store.lastAttempt('demo'))?.id).toBe(ok.id);
  });

  // El escenario de inanición completo, que es lo que pasaba antes del arreglo: una
  // tanda de ticks saltados seguidos no puede alejar el ancla ni un milímetro.
  test('una racha de saltos no mueve el ancla: el ancla sigue siendo el último run que ejecutó', async () => {
    const ejecutado = await store.createRun('demo', 1, {});
    await store.finishRun(ejecutado, 'success');
    for (let i = 0; i < 5; i += 1) {
      await Bun.sleep(2);
      const saltado = await store.createRun('demo', 1, {});
      await store.finishRun(saltado, 'skipped', 'throttle: 46h');
    }

    expect((await store.lastAttempt('demo'))?.id).toBe(ejecutado.id);
  });

  test('lastAttempt devuelve undefined si todos los runs se saltaron', async () => {
    const saltado = await store.createRun('demo', 1, {});
    await store.finishRun(saltado, 'skipped', 'throttle: 46h');

    expect(await store.lastAttempt('demo')).toBeUndefined();
  });

  test('persist no deja ficheros temporales en el directorio del run tras escrituras correctas', async () => {
    const run = await store.createRun('demo', 1, {});
    await store.writeStep(run, {
      id: 'a', status: 'success', startedAt: new Date().toISOString(),
      durationMs: 5, outputs: {}, effects: [], attempts: 1,
    });
    await store.finishRun(run, 'success');

    const files = await readdir(join(root, '.runs', 'demo', run.id));
    expect(files).toEqual(['run.json']);
  });

  test('run.json es siempre JSON completo y parseable tras cada persist', async () => {
    const run = await store.createRun('demo', 1, {});
    await store.writeStep(run, {
      id: 'a', status: 'success', startedAt: new Date().toISOString(),
      durationMs: 5, outputs: {}, effects: [], attempts: 1,
    });

    const raw = await readFile(join(root, '.runs', 'demo', run.id, 'run.json'), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

describe('redactSecrets', () => {
  test('sustituye cada valor de secreto por un marcador', () => {
    expect(redactSecrets('token=abc123 fin', ['abc123'])).toBe('token=«redactado» fin');
  });
  test('sustituye todas las apariciones', () => {
    expect(redactSecrets('abc abc', ['abc'])).toBe('«redactado» «redactado»');
  });
  test('ignora secretos vacíos para no destrozar el texto', () => {
    expect(redactSecrets('hola', [''])).toBe('hola');
  });
  test('no altera el texto si no hay coincidencias', () => {
    expect(redactSecrets('hola', ['zzz'])).toBe('hola');
  });
});
