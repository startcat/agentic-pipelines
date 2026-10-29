/**
 * The read surface. `GET` only, nothing mutates and not a byte is written
 * outside the response: that is why it can stay open while a run is running
 * without being able to get in its way (`run.json` is already written with an
 * atomic `rename`, so every read sees a complete version).
 */
import { join } from 'node:path';
import { userHome } from '../cli/install-helpers.ts';
import { listPipelineNames, loadPipeline, type RepoContext } from '../cli/context.ts';
import { evaluateHealth, type JobFacts } from '../health/evaluate.ts';
import { schedulerFor } from '../install/backend.ts';
import { RunStore } from '../runs/store.ts';
import type { RunRecord } from '../runs/types.ts';
import type { Pipeline } from '../schema/pipeline.ts';
import {
  layout,
  renderHealthPanel,
  renderPipelinePage,
  renderRunPage,
  renderRunLive,
  renderUnreadableRun,
  type Chrome,
  type HealthRow,
  type RunInfo,
} from './render.ts';
import { costReport, spendOf, type CostRun } from './costs.ts';
import {
  collectOverview,
  costRunsFor,
  isRunObject,
  readRuns,
  reasonOf,
  runIds,
  schedulerLabel,
  unreadableReason,
} from './collect.ts';
import { createJobFactsCache } from './facts.ts';
import { renderCostsPage } from './render-costs.ts';
import { MAX_LOG_CHARS, renderStepLogPage } from './render-log.ts';
import { nextRun } from './schedule.ts';

const JOB_FACTS_TTL_MS = 30_000;

/** Last lines of the job's log. Empty string if it doesn't exist or is empty. */
const JOB_LOG_TAIL_BYTES = 4_000;

async function tailJobLog(pipelineName: string): Promise<string> {
  const file = Bun.file(schedulerFor().logPath(userHome(), pipelineName));
  if (!(await file.exists()) || file.size === 0) return '';
  return file.slice(Math.max(0, file.size - JOB_LOG_TAIL_BYTES), file.size).text();
}

/**
 * Resolves a pipeline name that comes from the URL. BY LOOKUP in the real list:
 * anything not there is a 404. The URL string is never concatenated into a
 * file path — `loadPipeline` does build a path from the name, so passing it
 * whatever arrives unfiltered would be the bug.
 */
async function resolvePipelineName(ctx: RepoContext, raw: string): Promise<string | undefined> {
  const names = await listPipelineNames(ctx);
  return names.find((name) => name === raw);
}

const notFound = (): Response => new Response('No such page.', { status: 404 });

/**
 * One run, by LOOKUP of the URL's id among the directory names, then read
 * on its own: a broken sibling does not hide it, and a broken
 * run says why instead of turning into a 500.
 */
async function findRun(
  ctx: RepoContext,
  store: RunStore,
  name: string,
  raw: string,
): Promise<{ kind: 'run'; run: RunRecord } | { kind: 'missing' } | { kind: 'unreadable'; id: string; reason: string }> {
  let id: string | undefined;
  try {
    id = (await runIds(ctx, name)).find((candidate) => candidate === raw);
  } catch (err) {
    return { kind: 'unreadable', id: raw, reason: reasonOf(err) };
  }
  if (id === undefined) return { kind: 'missing' };
  try {
    const run = await store.readRun(name, id);
    if (run === undefined) return { kind: 'missing' };
    if (!isRunObject(run)) return { kind: 'unreadable', id, reason: 'run.json is not a run record' };
    return { kind: 'run', run };
  } catch (err) {
    return { kind: 'unreadable', id, reason: reasonOf(err) };
  }
}

/** A run's steps, or none when a malformed `run.json` has no object there. */
const stepsOf = (run: RunRecord): Record<string, unknown> =>
  typeof run.steps === 'object' && run.steps !== null ? run.steps : {};

const POLL_MS = 1_000;

/**
 * An SSE event. The data goes through `JSON.stringify` because an HTML
 * fragment (or a log delta) contains newlines, and in SSE a blank line ENDS
 * the event: without wrapping it, multi-line data would split the stream.
 * It accepts `unknown` because the `log` event sends an object (`{ stepId,
 * delta }`, see `createRunStream`), not a bare string. The client does the
 * matching `JSON.parse` (see `SSE_CLIENT` in render.ts).
 */
function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * What a run's page takes from the pipeline's current YAML (see `RunInfo`).
 * In a `try`: the YAML may have broken since the run, and the run is still
 * worth showing — without chips and caps, not as a 500.
 */
export async function runInfo(ctx: RepoContext, name: string): Promise<RunInfo | undefined> {
  let pipeline: Pipeline;
  try {
    pipeline = await loadPipeline(ctx, name);
  } catch {
    return undefined;
  }
  const types: Record<string, string> = {};
  const caps: Record<string, number> = {};
  for (const step of pipeline.steps) {
    types[step.id] = step.type;
    if (step.type === 'agent' && step.maxCostUsd !== undefined) caps[step.id] = step.maxCostUsd;
  }
  return { types, caps, totalSteps: pipeline.steps.length };
}

export function createRunStream(
  ctx: RepoContext,
  store: RunStore,
  name: string,
  runId: string,
  info?: RunInfo,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const logDir = join(ctx.root, '.runs', name, runId);
  // Offset per step: only what is NEW is sent. An `agent` step's `.log` can
  // be large; resending it whole every second is not an option.
  const offsets = new Map<string, number>();
  let lastRunJson = '';
  let timer: ReturnType<typeof setInterval> | undefined;

  return new ReadableStream({
    start(controller) {
      const tick = async (): Promise<void> => {
        // Without this try/catch, a corrupt `run.json` appearing while the tab
        // is open would be an UNCAUGHT rejection inside `setInterval` — and
        // Bun kills the whole process over that, not just this stream. For a
        // surface whose thesis is that silence must not look like success,
        // dying silently is exactly the mode it can't have.
        try {
          const run = await store.readRun(name, runId);
          if (run === undefined) return;

          // Only what goes inside `#live`, not the whole page: the client receives
          // it with `innerHTML`, so sending `renderRunPage` would nest a second
          // copy of the breadcrumb and of the container itself inside itself on
          // every tick.
          const rendered = renderRunLive(run, info);
          if (rendered !== lastRunJson) {
            lastRunJson = rendered;
            controller.enqueue(encoder.encode(sseEvent('panel', rendered)));
          }

          for (const step of Object.values(stepsOf(run)) as RunRecord['steps'][string][]) {
            const file = Bun.file(join(logDir, `${step.id}.log`));
            if (!(await file.exists())) continue;
            const size = file.size;
            // The first time the size is noted without sending anything: what was
            // already on screen when the stream was opened is not resent.
            const seen = offsets.get(step.id);
            if (seen === undefined) {
              offsets.set(step.id, size);
              continue;
            }
            if (size <= seen) continue;
            const delta = await file.slice(seen, size).text();
            offsets.set(step.id, size);
            // Scoped: the step's id travels with the delta (the same event feeds
            // a run's page: steps and log). Without it, the step's page couldn't
            // tell its own delta from that of any other step running at the
            // same time in the same run.
            controller.enqueue(encoder.encode(sseEvent('log', { stepId: step.id, delta })));
          }

          // It closes by itself: the live view only makes sense while the run is running.
          if (run.status !== 'running') {
            controller.enqueue(encoder.encode(sseEvent('done', '')));
            if (timer) clearInterval(timer);
            controller.close();
          }
        } catch (err) {
          console.error(`[web] error refreshing the stream for ${name}/${runId}:`, err);
        }
      };
      timer = setInterval(() => void tick(), POLL_MS);
      void tick();
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });
}

/**
 * The fonts the stylesheet names, BY LOOKUP in a fixed table: the URL's
 * `:file` is a key, never a piece of a path: /fonts/:file only serves the
 * files of a fixed list. Anything else in the folder — the licence, a
 * stray file — is not served. The paths are built from `import.meta.dir`, so
 * they point at the engine's own copy whatever directory `pipelines web` was
 * started from.
 */
const FONT_FILES: Record<string, string> = {
  'young-serif-400.woff2': join(import.meta.dir, 'fonts', 'young-serif-400.woff2'),
  'lexend-var.woff2': join(import.meta.dir, 'fonts', 'lexend-var.woff2'),
  'azeret-mono-var.woff2': join(import.meta.dir, 'fonts', 'azeret-mono-var.woff2'),
};

export function createServer(ctx: RepoContext, opts: { port: number }): Bun.Server<undefined> {
  const store = new RunStore(ctx.root);
  const jobFacts = createJobFactsCache(JOB_FACTS_TTL_MS);

  // Per request and not once at start-up: the port is the one Bun really bound
  // (`port: 0` in the tests picks a free one), and the scheduler label reads
  // the environment, which can change under a running server in the tests.
  const chrome = (nav?: Chrome['nav']): Chrome => ({
    nav,
    port: server.port ?? opts.port,
    repoRoot: ctx.root,
    home: userHome(),
    scheduler: schedulerLabel(),
  });

  /**
   * The dashboard's rows and, from the very same reads, the runs the spend
   * strip adds up: `.runs/` is walked once per tick, not once for the rows and
   * again for the money. The reads and the verdicts are `collectOverview`'s,
   * the same ones `pipelines status --json` prints; this only adds what the
   * page draws on top.
   */
  async function healthRows(
    now: Date,
  ): Promise<{ rows: HealthRow[]; costRuns: CostRun[]; unreadableRuns: number }> {
    const overview = await collectOverview(ctx, await listPipelineNames(ctx), now, jobFacts.get);
    const rows: HealthRow[] = [];
    for (const entry of overview.entries) {
      if ('error' in entry) {
        rows.push(entry);
        continue;
      }
      const { name, pipeline, health, next } = entry;
      // Its own containment, like `collectOverview`'s: on a platform without a
      // scheduler `schedulerFor()` throws, and that row shows the error but
      // the dashboard doesn't 500.
      try {
        const backend = schedulerFor();
        rows.push({
          name,
          description: pipeline.description,
          health,
          steps: pipeline.steps.map((step) => step.id),
          next,
          scheduler: { label: backend.label, logPath: backend.logPath(userHome(), name) },
          // The job's log is read ONLY here. It is the only trace of an engine
          // that dies before writing `run.json`, and it is not a general source
          // — reading it always would make it a second truth that can
          // contradict `.runs/`.
          ...(health.contradiction ? { jobLogTail: await tailJobLog(name) } : {}),
        });
      } catch (err) {
        rows.push({ name, error: await unreadableReason(ctx, name, err) });
      }
    }
    return { rows, costRuns: overview.costRuns, unreadableRuns: overview.unreadableRuns };
  }

  /**
   * What goes inside `#live` on `/`, for the page and for every tick of its
   * stream alike. The strip only exists with at least one pipeline: an empty
   * repo has nothing to spend on.
   */
  async function renderOverview(now: Date): Promise<string> {
    const { rows, costRuns, unreadableRuns } = await healthRows(now);
    // `spendOf`, not `costReport`: this runs on every tick of every open tab,
    // and the strip only needs two months' sums.
    const spend =
      rows.length > 0
        ? { ...spendOf(costRuns, now), ...(unreadableRuns > 0 ? { unreadable: unreadableRuns } : {}) }
        : undefined;
    return renderHealthPanel(rows, now, spend);
  }

  /**
   * The runs of every pipeline, for the costs page. Same read as `healthRows`
   * (`readRuns`, one run at a time): a truncated `run.json` costs its own
   * run, not the pipeline's whole spend, and `unreadable` names the pipelines
   * that lost one so the page can say so. It does not need `loadPipeline`: a
   * half-authored pipeline that already ran has real costs.
   */
  async function costRows(): Promise<{ runs: CostRun[]; pipelines: string[]; unreadable: string[] }> {
    const runs: CostRun[] = [];
    const pipelines: string[] = [];
    const unreadable: string[] = [];
    for (const name of await listPipelineNames(ctx)) {
      const read = await readRuns(ctx, store, name);
      for (const run of costRunsFor(name, read.runs, read.ids)) runs.push(run);
      pipelines.push(name);
      if (read.unreadable.length > 0) unreadable.push(name);
    }
    return { runs, pipelines, unreadable };
  }

  function createHealthStream(): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let last = '';
    let timer: ReturnType<typeof setInterval> | undefined;

    return new ReadableStream({
      start(controller) {
        const tick = async (): Promise<void> => {
          // `healthRows` already holds each pipeline's error separately; this
          // try/catch is the second net — any other failure (e.g. in
          // `renderHealthPanel`) degrades the stream instead of ending the
          // process: an uncaught rejection inside `setInterval` is an unhandled
          // rejection, and Bun kills the whole process over that.
          try {
            // `jobFacts` caches with a 30 s TTL, so this one-second tick does NOT
            // ask the scheduler every second.
            const rendered = await renderOverview(new Date());
            if (rendered === last) return;
            last = rendered;
            controller.enqueue(encoder.encode(sseEvent('panel', rendered)));
          } catch (err) {
            console.error('[web] error refreshing the health dashboard:', err);
          }
        };
        timer = setInterval(() => void tick(), POLL_MS);
        void tick();
      },
      // Unlike a run's stream, this one doesn't close by itself: it lives
      // as long as the tab is open.
      cancel() {
        if (timer) clearInterval(timer);
      },
    });
  }

  const server: Bun.Server<undefined> = Bun.serve({
    // Fixed and with no flag: exposing this to the network is a different
    // design, with its own conversation about auth.
    hostname: '127.0.0.1',
    port: opts.port,
    routes: {
      // Per-method form, not the bare handler: with the bare handler Bun serves
      // the page for ANY verb (POST, PUT...), which violates this surface's one
      // rule — "every route is GET". The default handler (`fetch`) keeps
      // returning 404 for any other route and, with this form, also for a
      // non-GET verb on a route that does exist.
      '/': {
        GET: async () => {
          return new Response(
            layout('pipelines', `<div id="live">${await renderOverview(new Date())}</div>`, chrome('overview'), {
              sse: '/sse/health',
            }),
            { headers: { 'content-type': 'text/html; charset=utf-8' } },
          );
        },
      },
      '/costs': {
        GET: async () => {
          const now = new Date();
          const { runs, pipelines, unreadable } = await costRows();
          return new Response(
            layout('Costs', renderCostsPage(costReport(runs, pipelines, now), now, unreadable), chrome('costs')),
            { headers: { 'content-type': 'text/html; charset=utf-8' } },
          );
        },
      },
      '/p/:name': {
        GET: async (req) => {
          const name = await resolvePipelineName(ctx, req.params.name);
          if (name === undefined) return notFound();
          const pipeline = await loadPipeline(ctx, name);
          const { runs, ids, unreadable } = await readRuns(ctx, store, name);
          const now = new Date();
          // `schedulerFor()` throws on a platform without a scheduler. The
          // page is still worth drawing — steps, guards, history — and the
          // verdict says what could not be asked instead of a 500. The facts
          // it falls back to are never shown as such: with `schedulerError`
          // the renderer prints a dash for the trigger and for NEXT.
          let facts: JobFacts = { loaded: false, disabled: false };
          let schedulerError: string | undefined;
          try {
            facts = await jobFacts.get(pipeline, ctx, now);
          } catch (err) {
            schedulerError = reasonOf(err);
          }
          const health = evaluateHealth(pipeline, runs, facts, now);
          const next = nextRun(health.trigger, pipeline.triggers.map((t) => t.cron), now);
          // The month from the same read (`readRuns`), the same reduction
          // (`costRunsFor`) and the same in-order sum as /costs and the
          // overview's strip, so the three can't disagree.
          const month = spendOf(costRunsFor(name, runs, ids), now).month;
          const extra = {
            ...(next.kind === 'at' && next.at !== '' && schedulerError === undefined ? { next: new Date(next.at) } : {}),
            monthLabel: month.label,
            monthTotal: month.total,
            monthRuns: month.runs,
            ...(schedulerError !== undefined ? { schedulerError } : {}),
            ...(unreadable.length > 0 ? { unreadable } : {}),
          };
          // `schedulerLabel()` and not `schedulerFor().label`: on a platform
          // without a scheduler the verdict says "—" instead of a 500.
          // No nav item is marked under /p/: the crumb says where you are.
          return new Response(
            layout(name, renderPipelinePage(pipeline, runs, health, now, schedulerLabel(), extra), chrome()),
            { headers: { 'content-type': 'text/html; charset=utf-8' } },
          );
        },
      },
      '/p/:name/runs/:runId': {
        GET: async (req) => {
          const name = await resolvePipelineName(ctx, req.params.name);
          if (name === undefined) return notFound();
          const found = await findRun(ctx, store, name, req.params.runId);
          if (found.kind === 'missing') return notFound();
          // A 500 with the viewer's own page: the request was fine, the file on
          // disk is not, and the page says which and why.
          if (found.kind === 'unreadable') {
            return new Response(
              layout(`${name} / ${found.id}`, renderUnreadableRun(name, found.id, found.reason), chrome()),
              { status: 500, headers: { 'content-type': 'text/html; charset=utf-8' } },
            );
          }
          const run = found.run;
          const info = await runInfo(ctx, name);
          return new Response(
            layout(`${name} / ${run.id}`, renderRunPage(name, run, info), chrome(), {
              // The live view only makes sense while the run is running.
              ...(run.status === 'running'
                ? { sse: `/sse/${encodeURIComponent(name)}/${encodeURIComponent(run.id)}` }
                : {}),
            }),
            { headers: { 'content-type': 'text/html; charset=utf-8' } },
          );
        },
      },
      '/p/:name/runs/:runId/:stepId': {
        GET: async (req) => {
          const name = await resolvePipelineName(ctx, req.params.name);
          if (name === undefined) return notFound();
          const found = await findRun(ctx, store, name, req.params.runId);
          // Same as the run's page: a run.json on disk that can't be read is
          // said, with the reason, and not passed off as a missing page.
          if (found.kind === 'unreadable') {
            return new Response(
              layout(`${name} / ${found.id}`, renderUnreadableRun(name, found.id, found.reason), chrome()),
              { status: 500, headers: { 'content-type': 'text/html; charset=utf-8' } },
            );
          }
          const run = found.kind === 'run' ? found.run : undefined;
          // The step is validated against the run's OWN keys, not against the disk
          // nor the prototype chain: that way the URL's `:stepId` never becomes
          // part of a path unfiltered. With a bare `run.steps[id] === undefined`,
          // `constructor`, `toString` or `__proto__` returned 200 — they are not
          // own keys, but they are not `undefined` either. `Object.hasOwn` closes
          // that.
          if (run === undefined || !Object.hasOwn(stepsOf(run), req.params.stepId)) return notFound();
          const stepId = req.params.stepId;

          const path = join(ctx.root, '.runs', name, run.id, `${stepId}.log`);
          const file = Bun.file(path);
          const exists = await file.exists();
          const text = exists ? await file.text() : '';

          if (new URL(req.url).searchParams.get('raw') === '1') {
            return new Response(exists ? text : '(this step left no log)', {
              headers: { 'content-type': 'text/plain; charset=utf-8' },
            });
          }
          // The run's steps in the order the YAML declares them, so "previous"
          // and "next" walk the pipeline as written. Steps the run has and the
          // YAML no longer declares go after, in the run's order; with no
          // readable YAML that is all of them.
          const info = await runInfo(ctx, name);
          const recorded = Object.keys(stepsOf(run));
          const declared = info === undefined ? [] : Object.keys(info.types).filter((id) => recorded.includes(id));
          const order = [...declared, ...recorded.filter((id) => !declared.includes(id))];
          const type = info !== undefined && Object.hasOwn(info.types, stepId) ? info.types[stepId] : undefined;
          const body = renderStepLogPage({
            pipeline: name,
            run,
            stepId,
            ...(type !== undefined ? { type } : {}),
            order,
            text,
            truncated: text.length > MAX_LOG_CHARS,
          });
          return new Response(
            layout(`${name} / ${run.id} / ${stepId}`, body, chrome(), {
              // The live view only makes sense while the run is running, same
              // as on the run's page. It is passed its own stepId so the
              // client picks only its portion of the `log` event (see
              // `SSE_CLIENT` in render.ts).
              ...(run.status === 'running'
                ? { sse: `/sse/${encodeURIComponent(name)}/${encodeURIComponent(run.id)}`, stepId }
                : {}),
            }),
            { headers: { 'content-type': 'text/html; charset=utf-8' } },
          );
        },
      },
      '/fonts/:file': {
        GET: (req) => {
          const path = Object.hasOwn(FONT_FILES, req.params.file) ? FONT_FILES[req.params.file] : undefined;
          if (path === undefined) return notFound();
          return new Response(Bun.file(path), {
            headers: {
              'content-type': 'font/woff2',
              // A font file never changes under the same name: replacing a
              // face means a new file name in FONT_FILES and in the sheet. So
              // the browser can keep it for good and not ask on every page.
              'cache-control': 'public, max-age=31536000, immutable',
            },
          });
        },
      },
      '/sse/health': {
        GET: () =>
          new Response(createHealthStream(), {
            headers: {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              connection: 'keep-alive',
            },
          }),
      },
      '/sse/:name/:runId': {
        GET: async (req) => {
          const name = await resolvePipelineName(ctx, req.params.name);
          if (name === undefined) return notFound();
          const found = await findRun(ctx, store, name, req.params.runId);
          if (found.kind !== 'run') return notFound();
          const run = found.run;
          return new Response(createRunStream(ctx, store, name, run.id, await runInfo(ctx, name)), {
            headers: {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              connection: 'keep-alive',
            },
          });
        },
      },
    },
    fetch: () => new Response('No such page.', { status: 404 }),
  });
  return server;
}
