import { describe, expect, test } from 'bun:test';
import { STYLES } from '../../src/web/styles.ts';
import { layout } from '../../src/web/render.ts';

const COLOR_TOKENS = [
  '--bg', '--surface', '--well', '--rule', '--hair', '--ink', '--dim', '--faint',
  '--accent', '--bad-ink', '--ok', '--warn', '--live', '--empty',
];

const CHROME = { port: 7717, repoRoot: '/home/u/repo', home: '/home/u', scheduler: 'launchd' };

describe('STYLES', () => {
  // The constraint easiest to break by accident: a single `@import` or a
  // `url()` to a CDN makes the viewer stop working offline. The fonts are
  // served by the viewer itself, so the only `url()` allowed is one under
  // `/fonts/` (which `server.test.ts` checks is really served).
  test('brings in no outside resource', () => {
    expect(STYLES).not.toContain('@import');
    expect(STYLES).not.toContain('http://');
    expect(STYLES).not.toContain('https://');
    const urls = [...STYLES.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url).toMatch(/^"\/fonts\/[a-z0-9-]+\.woff2"$/);
  });

  test('the three families are declared locally, each with a system fallback', () => {
    for (const family of ['"Young Serif"', '"Lexend"', '"Azeret Mono"']) {
      expect(STYLES).toContain(`font-family: ${family};`);
    }
    expect(STYLES).toContain('ui-monospace');
    expect(STYLES).toContain('system-ui');
  });

  // Azeret Mono ships an "fi" ligature that draws a dotless i: "docs-drift"
  // would read "docs-drıft". In a face reserved for literal machine strings,
  // a ligature is a typo.
  test('the monospace has its ligatures off', () => {
    expect(STYLES).toContain('"liga" 0');
  });

  test('defines every color token in :root', () => {
    const root = STYLES.slice(0, STYLES.indexOf('@media'));
    for (const token of COLOR_TOKENS) expect(root).toContain(`${token}:`);
  });

  // A token defined ONLY inside the media query leaves the other theme without it.
  test('the light theme redefines tokens, it does not introduce them', () => {
    expect(STYLES).toContain('prefers-color-scheme: light');
    const light = STYLES.slice(STYLES.indexOf('prefers-color-scheme: light'));
    for (const token of COLOR_TOKENS) expect(light).toContain(`${token}:`);
  });

  // Dark by default: the scene includes looking at this at three in the morning.
  test('the scheme declares dark first', () => {
    expect(STYLES).toContain('color-scheme: dark light');
  });

  test('layout still emits the stylesheet', () => {
    expect(layout('t', '', CHROME)).toContain('--ok:');
  });

  // In the design the healthy headline is ink, not green. The sheet has a bare .ok
  // rule that paints any element with that class green, so the headline needs
  // its own, more specific rule — without it "All in order." came out green.
  test('the healthy headline is ink, the empty one dim', () => {
    expect(STYLES).toMatch(/\.headline\.ok \{ color: var\(--ink\); \}/);
    expect(STYLES).toMatch(/\.headline\.neutral \{ color: var\(--dim\); \}/);
  });
});
