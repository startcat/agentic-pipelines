import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRepoContext } from '../../src/cli/context.ts';
import { createServer } from '../../src/web/server.ts';

export const SKIPPED_RUN_ID = '2026-08-29T01-00-00-000Z';
export const RUNNING_RUN_ID = '2026-08-29T02-00-00-000Z';

// Fake run.json factory, used to build RUNNING_RUN_ID with STEP.
function runJson(id: string, status: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id, pipeline: 'demo', pipelineVersion: 1, status,
    startedAt: `${id.slice(0, 10)}T${id.slice(11, 13)}:00:00.000Z`,
    params: {}, steps: {}, ...extra,
  });
}

const STEP = {
  one: {
    id: 'one', status: 'success', startedAt: '2026-08-29T01:00:00.000Z',
    durationMs: 12_000, outputs: {}, effects: [], attempts: 1,
  },
};

/**
 * Fake data repo: a manual pipeline, a skipped run (with a reason that
 * carries `<` and `>`, to test the escaping) and a run in progress
 * (`RUNNING_RUN_ID`) with the step `one` and its `one.log` — the latter with
 * `<b>` in the content, to test that the log's HTML view escapes and that
 * `?raw=1` doesn't.
 */
export async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pipes-web-'));
  await writeFile(join(root, 'pipelines.yaml'), 'channels: {}\n');
  await mkdir(join(root, 'pipelines', 'demo'), { recursive: true });
  await writeFile(
    join(root, 'pipelines', 'demo', 'pipeline.yaml'),
    'name: demo\ndescription: A test pipeline\nversion: 1\nsteps:\n  - id: one\n    type: shell\n    run: "true"\n',
  );
  const runDir = join(root, '.runs', 'demo', '2026-08-29T01-00-00-000Z');
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, 'run.json'),
    JSON.stringify({
      id: '2026-08-29T01-00-00-000Z', pipeline: 'demo', pipelineVersion: 1,
      status: 'skipped', startedAt: '2026-08-29T01:00:00.000Z', params: {}, steps: {},
      skipReason: 'shell: <guard> returned 1',
    }),
  );

  const runningDir = join(root, '.runs', 'demo', RUNNING_RUN_ID);
  await mkdir(runningDir, { recursive: true });
  await writeFile(join(runningDir, 'run.json'), runJson(RUNNING_RUN_ID, 'running', { steps: STEP }));
  await writeFile(join(runningDir, 'one.log'), 'starting the step\noutput: <b>bold</b>\n');

  return root;
}

/**
 * Fake repo already served: used by `server.test.ts`, `sse.test.ts` and
 * any later web test, so as not to repeat in every file the
 * `loadRepoContext` + `createServer` + base URL setup.
 */
export async function serve(): Promise<{ server: Bun.Server<undefined>; base: string; root: string }> {
  const root = await fixture();
  const ctx = await loadRepoContext(root);
  const server = createServer(ctx, { port: 0 });
  return { server, base: `http://127.0.0.1:${server.port}`, root };
}

/**
 * Adds a half-authored pipeline: the directory exists but `pipeline.yaml`
 * is missing. It is exactly the moment when this viewer is most useful
 * (halfway through writing a pipeline), and today it is one of the two hostile
 * cases that take down `GET /` with a 500 because `healthRows` doesn't
 * contain `loadPipeline`'s error.
 */
export async function addUnparseablePipeline(root: string, name: string): Promise<void> {
  await mkdir(join(root, 'pipelines', name), { recursive: true });
}

/**
 * Adds a valid pipeline with a truncated `run.json` — the other of the two
 * hostile cases: a half-written file that `JSON.parse` can't read. Without
 * containment, `store.listRuns` propagates the `SyntaxError` and takes down
 * `healthRows`.
 */
export async function addPipelineWithTruncatedRun(
  root: string,
  name: string,
  runId: string,
): Promise<void> {
  await mkdir(join(root, 'pipelines', name), { recursive: true });
  await writeFile(
    join(root, 'pipelines', name, 'pipeline.yaml'),
    `name: ${name}\ndescription: Pipeline with a corrupt run\nversion: 1\nsteps:\n  - id: one\n    type: shell\n    run: "true"\n`,
  );
  const dir = join(root, '.runs', name, runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'run.json'), '{"id": "trunc');
}

/**
 * Strips the `<style>…</style>` block from a page already rendered by
 * `layout()`. The embedded stylesheet (`render.ts`, `STYLES`) literally names
 * every possible state in its selectors (`.s-success`, `.s-failed`,
 * `.s-skipped`, `.s-running`): a test that checks with `toContain(<state>)`
 * against the whole page can give a false positive from the stylesheet
 * —present in EVERY page this server serves— and not from the datum it claims
 * to check. Use it in any test whose intent is "the datum reached the page";
 * never in one that checks the stylesheet or the layout itself.
 */
export function stripStyles(html: string): string {
  return html.replace(/<style>[\s\S]*?<\/style>/, '');
}
