import { describe, expect, test } from 'bun:test';
import { triggerPeriodMs, evaluateTrigger, evaluateHealth } from '../../src/health/evaluate.ts';
import type { RunRecord } from '../../src/runs/types.ts';
import type { Pipeline } from '../../src/schema/pipeline.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('triggerPeriodMs', () => {
  test('un horario diario es un periodo de 24 h', () => {
    expect(triggerPeriodMs([{ Minute: 0, Hour: 3 }])).toBe(DAY);
  });

  test('dos horarios diarios reparten el día', () => {
    expect(triggerPeriodMs([{ Minute: 0, Hour: 3 }, { Minute: 0, Hour: 15 }])).toBe(DAY / 2);
  });

  test('sin hora fijada, dispara cada hora', () => {
    expect(triggerPeriodMs([{ Minute: 0 }])).toBe(HOUR);
  });

  test('sin minuto fijado, dispara cada minuto', () => {
    expect(triggerPeriodMs([{}])).toBe(60_000);
  });

  test('un día de la semana fijado estira el periodo a una semana', () => {
    expect(triggerPeriodMs([{ Minute: 0, Hour: 3, Weekday: 1 }])).toBe(7 * DAY);
  });

  test('un día del mes fijado lo estira a un mes aproximado', () => {
    expect(triggerPeriodMs([{ Minute: 0, Hour: 3, Day: 1 }])).toBe(30 * DAY);
  });
});

const loaded = { loaded: true, disabled: false, plistOnDisk: 'X', plistExpected: 'X' };

describe('evaluateTrigger', () => {
  // Un pipeline manual no está roto: pintarlo en rojo sería ruido, y el ruido
  // es lo que hace que nadie mire el panel.
  test('sin triggers declarados es no-trigger, no un fallo', () => {
    expect(evaluateTrigger(false, { loaded: false, disabled: false })).toBe('no-trigger');
  });

  test('declara cron y no hay job: not-installed', () => {
    expect(evaluateTrigger(true, { loaded: false, disabled: false })).toBe('not-installed');
  });

  // Accionable gana a genérico: "deshabilitado" dice qué hacer.
  test('deshabilitado manda sobre no-cargado', () => {
    expect(evaluateTrigger(true, { loaded: false, disabled: true })).toBe('disabled');
  });

  test('cargado y coincidente: installed', () => {
    expect(evaluateTrigger(true, loaded)).toBe('installed');
  });

  test('cargado pero el plist no es el que install generaría hoy: drifted', () => {
    expect(evaluateTrigger(true, { ...loaded, plistExpected: 'OTRO' })).toBe('drifted');
  });

  // Solo la marca de tiempo difiere: eso NO es una desviación.
  test('la marca de tiempo no cuenta como desviación', () => {
    expect(
      evaluateTrigger(true, {
        loaded: true,
        disabled: false,
        plistOnDisk: 'a\n  Generado:  2026-01-01T00:00:00.000Z\nb',
        plistExpected: 'a\n  Generado:  2026-08-29T00:00:00.000Z\nb',
      }),
    ).toBe('installed');
  });

  // Cargado sin plist en disco es raro pero no es una desviación demostrable:
  // afirmar `drifted` sin poder comparar sería inventarse un diagnóstico.
  test('sin plist en disco no se afirma desviación', () => {
    expect(evaluateTrigger(true, { loaded: true, disabled: false })).toBe('installed');
  });
});

const NOW = new Date('2026-08-29T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

function run(status: RunRecord['status'], startedAt: string, skipReason?: string): RunRecord {
  return {
    id: startedAt, pipeline: 'demo', pipelineVersion: 1, status,
    startedAt, params: {}, steps: {}, ...(skipReason ? { skipReason } : {}),
  };
}

/** Pipeline mínimo: solo se leen `triggers` y `name`. */
function pipe(cron?: string): Pipeline {
  return { name: 'demo', triggers: cron ? [{ cron }] : [] } as unknown as Pipeline;
}

const installed = { loaded: true, disabled: false };
const nightly = '0 3 * * *'; // ventana = 48 h

describe('evaluateHealth — eje de trabajo', () => {
  test('sin runs es never-worked, no silent', () => {
    expect(evaluateHealth(pipe(nightly), [], installed, NOW).work).toBe('never-worked');
  });

  test('trabajo reciente con éxito es working', () => {
    const runs = [run('success', hoursAgo(9))];
    expect(evaluateHealth(pipe(nightly), runs, installed, NOW).work).toBe('working');
  });

  test('el último trabajo real falló: failing', () => {
    const runs = [run('failed', hoursAgo(9))];
    expect(evaluateHealth(pipe(nightly), runs, installed, NOW).work).toBe('failing');
  });

  // El caso de las diez noches: el disparador funciona, el trabajo no.
  //
  // La guarda culpable ya no se lee de `health.skipReason` (retirado: nadie
  // en producción lo consumía — el visor lee `lastRun.skipReason`, el campo
  // del propio RunRecord, que `evaluateHealth` no necesita repetir). Este
  // caso sigue probando lo que le da su nombre: que se cuenten los saltos
  // consecutivos y que el veredicto sea `stuck`.
  test('se dispara y salta siempre: stuck, con el conteo de saltos', () => {
    const runs = [
      run('skipped', hoursAgo(9), 'shell: guarda del tracker devolvió 1'),
      run('skipped', hoursAgo(33), 'shell: guarda del tracker devolvió 1'),
      run('success', hoursAgo(240)),
    ];
    const health = evaluateHealth(pipe(nightly), runs, installed, NOW);
    expect(health.work).toBe('stuck');
    expect(health.consecutiveSkips).toBe(2);
  });

  // El caso que stale_after no puede ver: ni un run, ni siquiera saltado.
  test('nada dentro de la ventana: silent', () => {
    const runs = [run('success', hoursAgo(100))];
    expect(evaluateHealth(pipe(nightly), runs, installed, NOW).work).toBe('silent');
  });

  test('un pipeline manual nunca es stuck ni silent', () => {
    const runs = [run('success', hoursAgo(500))];
    const health = evaluateHealth(pipe(), runs, { loaded: false, disabled: false }, NOW);
    expect(health.work).toBe('working');
    expect(health.windowMs).toBeUndefined();
  });

  // Ni launchd ni .runs/ detectan esto por su cuenta.
  test('installed + silent es la contradicción que hay que gritar', () => {
    const runs = [run('success', hoursAgo(100))];
    expect(evaluateHealth(pipe(nightly), runs, installed, NOW).contradiction).toBe(true);
  });

  // Un plist DESVIADO sigue estando cargado en launchd: la desviación dice que
  // no es el que `install` generaría hoy, no que no dispare. Exigir exactamente
  // `installed` dejaba esta casilla sin alarma y, peor, sin la cola del log del
  // job — que `server.ts` solo lee cuando `contradiction` es cierto, y que es
  // el único rastro de un motor que muere antes de escribir `run.json`.
  test('drifted + silent es la misma contradicción: el plist desviado también dispara', () => {
    const runs = [run('success', hoursAgo(100))];
    const drifted = { loaded: true, disabled: false, plistOnDisk: 'X', plistExpected: 'OTRO' };
    const health = evaluateHealth(pipe(nightly), runs, drifted, NOW);
    expect(health.trigger).toBe('drifted');
    expect(health.work).toBe('silent');
    expect(health.contradiction).toBe(true);
  });

  // La alarma es del CRUCE, no de un eje suelto: un plist desviado que trabaja
  // con normalidad es una desviación, no una contradicción.
  test('drifted y trabajando no es contradicción', () => {
    const runs = [run('success', hoursAgo(9))];
    const drifted = { loaded: true, disabled: false, plistOnDisk: 'X', plistExpected: 'OTRO' };
    const health = evaluateHealth(pipe(nightly), runs, drifted, NOW);
    expect(health.trigger).toBe('drifted');
    expect(health.contradiction).toBe(false);
  });

  test('deshabilitado y mudo no es contradicción: es coherente', () => {
    const runs = [run('success', hoursAgo(100))];
    const health = evaluateHealth(pipe(nightly), runs, { loaded: false, disabled: true }, NOW);
    expect(health.trigger).toBe('disabled');
    expect(health.contradiction).toBe(false);
  });

  test('no-instalado y mudo no es contradicción: es coherente', () => {
    const runs = [run('success', hoursAgo(100))];
    const health = evaluateHealth(pipe(nightly), runs, { loaded: false, disabled: false }, NOW);
    expect(health.work).toBe('silent');
    expect(health.contradiction).toBe(false);
  });

  // `cronToCalendarIntervals` lanza sobre
  // sintaxis que el subconjunto de launchd no soporta (aquí, el paso "/15").
  // Un pipeline.yaml así no se puede instalar, pero sí puede existir en el
  // repo — y una excepción aquí tumbaría el panel entero, el único sitio
  // pensado para que nada falle en silencio.
  test('un cron con sintaxis que launchd no soporta no revienta el panel', () => {
    const runs = [run('success', hoursAgo(9))];
    const health = evaluateHealth(pipe('*/15 * * * *'), runs, installed, NOW);
    expect(health.windowMs).toBeUndefined();
    expect(health.work).toBe('working');
  });
});
