import { describe, expect, test } from 'bun:test';
import type { CostReport } from '../../src/web/costs.ts';
import { renderCostsPage } from '../../src/web/render-costs.ts';

const NOW = new Date(2026, 9, 28, 12);

function report(over: Partial<CostReport> = {}): CostReport {
  return {
    month: { label: 'October', total: 4.08, day: 28, days: 31, projected: 4.52, runs: 92, withAgent: 36 },
    previous: { label: 'September', total: 4.86 },
    lastSix: ['May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'].map((label, i) => ({ label, total: i, current: i === 5 })),
    byDay: Array.from({ length: 31 }, (_, i) => ({ day: i + 1, total: i < 28 ? 0.1 : 0, future: i >= 28 })),
    heavyWeekday: { weekday: 'Monday', pipeline: 'docs-drift' },
    byPipeline: [
      { name: 'news-digest', runs: 28, perRun: 0.06, total: 1.81 },
      { name: 'site-checks', runs: 28, total: 0 },
    ],
    priciest: [
      {
        pipeline: 'docs-drift', id: '2026-10-05T07-00-00-000Z', startedAt: new Date(2026, 9, 5, 7).toISOString(),
        status: 'success', costUsd: 0.41, withAgent: true,
      },
    ],
    ...over,
  };
}

describe('renderCostsPage', () => {
  test('the figures of the month, with $0.00 spelled out', () => {
    const html = renderCostsPage(report({ previous: { label: 'September', total: 0 } }), NOW);
    expect(html).toContain('Costs');
    expect(html).toContain('$4.08');
    expect(html).toContain('~$4.52');
    expect(html).toContain('28 of 31 days');
    expect(html).toContain('September');
    expect(html).toMatch(/September[\s\S]*?\$0\.00/);
  });

  test('without a projection the "at this pace" figure is not drawn', () => {
    const r = report();
    delete r.month.projected;
    const html = renderCostsPage(r, NOW);
    expect(html).not.toContain('At this pace');
    expect(html).not.toContain('~$');
  });

  test('the escaped pipeline name, in the table and among the runs', () => {
    const r = report({
      byPipeline: [{ name: '<x>', runs: 1, perRun: 0.2, total: 0.2 }],
      priciest: [{ ...report().priciest[0]!, pipeline: '<x>' }],
    });
    const html = renderCostsPage(r, NOW);
    expect(html).not.toContain('<x>');
    expect(html).toContain('&lt;x&gt;');
  });

  test('the priciest runs link to their page', () => {
    const r = report({ priciest: [{ ...report().priciest[0]!, pipeline: 'a b', id: 'r/1' }] });
    expect(renderCostsPage(r, NOW)).toContain('href="/p/a%20b/runs/r%2F1"');
  });

  test('a pipeline that cost nothing shows — per run, $0.00 and is dimmed', () => {
    const html = renderCostsPage(report(), NOW);
    const row = html.slice(html.indexOf('site-checks') - 200, html.indexOf('site-checks') + 400);
    expect(row).toContain('zero');
    expect(row).toContain('—');
    expect(row).toContain('$0.00');
  });

  test('the heavy weekday note, only when there is one', () => {
    expect(renderCostsPage(report(), NOW)).toContain('Mondays weigh more: docs-drift');
    expect(renderCostsPage(report({ heavyWeekday: undefined }), NOW)).not.toContain('weigh more');
  });

  test('today is outlined, the days to come are empty, and the axis names today and the last day', () => {
    const html = renderCostsPage(report(), NOW);
    expect(html.match(/class="cday today"/g)).toHaveLength(1);
    expect(html.match(/class="cday future"/g)).toHaveLength(3);
    const axis = html.slice(html.indexOf('class="caxis"'), html.indexOf('class="clegend"'));
    const ticks = [...axis.matchAll(/<span>(\d+)<\/span>/g)].map((m) => Number(m[1]));
    expect(ticks).toEqual([1, 5, 12, 19, 26, 28, 31]);
  });

  test('a tick is not repeated when today is one of them', () => {
    const r = report();
    const html = renderCostsPage({ ...r, month: { ...r.month, day: 26 } }, new Date(2026, 9, 26, 12));
    const axis = html.slice(html.indexOf('class="caxis"'), html.indexOf('class="clegend"'));
    expect([...axis.matchAll(/<span>(\d+)<\/span>/g)].map((m) => Number(m[1]))).toEqual([1, 5, 12, 19, 26, 31]);
  });

  test('with nothing spent there is a line instead of an empty runs list', () => {
    expect(renderCostsPage(report({ priciest: [] }), NOW)).toContain('No run cost anything in October yet.');
  });

  test('the closing note says what is not counted', () => {
    expect(renderCostsPage(report(), NOW)).toContain('Only what agent steps measure counts here');
  });
});
