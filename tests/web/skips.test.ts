import { describe, expect, test } from 'bun:test';
import type { RunRecord } from '../../src/runs/types.ts';
import { guardOf, groupHistory } from '../../src/web/skips.ts';

// The real reason of the eight skips from August 22 to 29, with its parentheses
// INSIDE the command: those are the ones that can't be trimmed.
const GREP =
  'shell: "grep -qE "^\\| Slug \\(ca\\)\\s+\\| Estat\\s+" {{params.docs_repo}}/scripts/x.md" returned 1';

function run(day: string, status: RunRecord['status'], skipReason?: string): RunRecord {
  return {
    id: `2026-08-${day}T01-00-00-000Z`,
    pipeline: 'demo', pipelineVersion: 1, status,
    startedAt: `2026-08-${day}T01:00:00.000Z`, params: {}, steps: {},
    ...(skipReason === undefined ? {} : { skipReason }),
  };
}

describe('guardOf', () => {
  // The two throttle skips carry different minutes in the parenthesis. If the
  // key were the whole reason they wouldn't group, and they are the same fact.
  test('the variable trailing parenthesis is not part of the guard', () => {
    expect(guardOf('throttle: 46h (last run 2211 min ago)')).toBe('throttle: 46h');
    expect(guardOf('throttle: 46h (last run 771 min ago)')).toBe('throttle: 46h');
  });

  test('two throttles with different minutes are the same guard', () => {
    expect(guardOf('throttle: 46h (2211 min ago)')).toBe(guardOf('throttle: 46h (771 min ago)'));
  });

  // A shell command carries parentheses of its own that can NOT be touched:
  // only the trailing parenthesis is trimmed, and this reason doesn't end in one.
  test('a shell guard stays whole, inner parentheses included', () => {
    expect(guardOf(GREP)).toBe(GREP);
    expect(guardOf(GREP)).toContain('\\(ca\\)');
  });

  test('with no reason there is no guard', () => {
    expect(guardOf(undefined)).toBe('');
  });
});

describe('groupHistory', () => {
  test('an empty history gives an empty list', () => {
    expect(groupHistory([])).toEqual([]);
  });

  test('with no skips nothing is grouped', () => {
    const runs = [run('31', 'success'), run('30', 'failed')];
    expect(groupHistory(runs).map((t) => t.kind)).toEqual(['run', 'run']);
  });

  // A block for a single skip would take more room than the row it replaces.
  test('a lone skip is still a row', () => {
    const segments = groupHistory([run('31', 'success'), run('30', 'skipped', GREP)]);
    expect(segments.map((t) => t.kind)).toEqual(['run', 'run']);
  });

  // The real case: August 22 → 29, eight nights with the same grep.
  test('two or more consecutive skips with the same guard are grouped', () => {
    const runs = [
      run('31', 'success'),
      run('29', 'skipped', GREP), run('28', 'skipped', GREP), run('27', 'skipped', GREP),
      run('19', 'success'),
    ];
    const segments = groupHistory(runs);
    expect(segments.map((t) => t.kind)).toEqual(['run', 'skips', 'run']);
    const block = segments[1];
    if (block?.kind !== 'skips') throw new Error('a skips block was expected');
    expect(block.runs).toHaveLength(3);
    expect(block.guard).toBe(GREP);
  });

  test('two different guards are not mixed in one block', () => {
    const runs = [
      run('29', 'skipped', GREP), run('28', 'skipped', GREP),
      run('21', 'skipped', 'throttle: 46h (last run 2211 min ago)'),
      run('20', 'skipped', 'throttle: 46h (last run 771 min ago)'),
    ];
    const segments = groupHistory(runs);
    expect(segments.map((t) => t.kind)).toEqual(['skips', 'skips']);
    const second = segments[1];
    if (second?.kind !== 'skips') throw new Error('a skips block was expected');
    expect(second.guard).toBe('throttle: 46h');
  });

  // A run that worked between two skips breaks the streak: they aren't consecutive.
  test('a run that is not a skip cuts the streak', () => {
    const runs = [
      run('29', 'skipped', GREP), run('28', 'success'), run('27', 'skipped', GREP),
    ];
    expect(groupHistory(runs).map((t) => t.kind)).toEqual(['run', 'run', 'run']);
  });

  test('no run is lost or duplicated when grouping', () => {
    const runs = [
      run('31', 'success'),
      run('29', 'skipped', GREP), run('28', 'skipped', GREP), run('27', 'skipped', GREP),
      run('21', 'skipped', 'throttle: 46h (2211 min ago)'),
      run('20', 'skipped', 'throttle: 46h (771 min ago)'),
      run('19', 'success'),
    ];
    const seen = groupHistory(runs).flatMap((t) => (t.kind === 'run' ? [t.run] : t.runs));
    expect(seen.map((r) => r.id)).toEqual(runs.map((r) => r.id));
  });

  test('a whole history of identical skips is a single block', () => {
    const runs = ['29', '28', '27'].map((d) => run(d, 'skipped', GREP));
    const segments = groupHistory(runs);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.kind).toBe('skips');
  });

  test('a skip with no reason groups with another skip with no reason', () => {
    const runs = [run('29', 'skipped'), run('28', 'skipped')];
    const segments = groupHistory(runs);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.kind).toBe('skips');
  });
});
