import { describe, expect, test } from 'bun:test';
import { STYLES } from '../../src/web/styles.ts';
import { layout } from '../../src/web/render.ts';

const TOKENS_DE_COLOR = ['--bg', '--ink', '--dim', '--faint', '--rule', '--ok', '--warn', '--bad', '--live'];

describe('STYLES', () => {
  // La restricción que más fácil se rompe sin querer: basta un `@import` o un
  // `url()` para que el visor deje de funcionar sin red, y el motor no tiene
  // dependencias de frontend ni las va a tener.
  test('no trae ni una fuente ni un recurso de fuera', () => {
    expect(STYLES).not.toContain('@import');
    expect(STYLES).not.toContain('http://');
    expect(STYLES).not.toContain('https://');
    expect(STYLES).not.toContain('url(');
  });

  test('las dos familias son pilas del sistema', () => {
    expect(STYLES).toContain('ui-monospace');
    expect(STYLES).toContain('-apple-system');
  });

  test('define todos los tokens de color en :root', () => {
    const raiz = STYLES.slice(0, STYLES.indexOf('@media'));
    for (const token of TOKENS_DE_COLOR) expect(raiz).toContain(`${token}:`);
  });

  // Un token definido SOLO dentro de la media query deja el otro tema sin él.
  test('el tema claro redefine tokens, no los estrena', () => {
    const claro = STYLES.slice(STYLES.indexOf('prefers-color-scheme: light'));
    for (const token of TOKENS_DE_COLOR) expect(claro).toContain(`${token}:`);
  });

  // Oscuro por defecto: la escena incluye mirar esto a las tres de la mañana.
  test('el esquema declara oscuro primero', () => {
    expect(STYLES).toContain('color-scheme: dark light');
  });

  test('layout sigue emitiendo la hoja', () => {
    expect(layout('t', '')).toContain('--ok:');
  });
});
