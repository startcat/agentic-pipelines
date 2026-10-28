import { describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { escapeHtml, renderHealthPanel } from '../../src/web/render.ts';
import { STYLES } from '../../src/web/styles.ts';
import {
  addPipelineWithTruncatedRun,
  addUnparseablePipeline,
  RUNNING_RUN_ID,
  serve,
  SKIPPED_RUN_ID,
  stripStyles,
} from './fixture.ts';

/** A finished run started right now, with one agent step that cost `usd`. */
async function writeRunNow(root: string, pipeline: string, usd: number): Promise<void> {
  const startedAt = new Date().toISOString();
  const id = startedAt.replace(/[:.]/g, '-');
  const dir = join(root, '.runs', pipeline, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'run.json'), JSON.stringify({
    id, pipeline, pipelineVersion: 1, status: 'success', startedAt, params: {}, totalCostUsd: usd,
    steps: { one: { id: 'one', status: 'success', startedAt, durationMs: 1_000, outputs: {}, effects: [], attempts: 1, costUsd: usd } },
  }));
}

describe('GET /', () => {
  test('lists the pipelines with their latest state', async () => {
    const { server, base } = await serve();
    try {
      const html = stripStyles(await (await fetch(`${base}/`)).text());
      expect(html).toContain('demo');
      // The fixture's most recent run is RUNNING_RUN_ID, in progress: that row's
      // verdict has to reflect it. It is checked against the health dot's class
      // (`class="dot live"`), not against the bare word — a lone state word can
      // slip through even if the real datum is another (`stripStyles` also
      // strips the stylesheet, which names the four possible tones in its
      // selectors).
      expect(html).toContain('class="dot live"');
      expect(html).toContain('Running now');
    } finally {
      server.stop(true);
    }
  });

  test('a pipeline with no cron says it is run by hand', async () => {
    const { server, base, root } = await serve();
    try {
      // The fixture's run in progress, finished: a running row says how long
      // it has been going instead.
      const runJson = join(root, '.runs', 'demo', RUNNING_RUN_ID, 'run.json');
      await writeFile(runJson, (await Bun.file(runJson).text()).replace('"running"', '"success"'));
      const html = stripStyles(await (await fetch(`${base}/`)).text());
      expect(html).toContain('<div class="next">run by hand</div>');
    } finally {
      server.stop(true);
    }
  });

  // The strip is computed from the runs the rows already read: same source as
  // /costs, without a second pass over `.runs/`.
  test('the spend strip counts this month\'s runs', async () => {
    const { server, base, root } = await serve();
    try {
      await writeRunNow(root, 'demo', 0.5);
      const html = stripStyles(await (await fetch(`${base}/`)).text());
      expect(html).toContain('class="spend"');
      expect(html).toContain(', to date');
      expect(html).toContain('$0.50');
      expect(html).toContain('1 run · 1 with an agent');
      expect(html).toContain('href="/costs"');
    } finally {
      server.stop(true);
    }
  });

  // A pipeline whose pipeline.yaml broke after it ran still spent that money:
  // /costs counts it, so the strip does too.
  test('the strip counts the runs of a pipeline that cannot be read', async () => {
    const { server, base, root } = await serve();
    try {
      await addUnparseablePipeline(root, 'half');
      await writeRunNow(root, 'half', 0.25);
      const html = stripStyles(await (await fetch(`${base}/`)).text());
      expect(html).toContain('Could not be read');
      expect(html).toContain('$0.25');
    } finally {
      server.stop(true);
    }
  });

  test('a pipeline with no triggers is not drawn as broken', async () => {
    const { server, base } = await serve();
    try {
      const html = stripStyles(await (await fetch(`${base}/`)).text());
      // The dashboard doesn't show the raw enum, it shows the phrase: `no-trigger`
      // is a manual pipeline, and painting it red would be noise.
      expect(html).toContain('no cron');
      expect(html).not.toContain('no-trigger');
    } finally {
      server.stop(true);
    }
  });

  // Direct coverage, with no fixture or server: `renderHealthPanel` is called
  // here with a hand-built `Health` (same pattern as the two tests of
  // 'the installed + silent contradiction' below). Why it is needed, besides
  // the test above against the real fixture: any future fixture that changes
  // which run is the most recent (as happened when adding RUNNING_RUN_ID) can
  // again displace the skip reason from the dashboard without any test
  // turning red — as already happened once. This test doesn't depend on which
  // run is the last in any fixture: it builds the Health directly, so that
  // displacement can't disarm it.
  // NOTE: the skip reason is NO LONGER drawn on the dashboard — the verdict
  // says "Skipped N nights in a row" and the whole reason lives on the
  // pipeline's page, grouped. The test that THAT text arrives escaped has not
  // been lost: it is in `render.test.ts`, on `renderPipelinePage`. What remains
  // here is the other text the dashboard does interpolate from a file we don't
  // control: the `pipeline.yaml` description.
  test('the pipeline description arrives escaped on the dashboard', () => {
    const health = {
      trigger: 'installed', work: 'working', consecutiveSkips: 0, contradiction: false,
    } as never;
    const html = renderHealthPanel(
      [{ name: 'demo', description: 'drafts <guard> and publishes', health, steps: ['one'], next: { kind: 'manual' }, scheduler: { label: 'launchd', logPath: '/h/demo.log' } }],
      new Date('2026-08-31T11:56:00.000Z'),
    );
    expect(html).toContain('&lt;guard&gt;');
    expect(html).not.toContain('<guard>');
  });

  test('the pipeline name arrives escaped in the link and in the text', () => {
    const health = {
      trigger: 'installed', work: 'working', consecutiveSkips: 0, contradiction: false,
    } as never;
    const html = renderHealthPanel(
      [{ name: 'a&b', description: 'd', health, steps: ['one'], next: { kind: 'manual' }, scheduler: { label: 'launchd', logPath: '/h/demo.log' } }],
      new Date('2026-08-31T11:56:00.000Z'),
    );
    expect(html).toContain('a%26b');
    expect(html).toContain('a&amp;b');
  });
});

describe('the installed + silent contradiction', () => {
  // It is the only case in which the job's log is read: the trace of an engine
  // that dies before writing run.json. With no runs in the window and the job
  // loaded, the alarm has to show up.
  test('the alarm is drawn and says where to look', () => {
    const health = {
      trigger: 'installed', work: 'silent', consecutiveSkips: 0, contradiction: true,
    } as never;
    const html = renderHealthPanel(
      [{ name: 'demo', description: 'd', health, steps: ['one'], next: { kind: 'manual' }, scheduler: { label: 'launchd', logPath: '/h/demo.log' } }],
      new Date('2026-08-31T11:56:00.000Z'),
    );
    expect(html).toContain('class="alarmbox"');
    expect(html).toContain('LOADED AND PRODUCING NOTHING');
    expect(html).toContain('never even started');
  });

  test('with a log tail, it shows it escaped', () => {
    const health = {
      trigger: 'installed', work: 'silent', consecutiveSkips: 0, contradiction: true,
    } as never;
    const html = renderHealthPanel(
      [{ name: 'demo', description: 'd', health, steps: ['one'], next: { kind: 'manual' }, scheduler: { label: 'launchd', logPath: '/h/demo.log' }, jobLogTail: 'error: <bun> not found' }],
      new Date('2026-08-31T11:56:00.000Z'),
    );
    expect(html).toContain('&lt;bun&gt;');
    expect(html).not.toContain('<bun>');
  });
});

// The two hostile files, uncovered until now: `loadPipeline` and
// `store.listRuns` propagate their errors and `healthRows` didn't contain
// them, so a single broken pipeline took down `GET /` for ALL pipelines —
// exactly when this viewer is most useful (a pipeline half-way through
// authoring, or a half-written `run.json`).
describe('GET / — error containment', () => {
  test('a pipeline without pipeline.yaml does not take down the dashboard', async () => {
    const { server, base, root } = await serve();
    try {
      await addUnparseablePipeline(root, 'half-authored');
      const res = await fetch(`${base}/`);
      expect(res.status).toBe(200);
      const html = stripStyles(await res.text());
      expect(html).toContain('class="dot live"'); // demo is still on the dashboard
      expect(html).toContain('half-authored');
    } finally {
      server.stop(true);
    }
  });

  // `loadPipeline` is written for the CLI, where a person types the name:
  // "Pipeline "x" does not exist. Available: demo, x" is useful there and here
  // it contradicts itself — it names `x` as absent and as available in the
  // same sentence, and reads as if the tool is broken.
  test('a directory without pipeline.yaml says what is going on, without contradicting itself', async () => {
    const { server, base, root } = await serve();
    try {
      await addUnparseablePipeline(root, 'half-authored');
      const html = stripStyles(await (await fetch(`${base}/`)).text());
      expect(html).toContain('has no pipeline.yaml');
      expect(html).not.toContain('Available:');
      expect(html).not.toContain('does not exist');
    } finally {
      server.stop(true);
    }
  });

  // The other path of the same `catch`: if the file IS there and what fails is
  // the parsing, the real message is the only thing that says what to fix. That
  // one is left alone.
  test('an unreadable pipeline.yaml does show the real reason', async () => {
    const { server, base, root } = await serve();
    try {
      await mkdir(join(root, 'pipelines', 'bad-yaml'), { recursive: true });
      await writeFile(join(root, 'pipelines', 'bad-yaml', 'pipeline.yaml'), 'name: [unclosed\n');
      const html = stripStyles(await (await fetch(`${base}/`)).text());
      expect(html).toContain('bad-yaml');
      expect(html).not.toContain('has no pipeline.yaml');
    } finally {
      server.stop(true);
    }
  });

  test('with no scheduler for the platform, the dashboard does not 500: each row shows the error', async () => {
    const { server, base } = await serve();
    // An unknown value makes `schedulerFor()` throw, same as on FreeBSD.
    const saved = process.env.PIPELINES_SCHEDULER;
    process.env.PIPELINES_SCHEDULER = 'freebsd';
    try {
      const res = await fetch(`${base}/`);
      expect(res.status).toBe(200);
      const html = stripStyles(await res.text());
      expect(html).toContain('demo');
      expect(html).toContain('is not a known scheduler');
    } finally {
      if (saved === undefined) delete process.env.PIPELINES_SCHEDULER;
      else process.env.PIPELINES_SCHEDULER = saved;
      server.stop(true);
    }
  });

  test('a truncated run.json does not take down the dashboard', async () => {
    const { server, base, root } = await serve();
    try {
      await addPipelineWithTruncatedRun(root, 'corrupt-run', '2026-08-29T03-00-00-000Z');
      const res = await fetch(`${base}/`);
      expect(res.status).toBe(200);
      const html = stripStyles(await res.text());
      expect(html).toContain('class="dot live"'); // demo is still on the dashboard
      expect(html).toContain('corrupt-run');
    } finally {
      server.stop(true);
    }
  });
});

describe('404', () => {
  test('an unknown route is 404', async () => {
    const { server, base } = await serve();
    try {
      expect((await fetch(`${base}/does-not-exist`)).status).toBe(404);
    } finally {
      server.stop(true);
    }
  });
});

describe('GET /p/:name', () => {
  test('shows the steps, the guards and the history', async () => {
    const { server, base } = await serve();
    try {
      const html = stripStyles(await (await fetch(`${base}/p/demo`)).text());
      expect(html).toContain('A test pipeline');
      // Not a bare 'one': other texts on the page contain that substring
      // ("None", "someone"), so the assertion passed even if the step list came
      // out empty. `<code>one</code>` inside `.sid` is the markup that ONLY a
      // step row produces.
      expect(html).toContain('<code>one</code>'); // the step
      expect(html).toContain(SKIPPED_RUN_ID); // the run
    } finally {
      server.stop(true);
    }
  });

  // The skip reason comes from a file and carries `<` and `>`: if it is
  // interpolated unescaped, the viewer becomes its own hole. It lives here (and
  // not in `GET /`, where it was before) because the fixture's most recent run
  // is now RUNNING_RUN_ID, in progress — there is no skip to show on the health
  // dashboard (its `consecutiveSkips` drops to 0), so the skipped reason is
  // only still visible, just as escaped, in this page's history. The
  // dashboard's own escaping has its own coverage, with no fixture, in
  // `describe('GET /')`.
  test('the skip reason arrives escaped', async () => {
    const { server, base } = await serve();
    try {
      const html = stripStyles(await (await fetch(`${base}/p/demo`)).text());
      expect(html).toContain('&lt;guard&gt;');
      expect(html).not.toContain('<guard>');
    } finally {
      server.stop(true);
    }
  });

  // The bug this route could introduce, and its test.
  test('a name with traversal is 404, not a file', async () => {
    const { server, base } = await serve();
    try {
      const res = await fetch(`${base}/p/${encodeURIComponent('../../etc/passwd')}`);
      expect(res.status).toBe(404);
    } finally {
      server.stop(true);
    }
  });

  test('a nonexistent pipeline is 404', async () => {
    const { server, base } = await serve();
    try {
      expect((await fetch(`${base}/p/nope`)).status).toBe(404);
    } finally {
      server.stop(true);
    }
  });

  // The fixture's pipeline has no cron: there is nothing to promise. The
  // month comes from the same sum as /costs, so a run from today shows up.
  test('the meta says when it runs next and what it cost this month', async () => {
    const { server, base, root } = await serve();
    try {
      await writeRunNow(root, 'demo', 0.25);
      const html = stripStyles(await (await fetch(`${base}/p/demo`)).text());
      expect(html).toContain('<span>Next</span><b>run by hand</b>');
      const month = new Date().toLocaleString('en-US', { month: 'long' });
      expect(html).toContain(`<span>${month}</span><b class="mono">$0.25</b>`);
      // A shell-only pipeline has nothing to cap.
      expect(html).not.toContain('Spending cap');
    } finally {
      server.stop(true);
    }
  });
});

/** A run folder whose run.json was cut mid-write. */
async function writeTruncatedRun(root: string, pipeline: string, id: string): Promise<void> {
  const dir = join(root, '.runs', pipeline, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'run.json'), '{"id": "trunc');
}

const TRUNCATED_ID = '2026-08-29T03-00-00-000Z';

describe('a run.json that cannot be read', () => {
  // `RunStore.listRuns` throws on the first broken file — the CLI needs that.
  // The pages read run by run instead, so one file costs its own row.
  test('the pipeline page is still drawn, and says in one line which run could not be read', async () => {
    const { server, base, root } = await serve();
    try {
      await writeTruncatedRun(root, 'demo', TRUNCATED_ID);
      const res = await fetch(`${base}/p/demo`);
      expect(res.status).toBe(200);
      const html = stripStyles(await res.text());
      expect(html).toContain(`1 run could not be read: ${TRUNCATED_ID}: `);
      expect(html).toContain(SKIPPED_RUN_ID); // the readable runs are still listed
    } finally {
      server.stop(true);
    }
  });

  test('its own page says it could not be read and why, inside the viewer\'s layout', async () => {
    const { server, base, root } = await serve();
    try {
      await writeTruncatedRun(root, 'demo', TRUNCATED_ID);
      const res = await fetch(`${base}/p/demo/runs/${TRUNCATED_ID}`);
      expect(res.status).toBe(500);
      const html = stripStyles(await res.text());
      expect(html).toContain('This run could not be read.');
      expect(html).toContain('<footer class="foot">');
      expect(html).toContain('JSON');
    } finally {
      server.stop(true);
    }
  });

  test('a sibling run is still served', async () => {
    const { server, base, root } = await serve();
    try {
      await writeTruncatedRun(root, 'demo', TRUNCATED_ID);
      expect((await fetch(`${base}/p/demo/runs/${RUNNING_RUN_ID}`)).status).toBe(200);
      expect((await fetch(`${base}/p/demo/runs/${RUNNING_RUN_ID}/one`)).status).toBe(200);
    } finally {
      server.stop(true);
    }
  });

  test('a run.json that parses to something other than a run is unreadable, not a 500', async () => {
    const { server, base, root } = await serve();
    try {
      const dir = join(root, '.runs', 'demo', TRUNCATED_ID);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'run.json'), 'null');
      expect(stripStyles(await (await fetch(`${base}/p/demo`)).text())).toContain('run.json is not a run record');
      expect((await fetch(`${base}/p/demo/runs/${TRUNCATED_ID}`)).status).toBe(500);
    } finally {
      server.stop(true);
    }
  });

  test('a run.json without steps still gets its page', async () => {
    const { server, base, root } = await serve();
    try {
      const dir = join(root, '.runs', 'demo', TRUNCATED_ID);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'run.json'), JSON.stringify({
        id: TRUNCATED_ID, pipeline: 'demo', status: 'success', startedAt: '2026-08-29T03:00:00.000Z', steps: null,
      }));
      expect((await fetch(`${base}/p/demo/runs/${TRUNCATED_ID}`)).status).toBe(200);
      expect((await fetch(`${base}/p/demo/runs/${TRUNCATED_ID}/x`)).status).toBe(404);
    } finally {
      server.stop(true);
    }
  });
});

describe('GET /p/:name without a scheduler for the platform', () => {
  test('the page is drawn; the verdict says the scheduler could not be asked and NEXT is a dash', async () => {
    const { server, base } = await serve();
    // An unknown value makes `schedulerFor()` throw, same as on FreeBSD.
    const saved = process.env.PIPELINES_SCHEDULER;
    process.env.PIPELINES_SCHEDULER = 'freebsd';
    try {
      const res = await fetch(`${base}/p/demo`);
      expect(res.status).toBe(200);
      const html = stripStyles(await res.text());
      expect(html).toContain('<div class="verdict bad">Could not ask the scheduler: ');
      expect(html).toContain('is not a known scheduler');
      expect(html).toContain('<span>Next</span><b>—</b>');
    } finally {
      if (saved === undefined) delete process.env.PIPELINES_SCHEDULER;
      else process.env.PIPELINES_SCHEDULER = saved;
      server.stop(true);
    }
  });
});

describe('GET /p/:name/runs/:runId', () => {
  test('shows the steps of the run', async () => {
    const { server, base } = await serve();
    try {
      const html = stripStyles(await (await fetch(`${base}/p/demo/runs/${RUNNING_RUN_ID}`)).text());
      expect(html).toContain('one');
    } finally {
      server.stop(true);
    }
  });

  test('the steps carry the chip of their type in the current YAML', async () => {
    const { server, base } = await serve();
    try {
      const html = stripStyles(await (await fetch(`${base}/p/demo/runs/${RUNNING_RUN_ID}`)).text());
      expect(html).toContain('>one</a> <span class="kind">shell</span>');
    } finally {
      server.stop(true);
    }
  });

  // The YAML may break after the run. The run is still worth showing:
  // without chips or caps, not as a 500.
  test('with a YAML that no longer parses, the run is still served, without chips', async () => {
    const { server, base, root } = await serve();
    try {
      await writeFile(join(root, 'pipelines', 'demo', 'pipeline.yaml'), 'name: [unclosed\n');
      const res = await fetch(`${base}/p/demo/runs/${RUNNING_RUN_ID}`);
      expect(res.status).toBe(200);
      const html = stripStyles(await res.text());
      expect(html).toContain('>one</a>');
      expect(html).not.toContain('class="kind');
    } finally {
      server.stop(true);
    }
  });

  test('a made-up runId is 404', async () => {
    const { server, base } = await serve();
    try {
      expect((await fetch(`${base}/p/demo/runs/9999`)).status).toBe(404);
    } finally {
      server.stop(true);
    }
  });
});

describe('GET /p/:name/runs/:runId/:stepId', () => {
  test('serves the escaped log', async () => {
    const { server, base } = await serve();
    try {
      const html = stripStyles(await (await fetch(`${base}/p/demo/runs/${RUNNING_RUN_ID}/one`)).text());
      expect(html).toContain('&lt;b&gt;');
    } finally {
      server.stop(true);
    }
  });

  test('?raw=1 serves it as plain text, unescaped', async () => {
    const { server, base } = await serve();
    try {
      const res = await fetch(`${base}/p/demo/runs/${RUNNING_RUN_ID}/one?raw=1`);
      expect(res.headers.get('content-type')).toContain('text/plain');
      expect(await res.text()).toContain('<b>');
    } finally {
      server.stop(true);
    }
  });

  test('a stepId that is not in the run is 404', async () => {
    const { server, base } = await serve();
    try {
      const res = await fetch(`${base}/p/demo/runs/${RUNNING_RUN_ID}/${encodeURIComponent('../run')}`);
      expect(res.status).toBe(404);
    } finally {
      server.stop(true);
    }
  });

  // `run.steps[stepId] === undefined` is a lookup through the PROTOTYPE CHAIN:
  // `constructor`, `toString`, `__proto__`... exist on any object and are not
  // `undefined`, so they returned 200 instead of 404 despite not being real
  // steps of the run. It is not a traversal, but the comment next to it claims
  // "validated against the run's keys" and that is not what the code did.
  test('a stepId from the prototype chain (constructor) is 404', async () => {
    const { server, base } = await serve();
    try {
      const res = await fetch(`${base}/p/demo/runs/${RUNNING_RUN_ID}/constructor`);
      expect(res.status).toBe(404);
    } finally {
      server.stop(true);
    }
  });

  // This page DOES have to subscribe to the live view while the run is
  // `running` — it didn't before (`layout()` was called without `sse`), so the
  // `log` event that `createRunStream` sends had no consumer. It checks that
  // the script references the right stream AND that it carries its own stepId
  // to pick its portion of the log (the next commit in `sse.test.ts` checks
  // that the event really carries it).
  test('the page of a step: trail, title with its chip, state and the numbered log', async () => {
    const { server, base } = await serve();
    try {
      const html = stripStyles(await (await fetch(`${base}/p/demo/runs/${RUNNING_RUN_ID}/one`)).text());
      expect(html).toContain(`<a href="/p/demo/runs/${RUNNING_RUN_ID}" class="up">${RUNNING_RUN_ID}</a>`);
      expect(html).toContain('<h1>one</h1><span class="kind">shell</span><span class="tkind">step 1 of 1</span>');
      expect(html).toContain('<div class="bigline s-success">✓ success · 12s</div>');
      expect(html).toContain('previous: none');
      expect(html).toContain('next: none');
      expect(html).toContain('>2 lines · 38 B</span>');
      expect(html).toContain('<span>starting the step</span><span>output: &lt;b&gt;bold&lt;/b&gt;</span>');
      expect(html).toContain(`href="/p/demo/runs/${RUNNING_RUN_ID}/one?raw=1"`);
      // No nav item is marked under /p/: the crumb says where you are.
      expect(html).not.toContain('aria-current');
    } finally {
      server.stop(true);
    }
  });

  test('the steps go in the YAML\'s order, and the run\'s own when the YAML is gone', async () => {
    const { server, base, root } = await serve();
    try {
      await writeFile(
        join(root, 'pipelines', 'demo', 'pipeline.yaml'),
        'name: demo\ndescription: A test pipeline\nversion: 1\nsteps:\n'
          + '  - id: zero\n    type: shell\n    run: "true"\n'
          + '  - id: two\n    type: shell\n    run: "true"\n'
          + '  - id: one\n    type: shell\n    run: "true"\n',
      );
      const runJson = join(root, '.runs', 'demo', RUNNING_RUN_ID, 'run.json');
      const run = JSON.parse(await Bun.file(runJson).text());
      run.steps.two = { ...run.steps.one, id: 'two' };
      await writeFile(runJson, JSON.stringify(run));

      // `zero` is declared but not in the run: it is not counted.
      let html = stripStyles(await (await fetch(`${base}/p/demo/runs/${RUNNING_RUN_ID}/one`)).text());
      expect(html).toContain('step 2 of 2');
      expect(html).toContain(`<a href="/p/demo/runs/${RUNNING_RUN_ID}/two"><span class="arr">←</span>`);

      await writeFile(join(root, 'pipelines', 'demo', 'pipeline.yaml'), 'name: [unclosed\n');
      const res = await fetch(`${base}/p/demo/runs/${RUNNING_RUN_ID}/one`);
      expect(res.status).toBe(200);
      html = stripStyles(await res.text());
      expect(html).toContain('step 1 of 2');
      expect(html).not.toContain('class="kind');
    } finally {
      server.stop(true);
    }
  });

  test('a step without a log file says so; ?raw=1 still answers', async () => {
    const { server, base, root } = await serve();
    try {
      await rm(join(root, '.runs', 'demo', RUNNING_RUN_ID, 'one.log'));
      const html = stripStyles(await (await fetch(`${base}/p/demo/runs/${RUNNING_RUN_ID}/one`)).text());
      expect(html).toContain('0 lines · 0 B');
      expect(html).toContain('<p class="lognone">');
      const raw = await fetch(`${base}/p/demo/runs/${RUNNING_RUN_ID}/one?raw=1`);
      expect(raw.status).toBe(200);
    } finally {
      server.stop(true);
    }
  });

  test('a run.json that can\'t be read is the viewer\'s 500 page, as on the run\'s page', async () => {
    const { server, base, root } = await serve();
    try {
      await writeTruncatedRun(root, 'demo', TRUNCATED_ID);
      const res = await fetch(`${base}/p/demo/runs/${TRUNCATED_ID}/one`);
      expect(res.status).toBe(500);
      expect(stripStyles(await res.text())).toContain('This run could not be read.');
    } finally {
      server.stop(true);
    }
  });

  test('a finished run does not subscribe to anything', async () => {
    const { server, base, root } = await serve();
    try {
      const runJson = join(root, '.runs', 'demo', RUNNING_RUN_ID, 'run.json');
      await writeFile(runJson, (await Bun.file(runJson).text()).replace('"running"', '"success"'));
      const html = await (await fetch(`${base}/p/demo/runs/${RUNNING_RUN_ID}/one`)).text();
      expect(html).not.toContain('EventSource');
    } finally {
      server.stop(true);
    }
  });

  test('it subscribes to the run stream while it runs, with its own stepId', async () => {
    const { server, base } = await serve();
    try {
      const html = await (await fetch(`${base}/p/demo/runs/${RUNNING_RUN_ID}/one`)).text();
      expect(html).toContain(`new EventSource("/sse/demo/${RUNNING_RUN_ID}")`);
      expect(html).toContain('payload.stepId !== "one"');
    } finally {
      server.stop(true);
    }
  });
});

describe('GET /fonts/:file', () => {
  test('serves a font as woff2, cacheable for good', async () => {
    const { server, base } = await serve();
    try {
      const res = await fetch(`${base}/fonts/lexend-var.woff2`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('font/woff2');
      expect(res.headers.get('cache-control')).toContain('immutable');
      // The real file, not an error page: a woff2 starts with "wOF2".
      expect(new TextDecoder().decode((await res.arrayBuffer()).slice(0, 4))).toBe('wOF2');
    } finally {
      server.stop(true);
    }
  });

  // The other half of the contract with `styles.test.ts`: there it is checked
  // that the sheet only points under /fonts/; here, that everything it points
  // to is really served. A renamed file would otherwise fall back to the system
  // font without a single red test.
  test('every font the stylesheet names is served', async () => {
    const { server, base } = await serve();
    try {
      const urls = [...STYLES.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]);
      expect(urls.length).toBe(3);
      for (const url of urls) expect((await fetch(`${base}${url}`)).status).toBe(200);
    } finally {
      server.stop(true);
    }
  });

  test('a file that is not on the list is 404', async () => {
    const { server, base } = await serve();
    try {
      expect((await fetch(`${base}/fonts/nope.woff2`)).status).toBe(404);
      // The licence lives in the same folder, but it is not a font: not served.
      expect((await fetch(`${base}/fonts/OFL.txt`)).status).toBe(404);
    } finally {
      server.stop(true);
    }
  });

  test('a traversal is 404, not a file', async () => {
    const { server, base } = await serve();
    try {
      expect((await fetch(`${base}/fonts/..%2Fpackage.json`)).status).toBe(404);
      expect((await fetch(`${base}/fonts/..%2F..%2F..%2Fpackage.json`)).status).toBe(404);
    } finally {
      server.stop(true);
    }
  });
});

describe('GET /costs', () => {
  test('serves the costs page, marked as the current section', async () => {
    const { server, base } = await serve();
    try {
      const res = await fetch(`${base}/costs`);
      expect(res.status).toBe(200);
      const html = stripStyles(await res.text());
      expect(html).toContain('Costs');
      expect(html).toContain('href="/costs" aria-current="page"');
      // The fixture's pipeline is in the table even if it cost nothing.
      expect(html).toContain('<span class="cpname">demo</span>');
    } finally {
      server.stop(true);
    }
  });

  test('a truncated run.json does not take the page down, and the page says it left it out', async () => {
    const { server, base, root } = await serve();
    try {
      await addPipelineWithTruncatedRun(root, 'corrupt-run', '2026-08-29T03-00-00-000Z');
      const res = await fetch(`${base}/costs`);
      expect(res.status).toBe(200);
      const html = stripStyles(await res.text());
      expect(html).toContain('<span class="cpname">demo</span>');
      expect(html).toContain('could not be read: <code>corrupt-run</code>');
    } finally {
      server.stop(true);
    }
  });

  test('a POST is not served', async () => {
    const { server, base } = await serve();
    try {
      expect((await fetch(`${base}/costs`, { method: 'POST' })).status).not.toBe(200);
    } finally {
      server.stop(true);
    }
  });
});

describe('header and footer', () => {
  test('the dashboard marks Overview as the current section', async () => {
    const { server, base } = await serve();
    try {
      const html = await (await fetch(`${base}/`)).text();
      expect(html).toContain('href="/" aria-current="page"');
    } finally {
      server.stop(true);
    }
  });

  // As in the design: under /p/ no nav item is marked, the trail says where
  // you are and its first step is the way back to the overview.
  test('a pipeline page marks no section, and its trail starts at Overview', async () => {
    const { server, base } = await serve();
    try {
      for (const path of ['/p/demo', `/p/demo/runs/${RUNNING_RUN_ID}`]) {
        // Without the sheet: it names aria-current in the nav's own rule.
        const html = stripStyles(await (await fetch(`${base}${path}`)).text());
        expect(html).not.toContain('aria-current');
        expect(html).toContain('<div class="crumb"><a href="/">Overview</a>');
      }
    } finally {
      server.stop(true);
    }
  });

  test('the footer carries the real port and the repo root', async () => {
    const { server, base, root } = await serve();
    try {
      const html = stripStyles(await (await fetch(`${base}/`)).text());
      const footer = html.slice(html.indexOf('<footer'));
      expect(footer).toContain(`127.0.0.1:${server.port} · read-only`);
      // The fixture lives under the temp dir, not under HOME: the path stays whole.
      expect(footer).toContain(escapeHtml(root));
    } finally {
      server.stop(true);
    }
  });

  // `schedulerFor()` throws on a platform without a scheduler. The rows
  // already say so one by one; the footer just says it does not know.
  test('with no scheduler for the platform, the footer says — instead of a 500', async () => {
    const { server, base } = await serve();
    const saved = process.env.PIPELINES_SCHEDULER;
    process.env.PIPELINES_SCHEDULER = 'freebsd';
    try {
      const res = await fetch(`${base}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html.slice(html.indexOf('<footer'))).toContain('<span>—</span>');
    } finally {
      if (saved === undefined) delete process.env.PIPELINES_SCHEDULER;
      else process.env.PIPELINES_SCHEDULER = saved;
      server.stop(true);
    }
  });
});

describe('GET only', () => {
  // This surface's one rule is "every route is GET, nothing mutates". With
  // Bun's bare handler, any verb falls into the same 200 response — no
  // concrete exploit needs to exist for it to be a violation of that rule.
  test('a POST to / does not return the page', async () => {
    const { server, base } = await serve();
    try {
      const res = await fetch(`${base}/`, { method: 'POST' });
      expect(res.status).not.toBe(200);
    } finally {
      server.stop(true);
    }
  });
});

/**
 * A pipeline shaped like the demo's docs-drift: a shell step, then an agent
 * step declared with the short `agent: <name>` form, then one run started now.
 */
async function addAgentPipeline(root: string, run: Record<string, unknown> = {}): Promise<string> {
  await mkdir(join(root, 'pipelines', 'drift', 'steps'), { recursive: true });
  await writeFile(join(root, 'pipelines', 'drift', 'steps', 'review.md'), 'Review the docs.\n');
  await writeFile(
    join(root, 'pipelines', 'drift', 'pipeline.yaml'),
    'name: drift\ndescription: Docs drift\nversion: 1\nsteps:\n' +
      '  - id: fetch\n    type: shell\n    run: "true"\n' +
      '  - id: review\n    agent: writer\n    prompt: steps/review.md\n    max_cost_usd: 1.00\n',
  );
  const startedAt = new Date().toISOString();
  const id = startedAt.replace(/[:.]/g, '-');
  const dir = join(root, '.runs', 'drift', id);
  await mkdir(dir, { recursive: true });
  const step = (stepId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: stepId, status: 'success', startedAt, durationMs: 1_000, outputs: {}, effects: [], attempts: 1, ...extra,
  });
  await writeFile(join(dir, 'run.json'), JSON.stringify({
    id, pipeline: 'drift', pipelineVersion: 1, status: 'success', startedAt, params: {}, totalCostUsd: 0.4,
    steps: { fetch: step('fetch'), review: step('review', { costUsd: 0.4 }) },
    ...run,
  }));
  await writeFile(join(dir, 'review.log'), 'reviewing\n');
  return id;
}

describe('hostile costs in run.json', () => {
  // `money()` reached `toFixed` with whatever the file said: a string cost
  // made `/`, the pipeline page and the run page 500, and froze the open
  // dashboard (the health stream logged the throw on every tick).
  test('a non-numeric totalCostUsd and step costUsd do not take any page down', async () => {
    const { server, base, root } = await serve();
    try {
      const id = await addAgentPipeline(root, {
        totalCostUsd: 'x',
        steps: { review: { id: 'review', status: 'success', startedAt: new Date().toISOString(), durationMs: 1, costUsd: 'y' } },
      });
      for (const path of ['/', '/p/drift', `/p/drift/runs/${id}`, `/p/drift/runs/${id}/review`, '/costs']) {
        const res = await fetch(`${base}${path}`);
        expect(`${path} ${res.status}`).toBe(`${path} 200`);
        expect(await res.text()).not.toContain('NaN');
      }
    } finally {
      server.stop(true);
    }
  });

  test('a null denial does not take the run page down', async () => {
    const { server, base, root } = await serve();
    try {
      const startedAt = new Date().toISOString();
      const id = await addAgentPipeline(root, {
        steps: {
          review: {
            id: 'review', status: 'success', startedAt, durationMs: 1, costUsd: 0.1,
            denials: [null, { toolName: 'Bash', source: 'sandbox', reason: 'outside the repo' }],
          },
        },
      });
      const res = await fetch(`${base}/p/drift/runs/${id}`);
      expect(res.status).toBe(200);
      expect(stripStyles(await res.text())).toContain('outside the repo');
    } finally {
      server.stop(true);
    }
  });
});

describe('a status that names a prototype member', () => {
  // The word tables were read with `TABLE[status]`: `constructor` found the
  // inherited function and printed "function Object() { [native code] }".
  test('is drawn as an unknown status, not as Object\'s source', async () => {
    const { server, base, root } = await serve();
    try {
      const startedAt = new Date().toISOString();
      const step = { id: 'fetch', status: 'constructor', startedAt, durationMs: 1 };
      const running = await addAgentPipeline(root, { status: 'running', steps: { fetch: step } });
      const pages = ['/', '/p/drift', `/p/drift/runs/${running}`, `/p/drift/runs/${running}/fetch`];
      for (const path of pages) {
        const html = await (await fetch(`${base}${path}`)).text();
        expect(`${path} ${html.includes('native code')}`).toBe(`${path} false`);
      }
      const runJson = join(root, '.runs', 'drift', running, 'run.json');
      await writeFile(runJson, (await Bun.file(runJson).text()).replace('"running"', '"toString"'));
      for (const path of ['/p/drift', `/p/drift/runs/${running}`]) {
        const html = await (await fetch(`${base}${path}`)).text();
        expect(`${path} ${html.includes('native code')}`).toBe(`${path} false`);
      }
    } finally {
      server.stop(true);
    }
  });
});

describe('the spend strip, /costs and the pipeline page agree', () => {
  const monthOf = (html: string): string | undefined =>
    /<span>[A-Z][a-z]+<\/span><b class="mono">(\$[\d.]+)<\/b>/.exec(html)?.[1];

  // A Finder `.DS_Store` under `.runs/<name>/` made `listRuns` throw (ENOTDIR):
  // the strip and /costs dropped the pipeline's whole spend while its own page
  // still counted it.
  test('a stray file under .runs/<name>/ is not a run and hides nothing', async () => {
    const { server, base, root } = await serve();
    try {
      await addAgentPipeline(root);
      await writeFile(join(root, '.runs', 'drift', '.DS_Store'), 'junk');
      const overview = stripStyles(await (await fetch(`${base}/`)).text());
      expect(overview).toContain('<span class="sfig">$0.40</span>');
      expect(overview).not.toContain('Could not be read');
      expect(monthOf(stripStyles(await (await fetch(`${base}/p/drift`)).text()))).toBe('$0.40');
      const costs = stripStyles(await (await fetch(`${base}/costs`)).text());
      expect(costs).toContain('<span class="cbig">$0.40</span>');
      expect(costs).not.toContain('could not be read');
    } finally {
      server.stop(true);
    }
  });

  // One truncated run.json costs that run only; the strip says it left one out.
  test('a truncated run.json drops only itself, and the strip says so', async () => {
    const { server, base, root } = await serve();
    try {
      await addAgentPipeline(root);
      await writeTruncatedRun(root, 'drift', '2020-01-01T00-00-00-000Z');
      const overview = stripStyles(await (await fetch(`${base}/`)).text());
      expect(overview).toContain('<span class="sfig">$0.40</span>');
      expect(overview).toContain('1 unreadable, not counted');
      expect(monthOf(stripStyles(await (await fetch(`${base}/p/drift`)).text()))).toBe('$0.40');
      const costs = stripStyles(await (await fetch(`${base}/costs`)).text());
      expect(costs).toContain('<span class="cbig">$0.40</span>');
      expect(costs).toContain('could not be read: <code>drift</code>');
    } finally {
      server.stop(true);
    }
  });

  // The link is built from the directory, so a run.json whose `id` lies still
  // leads to its own page.
  test('the most expensive runs link to the run directory, not to the id in the file', async () => {
    const { server, base, root } = await serve();
    try {
      const id = await addAgentPipeline(root, { id: 'something-else' });
      const costs = stripStyles(await (await fetch(`${base}/costs`)).text());
      expect(costs).toContain(`href="/p/drift/runs/${id}"`);
      expect(costs).not.toContain('something-else');
    } finally {
      server.stop(true);
    }
  });
});

describe('the step page of an agent step', () => {
  // Seen missing in a screenshot of the demo's docs-drift `review`. The chip
  // comes from the current YAML, where `agent: <name>` makes the step an agent.
  test('carries the AGENT chip', async () => {
    const { server, base, root } = await serve();
    try {
      const id = await addAgentPipeline(root);
      const res = await fetch(`${base}/p/drift/runs/${id}/review`);
      expect(res.status).toBe(200);
      expect(stripStyles(await res.text())).toContain(
        '<h1>review</h1><span class="kind agent">agent</span><span class="tkind">step 2 of 2</span>',
      );
    } finally {
      server.stop(true);
    }
  });
});
