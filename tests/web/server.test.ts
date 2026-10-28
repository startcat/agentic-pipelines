import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderHealthPanel } from '../../src/web/render.ts';
import {
  addPipelineWithTruncatedRun,
  addUnparseablePipeline,
  RUNNING_RUN_ID,
  serve,
  SKIPPED_RUN_ID,
  stripStyles,
} from './fixture.ts';

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
      [{ name: 'demo', description: 'drafts <guard> and publishes', health, totalSteps: 1, scheduler: { label: 'launchd', logPath: '/h/demo.log' } }],
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
      [{ name: 'a&b', description: 'd', health, totalSteps: 1, scheduler: { label: 'launchd', logPath: '/h/demo.log' } }],
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
      [{ name: 'demo', description: 'd', health, totalSteps: 1, scheduler: { label: 'launchd', logPath: '/h/demo.log' } }],
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
      [{ name: 'demo', description: 'd', health, totalSteps: 1, scheduler: { label: 'launchd', logPath: '/h/demo.log' }, jobLogTail: 'error: <bun> not found' }],
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
