import { describe, expect, test } from 'bun:test';
import { STYLES } from '../../src/web/styles.ts';
import { layout } from '../../src/web/render.ts';

const COLOR_TOKENS = ['--bg', '--ink', '--dim', '--faint', '--rule', '--ok', '--warn', '--bad', '--live'];

describe('STYLES', () => {
  // The constraint easiest to break by accident: a single `@import` or
  // `url()` makes the viewer stop working offline, and the engine has no
  // frontend dependencies and won't get any.
  test('brings in no font or outside resource', () => {
    expect(STYLES).not.toContain('@import');
    expect(STYLES).not.toContain('http://');
    expect(STYLES).not.toContain('https://');
    expect(STYLES).not.toContain('url(');
  });

  test('both families are system stacks', () => {
    expect(STYLES).toContain('ui-monospace');
    expect(STYLES).toContain('-apple-system');
  });

  test('defines every color token in :root', () => {
    const root = STYLES.slice(0, STYLES.indexOf('@media'));
    for (const token of COLOR_TOKENS) expect(root).toContain(`${token}:`);
  });

  // A token defined ONLY inside the media query leaves the other theme without it.
  test('the light theme redefines tokens, it does not introduce them', () => {
    const light = STYLES.slice(STYLES.indexOf('prefers-color-scheme: light'));
    for (const token of COLOR_TOKENS) expect(light).toContain(`${token}:`);
  });

  // Dark by default: the scene includes looking at this at three in the morning.
  test('the scheme declares dark first', () => {
    expect(STYLES).toContain('color-scheme: dark light');
  });

  test('layout still emits the stylesheet', () => {
    expect(layout('t', '')).toContain('--ok:');
  });
});
