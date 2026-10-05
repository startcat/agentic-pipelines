import { describe, expect, test } from 'bun:test';
import type { RunRecord } from '../../src/runs/types.ts';
import { guardaDe, agrupaHistorial } from '../../src/web/skips.ts';

// El motivo real de los ocho saltos del 22 al 29 de agosto, con sus paréntesis
// DENTRO del comando: son los que no se pueden recortar.
const GREP =
  'shell: "grep -qE "^\\| Slug \\(ca\\)\\s+\\| Estat\\s+" {{params.docs_repo}}/scripts/x.md" devolvió 1';

function run(dia: string, status: RunRecord['status'], skipReason?: string): RunRecord {
  return {
    id: `2026-08-${dia}T01-00-00-000Z`,
    pipeline: 'demo', pipelineVersion: 1, status,
    startedAt: `2026-08-${dia}T01:00:00.000Z`, params: {}, steps: {},
    ...(skipReason === undefined ? {} : { skipReason }),
  };
}

describe('guardaDe', () => {
  // Los dos saltos por throttle traen minutos distintos en el paréntesis. Si la
  // clave fuera el motivo entero no agruparían, y son el mismo hecho.
  test('el paréntesis final variable no forma parte de la guarda', () => {
    expect(guardaDe('throttle: 46h (última ejecución hace 2211 min)')).toBe('throttle: 46h');
    expect(guardaDe('throttle: 46h (última ejecución hace 771 min)')).toBe('throttle: 46h');
  });

  test('dos throttles con minutos distintos son la misma guarda', () => {
    expect(guardaDe('throttle: 46h (hace 2211 min)')).toBe(guardaDe('throttle: 46h (hace 771 min)'));
  });

  // Un comando shell lleva paréntesis propios que NO se pueden tocar: solo se
  // recorta el paréntesis final, y este motivo no acaba en uno.
  test('una guarda shell se queda entera, paréntesis internos incluidos', () => {
    expect(guardaDe(GREP)).toBe(GREP);
    expect(guardaDe(GREP)).toContain('\\(ca\\)');
  });

  test('sin motivo no hay guarda', () => {
    expect(guardaDe(undefined)).toBe('');
  });
});

describe('agrupaHistorial', () => {
  test('un historial vacío da una lista vacía', () => {
    expect(agrupaHistorial([])).toEqual([]);
  });

  test('sin saltos no agrupa nada', () => {
    const runs = [run('31', 'success'), run('30', 'failed')];
    expect(agrupaHistorial(runs).map((t) => t.kind)).toEqual(['run', 'run']);
  });

  // Un bloque para un solo salto ocuparía más que la fila que sustituye.
  test('un salto suelto sigue siendo una fila', () => {
    const tramos = agrupaHistorial([run('31', 'success'), run('30', 'skipped', GREP)]);
    expect(tramos.map((t) => t.kind)).toEqual(['run', 'run']);
  });

  // El caso real: 22 → 29 de agosto, ocho noches con el mismo grep.
  test('dos o más saltos seguidos con la misma guarda se agrupan', () => {
    const runs = [
      run('31', 'success'),
      run('29', 'skipped', GREP), run('28', 'skipped', GREP), run('27', 'skipped', GREP),
      run('19', 'success'),
    ];
    const tramos = agrupaHistorial(runs);
    expect(tramos.map((t) => t.kind)).toEqual(['run', 'saltos', 'run']);
    const bloque = tramos[1];
    if (bloque?.kind !== 'saltos') throw new Error('se esperaba un bloque de saltos');
    expect(bloque.runs).toHaveLength(3);
    expect(bloque.guarda).toBe(GREP);
  });

  test('dos guardas distintas no se mezclan en un bloque', () => {
    const runs = [
      run('29', 'skipped', GREP), run('28', 'skipped', GREP),
      run('21', 'skipped', 'throttle: 46h (última ejecución hace 2211 min)'),
      run('20', 'skipped', 'throttle: 46h (última ejecución hace 771 min)'),
    ];
    const tramos = agrupaHistorial(runs);
    expect(tramos.map((t) => t.kind)).toEqual(['saltos', 'saltos']);
    const segundo = tramos[1];
    if (segundo?.kind !== 'saltos') throw new Error('se esperaba un bloque de saltos');
    expect(segundo.guarda).toBe('throttle: 46h');
  });

  // Un run que trabajó entre dos saltos parte la racha: no son consecutivos.
  test('un run que no es salto corta la racha', () => {
    const runs = [
      run('29', 'skipped', GREP), run('28', 'success'), run('27', 'skipped', GREP),
    ];
    expect(agrupaHistorial(runs).map((t) => t.kind)).toEqual(['run', 'run', 'run']);
  });

  test('ningún run se pierde ni se duplica al agrupar', () => {
    const runs = [
      run('31', 'success'),
      run('29', 'skipped', GREP), run('28', 'skipped', GREP), run('27', 'skipped', GREP),
      run('21', 'skipped', 'throttle: 46h (hace 2211 min)'),
      run('20', 'skipped', 'throttle: 46h (hace 771 min)'),
      run('19', 'success'),
    ];
    const vistos = agrupaHistorial(runs).flatMap((t) => (t.kind === 'run' ? [t.run] : t.runs));
    expect(vistos.map((r) => r.id)).toEqual(runs.map((r) => r.id));
  });

  test('un historial entero de saltos iguales es un solo bloque', () => {
    const runs = ['29', '28', '27'].map((d) => run(d, 'skipped', GREP));
    const tramos = agrupaHistorial(runs);
    expect(tramos).toHaveLength(1);
    expect(tramos[0]?.kind).toBe('saltos');
  });

  test('un salto sin motivo agrupa con otro salto sin motivo', () => {
    const runs = [run('29', 'skipped'), run('28', 'skipped')];
    const tramos = agrupaHistorial(runs);
    expect(tramos).toHaveLength(1);
    expect(tramos[0]?.kind).toBe('saltos');
  });
});
