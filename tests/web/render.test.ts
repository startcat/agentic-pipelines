import { describe, expect, test } from 'bun:test';
import {
  escapeHtml,
  layout,
  renderHealthPanel,
  renderPipelinePage,
  renderRunLive,
  renderRunPage,
} from '../../src/web/render.ts';

describe('escapeHtml', () => {
  test('neutralizes a tag', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  // A real skipReason carries quotes and bars: it is the most hostile text this
  // viewer will render, and it comes from a file, not from a user.
  test('escapes quotes and ampersands of a real skipReason', () => {
    const reason = 'shell: "grep -qE "^\\| Slug" f.md" & returned 1';
    const escaped = escapeHtml(reason);
    expect(escaped).not.toContain('"');
    expect(escaped).toContain('&amp;');
  });

  test('undefined is the empty string, not "undefined"', () => {
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('layout', () => {
  test('escapes the title', () => {
    expect(layout('<b>x</b>', '')).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  test('without sse it does not include EventSource', () => {
    expect(layout('t', '<p>b</p>')).not.toContain('EventSource');
  });

  test('with sse it includes the client', () => {
    expect(layout('t', '<p>b</p>', { sse: '/sse/health' })).toContain('/sse/health');
  });
});

describe('renderPipelinePage', () => {
  const NOW = new Date('2026-08-31T11:56:00.000Z');
  const GREP = 'shell: "grep -qE x" returned 1';

  const PIPE = {
    name: 'demo', description: 'A test pipeline', version: 1,
    params: { docs_repo: { description: 'Local path of the clone' } },
    when: [{ throttle: '46h' }, { shell: 'grep -qE "^\\| Slug" f.md' }],
    triggers: [{ cron: '0 3 * * *' }],
    steps: [{ id: 'one', type: 'shell' }, { id: 'two', type: 'agent' }],
  } as never;

  const HEALTH = {
    trigger: 'installed', work: 'working', consecutiveSkips: 0, contradiction: false,
  } as never;

  function skip(day: string, reason: string) {
    return {
      id: `2026-08-${day}T01-00-00-000Z`, pipeline: 'demo', pipelineVersion: 1,
      status: 'skipped', startedAt: `2026-08-${day}T01:00:00.000Z`, params: {}, steps: {},
      skipReason: reason,
    } as never;
  }

  test('the cadence is said in words', () => {
    expect(renderPipelinePage(PIPE, [], HEALTH, NOW, 'launchd')).toContain('every night at 03:00');
  });

  test('agent steps are marked: they are the ones that cost money', () => {
    const html = renderPipelinePage(PIPE, [], HEALTH, NOW, 'launchd');
    expect(html).toContain('kind agent');
    expect(html).toContain('1 agent');
  });

  test('a guard is drawn as a command, not as escaped JSON', () => {
    const html = renderPipelinePage(PIPE, [], HEALTH, NOW, 'launchd');
    expect(html).toContain('46h');
    expect(html).toContain('class="cmd"');
    expect(html).not.toContain('&quot;throttle&quot;');
  });

  // This page's reason to exist: eight paragraphs with the same grep.
  test('eight skips with the same guard are one block, not eight rows', () => {
    const runs = ['29', '28', '27', '26', '25', '24', '23', '22'].map((d) => skip(d, GREP));
    const html = renderPipelinePage(PIPE, runs, HEALTH, NOW, 'launchd');
    expect(html).toContain('colapso');
    expect(html).toContain('8 skipped nights in a row');
    // The grep appears ONCE, not eight times. That is all that is checked.
    expect(html.split('grep -qE x').length - 1).toBe(1);
  });

  test('the dates in the block are still links to each run', () => {
    const runs = ['29', '28'].map((d) => skip(d, GREP));
    const html = renderPipelinePage(PIPE, runs, HEALTH, NOW, 'launchd');
    expect(html).toContain('/runs/2026-08-29T01-00-00-000Z');
    expect(html).toContain('/runs/2026-08-28T01-00-00-000Z');
  });

  // A lone skip is not grouped, so its reason has to keep showing in its row:
  // otherwise the explanation would be lost in exactly the simplest case.
  test('a lone skip keeps its reason, escaped', () => {
    const runs = [skip('29', 'shell: <guard> returned 1')];
    const html = renderPipelinePage(PIPE, runs, HEALTH, NOW, 'launchd');
    expect(html).toContain('&lt;guard&gt;');
    expect(html).not.toContain('<guard>');
  });

  test('the grouped reason also arrives escaped', () => {
    const runs = ['29', '28'].map((d) => skip(d, 'shell: <guard> returned 1'));
    const html = renderPipelinePage(PIPE, runs, HEALTH, NOW, 'launchd');
    expect(html).toContain('&lt;guard&gt;');
    expect(html).not.toContain('<guard>');
  });

  test('a forced run is marked', () => {
    const forced = {
      id: 'r', pipeline: 'demo', pipelineVersion: 1, status: 'success',
      startedAt: '2026-08-31T08:58:12.953Z', params: {}, steps: {}, forced: true,
    } as never;
    expect(renderPipelinePage(PIPE, [forced], HEALTH, NOW, 'launchd')).toContain('forced');
  });

  test('a pipeline with no guards says so, and does not leave a silent hole', () => {
    const noGuards = { ...(PIPE as object), when: [] } as never;
    expect(renderPipelinePage(noGuards, [], HEALTH, NOW, 'launchd')).toContain('None');
  });
});

describe('renderRunLive', () => {
  function step(id: string, over: Record<string, unknown> = {}) {
    return {
      id, status: 'success', startedAt: '2026-08-30T01:00:00.000Z',
      durationMs: 1000, outputs: {}, effects: [], attempts: 1, ...over,
    };
  }

  const RUN = {
    id: '2026-08-30T01-00-07-795Z', pipeline: 'demo', pipelineVersion: 1, status: 'failed',
    startedAt: '2026-08-30T01:00:07.795Z', params: {}, totalCostUsd: 7.36,
    steps: {
      redact: step('redact', { durationMs: 470_000, costUsd: 6.71, toolsUsed: ['Read', 'Edit'] }),
      build: step('build', { status: 'failed', durationMs: 14_000, error: 'exit code 1' }),
    },
  } as never;

  // If the header stayed outside #live, a run that finishes while you look
  // would keep saying "running" until you reloaded.
  test('the run header goes inside what gets refreshed', () => {
    const html = renderRunLive(RUN);
    expect(html.startsWith('<div class="bigline')).toBe(true);
    expect(html).toContain('Duration');
    expect(html).toContain('$7.36');
  });

  test('says at which step it failed', () => {
    expect(renderRunLive(RUN)).toContain('<code>build</code>');
  });

  test('the bar is proportional to the longest step', () => {
    const html = renderRunLive(RUN);
    expect(html).toContain('width: 100.0%'); // redact, 470s
    expect(html).toContain('width: 3.0%'); // build, 14s over 470s
  });

  // A just-started run has every step at zero: without the cap, each bar would
  // come out with `width: NaN%`.
  test('a run with every step at zero does not divide by zero', () => {
    const zero = { ...(RUN as object), steps: { a: step('a', { durationMs: 0 }) } } as never;
    const html = renderRunLive(zero);
    expect(html).not.toContain('NaN');
  });

  test('a run with no steps does not blow up', () => {
    const empty = { ...(RUN as object), steps: {} } as never;
    expect(() => renderRunLive(empty)).not.toThrow();
  });

  test('the failure reason is visible, and escaped', () => {
    const hostile = {
      ...(RUN as object),
      steps: { build: step('build', { status: 'failed', error: 'failed <b>build</b>' }) },
    } as never;
    const html = renderRunLive(hostile);
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toContain('<b>build</b>');
  });

  // It used to print `redact: Read (both)` and the reason —the part that explains
  // why the sandbox didn't let the tool through— was dropped.
  test('a denial keeps its reason', () => {
    const withDenial = {
      ...(RUN as object),
      steps: {
        redact: step('redact', {
          denials: [{
            toolName: 'Read', toolUseId: 't1', source: 'both',
            reason: '"/repo/x.mdx" resolves outside every allowed root',
          }],
        }),
      },
    } as never;
    const html = renderRunLive(withDenial);
    expect(html).toContain('Sandbox denials');
    expect(html).toContain('resolves outside every allowed root');
  });

  test('a denial with no reason does not print "undefined"', () => {
    const noReason = {
      ...(RUN as object),
      steps: {
        redact: step('redact', {
          denials: [{ toolName: 'Read', toolUseId: 't1', source: 'hook-log' }],
        }),
      },
    } as never;
    expect(renderRunLive(noReason)).not.toContain('undefined');
  });

  test('with no denials the section is not drawn', () => {
    expect(renderRunLive(RUN)).not.toContain('denials');
  });

  test('a forced run says it skipped the guards', () => {
    const forced = { ...(RUN as object), forced: true } as never;
    expect(renderRunLive(forced)).toContain('forced');
  });
});

describe('renderRunPage', () => {
  const RUN = {
    id: 'r1', pipeline: 'demo', pipelineVersion: 1, status: 'success',
    startedAt: '2026-08-30T01:00:07.795Z', params: {}, steps: {},
  } as never;

  test('it wraps the live view in #live only once', () => {
    expect(renderRunPage('demo', RUN).split('id="live"').length - 1).toBe(1);
  });

  test('the pipeline name arrives escaped', () => {
    expect(renderRunPage('a&b', RUN)).toContain('a&amp;b');
  });
});

describe('renderHealthPanel — fragment stability', () => {
  const ROW = {
    name: 'demo', description: 'd', totalSteps: 3, scheduler: { label: 'launchd', logPath: '/h/demo.log' },
    health: { trigger: 'installed', work: 'working', consecutiveSkips: 0, contradiction: false },
  } as never;

  // `createHealthStream` compares this fragment's HTML with the previous
  // tick's (`rendered === last`) and only re-emits if it changed. Anything that
  // depends on the instant and not on the STATE —a clock in the subtitle, for
  // example— makes the dashboard re-emit every minute with nothing new, and the
  // only signal that tells "something happened" from "everything is the same"
  // is lost. It happened once: the subtitle carried the time.
  test('the same state gives the same HTML even as the clock advances', () => {
    const a = renderHealthPanel([ROW], new Date('2026-08-31T11:56:00.000Z'));
    const b = renderHealthPanel([ROW], new Date('2026-08-31T11:59:30.000Z'));
    expect(a).toBe(b);
  });

  // But it does have to change when the last run's relative DAY changes:
  // "today · 13:42" and "yesterday · 13:42" are not the same.
  test('it changes when the last run becomes one from yesterday', () => {
    const withRun = {
      ...(ROW as object),
      health: {
        trigger: 'installed', work: 'working', consecutiveSkips: 0, contradiction: false,
        lastRun: { startedAt: new Date(2026, 7, 31, 13, 42).toISOString(), status: 'success' },
      },
    } as never;
    const today = renderHealthPanel([withRun], new Date(2026, 7, 31, 23, 0));
    const tomorrow = renderHealthPanel([withRun], new Date(2026, 8, 1, 9, 0));
    expect(today).not.toBe(tomorrow);
    expect(today).toContain('today');
    expect(tomorrow).toContain('yesterday');
  });
});

describe('renderHealthPanel — the alarm names the scheduler', () => {
  test('it uses the label and log path the server passes it', () => {
    const health = {
      trigger: 'installed', work: 'silent', consecutiveSkips: 0, contradiction: true,
    } as never;
    const html = renderHealthPanel(
      [{
        name: 'demo', description: 'd', health, totalSteps: 1,
        scheduler: { label: 'systemd', logPath: '/x/pipelines-demo.log' },
      }],
      new Date('2026-08-31T11:56:00.000Z'),
    );
    expect(html).toContain('systemd says it triggers this pipeline');
    expect(html).toContain('/x/pipelines-demo.log');
  });
});
