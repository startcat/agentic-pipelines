/**
 * The read surface. `GET` only, nothing mutates and not a byte is written
 * outside the response: that is why it can stay open while a run is running
 * without being able to get in its way (`run.json` is already written with an
 * atomic `rename`, so every read sees a complete version).
 */
import { join } from 'node:path';
import { userHome } from '../cli/install-helpers.ts';
import { listPipelineNames, loadPipeline, type RepoContext } from '../cli/context.ts';
import { evaluateHealth } from '../health/evaluate.ts';
import { schedulerFor } from '../install/backend.ts';
import { RunStore } from '../runs/store.ts';
import {
  escapeHtml,
  layout,
  renderHealthPanel,
  renderPipelinePage,
  renderRunPage,
  renderRunLive,
  type HealthRow,
} from './render.ts';
import { createJobFactsCache } from './facts.ts';

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
 * Why a pipeline couldn't be read, said for THIS surface.
 *
 * `loadPipeline` is written for the CLI, where a person types the name and
 * getting it wrong is the normal case: "Pipeline "broken" does not exist.
 * Available: good, broken" is useful there. Here the name comes from walking
 * the disk, so the sentence contradicts itself —it names `broken` as absent
 * and as available at once— and reads as if the tool is broken.
 *
 * On the web the fact is different and simple: the folder is there, the file
 * is not. Any other failure (an unreadable YAML, a `name` that doesn't match
 * its directory) keeps its message: there the original text is the only thing
 * that says what needs fixing.
 *
 * Returns PLAIN TEXT, no tags: `renderHealthPanel` runs it through
 * `escapeHtml` like everything else.
 */
async function unreadableReason(ctx: RepoContext, name: string, err: unknown): Promise<string> {
  const yaml = join(ctx.root, 'pipelines', name, 'pipeline.yaml');
  if (!(await Bun.file(yaml).exists())) return 'the folder has no pipeline.yaml';
  return err instanceof Error ? err.message : String(err);
}

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

export function createRunStream(
  ctx: RepoContext,
  store: RunStore,
  name: string,
  runId: string,
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
          const rendered = renderRunLive(run);
          if (rendered !== lastRunJson) {
            lastRunJson = rendered;
            controller.enqueue(encoder.encode(sseEvent('panel', rendered)));
          }

          for (const step of Object.values(run.steps)) {
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

/** Cap of a log's HTML view. Above it, a link to `?raw=1`. */
const MAX_LOG_CHARS = 200_000;

export function createServer(ctx: RepoContext, opts: { port: number }): Bun.Server<undefined> {
  const store = new RunStore(ctx.root);
  const jobFacts = createJobFactsCache(JOB_FACTS_TTL_MS);

  async function healthRows(now: Date): Promise<HealthRow[]> {
    const rows: HealthRow[] = [];
    for (const name of await listPipelineNames(ctx)) {
      // Per-pipeline containment: `loadPipeline` and `store.listRuns` throw under
      // ORDINARY conditions (a half-authored `pipelines/<x>/` with no
      // `pipeline.yaml` — exactly when this viewer is most useful —, or a
      // `run.json` truncated mid-write). Without this try/catch, a single
      // broken pipeline took down `GET /` with a 500 for all the others.
      // `schedulerFor()` is inside for the same reason: on a platform without a
      // scheduler each row shows the error, but the dashboard doesn't 500.
      try {
        const backend = schedulerFor();
        const pipeline = await loadPipeline(ctx, name);
        const runs = await store.listRuns(name);
        const facts = await jobFacts.get(pipeline, ctx, now);
        const health = evaluateHealth(pipeline, runs, facts, now);
        rows.push({
          name,
          description: pipeline.description,
          health,
          totalSteps: pipeline.steps.length,
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
    return rows;
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
            const now = new Date();
            const rendered = renderHealthPanel(await healthRows(now), now);
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

  return Bun.serve({
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
          const now = new Date();
          return new Response(
            layout('pipelines', `<div id="live">${renderHealthPanel(await healthRows(now), now)}</div>`, {
              sse: '/sse/health',
            }),
            { headers: { 'content-type': 'text/html; charset=utf-8' } },
          );
        },
      },
      '/p/:name': {
        GET: async (req) => {
          const name = await resolvePipelineName(ctx, req.params.name);
          if (name === undefined) return notFound();
          const pipeline = await loadPipeline(ctx, name);
          const runs = await store.listRuns(name);
          const now = new Date();
          const health = evaluateHealth(pipeline, runs, await jobFacts.get(pipeline, ctx, now), now);
          return new Response(layout(name, renderPipelinePage(pipeline, runs, health, now, schedulerFor().label)), {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        },
      },
      '/p/:name/runs/:runId': {
        GET: async (req) => {
          const name = await resolvePipelineName(ctx, req.params.name);
          if (name === undefined) return notFound();
          const run = (await store.listRuns(name)).find((r) => r.id === req.params.runId);
          if (run === undefined) return notFound();
          return new Response(
            layout(`${name} / ${run.id}`, renderRunPage(name, run), {
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
          const run = (await store.listRuns(name)).find((r) => r.id === req.params.runId);
          // The step is validated against the run's OWN keys, not against the disk
          // nor the prototype chain: that way the URL's `:stepId` never becomes
          // part of a path unfiltered. With a bare `run.steps[id] === undefined`,
          // `constructor`, `toString` or `__proto__` returned 200 — they are not
          // own keys, but they are not `undefined` either. `Object.hasOwn` closes
          // that.
          if (run === undefined || !Object.hasOwn(run.steps, req.params.stepId)) return notFound();

          const path = join(ctx.root, '.runs', name, run.id, `${req.params.stepId}.log`);
          const file = Bun.file(path);
          const text = (await file.exists()) ? await file.text() : '(this step left no log)';

          if (new URL(req.url).searchParams.get('raw') === '1') {
            return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
          }
          const truncated = text.length > MAX_LOG_CHARS;
          const shown = truncated ? text.slice(-MAX_LOG_CHARS) : text;
          const rawUrl = `/p/${encodeURIComponent(name)}/runs/${encodeURIComponent(run.id)}/${encodeURIComponent(req.params.stepId)}?raw=1`;
          return new Response(
            layout(
              `${name} / ${run.id} / ${req.params.stepId}`,
              `<h2>${escapeHtml(req.params.stepId)}</h2>
               ${truncated ? `<p>Showing the tail. <a href="${rawUrl}">Full log as plain text</a>.</p>` : ''}
               <pre id="log">${escapeHtml(shown)}</pre>`,
              {
                // The live view only makes sense while the run is running, same
                // as on the run's page. It is passed its own stepId so the
                // client picks only its portion of the `log` event (see
                // `SSE_CLIENT` in render.ts).
                ...(run.status === 'running'
                  ? {
                      sse: `/sse/${encodeURIComponent(name)}/${encodeURIComponent(run.id)}`,
                      stepId: req.params.stepId,
                    }
                  : {}),
              },
            ),
            { headers: { 'content-type': 'text/html; charset=utf-8' } },
          );
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
          const run = (await store.listRuns(name)).find((r) => r.id === req.params.runId);
          if (run === undefined) return notFound();
          return new Response(createRunStream(ctx, store, name, run.id), {
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
}
