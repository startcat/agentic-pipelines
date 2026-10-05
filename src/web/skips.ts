/**
 * Agrupa saltos consecutivos que comparten guarda. Módulo PURO.
 *
 * El motivo de existir: diez noches saltadas se pintaban como diez párrafos con
 * el mismo grep de doscientos caracteres. El HECHO es "ocho noches, misma
 * guarda"; repetirlo ocho veces no informa, tapa.
 */
import type { RunRecord } from '../runs/types.ts';

/**
 * La parte ESTABLE del motivo: el motivo menos su paréntesis final.
 *
 * `throttle: 46h (última ejecución hace 2211 min)` y `(… hace 771 min)` son el
 * mismo hecho con dos cifras distintas, y agrupar por el motivo entero los
 * dejaría separados. El `$` ancla al final A PROPÓSITO: una guarda `shell`
 * lleva paréntesis DENTRO del comando (`\(ca\)`) que no se pueden tocar.
 */
export function guardaDe(skipReason: string | undefined): string {
  if (skipReason === undefined) return '';
  return skipReason.replace(/\s*\([^)]*\)\s*$/, '');
}

export type Tramo =
  | { kind: 'run'; run: RunRecord }
  | { kind: 'saltos'; runs: RunRecord[]; guarda: string };

/** Mínimo de saltos seguidos para colapsarlos. Con uno solo el bloque ocuparía
 *  más que la fila que sustituye. */
const MINIMO = 2;

export function agrupaHistorial(runs: readonly RunRecord[]): Tramo[] {
  const tramos: Tramo[] = [];
  let i = 0;

  while (i < runs.length) {
    const actual = runs[i]!;
    if (actual.status !== 'skipped') {
      tramos.push({ kind: 'run', run: actual });
      i += 1;
      continue;
    }

    // Una racha se extiende mientras el siguiente run sea un salto CON LA MISMA
    // guarda. Un run que trabajó en medio la corta: dos saltos separados por
    // una noche buena no son ocho noches seguidas, y decirlo sería mentir.
    const guarda = guardaDe(actual.skipReason);
    let fin = i + 1;
    while (fin < runs.length) {
      const siguiente = runs[fin]!;
      if (siguiente.status !== 'skipped' || guardaDe(siguiente.skipReason) !== guarda) break;
      fin += 1;
    }

    const racha = runs.slice(i, fin);
    if (racha.length >= MINIMO) tramos.push({ kind: 'saltos', runs: racha, guarda });
    else for (const r of racha) tramos.push({ kind: 'run', run: r });
    i = fin;
  }

  return tramos;
}
