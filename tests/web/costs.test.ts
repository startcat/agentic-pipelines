import { describe, expect, test } from 'bun:test';
import { costReport, costRunsOf, spendOf, type CostRun } from '../../src/web/costs.ts';
import type { RunRecord } from '../../src/runs/types.ts';

/**
 * Dates are built in LOCAL time, same as in format.test.ts: the page speaks in
 * the calendar of whoever looks at it, so a run at 00:30 on the 1st belongs to
 * that month here even if in UTC it is still the previous one.
 */
const local = (y: number, m: number, d: number, h = 7): Date => new Date(y, m - 1, d, h);
const NOW = local(2026, 10, 28, 12);

let seq = 0;
function run(pipeline: string, at: Date, costUsd: number, extra: Partial<CostRun> = {}): CostRun {
  seq += 1;
  return {
    pipeline,
    id: `run-${seq}`,
    startedAt: at.toISOString(),
    status: 'success',
    costUsd,
    withAgent: costUsd > 0,
    ...extra,
  };
}

describe('costReport — the month', () => {
  test('sums the current month to date and the previous one, and nothing older', () => {
    const report = costReport(
      [
        run('a', local(2026, 10, 1), 1),
        run('a', local(2026, 10, 27), 0.5),
        run('b', local(2026, 9, 30), 2),
        run('b', local(2026, 9, 1), 0.25),
        run('b', local(2026, 8, 15), 9),
      ],
      ['a', 'b'],
      NOW,
    );
    expect(report.month.label).toBe('October');
    expect(report.month.total).toBeCloseTo(1.5);
    expect(report.month.day).toBe(28);
    expect(report.month.days).toBe(31);
    expect(report.previous).toEqual({ label: 'September', total: 2.25 });
  });

  test('counts the runs of the month and how many had an agent', () => {
    const report = costReport(
      [
        run('a', local(2026, 10, 2), 0.3),
        run('a', local(2026, 10, 3), 0, { withAgent: true }),
        run('a', local(2026, 10, 4), 0),
        run('a', local(2026, 9, 4), 1),
      ],
      ['a'],
      NOW,
    );
    expect(report.month.runs).toBe(3);
    expect(report.month.withAgent).toBe(2);
  });

  test('the projection is total / day * days of the month', () => {
    const report = costReport([run('a', local(2026, 10, 3), 2.8)], ['a'], NOW);
    expect(report.month.projected).toBeCloseTo((2.8 / 28) * 31);
  });

  // One day is not a pace.
  test('on the 1st there is no projection', () => {
    const report = costReport([run('a', local(2026, 10, 1, 6), 2)], ['a'], local(2026, 10, 1, 12));
    expect(report.month.projected).toBeUndefined();
  });
});

describe('costReport — the last six months', () => {
  test('six entries, oldest first, current only on the last, across the turn of the year', () => {
    const now = local(2027, 2, 10);
    const report = costReport(
      [run('a', local(2026, 12, 24), 1.25), run('a', local(2027, 2, 3), 0.5), run('a', local(2026, 8, 31), 7)],
      ['a'],
      now,
    );
    expect(report.lastSix.map((m) => m.label)).toEqual(['Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb']);
    expect(report.lastSix.map((m) => m.current)).toEqual([false, false, false, false, false, true]);
    expect(report.lastSix.map((m) => m.total)).toEqual([0, 0, 0, 1.25, 0, 0.5]);
    expect(report.previous).toEqual({ label: 'January', total: 0 });
  });
});

describe('costReport — by day', () => {
  test('one entry per day of the month, future from tomorrow on', () => {
    const report = costReport(
      [run('a', local(2026, 10, 5), 0.4), run('b', local(2026, 10, 5, 22), 0.1), run('a', local(2026, 10, 28), 0.2)],
      ['a', 'b'],
      NOW,
    );
    expect(report.byDay).toHaveLength(31);
    expect(report.byDay[0]).toEqual({ day: 1, total: 0, future: false });
    expect(report.byDay[4]!.total).toBeCloseTo(0.5);
    expect(report.byDay[27]).toEqual({ day: 28, total: 0.2, future: false });
    expect(report.byDay[28]!.future).toBe(true);
    expect(report.byDay[30]).toEqual({ day: 31, total: 0, future: true });
  });

  test('a short month has as many entries as days', () => {
    const report = costReport([], [], local(2027, 2, 10));
    expect(report.byDay).toHaveLength(28);
    expect(report.month.days).toBe(28);
  });
});

describe('costReport — the heavy weekday', () => {
  // October 2026: the 5th, 12th, 19th and 26th are Mondays.
  test('present when one weekday carries at least 40 % of the month, naming its top pipeline', () => {
    const runs = [
      ...[5, 12, 19, 26].map((d) => run('docs-drift', local(2026, 10, d), 0.35)),
      run('news-digest', local(2026, 10, 12), 0.05),
      ...[6, 7, 8, 9, 13, 14, 15].map((d) => run('news-digest', local(2026, 10, d), 0.1)),
    ];
    const report = costReport(runs, ['docs-drift', 'news-digest'], NOW);
    expect(report.heavyWeekday).toEqual({ weekday: 'Monday', pipeline: 'docs-drift' });
  });

  test('absent when the cost is spread over the week', () => {
    const runs = [5, 6, 7, 8, 9, 10, 11].map((d) => run('a', local(2026, 10, d), 0.1));
    expect(costReport(runs, ['a'], NOW).heavyWeekday).toBeUndefined();
  });

  test('absent when nothing cost anything', () => {
    expect(costReport([run('a', local(2026, 10, 5), 0)], ['a'], NOW).heavyWeekday).toBeUndefined();
  });
});

describe('costReport — by pipeline', () => {
  test('sorted by total, including pipelines with no runs this month', () => {
    const report = costReport(
      [
        run('cheap', local(2026, 10, 2), 0.1),
        run('dear', local(2026, 10, 2), 0.6),
        run('dear', local(2026, 10, 3), 0.4),
        run('dear', local(2026, 10, 4), 0),
        run('shell', local(2026, 10, 2), 0),
        run('shell', local(2026, 10, 3), 0),
        run('idle', local(2026, 9, 3), 3),
      ],
      ['cheap', 'dear', 'idle', 'shell'],
      NOW,
    );
    expect(report.byPipeline.map((p) => p.name)).toEqual(['dear', 'cheap', 'shell', 'idle']);
    // The average is over the runs that cost something, not over all of them:
    // a skipped run would otherwise make an agent pipeline look cheaper.
    expect(report.byPipeline[0]).toEqual({ name: 'dear', runs: 3, perRun: 0.5, total: 1 });
    expect(report.byPipeline[2]).toEqual({ name: 'shell', runs: 2, total: 0 });
    expect(report.byPipeline[3]).toEqual({ name: 'idle', runs: 0, total: 0 });
    expect(report.byPipeline[2]!.perRun).toBeUndefined();
  });
});

describe('costReport — the priciest runs', () => {
  test('the five most expensive of the month, most expensive first', () => {
    const costs = [0.1, 0.7, 0.3, 0.5, 0.2, 0.6, 0.4];
    const runs = costs.map((c, i) => run('a', local(2026, 10, i + 1), c));
    runs.push(run('a', local(2026, 9, 3), 5));
    const report = costReport(runs, ['a'], NOW);
    expect(report.priciest.map((r) => r.costUsd)).toEqual([0.7, 0.6, 0.5, 0.4, 0.3]);
  });

  test('a run that cost nothing is not among the priciest', () => {
    const report = costReport([run('a', local(2026, 10, 2), 0)], ['a'], NOW);
    expect(report.priciest).toEqual([]);
  });
});

describe('costRunsOf', () => {
  const base = {
    pipeline: 'p', pipelineVersion: 1, status: 'success', params: {},
  } as const;

  // `RunStore.readRun` parses `run.json` with an `as` and no validation: every
  // field here can be anything.
  test('survives a corrupt startedAt, a non-numeric cost and missing steps', () => {
    const runs = [
      { ...base, id: 'bad-date', startedAt: 'yesterday-ish', steps: {}, totalCostUsd: 1 },
      { ...base, id: 'no-date', steps: {} },
      { ...base, id: 'x-cost', startedAt: local(2026, 10, 2).toISOString(), totalCostUsd: 'x' },
      {
        ...base, id: 'agent', startedAt: local(2026, 10, 3).toISOString(), totalCostUsd: 0.42,
        steps: { s: { id: 's', costUsd: 0.42 } },
      },
      { ...base, id: 'null-steps', startedAt: local(2026, 10, 4).toISOString(), steps: null },
    ] as unknown as RunRecord[];

    const out = costRunsOf(runs);
    expect(out.map((r) => r.id)).toEqual(['x-cost', 'agent', 'null-steps']);
    expect(out[0]).toMatchObject({ costUsd: 0, withAgent: false });
    expect(out[1]).toMatchObject({ pipeline: 'p', status: 'success', costUsd: 0.42, withAgent: true });
    expect(out[2]).toMatchObject({ costUsd: 0, withAgent: false });
  });

  test('a step whose costUsd is not a number does not make the run an agent run', () => {
    const runs = [
      { ...base, id: 'r', startedAt: local(2026, 10, 3).toISOString(), steps: { s: { id: 's', costUsd: '0.1' } } },
    ] as unknown as RunRecord[];
    expect(costRunsOf(runs)[0]!.withAgent).toBe(false);
  });

  // Only a corrupt file has a negative cost; it would draw a bar downwards.
  test('a negative cost counts as nothing', () => {
    const runs = [
      { ...base, id: 'neg', startedAt: local(2026, 10, 3).toISOString(), totalCostUsd: -4 },
    ] as unknown as RunRecord[];
    expect(costRunsOf(runs)[0]!.costUsd).toBe(0);
  });
});

describe('spendOf — the dashboard strip', () => {
  const runs = [
    run('a', local(2026, 10, 2), 1.25),
    run('b', local(2026, 10, 27), 0.5),
    run('b', local(2026, 10, 27), 0, { withAgent: false }),
    run('a', local(2026, 9, 30), 2),
    run('a', local(2026, 8, 30), 9),
  ];

  test('this month and the previous one, and nothing older', () => {
    expect(spendOf(runs, NOW)).toEqual({
      month: { label: 'October', total: 1.75, runs: 3, withAgent: 2 },
      previous: { label: 'September', total: 2 },
    });
  });

  // The strip links to /costs: both must print the same cents.
  test('says exactly what costReport says for the same months', () => {
    const report = costReport(runs, ['a', 'b'], NOW);
    const { label, total, runs: count, withAgent } = report.month;
    expect(spendOf(runs, NOW)).toEqual({ month: { label, total, runs: count, withAgent }, previous: report.previous });
  });

  test('January looks back at December of the year before', () => {
    const s = spendOf([run('a', local(2026, 12, 31), 3)], local(2027, 1, 5));
    expect(s.previous).toEqual({ label: 'December', total: 3 });
    expect(s.month.label).toBe('January');
  });
});

// The strip is redrawn every second for every open tab, and nothing deletes old
// runs: a 15-minute pipeline has ~35,000 of them after a year. The grouping used
// to copy each month's bucket on every run (quadratic) and took ~150 ms here.
describe('cost on a long history', () => {
  const many = Array.from({ length: 36_000 }, (_, i) =>
    run(`p${i % 4}`, local(2026, (i % 12) + 1, (i % 28) + 1), 0.01 * (i % 7)),
  );

  test('spendOf and costReport stay well under a tick', () => {
    const t0 = performance.now();
    spendOf(many, NOW);
    const t1 = performance.now();
    costReport(many, ['p0', 'p1', 'p2', 'p3'], NOW);
    const t2 = performance.now();
    expect(t1 - t0).toBeLessThan(100);
    expect(t2 - t1).toBeLessThan(150);
  });
});
