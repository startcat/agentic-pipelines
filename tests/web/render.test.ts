import { describe, expect, test } from 'bun:test';
import {
  escapeHtml,
  layout,
  renderHealthPanel,
  renderPipelinePage,
  renderRunLive,
  renderRunPage,
  renderUnreadableRun,
  type Chrome,
  type HealthRow,
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

const CHROME: Chrome = { port: 7717, repoRoot: '/home/u/repo', home: '/home/u', scheduler: 'launchd' };

describe('layout', () => {
  test('escapes the title', () => {
    expect(layout('<b>x</b>', '', CHROME)).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  test('without sse it does not include EventSource', () => {
    expect(layout('t', '<p>b</p>', CHROME)).not.toContain('EventSource');
  });

  test('with sse it includes the client', () => {
    expect(layout('t', '<p>b</p>', CHROME, { sse: '/sse/health' })).toContain('/sse/health');
  });

  test('the fonts come from the viewer itself', () => {
    const html = layout('t', '', CHROME);
    expect(html).toContain('@font-face');
    expect(html).toContain('/fonts/young-serif-400.woff2');
  });

  test('the header carries the brand, as on the landing', () => {
    const html = layout('t', '', CHROME);
    expect(html).toContain('agentic-pipelines');
    expect(html).toContain('<svg');
    expect(html).toContain('rel="icon" href="data:image/svg+xml,');
  });

  test('the footer says where it listens, that it only reads, the repo and the scheduler', () => {
    const html = layout('t', '', CHROME);
    expect(html).toContain('127.0.0.1:7717 · read-only');
    expect(html).toContain('~/repo');
    expect(html).not.toContain('/home/u/repo');
    expect(html).toContain('launchd');
  });

  // The `~` is a prefix of whole path segments: `/home/user2` is not inside
  // `/home/u`, and saying `~ser2/x` would be a made-up path.
  test('the home is replaced with ~ only on a segment boundary', () => {
    expect(layout('t', '', { ...CHROME, repoRoot: '/home/u' })).toContain('<span>~</span>');
    const other = layout('t', '', { ...CHROME, repoRoot: '/home/user2/x' });
    expect(other).toContain('/home/user2/x');
    expect(other).not.toContain('~ser2');
  });

  test('the repo path arrives escaped', () => {
    const html = layout('t', '', { ...CHROME, repoRoot: '/srv/<b>repo' });
    expect(html).toContain('/srv/&lt;b&gt;repo');
  });

  test('the current section is marked in the nav, and only that one', () => {
    const costs = layout('t', '', { ...CHROME, nav: 'costs' });
    expect(costs).toContain('href="/costs" aria-current="page"');
    expect(costs).not.toContain('href="/" aria-current="page"');
    const overview = layout('t', '', { ...CHROME, nav: 'overview' });
    expect(overview).toContain('href="/" aria-current="page"');
    expect(overview).not.toContain('href="/costs" aria-current="page"');
    // Sliced from the header on: the stylesheet names the attribute in its
    // selector, and that is not a marked nav item.
    const none = layout('t', '', CHROME);
    expect(none.slice(none.indexOf('<header'))).not.toContain('aria-current');
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

  const EXTRA = { monthLabel: 'August', monthTotal: 0, monthRuns: 0 };

  function skip(day: string, reason: string) {
    return {
      id: `2026-08-${day}T01-00-00-000Z`, pipeline: 'demo', pipelineVersion: 1,
      status: 'skipped', startedAt: `2026-08-${day}T01:00:00.000Z`, params: {}, steps: {},
      skipReason: reason,
    } as never;
  }

  test('the cadence is said in words', () => {
    expect(renderPipelinePage(PIPE, [], HEALTH, NOW, 'launchd', EXTRA)).toContain('every night at 03:00');
  });

  test('agent steps are marked: they are the ones that cost money', () => {
    const html = renderPipelinePage(PIPE, [], HEALTH, NOW, 'launchd', EXTRA);
    expect(html).toContain('kind agent');
    expect(html).toContain('2, 1 with an agent');
  });

  test('a guard is drawn as a command, not as escaped JSON', () => {
    const html = renderPipelinePage(PIPE, [], HEALTH, NOW, 'launchd', EXTRA);
    expect(html).toContain('46h');
    expect(html).toContain('class="cmd"');
    expect(html).not.toContain('&quot;throttle&quot;');
  });

  // This page's reason to exist: eight paragraphs with the same grep.
  test('eight skips with the same guard are one block, not eight rows', () => {
    const runs = ['29', '28', '27', '26', '25', '24', '23', '22'].map((d) => skip(d, GREP));
    const html = renderPipelinePage(PIPE, runs, HEALTH, NOW, 'launchd', EXTRA);
    expect(html).toContain('colapso');
    expect(html).toContain('8 skipped nights in a row');
    // The grep appears ONCE, not eight times. That is all that is checked.
    expect(html.split('grep -qE x').length - 1).toBe(1);
  });

  test('the dates in the block are still links to each run', () => {
    const runs = ['29', '28'].map((d) => skip(d, GREP));
    const html = renderPipelinePage(PIPE, runs, HEALTH, NOW, 'launchd', EXTRA);
    expect(html).toContain('/runs/2026-08-29T01-00-00-000Z');
    expect(html).toContain('/runs/2026-08-28T01-00-00-000Z');
  });

  // A lone skip is not grouped, so its reason has to keep showing in its row:
  // otherwise the explanation would be lost in exactly the simplest case.
  test('a lone skip keeps its reason, escaped', () => {
    const runs = [skip('29', 'shell: <guard> returned 1')];
    const html = renderPipelinePage(PIPE, runs, HEALTH, NOW, 'launchd', EXTRA);
    expect(html).toContain('&lt;guard&gt;');
    expect(html).not.toContain('<guard>');
  });

  test('the grouped reason also arrives escaped', () => {
    const runs = ['29', '28'].map((d) => skip(d, 'shell: <guard> returned 1'));
    const html = renderPipelinePage(PIPE, runs, HEALTH, NOW, 'launchd', EXTRA);
    expect(html).toContain('&lt;guard&gt;');
    expect(html).not.toContain('<guard>');
  });

  test('a forced run is marked', () => {
    const forced = {
      id: 'r', pipeline: 'demo', pipelineVersion: 1, status: 'success',
      startedAt: '2026-08-31T08:58:12.953Z', params: {}, steps: {}, forced: true,
    } as never;
    expect(renderPipelinePage(PIPE, [forced], HEALTH, NOW, 'launchd', EXTRA)).toContain('forced');
  });

  test('a pipeline with no guards says so, and does not leave a silent hole', () => {
    const noGuards = { ...(PIPE as object), when: [] } as never;
    expect(renderPipelinePage(noGuards, [], HEALTH, NOW, 'launchd', EXTRA)).toContain('None');
  });
});

describe('renderPipelinePage — next run, the month and the spending cap', () => {
  const NOW = new Date(2026, 9, 28, 12, 0);
  const HEALTH = {
    trigger: 'installed', work: 'failing', consecutiveSkips: 0, contradiction: false,
  } as never;
  const EXTRA = { next: new Date(2026, 10, 2, 7, 0), monthLabel: 'October', monthTotal: 1.46, monthRuns: 4 };

  const DRIFT = {
    name: 'docs-drift', description: 'Checks the docs', version: 1, params: {}, when: [],
    triggers: [{ cron: '0 7 * * 1' }],
    steps: [
      { id: 'prepare', type: 'shell' },
      { id: 'review', type: 'agent', maxCostUsd: 1 },
      { id: 'commit', type: 'shell' },
      { id: 'unchanged', type: 'shell' },
    ],
  } as never;

  function run(day: number) {
    const startedAt = new Date(2026, 9, day, 7, 0).toISOString();
    return {
      id: `r${day}`, pipeline: 'docs-drift', pipelineVersion: 1, status: 'success',
      startedAt, params: {}, steps: {},
    } as never;
  }

  /** The value under a meta label, tags and all: what follows `<span>LABEL</span>` up to its `</div>`. */
  function meta(html: string, label: string): string {
    const at = html.indexOf(`<span>${label}</span>`);
    if (at < 0) return '';
    return html.slice(at + label.length + 13, html.indexOf('</div>', at));
  }

  test('the trail starts at the overview', () => {
    const html = renderPipelinePage(DRIFT, [], HEALTH, NOW, 'launchd', EXTRA);
    expect(html).toContain('<div class="crumb"><a href="/">Overview</a><span class="sep">/</span><span>docs-drift</span></div>');
  });

  test('NEXT says the day and the time it fires', () => {
    const html = renderPipelinePage(DRIFT, [], HEALTH, NOW, 'launchd', EXTRA);
    expect(meta(html, 'Next')).toContain('Mon Nov 2 · 07:00');
  });

  test('with nothing to promise, NEXT says why in the words of the trigger axis', () => {
    const { next: _, ...noNext } = EXTRA;
    const as = (trigger: string): string =>
      meta(renderPipelinePage(DRIFT, [], { ...(HEALTH as object), trigger } as never, NOW, 'launchd', noNext), 'Next');
    expect(as('not-installed')).toContain('<b class="bad">no next run</b>');
    expect(as('disabled')).toContain('no next run');
    expect(as('no-trigger')).toContain('run by hand');
    expect(as('installed')).toContain('—');
  });

  test('the month says what it cost and in how many runs', () => {
    const value = meta(renderPipelinePage(DRIFT, [], HEALTH, NOW, 'launchd', EXTRA), 'October');
    expect(value).toContain('$1.46');
    expect(value).toContain('· 4 runs');
    const one = meta(renderPipelinePage(DRIFT, [], HEALTH, NOW, 'launchd', { ...EXTRA, monthRuns: 1 }), 'October');
    expect(one).toContain('· 1 run<');
  });

  test('the spending cap names the agent step and its ceiling', () => {
    const html = renderPipelinePage(DRIFT, [], HEALTH, NOW, 'launchd', EXTRA);
    expect(meta(html, 'Spending cap')).toContain('review ≤ $1.00');
  });

  test('an agent step without a ceiling is said in amber', () => {
    const uncapped = {
      ...(DRIFT as object),
      steps: [{ id: 'prepare', type: 'shell' }, { id: 'review', type: 'agent' }],
    } as never;
    expect(renderPipelinePage(uncapped, [], HEALTH, NOW, 'launchd', EXTRA)).toContain(
      '<em class="mono warnc">review: no cap</em>',
    );
  });

  test('a pipeline without agent steps has no spending cap', () => {
    const shellOnly = { ...(DRIFT as object), steps: [{ id: 'prepare', type: 'shell' }] } as never;
    expect(renderPipelinePage(shellOnly, [], HEALTH, NOW, 'launchd', EXTRA)).not.toContain('Spending cap');
  });

  test('each step carries its SHELL or AGENT chip', () => {
    const html = renderPipelinePage(DRIFT, [], HEALTH, NOW, 'launchd', EXTRA);
    expect(html.split('<span class="kind">shell</span>').length - 1).toBe(3);
    expect(html.split('<span class="kind agent">agent</span>').length - 1).toBe(1);
    expect(html).toContain('— 4, 1 with an agent');
  });

  test('the runs section counts them', () => {
    const runs = [26, 19, 12, 5, 28, 21, 14, 7].map(run);
    expect(renderPipelinePage(DRIFT, runs, HEALTH, NOW, 'launchd', EXTRA)).toContain('Runs <i>— 8</i>');
  });

  test('without a scheduler the verdict says so, and the trigger and NEXT are dashes', () => {
    const html = renderPipelinePage(DRIFT, [], HEALTH, NOW, 'launchd', { ...EXTRA, schedulerError: 'no <sched>' });
    expect(html).toContain('<div class="verdict bad">Could not ask the scheduler: no &lt;sched&gt;</div>');
    expect(meta(html, 'Trigger')).toBe('<b>—</b>');
    expect(meta(html, 'Next')).toBe('<b>—</b>');
  });

  test('runs that could not be read are said in one line, escaped', () => {
    const unreadable = [{ id: 'r1', reason: 'Unexpected <end>' }, { reason: 'EACCES' }];
    const html = renderPipelinePage(DRIFT, [run(19)], HEALTH, NOW, 'launchd', { ...EXTRA, unreadable });
    expect(html).toContain('2 runs could not be read: r1: Unexpected &lt;end&gt; · EACCES');
    expect(html).toContain('/runs/r19'); // the readable one is still there
    expect(renderPipelinePage(DRIFT, [], HEALTH, NOW, 'launchd', EXTRA)).not.toContain('could not be read');
  });

  test('a hostile step id or month label arrives escaped', () => {
    const hostile = { ...(DRIFT as object), steps: [{ id: '<x>', type: 'agent', maxCostUsd: 1 }] } as never;
    const html = renderPipelinePage(hostile, [], HEALTH, NOW, 'launchd', { ...EXTRA, monthLabel: '<m>' });
    expect(html).not.toContain('<x>');
    expect(html).not.toContain('<m>');
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

  // The skip reason travels with the verdict, under it, not hidden in a step.
  test('a skipped run says so, with its reason escaped', () => {
    const skipped = { ...(RUN as object), status: 'skipped', steps: {}, skipReason: 'shell: <g> returned 1' } as never;
    const html = renderRunLive(skipped);
    expect(html).toContain('– Skipped.');
    expect(html).toContain('shell: &lt;g&gt; returned 1');
  });
});

describe('renderRunLive — the run of docs-drift, as in the design', () => {
  /** A local instant, so the assertions read the same in any time zone. */
  const at = (h: number, m: number, sec: number, ms = 0): string => new Date(2026, 9, 19, h, m, sec, ms).toISOString();

  function step(id: string, over: Record<string, unknown> = {}) {
    return {
      id, status: 'success', startedAt: at(7, 0, 4), durationMs: 1000, outputs: {}, effects: [], attempts: 1, ...over,
    };
  }

  const DENIAL = { toolName: 'Read', toolUseId: 't1', source: 'both', reason: 'outside every allowed root' };
  const RUN = {
    id: '2026-10-19T05-00-04-212Z', pipeline: 'docs-drift', pipelineVersion: 1, status: 'success',
    startedAt: at(7, 0, 4, 212), finishedAt: at(7, 3, 53, 212), params: {}, totalCostUsd: 0.36,
    steps: {
      prepare: step('prepare', { durationMs: 6_000, outputs: { changed: 'true' } }),
      review: step('review', {
        durationMs: 221_000, costUsd: 0.36, toolsUsed: ['Read', 'Glob'], denials: [DENIAL],
        outputs: { report: 'README: <b>old</b> Node', changed_files: ['README.md', 'docs/config.md'] },
      }),
      commit: step('commit', { durationMs: 2_000 }),
      unchanged: step('unchanged', { status: 'skipped', durationMs: 0, skipReason: 'when: {{prepare.changed}} == false' }),
    },
  } as never;

  const INFO = {
    types: { prepare: 'shell', review: 'agent', commit: 'shell', unchanged: 'shell' },
    caps: { review: 1 },
    totalSteps: 4,
  };

  function meta(html: string, label: string): string {
    const i = html.indexOf(`<span>${label}</span>`);
    if (i < 0) return '';
    return html.slice(i, html.indexOf('</div>', i));
  }

  test('the title is the day and the time it started, in local time', () => {
    const html = renderRunPage('docs-drift', RUN, INFO);
    expect(html).toContain('<h1>Mon Oct 19 · 07:00</h1>');
    expect(html).not.toContain('forced');
    expect(html).not.toContain('scheduled');
  });

  test('a forced run says it skipped the guards, next to the title', () => {
    const forced = { ...(RUN as object), forced: true } as never;
    expect(renderRunPage('docs-drift', forced, INFO)).toContain('<span class="tkind">forced — guards skipped</span>');
  });

  test('the trail goes overview, pipeline, run', () => {
    const html = renderRunPage('docs-drift', RUN, INFO);
    expect(html).toContain(
      '<div class="crumb"><a href="/">Overview</a><span class="sep">/</span><a href="/p/docs-drift" class="up">docs-drift</a><span class="sep">/</span><span>2026-10-19T05-00-04-212Z</span></div>',
    );
  });

  test('a success with a denial says the sandbox blocked one action', () => {
    expect(renderRunLive(RUN, INFO)).toContain(
      '✓ Success. The sandbox blocked one action and the run still finished.',
    );
  });

  test('with several denials it counts them', () => {
    const two = {
      ...(RUN as object),
      steps: { review: step('review', { denials: [DENIAL, { ...DENIAL, toolUseId: 't2' }] }) },
    } as never;
    expect(renderRunLive(two, INFO)).toContain('The sandbox blocked 2 actions and the run still finished.');
  });

  test('a success with no denials is just a success', () => {
    const clean = { ...(RUN as object), steps: { prepare: step('prepare') } } as never;
    expect(renderRunLive(clean, INFO)).toContain('>✓ Success.</div>');
  });

  test('a failure names the step', () => {
    const failed = {
      ...(RUN as object), status: 'failed',
      steps: { prepare: step('prepare'), commit: step('commit', { status: 'failed', error: 'exit 1' }) },
    } as never;
    expect(renderRunLive(failed, INFO)).toContain('✕ Failed at <code>commit</code>.');
  });

  test('STARTED to the second, DURATION from start to finish, COST and STEPS', () => {
    const html = renderRunLive(RUN, INFO);
    expect(meta(html, 'Started')).toContain('07:00:04');
    // The steps add up to 3m 49s; a finish ten minutes after the start has to win.
    const longer = { ...(RUN as object), finishedAt: at(7, 10, 4, 212) } as never;
    expect(meta(renderRunLive(longer, INFO), 'Duration')).toContain('10m 0s');
    expect(meta(html, 'Cost')).toContain('$0.36');
    expect(meta(html, 'Steps')).toContain('4 · 1 skipped');
  });

  test('without finishedAt the duration is the sum of the steps', () => {
    const { finishedAt: _, ...open } = RUN as Record<string, unknown>;
    expect(meta(renderRunLive(open as never, INFO), 'Duration')).toContain('3m 49s');
  });

  test('a run in progress counts its steps against the declared ones', () => {
    const running = { ...(RUN as object), status: 'running', steps: { prepare: step('prepare') } } as never;
    const html = renderRunLive(running, INFO);
    expect(html).toContain('▸ Running.');
    expect(meta(html, 'Steps')).toContain('1 of 4');
  });

  test('the spending cap says what the agent step spent of its ceiling', () => {
    const html = renderRunLive(RUN, INFO);
    expect(meta(html, 'Spending cap')).toContain('review $0.36 of $1.00');
    expect(html).toContain('style="width: 36.0%"');
  });

  test('an agent step without a ceiling is said in amber; without the YAML there is no cap at all', () => {
    expect(renderRunLive(RUN, { ...INFO, caps: {} })).toContain('review: no cap');
    expect(renderRunLive(RUN)).not.toContain('Spending cap');
  });

  test('each step carries its chip, and without the YAML none does', () => {
    const html = renderRunLive(RUN, INFO);
    expect(html).toContain('>review</a> <span class="kind agent">agent</span>');
    expect(html).toContain('>prepare</a> <span class="kind">shell</span>');
    expect(renderRunLive(RUN)).not.toContain('class="kind');
  });

  test('a step with no cost leaves its cell blank', () => {
    const html = renderRunLive(RUN, INFO);
    expect(html).toContain('<span class="stcost"></span>');
    expect(html).not.toContain('undefined');
  });

  test('the denials section says what it holds', () => {
    const html = renderRunLive(RUN, INFO);
    expect(html).toContain('Sandbox denials <i>— 1</i>');
    expect(html).toContain('what the engine refused an agent; the run went on');
  });

  test('the outputs of the agent step: key, type and value, escaped', () => {
    const html = renderRunLive(RUN, INFO);
    expect(html).toContain('Outputs <i>— review</i><small>what the step handed to the next ones</small>');
    expect(html).toContain('<span class="oname">report</span><span class="otype">string</span>');
    expect(html).toContain('README: &lt;b&gt;old&lt;/b&gt; Node');
    expect(html).toContain('<span class="otype">string[]</span>');
    expect(html).toContain('README.md · docs/config.md');
  });

  test('a shell step\'s outputs are not shown: they are already in its log', () => {
    expect(renderRunLive(RUN, INFO)).not.toContain('Outputs <i>— prepare</i>');
  });

  test('every type is told from the value', () => {
    const typed = {
      ...(RUN as object),
      steps: {
        review: step('review', {
          costUsd: 0.1,
          outputs: { n: 3, ok: false, nums: [1, 2], nested: { a: '<x>' } },
        }),
      },
    } as never;
    const html = renderRunLive(typed, INFO);
    expect(html).toContain('<span class="oname">n</span><span class="otype">number</span>');
    expect(html).toContain('<span class="oname">ok</span><span class="otype">boolean</span>');
    expect(html).toContain('<span class="otype">number[]</span>');
    expect(html).toContain('<span class="oname">nested</span><span class="otype">object</span>');
    expect(html).toContain('{&quot;a&quot;:&quot;&lt;x&gt;&quot;}');
  });

  test('an agent step with no outputs has no section', () => {
    const none = { ...(RUN as object), steps: { review: step('review', { costUsd: 0.3 }) } } as never;
    expect(renderRunLive(none, INFO)).not.toContain('Outputs');
  });

  test('without the YAML, a step that measured a cost counts as an agent', () => {
    const html = renderRunLive(RUN);
    expect(html).toContain('Outputs <i>— review</i>');
    expect(html).not.toContain('Outputs <i>— prepare</i>');
  });
});

describe('renderRunLive — a run.json that does not keep its promises', () => {
  const BASE = {
    id: 'r1', pipeline: 'demo', pipelineVersion: 1, status: 'success',
    startedAt: '2026-08-30T01:00:07.795Z', params: {},
  };
  const INFO = { types: { a: 'agent' }, caps: { a: 1 }, totalSteps: 1 };

  test('steps missing or null: the page is drawn with no steps', () => {
    for (const steps of [undefined, null, 'x']) {
      const run = { ...BASE, steps } as never;
      expect(() => renderRunLive(run, INFO)).not.toThrow();
      expect(() => renderRunPage('demo', run, INFO)).not.toThrow();
      expect(renderRunLive(run, INFO)).toContain('<span>Steps</span><b>0</b>');
    }
  });

  test('denials and toolsUsed that are not arrays count as empty', () => {
    const run = {
      ...BASE,
      steps: {
        a: { id: 'a', status: 'success', startedAt: BASE.startedAt, durationMs: 'slow', outputs: {}, effects: [],
             attempts: 1, denials: 'Read', toolsUsed: { Read: true } },
        b: null,
      },
    } as never;
    const html = renderRunLive(run, INFO);
    expect(html).toContain('✓ Success.</div>');
    expect(html).not.toContain('Sandbox denials');
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('undefined');
  });

  test('a ceiling of zero does not draw a NaN bar', () => {
    const run = {
      ...BASE,
      steps: { a: { id: 'a', status: 'success', startedAt: BASE.startedAt, durationMs: 1, outputs: {}, effects: [], attempts: 1, costUsd: 0.2 } },
    } as never;
    expect(renderRunLive(run, { ...INFO, caps: { a: 0 } })).not.toContain('NaN');
  });

  test('an empty array output does not pretend to know its type', () => {
    const run = {
      ...BASE,
      steps: { a: { id: 'a', status: 'success', startedAt: BASE.startedAt, durationMs: 1, outputs: { files: [] }, effects: [], attempts: 1, costUsd: 0.2 } },
    } as never;
    const html = renderRunLive(run, INFO);
    expect(html).toContain('<span class="oname">files</span><span class="otype">array</span>');
    expect(html).toContain('<div class="oval">—</div>');
  });
});

describe('renderUnreadableRun', () => {
  test('the trail and the reason, escaped', () => {
    const html = renderUnreadableRun('demo', 'r<1>', 'Unexpected <end>');
    expect(html).toContain('This run could not be read.');
    expect(html).toContain('<span>r&lt;1&gt;</span>');
    expect(html).toContain('Unexpected &lt;end&gt;');
    expect(html).not.toContain('<end>');
  });
});

describe('renderRunPage', () => {
  const RUN = {
    id: 'r1', pipeline: 'demo', pipelineVersion: 1, status: 'success',
    startedAt: '2026-08-30T01:00:07.795Z', params: {}, steps: {},
  } as never;

  test('it wraps the live view in #live only once, and the live view never carries it', () => {
    expect(renderRunLive(RUN)).not.toContain('id="live"');
    expect(renderRunPage('demo', RUN).split('id="live"').length - 1).toBe(1);
  });

  test('the pipeline name arrives escaped', () => {
    expect(renderRunPage('a&b', RUN)).toContain('a&amp;b');
  });
});

describe('renderHealthPanel — fragment stability', () => {
  const ROW = {
    name: 'demo', description: 'd', steps: ['a', 'b', 'c'], scheduler: { label: 'launchd', logPath: '/h/demo.log' },
    next: { kind: 'at', at: '2026-09-01T06:00:00.000Z' },
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
        name: 'demo', description: 'd', health, steps: ['one'], next: { kind: 'at', at: '' },
        scheduler: { label: 'systemd', logPath: '/x/pipelines-demo.log' },
      }],
      new Date('2026-08-31T11:56:00.000Z'),
    );
    expect(html).toContain('systemd says it triggers this pipeline');
    expect(html).toContain('/x/pipelines-demo.log');
  });
});

// Local-time instants, so the table passes in any timezone. 2026-10-28 is a
// Wednesday.
const NOW = new Date(2026, 9, 28, 14, 0);
type Row = Extract<HealthRow, { health: unknown }>;

function row(over: Partial<Omit<Row, 'health'>> & { health?: Partial<Row['health']> } = {}): Row {
  const { health, ...rest } = over;
  return {
    name: 'site-checks',
    description: 'Checks a list of websites.',
    steps: ['one'],
    scheduler: { label: 'launchd', logPath: '/h/site-checks.log' },
    next: { kind: 'at', at: new Date(2026, 9, 29, 8, 0).toISOString() },
    ...rest,
    health: { trigger: 'installed', work: 'working', consecutiveSkips: 0, contradiction: false, ...health },
  };
}

const SPEND = {
  month: { label: 'October', total: 4.08, runs: 92, withAgent: 36 },
  previous: { label: 'September', total: 4.86 },
};

/** A run in progress, started 3m 12s before NOW, with `recorded` already written. */
function running(recorded: Record<string, string>): Partial<Row['health']> {
  return {
    lastRun: {
      id: 'r', pipeline: 'docs-drift', pipelineVersion: 1, status: 'running', params: {},
      startedAt: new Date(NOW.getTime() - 192_000).toISOString(),
      steps: Object.fromEntries(Object.entries(recorded).map(([id, status]) => [id, { id, status }])),
    } as never,
  };
}

/** The classes of the progress bar's segments, in order. */
function segments(html: string): string {
  const bar = /<div class="progress"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
  return [...bar.matchAll(/<i class="([a-z]+)"/g)].map((m) => m[1]).join(' ');
}

describe('renderHealthPanel — the right column says when it runs next', () => {
  test('a loaded trigger: next and the short day', () => {
    expect(renderHealthPanel([row()], NOW)).toContain('next · tomorrow 08:00');
  });

  test('not installed or disabled: no next run, in the bad tone', () => {
    for (const trigger of ['not-installed', 'disabled'] as const) {
      const html = renderHealthPanel([row({ next: { kind: 'none' }, health: { trigger } })], NOW);
      expect(html).toContain('<div class="next bad">no next run</div>');
    }
  });

  test('no cron: run by hand', () => {
    const html = renderHealthPanel([row({ next: { kind: 'manual' }, health: { trigger: 'no-trigger' } })], NOW);
    expect(html).toContain('<div class="next">run by hand</div>');
  });

  // An instant the server couldn't work out is a dash, never "Invalid Date".
  test('an instant that cannot be read is a dash', () => {
    const html = renderHealthPanel([row({ next: { kind: 'at', at: '' } })], NOW);
    expect(html).toContain('next · —');
    expect(html).not.toContain('NaN');
  });
});

describe('renderHealthPanel — the spend strip', () => {
  test('the month so far, the previous one, the runs and the way to the costs page', () => {
    const html = renderHealthPanel([row()], NOW, SPEND);
    expect(html).toContain('October, to date');
    expect(html).toContain('$4.08');
    expect(html).toContain('September');
    expect(html).toContain('$4.86');
    expect(html).toContain('92 runs · 36 with an agent');
    expect(html).toContain('href="/costs"');
  });

  // "$0.00" and not an empty cell: in the strip a zero is a figure.
  test('a month that cost nothing says $0.00', () => {
    const html = renderHealthPanel([row()], NOW, {
      month: { label: 'October', total: 0, runs: 1, withAgent: 0 },
      previous: { label: 'September', total: 0 },
    });
    expect(html).toContain('$0.00');
    expect(html).toContain('1 run · 0 with an agent');
  });

  test('with no pipelines there is no strip', () => {
    expect(renderHealthPanel([], NOW, SPEND)).not.toContain('class="spend"');
  });
});

describe('renderHealthPanel — a run in progress', () => {
  const live = (recorded: Record<string, string>): string =>
    renderHealthPanel([row({ name: 'docs-drift', steps: ['a', 'b', 'c', 'd'], health: running(recorded) })], NOW);

  test('blue dot and verdict, and how long it has been running instead of the next run', () => {
    const html = live({ a: 'success', b: 'success' });
    expect(html).toContain('class="dot live"');
    expect(html).toContain('class="verdict live"');
    expect(html).toContain('Running now — 2 of 4 steps.');
    expect(html).toContain('running · 3m 12s');
    expect(html).not.toContain('next ·');
  });

  test('one segment per declared step: done in their colour, the first pending live, the rest empty', () => {
    expect(segments(live({ a: 'success', b: 'success' }))).toBe('ok ok live empty');
  });

  test('a failed step is bad and a skipped one is muted', () => {
    expect(segments(live({ a: 'success', b: 'failed' }))).toBe('ok bad live empty');
    expect(segments(live({ a: 'skipped' }))).toBe('skip live empty empty');
  });

  test('only the running row has a bar', () => {
    expect(renderHealthPanel([row()], NOW)).not.toContain('class="progress"');
  });
});

describe('renderHealthPanel — empty and alarm', () => {
  test('no pipelines: the headline and how to write the first one', () => {
    const html = renderHealthPanel([], NOW);
    expect(html).toContain('This repo has no pipelines.');
    expect(html).toContain('pipelines/&lt;name&gt;/pipeline.yaml');
    expect(html).toContain('$ pipelines validate &lt;name&gt;');
    expect(html).toContain('pipelines-starter');
  });

  test('the alarm still shows the tail of the log, escaped', () => {
    const html = renderHealthPanel(
      [row({ health: { work: 'silent', contradiction: true }, jobLogTail: 'error: Module not found "<x>"' })],
      NOW,
      SPEND,
    );
    expect(html).toContain('class="alarmbox"');
    expect(html).toContain('Last lines of its log:');
    expect(html).toContain('error: Module not found &quot;&lt;x&gt;&quot;');
    expect(html).not.toContain('"<x>"');
  });
});

// `createHealthStream` only re-emits when the HTML changes. With
// nothing running, a second later the dashboard — next run and spend strip
// included — has to be byte for byte the same.
describe('renderHealthPanel — stable while nothing runs', () => {
  test('two renders a second apart give the same HTML', () => {
    const rows = [
      row(),
      row({ name: 'weekly', next: { kind: 'none' }, health: { trigger: 'not-installed' } }),
      row({ name: 'manual', next: { kind: 'manual' }, health: { trigger: 'no-trigger' } }),
    ];
    const a = renderHealthPanel(rows, NOW, SPEND);
    const b = renderHealthPanel(rows, new Date(NOW.getTime() + 1_000), SPEND);
    expect(a).toBe(b);
  });
});
