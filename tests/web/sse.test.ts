import { describe, expect, test } from 'bun:test';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { layout, type Chrome } from '../../src/web/render.ts';
import { serve, RUNNING_RUN_ID } from './fixture.ts';

const CHROME: Chrome = { port: 7717, repoRoot: '/home/u/repo', home: '/home/u', scheduler: 'launchd' };

describe('GET /sse/:name/:runId', () => {
  test('sends only the new piece of the log, not the whole file', async () => {
    const { server, base, root } = await serve();
    const runId = RUNNING_RUN_ID;
    const res = await fetch(`${base}/sse/demo/${runId}`);
    const reader = res.body!.getReader();
    try {
      await appendFile(join(root, '.runs', 'demo', runId, 'one.log'), 'NEW\n');

      let received = '';
      // The server compares mtime every second: two reads are enough.
      for (let i = 0; i < 4 && !received.includes('NEW'); i += 1) {
        const { value } = await reader.read();
        received += new TextDecoder().decode(value);
      }
      expect(received).toContain('NEW');
      expect(received).toContain('event: log');
      // What was already in the file before opening the stream (fixture.ts,
      // one.log) is NOT resent: only the delta after the opening.
      expect(received).not.toContain('starting the step');
    } finally {
      await reader.cancel();
      server.stop(true);
    }
  }, 15_000);

  // The `log` event had no consumer: the page that subscribes (the run detail)
  // has no `#log`, and the one that has it (the step) didn't subscribe. Fixed
  // by giving it scope: the datum is now `{ stepId, delta }`, not just the
  // delta. This assertion can ONLY pass if the server sends the step's id along
  // with the delta — with the old shape (a bare `data: delta`) `JSON.parse`
  // would have returned the delta string, not an object, and `payload.stepId`
  // would be `undefined`, not `'one'`.
  test('the log event carries the step id, so it can be picked on the client', async () => {
    const { server, base, root } = await serve();
    const runId = RUNNING_RUN_ID;
    const res = await fetch(`${base}/sse/demo/${runId}`);
    const reader = res.body!.getReader();
    try {
      await appendFile(join(root, '.runs', 'demo', runId, 'one.log'), 'NEW\n');

      let raw = '';
      let dataLine: string | undefined;
      for (let i = 0; i < 6 && dataLine === undefined; i += 1) {
        const { value } = await reader.read();
        raw += new TextDecoder().decode(value);
        dataLine = /^event: log\ndata: (.*)$/m.exec(raw)?.[1];
      }
      expect(dataLine).toBeDefined();
      const payload = JSON.parse(dataLine!) as { stepId: string; delta: string };
      expect(payload.stepId).toBe('one');
      expect(payload.delta).toContain('NEW');
    } finally {
      await reader.cancel();
      server.stop(true);
    }
  }, 15_000);

  test('the panel event sends only the steps table, not the whole page', async () => {
    const { server, base } = await serve();
    const runId = RUNNING_RUN_ID;
    const res = await fetch(`${base}/sse/demo/${runId}`);
    const reader = res.body!.getReader();
    try {
      // The first event is the initial panel. `sseEvent` leaves the HTML on a
      // single `data: "..."` line (the fragment's newlines are escaped inside
      // the JSON), so it is enough to gather reads until the whole line is seen
      // and parse it with JSON.parse — just like the real client (`SSE_CLIENT`,
      // render.ts) — to compare HTML against HTML and not against the stream's
      // raw text (which carries escaped quotes and wouldn't match a literal
      // `toContain`).
      let raw = '';
      let dataLine: string | undefined;
      for (let i = 0; i < 4 && dataLine === undefined; i += 1) {
        const { value } = await reader.read();
        raw += new TextDecoder().decode(value);
        dataLine = raw.match(/^data: (.*)$/m)?.[1];
      }
      expect(dataLine).toBeDefined();
      const html = JSON.parse(dataLine!) as string;

      // It is the run's live view: the status header —which is also refreshed—
      // and the fixture's step, `one`.
      expect(html).toContain('class="bigline');
      expect(html).toContain('>one<');

      // And ONLY the table — nothing of what wraps it on the initial page.
      // If this test ran against the whole page (`renderRunPage` instead of
      // `renderRunLive`), its own `<div id="live">` and its title `<h2>` would
      // come inside the fragment, and the client would nest them a second time
      // inside themselves when doing `#live.innerHTML = html`. The SHAPE is
      // pinned, not the absence of known markers: a list of absences wouldn't
      // cover a new wrapper that slipped in tomorrow. `renderRunLive` literally
      // starts with `<div class="bigline` — which is exactly what "only what
      // goes inside #live" means.
      expect(html.startsWith('<div class="bigline')).toBe(true);
      expect(html).not.toContain('id="live"');
    } finally {
      await reader.cancel();
      server.stop(true);
    }
  });

  test('the content-type is text/event-stream', async () => {
    const { server, base } = await serve();
    const runId = RUNNING_RUN_ID;
    const res = await fetch(`${base}/sse/demo/${runId}`);
    try {
      expect(res.headers.get('content-type')).toContain('text/event-stream');
    } finally {
      await res.body!.cancel();
      server.stop(true);
    }
  });
});

describe('GET /sse/health', () => {
  test('it re-emits the dashboard when a new run appears', async () => {
    const { server, base, root } = await serve();
    const res = await fetch(`${base}/sse/health`);
    const reader = res.body!.getReader();
    try {
      // First event: the dashboard as it is.
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first).toContain('event: panel');

      // A new run appears on disk; the dashboard must be emitted again.
      const dir = join(root, '.runs', 'demo', '2026-08-30T01-00-00-000Z');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'run.json'), JSON.stringify({
        id: '2026-08-30T01-00-00-000Z', pipeline: 'demo', pipelineVersion: 1,
        status: 'success', startedAt: '2026-08-30T01:00:00.000Z', params: {}, steps: {},
      }));

      // It used to look for the string "2026-08-30" because the dashboard printed
      // `startedAt` raw. Now it says "yesterday" / "Aug 30", which depends on the
      // day the suite runs. It looks for the VERDICT, which is what changes: the
      // fixture came with a run in progress ("Running now") and the new run,
      // successful and more recent, leaves it up to date.
      expect(first).toContain('Running now');
      let received = '';
      for (let i = 0; i < 4 && !received.includes('Up to date'); i += 1) {
        received += new TextDecoder().decode((await reader.read()).value);
      }
      expect(received).toContain('Up to date');
      expect(received).not.toContain('Running now');
    } finally {
      await reader.cancel();
      server.stop(true);
    }
  }, 15_000);

  // The other half of the comparison `rendered === last`: with nothing running
  // nothing on the dashboard depends on the second, so after the first event
  // the stream stays quiet. A dashboard re-emitted every second hides the one
  // signal that says "something happened".
  test('with nothing running it does not re-emit every second', async () => {
    const { server, base, root } = await serve();
    // The fixture's run in progress, finished: nothing runs any more.
    const runJson = join(root, '.runs', 'demo', RUNNING_RUN_ID, 'run.json');
    await writeFile(runJson, (await Bun.file(runJson).text()).replace('"running"', '"success"'));
    const res = await fetch(`${base}/sse/health`);
    const reader = res.body!.getReader();
    try {
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first).toContain('event: panel');
      expect(first).not.toContain('Running now');

      const quiet = Symbol('quiet');
      const next = await Promise.race([
        reader.read(),
        new Promise<typeof quiet>((resolve) => setTimeout(() => resolve(quiet), 2_500)),
      ]);
      expect(next).toBe(quiet);
    } finally {
      await reader.cancel();
      server.stop(true);
    }
  }, 15_000);
});

/**
 * The step page's live client, run against a stand-in for the few DOM calls it
 * makes. Bun has no DOM, and what is worth pinning here is the arithmetic of
 * the lines (a delta that ends mid-line, the next one that finishes it), not
 * the browser. `innerHTML` is not on the stand-in at all: if the client ever
 * wrote the log through it, the text would land nowhere and these fail.
 */
describe('the live client on a step page', () => {
  type Node = { tag: string; textContent: string; className: string; children: Node[]; dataset: Record<string, string> };
  const node = (tag: string, text = '', className = ''): Node => ({ tag, textContent: text, className, children: [], dataset: {} });

  function boot(initial: Node[], open: boolean, lines: number, bytes: number) {
    const log = {
      ...node('pre'),
      children: initial,
      dataset: { open: open ? '1' : '0' },
      get lastElementChild(): Node | null { return this.children.at(-1) ?? null; },
      append(n: Node) { this.children.push(n); },
    };
    const count = { ...node('span'), dataset: { lines: String(lines), bytes: String(bytes) } };
    const listeners: Record<string, (e: { data: string }) => void> = {};
    class FakeEventSource {
      constructor(public url: string) {}
      addEventListener(name: string, fn: (e: { data: string }) => void) { listeners[name] = fn; }
      close() {}
    }
    const document = {
      getElementById: (id: string) => (id === 'log' ? log : id === 'logcount' ? count : null),
      createElement: (tag: string) => node(tag),
    };
    const html = layout('t', '', CHROME, { sse: '/sse/demo/r', stepId: 'one' });
    const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]!;
    new Function('document', 'EventSource', script)(document, FakeEventSource);
    const send = (stepId: string, delta: string) => listeners.log!({ data: JSON.stringify({ stepId, delta }) });
    return { log, count, send };
  }

  test('a delta becomes one element per line, toned like the server tones them', () => {
    const { log, count, send } = boot([node('span', 'first')], false, 1, 6);
    send('one', 'warning: careful\nerror: broke\nplain\n');
    expect(log.children.map((n) => [n.textContent, n.className])).toEqual([
      ['first', ''], ['warning: careful', 'warn'], ['error: broke', 'bad'], ['plain', ''],
    ]);
    expect(log.dataset.open).toBe('0');
    expect(count.textContent).toBe('4 lines · 42 B');
  });

  test('a line cut between two deltas is finished in place, not drawn twice', () => {
    const { log, send } = boot([node('span', 'done'), node('span', 'warn')], true, 2, 9);
    send('one', 'ing: half\nnext');
    expect(log.children.map((n) => [n.textContent, n.className])).toEqual([
      ['done', ''], ['warning: half', 'warn'], ['next', ''],
    ]);
    expect(log.dataset.open).toBe('1');
    send('one', ' and the rest\n');
    expect(log.children.map((n) => n.textContent)).toEqual(['done', 'warning: half', 'next and the rest']);
    expect(log.dataset.open).toBe('0');
  });

  test('another step\'s delta is ignored', () => {
    const { log, send } = boot([], false, 0, 0);
    send('two', 'not mine\n');
    expect(log.children).toEqual([]);
  });
});
