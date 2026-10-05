/**
 * La superficie de lectura. Solo `GET`, nada muta y no se escribe un byte
 * fuera de la respuesta: por eso puede estar abierta mientras corre un run sin
 * poder estorbarlo (`run.json` ya se escribe con `rename`
 * atómico, así que toda lectura ve una versión completa).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { listPipelineNames, loadPipeline, type RepoContext } from '../cli/context.ts';
import { evaluateHealth } from '../health/evaluate.ts';
import { logPathFor } from '../install/launchd.ts';
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

/** Últimas líneas del log del job. Cadena vacía si no existe o está vacío. */
const JOB_LOG_TAIL_BYTES = 4_000;

async function tailJobLog(pipelineName: string): Promise<string> {
  const file = Bun.file(logPathFor(homedir(), pipelineName));
  if (!(await file.exists()) || file.size === 0) return '';
  return file.slice(Math.max(0, file.size - JOB_LOG_TAIL_BYTES), file.size).text();
}

/**
 * Resuelve un nombre de pipeline que viene de la URL. POR BÚSQUEDA en la lista
 * real: lo que no esté, es 404. Nunca se concatena la cadena de la URL en una
 * ruta de fichero — `loadPipeline` sí construye una ruta
 * con el nombre, así que pasarle lo que llegue sin filtrar sería el bug.
 */
async function resolvePipelineName(ctx: RepoContext, raw: string): Promise<string | undefined> {
  const names = await listPipelineNames(ctx);
  return names.find((name) => name === raw);
}

const notFound = (): Response => new Response('No existe esa página.', { status: 404 });

/**
 * Por qué un pipeline no se pudo leer, dicho para ESTA superficie.
 *
 * `loadPipeline` está escrito para el CLI, donde el nombre lo teclea una
 * persona y equivocarse es el caso normal: «No existe el pipeline "roto".
 * Disponibles: bueno, roto» es útil ahí. Aquí el nombre sale de recorrer el
 * disco, así que la frase se contradice —nombra a `roto` como ausente y como
 * disponible a la vez— y se lee como que la herramienta está rota.
 *
 * En la web el hecho es otro y es simple: la carpeta está, el fichero no.
 * Cualquier otro fallo (un YAML ilegible, un `name` que no cuadra con su
 * directorio) conserva su mensaje: ahí el texto original es lo único que dice
 * qué hay que corregir.
 *
 * Devuelve TEXTO PLANO, sin etiquetas: `renderHealthPanel` lo pasa por
 * `escapeHtml` como todo lo demás.
 */
async function motivoIlegible(ctx: RepoContext, name: string, err: unknown): Promise<string> {
  const yaml = join(ctx.root, 'pipelines', name, 'pipeline.yaml');
  if (!(await Bun.file(yaml).exists())) return 'la carpeta no tiene pipeline.yaml';
  return err instanceof Error ? err.message : String(err);
}

const POLL_MS = 1_000;

/**
 * Un evento SSE. El dato va con `JSON.stringify` porque un fragmento de HTML
 * (o un delta de log) lleva saltos de línea, y en SSE una línea en blanco
 * TERMINA el evento: sin envolverlo, un dato multilínea partiría el stream.
 * Acepta `unknown` porque el evento `log` manda un objeto (`{ stepId, delta
 * }`, ver `createRunStream`), no una cadena suelta. El cliente hace el
 * `JSON.parse` correspondiente (ver `SSE_CLIENT` en render.ts).
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
  // Desplazamiento por paso: solo se manda lo NUEVO. Un
  // `.log` de un paso `agent` puede ser grande; reenviarlo entero cada
  // segundo no es una opción.
  const offsets = new Map<string, number>();
  let lastRunJson = '';
  let timer: ReturnType<typeof setInterval> | undefined;

  return new ReadableStream({
    start(controller) {
      const tick = async (): Promise<void> => {
        // Sin este try/catch, un `run.json` corrupto que apareciera mientras
        // la pestaña está abierta sería un rechazo NO capturado dentro de
        // `setInterval` — y Bun mata el proceso entero por eso, no solo este
        // stream. Para una superficie cuya tesis es que el silencio no debe
        // parecer éxito, morir en silencio es justo el modo que no puede tener.
        try {
          const run = await store.readRun(name, runId);
          if (run === undefined) return;

          // Solo lo que va dentro de `#live`, no la página entera: el cliente
          // lo recibe con `innerHTML`, así que mandar `renderRunPage` anidaría
          // una segunda copia de la miga de pan y del propio contenedor dentro
          // de sí misma en cada tick.
          const rendered = renderRunLive(run);
          if (rendered !== lastRunJson) {
            lastRunJson = rendered;
            controller.enqueue(encoder.encode(sseEvent('panel', rendered)));
          }

          for (const step of Object.values(run.steps)) {
            const file = Bun.file(join(logDir, `${step.id}.log`));
            if (!(await file.exists())) continue;
            const size = file.size;
            // La primera vez se toma nota del tamaño sin mandar nada: lo que ya
            // estaba en pantalla cuando se abrió el stream no se reenvía.
            const seen = offsets.get(step.id);
            if (seen === undefined) {
              offsets.set(step.id, size);
              continue;
            }
            if (size <= seen) continue;
            const delta = await file.slice(seen, size).text();
            offsets.set(step.id, size);
            // Con ámbito: el id del paso viaja junto al delta (el
            // mismo evento alimenta la página de un run: pasos y log). Sin él, la página
            // del paso no podría distinguir su propio delta del de cualquier
            // otro paso corriendo a la vez en el mismo run.
            controller.enqueue(encoder.encode(sseEvent('log', { stepId: step.id, delta })));
          }

          // Se cierra solo: el vivo solo tiene sentido mientras el run corre.
          if (run.status !== 'running') {
            controller.enqueue(encoder.encode(sseEvent('done', '')));
            if (timer) clearInterval(timer);
            controller.close();
          }
        } catch (err) {
          console.error(`[web] error refrescando el stream de ${name}/${runId}:`, err);
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

/** Tope de la vista HTML de un log. Por encima, enlace a `?raw=1`. */
const MAX_LOG_CHARS = 200_000;

export function createServer(ctx: RepoContext, opts: { port: number }): Bun.Server<undefined> {
  const store = new RunStore(ctx.root);
  const jobFacts = createJobFactsCache(JOB_FACTS_TTL_MS);

  async function healthRows(now: Date): Promise<HealthRow[]> {
    const rows: HealthRow[] = [];
    for (const name of await listPipelineNames(ctx)) {
      // Contención por pipeline: `loadPipeline` y `store.listRuns` lanzan en
      // condiciones ORDINARIAS (un `pipelines/<x>/` a medio autoring sin
      // `pipeline.yaml` — justo cuando este visor es más útil —, o un
      // `run.json` truncado a media escritura). Sin este try/catch, un solo
      // pipeline roto tumbaba `GET /` con 500 para todos los demás.
      try {
        const pipeline = await loadPipeline(ctx, name);
        const runs = await store.listRuns(name);
        const facts = await jobFacts.get(pipeline, ctx, now);
        const health = evaluateHealth(pipeline, runs, facts, now);
        rows.push({
          name,
          description: pipeline.description,
          health,
          pasosTotales: pipeline.steps.length,
          // El log del job SOLO se lee aquí. Es el único
          // rastro de un motor que muere antes de escribir `run.json`, y no es
          // una fuente general — leerlo siempre lo convertiría en una segunda
          // verdad que puede contradecir a `.runs/`.
          ...(health.contradiction ? { jobLogTail: await tailJobLog(name) } : {}),
        });
      } catch (err) {
        rows.push({ name, error: await motivoIlegible(ctx, name, err) });
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
          // `healthRows` ya contiene el error de cada pipeline por separado;
          // este try/catch es la segunda red — cualquier otro fallo (p. ej. en
          // `renderHealthPanel`) degrada el stream en vez de terminar el
          // proceso: un rechazo sin capturar dentro de `setInterval` es un
          // unhandled rejection, y Bun mata el proceso entero por eso.
          try {
            // `jobFacts` cachea con TTL de 30 s, así que este tick de un segundo
            // NO lanza un `launchctl` por segundo.
            const ahora = new Date();
            const rendered = renderHealthPanel(await healthRows(ahora), ahora);
            if (rendered === last) return;
            last = rendered;
            controller.enqueue(encoder.encode(sseEvent('panel', rendered)));
          } catch (err) {
            console.error('[web] error refrescando el panel de salud:', err);
          }
        };
        timer = setInterval(() => void tick(), POLL_MS);
        void tick();
      },
      // A diferencia del stream de un run, este no se cierra solo: vive
      // mientras la pestaña esté abierta.
      cancel() {
        if (timer) clearInterval(timer);
      },
    });
  }

  return Bun.serve({
    // Fijo y sin flag: exponer esto a la red es otro diseño, con su
    // conversación sobre auth.
    hostname: '127.0.0.1',
    port: opts.port,
    routes: {
      // Forma por-método, no el handler suelto: con el handler suelto Bun
      // responde la página a CUALQUIER verbo (POST, PUT...), lo que viola
      // la única regla de esta superficie — "toda ruta es GET". El handler por defecto (`fetch`) sigue
      // devolviendo 404 para cualquier otra ruta y, con esta forma, también
      // para un verbo no-GET sobre una ruta que sí existe.
      '/': {
        GET: async () => {
          const ahora = new Date();
          return new Response(
            layout('pipelines', `<div id="live">${renderHealthPanel(await healthRows(ahora), ahora)}</div>`, {
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
          return new Response(layout(name, renderPipelinePage(pipeline, runs, health, now)), {
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
              // El vivo solo tiene sentido mientras el run está corriendo.
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
          // El paso se valida contra las claves PROPIAS del run, no contra el
          // disco ni contra la cadena de prototipos: así el `:stepId` de la
          // URL nunca llega a formar parte de una ruta sin filtrar. Con
          // `run.steps[id] === undefined` a secas, `constructor`, `toString`
          // o `__proto__` devolvían 200 — no son claves propias, pero
          // tampoco son `undefined`. `Object.hasOwn` cierra eso.
          if (run === undefined || !Object.hasOwn(run.steps, req.params.stepId)) return notFound();

          const path = join(ctx.root, '.runs', name, run.id, `${req.params.stepId}.log`);
          const file = Bun.file(path);
          const text = (await file.exists()) ? await file.text() : '(este paso no dejó log)';

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
               ${truncated ? `<p>Mostrando la cola. <a href="${rawUrl}">Completo en texto plano</a>.</p>` : ''}
               <pre id="log">${escapeHtml(shown)}</pre>`,
              {
                // El vivo solo tiene sentido mientras el run está corriendo,
                // igual que en la página del run. Se le pasa su propio
                // stepId para que el cliente escoja solo su porción del
                // evento `log` (ver `SSE_CLIENT` en render.ts).
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
    fetch: () => new Response('No existe esa página.', { status: 404 }),
  });
}
