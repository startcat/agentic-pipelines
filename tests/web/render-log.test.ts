import { describe, expect, test } from 'bun:test';
import type { RunRecord } from '../../src/runs/types.ts';
import { lineTone } from '../../src/web/render.ts';
import { MAX_LOG_CHARS, renderStepLogPage } from '../../src/web/render-log.ts';

const RUN_ID = '2026-10-19T05-00-04-212Z';
const ORDER = ['prepare', 'review', 'publish', 'notify'];

const step = (id: string, over: Record<string, unknown> = {}) => ({
  id, status: 'success', startedAt: '2026-10-19T05:00:04.212Z', durationMs: 6_000,
  outputs: {}, effects: [], attempts: 1, ...over,
});

const RUN = {
  id: RUN_ID, pipeline: 'docs-drift', pipelineVersion: 1, status: 'success',
  startedAt: '2026-10-19T05:00:04.212Z', params: {},
  steps: Object.fromEntries(ORDER.map((id) => [id, step(id)])),
} as unknown as RunRecord;

/** A sample log of 14 lines: a JSON blob, a warning and a summary. */
const LOG = [
  '{',
  ...Array.from({ length: 10 }, (_, i) => `  "key${i}": "${'x'.repeat(90)}",`),
  '}',
  'warning: CONTRIBUTING.md not found in acme/api',
].join('\n') + '\nacme/api main at f3b8d07c2a91: 3 doc file(s), changed=true\n';

function page(over: Partial<Parameters<typeof renderStepLogPage>[0]> = {}): string {
  return renderStepLogPage({
    pipeline: 'docs-drift', run: RUN, stepId: 'prepare', type: 'shell', order: ORDER, text: LOG, truncated: false, ...over,
  });
}

describe('renderStepLogPage', () => {
  test('the trail goes back to the run, and the step is where you are', () => {
    const html = page();
    expect(html).toContain('<a href="/">Overview</a>');
    expect(html).toContain('<a href="/p/docs-drift" class="up">docs-drift</a>');
    expect(html).toContain(`<a href="/p/docs-drift/runs/${RUN_ID}" class="up">${RUN_ID}</a>`);
    expect(html).toContain('<span class="sep">/</span><span>prepare</span></div>');
  });

  test('the title is the step, its type chip and where it sits in the run', () => {
    const html = page();
    expect(html).toContain('<h1>prepare</h1><span class="kind">shell</span><span class="tkind">step 1 of 4</span>');
    expect(page({ stepId: 'review', type: 'agent' })).toContain('<span class="kind agent">agent</span><span class="tkind">step 2 of 4</span>');
    // Without the YAML there is no type to show, and no empty chip either.
    expect(page({ type: undefined })).not.toContain('class="kind');
  });

  test('the state, with its glyph and how long it took', () => {
    expect(page()).toContain('<div class="bigline s-success">✓ success · 6s</div>');
  });

  test('a failed step says so in the bad tone, with its error underneath, escaped', () => {
    const run = { ...RUN, steps: { ...RUN.steps, prepare: step('prepare', { status: 'failed', durationMs: 2_000, error: 'exit 1: <boom>' }) } } as RunRecord;
    const html = page({ run });
    expect(html).toContain('<div class="bigline s-failed">✕ failed · 2s</div>');
    expect(html).toContain('<div class="bigwhy">exit 1: &lt;boom&gt;</div>');
  });

  test('a skipped step says why, and no duration', () => {
    const run = { ...RUN, steps: { ...RUN.steps, prepare: step('prepare', { status: 'skipped', durationMs: 0, skipReason: 'shell: "test -f x" returned 1' }) } } as RunRecord;
    const html = page({ run });
    expect(html).toContain('<div class="bigline s-skipped">– skipped</div>');
    expect(html).toContain('<div class="bigwhy">shell: &quot;test -f x&quot; returned 1</div>');
  });

  test('a step that is not an object in run.json still gets a page', () => {
    const run = { ...RUN, steps: { ...RUN.steps, prepare: 5 } } as unknown as RunRecord;
    const html = page({ run });
    expect(html).toContain('<h1>prepare</h1>');
    expect(html).not.toContain('class="bigline');
  });

  test('the first step has no previous; the next one is a link', () => {
    const html = page();
    expect(html).toContain('<span class="none"><span class="arr">←</span> previous: none</span>');
    expect(html).toContain(
      `<a href="/p/docs-drift/runs/${RUN_ID}/review"><span class="lbl">next:</span> <span class="nstep">review</span> <span class="arr">→</span></a>`,
    );
  });

  test('the last step the other way round', () => {
    const html = page({ stepId: 'notify' });
    expect(html).toContain(
      `<a href="/p/docs-drift/runs/${RUN_ID}/publish"><span class="arr">←</span> <span class="lbl">previous:</span> <span class="nstep">publish</span></a>`,
    );
    expect(html).toContain('<span class="none">next: none <span class="arr">→</span></span>');
    expect(html).toContain('step 4 of 4');
  });

  test('what the log is, how many lines and how big', () => {
    const html = page();
    expect(html).toContain('stdout and stderr, as the step wrote them · <span id="logcount"');
    expect(html).toMatch(/>14 lines · 1\.1 KB<\/span>/);
  });

  test('the full log as plain text is always linked, truncated or not', () => {
    const raw = `href="/p/docs-drift/runs/${RUN_ID}/prepare?raw=1"`;
    expect(page()).toContain(raw);
    expect(page()).toContain('Full log as plain text ↗');
  });

  test('one element per line, numbered by the stylesheet', () => {
    const html = page();
    const log = /<pre id="log"[^>]*>([\s\S]*?)<\/pre>/.exec(html)?.[1] ?? '';
    expect(log.match(/<span[ >]/g)?.length).toBe(14);
    expect(log.startsWith('<span>{</span><span>  &quot;key0&quot;')).toBe(true);
    // No text between the lines: inside a <pre>, a newline there would be a blank line.
    expect(log).not.toContain('</span>\n');
    expect(html).toContain('style="counter-reset: ln 0;');
  });

  test('warnings in amber, errors in the bad tone, the rest plain', () => {
    const html = page({ text: 'ok\nwarning: careful\n  WARN: indented\nerror: broke\nfatal oops\nerrors: 0\n' });
    expect(html).toContain('<span>ok</span>');
    expect(html).toContain('<span class="warn">warning: careful</span>');
    expect(html).toContain('<span class="warn">  WARN: indented</span>');
    expect(html).toContain('<span class="bad">error: broke</span>');
    expect(html).toContain('<span class="bad">fatal oops</span>');
    expect(html).toContain('<span>errors: 0</span>');
  });

  test('the content is escaped', () => {
    const html = page({ text: 'output: <b>bold</b> & "q"\n' });
    expect(html).toContain('<span>output: &lt;b&gt;bold&lt;/b&gt; &amp; &quot;q&quot;</span>');
    expect(html).not.toContain('<b>bold');
  });

  test('a last line without its newline is drawn and left open for the live view', () => {
    const html = page({ text: 'one\ntwo' });
    expect(html).toContain('<span>one</span><span>two</span></pre>');
    expect(html).toContain('data-open="1"');
    expect(page({ text: 'one\n' })).toContain('data-open="0"');
  });

  test('an empty log says so instead of an empty box', () => {
    const html = page({ text: '' });
    expect(html).toContain('0 lines · 0 B');
    expect(html).toContain('<p class="lognone">This step left no log.</p>');
  });

  test('truncated: the tail, numbered from its real line, with the note above', () => {
    // 30,000 lines of 9 digits + newline: 300,000 characters, over the cap.
    const lines = Array.from({ length: 30_000 }, (_, i) => String(i + 1).padStart(9, '0'));
    const text = `${lines.join('\n')}\n`;
    expect(text.length).toBeGreaterThan(MAX_LOG_CHARS);
    const html = page({ text, truncated: true });
    expect(html).toContain('30,000 lines');
    const at = html.indexOf('Showing the tail.');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(html.indexOf('<pre id="log"'));
    const log = /<pre id="log"([^>]*)>([\s\S]*?)<\/pre>/.exec(html)!;
    // The cut lands on a line boundary, and the counter starts where the raw
    // log would: the first line shown is line N, so the counter is reset to N - 1.
    const body = log[2]!;
    const first = Number(/^<span>(\d+)<\/span>/.exec(body)![1]);
    expect(log[1]).toContain(`counter-reset: ln ${first - 1};`);
    expect(body.endsWith('<span>000030000</span>')).toBe(true);
    // 200,000 characters of 10-character lines: the last 20,000 lines.
    expect(first).toBe(10_001);
  });
});

describe('lineTone', () => {
  test('warning/warn and error/fatal, at the start, any case; nothing else', () => {
    expect(lineTone('warning: x')).toBe('warn');
    expect(lineTone('Warn x')).toBe('warn');
    expect(lineTone('   ERROR: x')).toBe('bad');
    expect(lineTone('fatal: x')).toBe('bad');
    expect(lineTone('warnings: 2')).toBe('');
    expect(lineTone('no error: here')).toBe('');
  });
});
