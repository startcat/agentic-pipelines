import { describe, expect, test } from 'bun:test';
import type { Health } from '../../src/health/evaluate.ts';
import type { RunRecord } from '../../src/runs/types.ts';
import {
  triggerLabel,
  workLabel,
  verdict,
  panelSummary,
} from '../../src/web/verdict.ts';

function health(over: Partial<Health> = {}): Health {
  return { trigger: 'installed', work: 'working', consecutiveSkips: 0, contradiction: false, ...over };
}

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r', pipeline: 'demo', pipelineVersion: 1, status: 'success',
    startedAt: '2026-08-31T01:00:00.000Z', params: {}, steps: {}, ...over,
  };
}

describe('labels', () => {
  test('each trigger state has its word', () => {
    expect(triggerLabel('no-trigger')).toBe('no cron');
    expect(triggerLabel('not-installed')).toBe('not installed');
    expect(triggerLabel('disabled')).toBe('disabled');
    expect(triggerLabel('drifted')).toBe('drifted');
    expect(triggerLabel('installed')).toBe('loaded');
  });

  test('each work state has its word', () => {
    expect(workLabel('never-worked')).toBe('never worked');
    expect(workLabel('working')).toBe('working');
    expect(workLabel('failing')).toBe('failing');
    expect(workLabel('stuck')).toBe('stuck');
    expect(workLabel('silent')).toBe('silent');
  });

  // The vocabulary is ONE. "silence" was a loose word in a mockup and already
  // cost an inconsistency; the state is called "silent" across the whole interface.
  test('the silent state is not called two different ways', () => {
    expect(workLabel('silent')).not.toContain('silence');
  });
});

describe('verdict', () => {
  // The page's reason to exist. From August 20 to 29 the job was loaded and
  // produced nothing, and neither source saw it alone.
  test('loaded + silent is the alarm, and says so in capitals', () => {
    const v = verdict(health({ work: 'silent', contradiction: true }), 16, 'launchd');
    expect(v.tone).toBe('bad');
    expect(v.line).toBe('LOADED AND PRODUCING NOTHING');
  });

  test('a drifted and silent plist is also the alarm', () => {
    const v = verdict(health({ trigger: 'drifted', work: 'silent', contradiction: true }), 16, 'launchd');
    expect(v.tone).toBe('bad');
    expect(v.line).toBe('LOADED AND PRODUCING NOTHING');
  });

  test('the alarm rules even over a running run', () => {
    const lastRun = run({ status: 'running' });
    expect(verdict(health({ work: 'silent', contradiction: true, lastRun }), 16, 'launchd').line)
      .toBe('LOADED AND PRODUCING NOTHING');
  });

  test('stuck says how many nights it has been skipping', () => {
    const v = verdict(health({ work: 'stuck', consecutiveSkips: 8 }), 16, 'launchd');
    expect(v.tone).toBe('warn');
    expect(v.line).toContain('8 nights');
  });

  test('a single skipped night does not speak in plural', () => {
    const line = verdict(health({ work: 'stuck', consecutiveSkips: 1 }), 16, 'launchd').line;
    expect(line).toContain('1 night');
    expect(line).not.toContain('1 nights');
  });

  test('a running run counts the steps done', () => {
    const lastRun = run({ status: 'running', steps: { a: {}, b: {}, c: {} } as never });
    const v = verdict(health({ lastRun }), 16, 'launchd');
    expect(v.tone).toBe('live');
    expect(v.line).toBe('Running now — 3 of 16 steps.');
  });

  test('failing says it bluntly', () => {
    expect(verdict(health({ work: 'failing' }), 16, 'launchd').tone).toBe('bad');
  });

  test('a manual, up-to-date pipeline paints nothing red', () => {
    const v = verdict(health({ trigger: 'no-trigger', work: 'working' }), 3, 'launchd');
    expect(v.tone).toBe('ok');
    expect(v.line).toContain('by hand');
  });

  test('an up-to-date pipeline with cron does not mention by hand', () => {
    const v = verdict(health({ work: 'working' }), 16, 'launchd');
    expect(v.tone).toBe('ok');
    expect(v.line).not.toContain('by hand');
  });

  // `disabled` is evaluated before `not-installed` in evaluateTrigger because it
  // is the actionable diagnosis. The verdict respects that order: the trigger
  // axis rules over the work axis when nobody triggers it.
  test('disabled rules over whatever the work axis says', () => {
    const v = verdict(health({ trigger: 'disabled', work: 'working' }), 16, 'launchd');
    expect(v.tone).toBe('bad');
    expect(v.line).toContain('Nothing triggers it');
  });

  test('not installed also rules', () => {
    const v = verdict(health({ trigger: 'not-installed', work: 'working' }), 16, 'launchd');
    expect(v.tone).toBe('bad');
    expect(v.line).toContain('Nothing triggers it');
  });

  test('the two axis labels always travel with the verdict', () => {
    const v = verdict(health({ trigger: 'drifted', work: 'stuck', consecutiveSkips: 2 }), 16, 'launchd');
    expect(v.trigger).toBe('drifted');
    expect(v.work).toBe('stuck');
  });

  test('never worked is not an alarm', () => {
    expect(verdict(health({ work: 'never-worked' }), 16, 'launchd').tone).toBe('neutral');
  });
});

describe('panelSummary', () => {
  test('with nothing to look at, it says so and does not alarm', () => {
    const r = panelSummary([health(), health({ trigger: 'no-trigger' })], 0);
    expect(r.tone).toBe('ok');
    expect(r.line).toContain('All in order');
  });

  test('an alarm takes the headline', () => {
    const r = panelSummary([health(), health({ work: 'silent', contradiction: true })], 0);
    expect(r.tone).toBe('bad');
    expect(r.line).toMatch(/produces? nothing/);
    expect(r.sub).toContain('1 in alarm');
  });

  test('the alarm weighs more than a failure', () => {
    const r = panelSummary([health({ work: 'failing' }), health({ work: 'silent', contradiction: true })], 0);
    expect(r.line).toMatch(/produces? nothing/);
  });

  test('two alarms speak in plural', () => {
    const two = [health({ work: 'silent', contradiction: true }), health({ work: 'silent', contradiction: true })];
    expect(panelSummary(two, 0).line).toBe('2 pipelines are loaded and produce nothing.');
  });

  test('a stuck pipeline makes the headline even if it is not an alarm', () => {
    const r = panelSummary([health({ work: 'stuck', consecutiveSkips: 8 })], 0);
    expect(r.tone).toBe('warn');
    expect(r.line).toContain('without working');
  });

  test('unreadable pipelines are counted in the subtitle', () => {
    expect(panelSummary([health()], 1).sub).toContain('1 unreadable');
  });

  test('an empty dashboard does not pretend to be in order', () => {
    expect(panelSummary([], 0).tone).toBe('neutral');
  });

  test('if none can be read, it says so', () => {
    expect(panelSummary([], 2).tone).toBe('bad');
  });

  test('a running run is mentioned when everything else is fine', () => {
    const r = panelSummary([health({ lastRun: run({ status: 'running' }) })], 0);
    expect(r.line).toContain('in progress');
  });

  // The rows under the headline are red when nothing triggers the pipeline;
  // "All in order." above them was a contradiction.
  test('a pipeline that is not installed or disabled is never "All in order"', () => {
    const one = panelSummary([health(), health({ trigger: 'not-installed' })], 0);
    expect(one.line).toBe('One pipeline is not triggered by anything.');
    expect(one.tone).toBe('bad');
    expect(one.sub).toBe('2 pipelines · 1 not triggered');

    const two = panelSummary([health({ trigger: 'disabled' }), health({ trigger: 'not-installed' })], 0);
    expect(two.line).toBe('2 pipelines are not triggered by anything.');
  });

  test('not triggered comes after the alarm and before a failed run', () => {
    const alarm = health({ work: 'silent', contradiction: true });
    const untriggered = health({ trigger: 'not-installed', work: 'failing' });
    expect(panelSummary([alarm, untriggered], 0).line).toMatch(/produces? nothing/);
    expect(panelSummary([health({ work: 'failing' }), untriggered], 0).line).toBe(
      'One pipeline is not triggered by anything.',
    );
    expect(panelSummary([health({ work: 'stuck', consecutiveSkips: 4 }), untriggered], 0).tone).toBe('bad');
  });

  // Each pipeline counts once, in the category its own row shows first.
  test('the subhead counts every category present', () => {
    const r = panelSummary(
      [
        health(),
        health(),
        health(),
        health({ work: 'failing' }),
        health({ trigger: 'not-installed' }),
        health({ trigger: 'disabled', work: 'failing' }),
        health({ work: 'stuck', consecutiveSkips: 3 }),
      ],
      1,
    );
    expect(r.sub).toBe('8 pipelines · 1 unreadable · 2 not triggered · 1 stuck · 1 failing');
  });

  test('the alarm count stays in the subhead with the rest', () => {
    const r = panelSummary(
      [health({ work: 'silent', contradiction: true }), health({ work: 'failing' })],
      0,
    );
    expect(r.sub).toBe('2 pipelines · 1 in alarm · 1 failing');
  });

  test('one pipeline is "1 pipeline"', () => {
    expect(panelSummary([health()], 0).sub).toBe('1 pipeline · none silent');
  });
});

describe('verdict — names the scheduler of the machine', () => {
  test('on systemd it says systemd', () => {
    expect(verdict(health({ trigger: 'not-installed' }), 16, 'systemd').line).toBe(
      'Not installed in systemd. Nothing triggers it.',
    );
    expect(verdict(health({ trigger: 'disabled' }), 16, 'systemd').line).toBe(
      'Disabled in systemd. Nothing triggers it.',
    );
  });

  test('on launchd the sentence stays the same', () => {
    expect(verdict(health({ trigger: 'not-installed' }), 16, 'launchd').line).toBe(
      'Not installed in launchd. Nothing triggers it.',
    );
    expect(verdict(health({ trigger: 'disabled' }), 16, 'launchd').line).toBe(
      'Disabled in launchd. Nothing triggers it.',
    );
  });
});
