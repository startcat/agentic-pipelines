import { describe, expect, test } from 'bun:test';
import type { Health } from '../../src/health/evaluate.ts';
import type { RunRecord } from '../../src/runs/types.ts';
import {
  etiquetaDisparo,
  etiquetaTrabajo,
  veredicto,
  resumenPanel,
} from '../../src/web/verdict.ts';

function salud(over: Partial<Health> = {}): Health {
  return { trigger: 'installed', work: 'working', consecutiveSkips: 0, contradiction: false, ...over };
}

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r', pipeline: 'demo', pipelineVersion: 1, status: 'success',
    startedAt: '2026-08-31T01:00:00.000Z', params: {}, steps: {}, ...over,
  };
}

describe('etiquetas', () => {
  test('cada estado de disparo tiene su palabra en castellano', () => {
    expect(etiquetaDisparo('no-trigger')).toBe('sin cron');
    expect(etiquetaDisparo('not-installed')).toBe('no instalado');
    expect(etiquetaDisparo('disabled')).toBe('deshabilitado');
    expect(etiquetaDisparo('drifted')).toBe('desviado');
    expect(etiquetaDisparo('installed')).toBe('cargado');
  });

  test('cada estado de trabajo tiene su palabra en castellano', () => {
    expect(etiquetaTrabajo('never-worked')).toBe('nunca ha trabajado');
    expect(etiquetaTrabajo('working')).toBe('trabajando');
    expect(etiquetaTrabajo('failing')).toBe('fallando');
    expect(etiquetaTrabajo('stuck')).toBe('atascado');
    expect(etiquetaTrabajo('silent')).toBe('mudo');
  });

  // El vocabulario es UNO. "silencio" fue una palabra suelta en una maqueta y
  // ya costó una inconsistencia; el estado se llama "mudo" en toda la interfaz.
  test('el estado silent no se llama de dos maneras', () => {
    expect(etiquetaTrabajo('silent')).not.toContain('silencio');
  });
});

describe('veredicto', () => {
  // La razón de existir de la página. Del 20 al 29 de agosto el job estaba
  // cargado y no producía nada, y ninguna de las dos fuentes lo veía sola.
  test('cargado + mudo es la alarma, y lo dice en mayúsculas', () => {
    const v = veredicto(salud({ work: 'silent', contradiction: true }), 16);
    expect(v.tono).toBe('bad');
    expect(v.line).toBe('CARGADO Y SIN PRODUCIR NADA');
  });

  test('un plist desviado y mudo también es la alarma', () => {
    const v = veredicto(salud({ trigger: 'drifted', work: 'silent', contradiction: true }), 16);
    expect(v.tono).toBe('bad');
    expect(v.line).toBe('CARGADO Y SIN PRODUCIR NADA');
  });

  test('la alarma manda incluso sobre un run corriendo', () => {
    const lastRun = run({ status: 'running' });
    expect(veredicto(salud({ work: 'silent', contradiction: true, lastRun }), 16).line)
      .toBe('CARGADO Y SIN PRODUCIR NADA');
  });

  test('atascado dice cuántas noches lleva saltando', () => {
    const v = veredicto(salud({ work: 'stuck', consecutiveSkips: 8 }), 16);
    expect(v.tono).toBe('warn');
    expect(v.line).toContain('8 noches');
  });

  test('una sola noche saltada no habla en plural', () => {
    const linea = veredicto(salud({ work: 'stuck', consecutiveSkips: 1 }), 16).line;
    expect(linea).toContain('1 noche');
    expect(linea).not.toContain('1 noches');
  });

  test('un run corriendo cuenta los pasos hechos', () => {
    const lastRun = run({ status: 'running', steps: { a: {}, b: {}, c: {} } as never });
    const v = veredicto(salud({ lastRun }), 16);
    expect(v.tono).toBe('live');
    expect(v.line).toBe('Corriendo ahora — 3 de 16 pasos.');
  });

  test('fallando lo dice sin rodeos', () => {
    expect(veredicto(salud({ work: 'failing' }), 16).tono).toBe('bad');
  });

  test('un pipeline manual y al día no pinta de rojo nada', () => {
    const v = veredicto(salud({ trigger: 'no-trigger', work: 'working' }), 3);
    expect(v.tono).toBe('ok');
    expect(v.line).toContain('mano');
  });

  test('un pipeline con cron y al día no menciona la mano', () => {
    const v = veredicto(salud({ work: 'working' }), 16);
    expect(v.tono).toBe('ok');
    expect(v.line).not.toContain('mano');
  });

  // `disabled` se evalúa antes que `not-installed` en evaluateTrigger porque es
  // el diagnóstico accionable. El veredicto respeta ese orden: el eje de
  // disparo manda sobre el de trabajo cuando nadie lo dispara.
  test('deshabilitado manda sobre lo que diga el eje de trabajo', () => {
    const v = veredicto(salud({ trigger: 'disabled', work: 'working' }), 16);
    expect(v.tono).toBe('bad');
    expect(v.line).toContain('Nadie lo dispara');
  });

  test('no instalado también manda', () => {
    const v = veredicto(salud({ trigger: 'not-installed', work: 'working' }), 16);
    expect(v.tono).toBe('bad');
    expect(v.line).toContain('Nadie lo dispara');
  });

  test('las dos etiquetas de los ejes viajan siempre con el veredicto', () => {
    const v = veredicto(salud({ trigger: 'drifted', work: 'stuck', consecutiveSkips: 2 }), 16);
    expect(v.trigger).toBe('desviado');
    expect(v.work).toBe('atascado');
  });

  test('nunca ha trabajado no es una alarma', () => {
    expect(veredicto(salud({ work: 'never-worked' }), 16).tono).toBe('neutral');
  });
});

describe('resumenPanel', () => {
  test('sin nada que mirar, lo dice y no alarma', () => {
    const r = resumenPanel([salud(), salud({ trigger: 'no-trigger' })], 0);
    expect(r.tono).toBe('ok');
    expect(r.line).toContain('Todo en orden');
  });

  test('una alarma se lleva el titular', () => {
    const r = resumenPanel([salud(), salud({ work: 'silent', contradiction: true })], 0);
    expect(r.tono).toBe('bad');
    expect(r.line).toMatch(/no producen? nada/);
    expect(r.sub).toContain('1 en alarma');
  });

  test('la alarma pesa más que un fallo', () => {
    const r = resumenPanel([salud({ work: 'failing' }), salud({ work: 'silent', contradiction: true })], 0);
    expect(r.line).toMatch(/no producen? nada/);
  });

  test('dos alarmas hablan en plural', () => {
    const dos = [salud({ work: 'silent', contradiction: true }), salud({ work: 'silent', contradiction: true })];
    expect(resumenPanel(dos, 0).line).toBe('2 pipelines están cargados y no producen nada.');
  });

  test('un pipeline atascado sale en el titular aunque no sea alarma', () => {
    const r = resumenPanel([salud({ work: 'stuck', consecutiveSkips: 8 })], 0);
    expect(r.tono).toBe('warn');
    expect(r.line).toContain('sin trabajar');
  });

  test('los pipelines ilegibles se cuentan en el subtítulo', () => {
    expect(resumenPanel([salud()], 1).sub).toContain('1 ilegible');
  });

  test('un panel vacío no finge estar en orden', () => {
    expect(resumenPanel([], 0).tono).toBe('neutral');
  });

  test('si no se puede leer ninguno, lo dice', () => {
    expect(resumenPanel([], 2).tono).toBe('bad');
  });

  test('un run corriendo se menciona cuando todo lo demás está bien', () => {
    const r = resumenPanel([salud({ lastRun: run({ status: 'running' }) })], 0);
    expect(r.line).toContain('corriendo');
  });
});
