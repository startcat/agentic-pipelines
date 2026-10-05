import { describe, expect, test } from 'bun:test';
import { cuando, duracion, dinero, describeCron } from '../../src/web/format.ts';

/**
 * Las fechas se construyen en hora LOCAL, no como cadenas UTC: `cuando` habla
 * en la hora del que mira la pantalla, y fijar "13:42" para un ISO en Z ataría
 * esta tabla al huso de esta máquina.
 */
const local = (y: number, m: number, d: number, h: number, min = 0): Date => new Date(y, m - 1, d, h, min);
const AHORA = local(2026, 8, 31, 13, 56);

describe('cuando', () => {
  test('el mismo día es "hoy" y la hora local', () => {
    expect(cuando(local(2026, 8, 31, 13, 42).toISOString(), AHORA)).toEqual({ day: 'hoy', time: '13:42' });
  });

  test('la hora lleva dos dígitos siempre', () => {
    expect(cuando(local(2026, 8, 31, 3, 0).toISOString(), AHORA).time).toBe('03:00');
  });

  test('el día anterior es "ayer"', () => {
    expect(cuando(local(2026, 8, 30, 1, 0).toISOString(), AHORA).day).toBe('ayer');
  });

  // Dentro de la semana se dice el día; más atrás, la fecha. Un panel que se
  // mira treinta segundos no obliga a contar días hacia atrás.
  test('dentro de la semana da el día de la semana', () => {
    expect(cuando(local(2026, 8, 27, 1, 0).toISOString(), AHORA).day).toBe('jueves');
  });

  test('más atrás da día y mes', () => {
    expect(cuando(local(2026, 8, 19, 12, 9).toISOString(), AHORA).day).toBe('19 ago');
  });

  // 23 h antes puede caer en el mismo día natural, y 25 h antes en "ayer": el
  // corte es por día del calendario, no por división de milisegundos.
  test('el corte es por día natural, no por 24 horas', () => {
    expect(cuando(local(2026, 8, 31, 0, 30).toISOString(), AHORA).day).toBe('hoy');
    expect(cuando(local(2026, 8, 30, 23, 30).toISOString(), AHORA).day).toBe('ayer');
  });

  test('sin fecha no inventa nada', () => {
    expect(cuando(undefined, AHORA)).toEqual({ day: '—', time: '' });
  });

  // `run.json` no se valida al leerlo (RunStore.readRun hace un `as`), así que
  // una fecha corrupta es E/S ordinaria, no un imposible.
  test('una fecha ilegible no revienta', () => {
    expect(cuando('no-es-una-fecha', AHORA)).toEqual({ day: '—', time: '' });
  });
});

describe('duracion', () => {
  test('menos de un minuto va en segundos', () => {
    expect(duracion(14_000)).toBe('14s');
  });

  test('a partir del minuto, minutos y segundos', () => {
    expect(duracion(470_000)).toBe('7m 50s');
  });

  test('cero es cero, no vacío', () => {
    expect(duracion(0)).toBe('0s');
  });

  test('una duración negativa no imprime un menos', () => {
    expect(duracion(-5)).toBe('0s');
  });
});

describe('dinero', () => {
  test('dos decimales con dólar', () => {
    expect(dinero(4.492596500000001)).toBe('$4.49');
  });

  // Un paso `shell` no cuesta nada: la celda se queda vacía, no pone "$0.00".
  test('sin coste es la cadena vacía', () => {
    expect(dinero(undefined)).toBe('');
    expect(dinero(0)).toBe('');
  });
});

describe('describeCron', () => {
  test('la cadencia real de docs se dice en palabras', () => {
    expect(describeCron(['0 3 * * *'])).toBe('cada noche a las 3:00');
  });

  test('una hora diurna no es "noche"', () => {
    expect(describeCron(['30 14 * * *'])).toBe('cada día a las 14:30');
  });

  test('con día de la semana lo dice', () => {
    expect(describeCron(['0 9 * * 1'])).toBe('cada lunes a las 9:00');
  });

  test('sin triggers no hay cadencia', () => {
    expect(describeCron([])).toBe('ninguna, es manual');
  });

  // `cronToCalendarIntervals` lanza con rangos y pasos. Un cron así no se puede
  // INSTALAR, pero sí puede estar escrito en un pipeline.yaml del repo, y el
  // panel es el único sitio pensado para que nada falle en silencio.
  test('un cron que no se sabe traducir se devuelve crudo', () => {
    expect(describeCron(['*/5 * * * *'])).toBe('*/5 * * * *');
  });

  test('un cron con día del mes se devuelve crudo, sin inventar una frase', () => {
    expect(describeCron(['0 3 1 * *'])).toBe('0 3 1 * *');
  });

  test('varios triggers se listan crudos', () => {
    expect(describeCron(['0 3 * * *', '0 15 * * *'])).toBe('0 3 * * * · 0 15 * * *');
  });
});
