import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRepoContext } from '../../src/cli/context.ts';
import { createServer } from '../../src/web/server.ts';

export const SKIPPED_RUN_ID = '2026-08-29T01-00-00-000Z';
export const RUNNING_RUN_ID = '2026-08-29T02-00-00-000Z';

// Fábrica de run.json de mentira, usada para montar RUNNING_RUN_ID con STEP.
function runJson(id: string, status: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id, pipeline: 'demo', pipelineVersion: 1, status,
    startedAt: `${id.slice(0, 10)}T${id.slice(11, 13)}:00:00.000Z`,
    params: {}, steps: {}, ...extra,
  });
}

const STEP = {
  uno: {
    id: 'uno', status: 'success', startedAt: '2026-08-29T01:00:00.000Z',
    durationMs: 12_000, outputs: {}, effects: [], attempts: 1,
  },
};

/**
 * Repo de datos de mentira: un pipeline manual, un run saltado (con un
 * motivo que lleva `<` y `>`, para probar el escapado) y un run en curso
 * (`RUNNING_RUN_ID`) con el paso `uno` y su `uno.log` — este último con
 * `<b>` en el contenido, para probar que la vista HTML del log escapa y que
 * `?raw=1` no.
 */
export async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pipes-web-'));
  await writeFile(join(root, 'pipelines.yaml'), 'channels: {}\n');
  await mkdir(join(root, 'pipelines', 'demo'), { recursive: true });
  await writeFile(
    join(root, 'pipelines', 'demo', 'pipeline.yaml'),
    'name: demo\ndescription: Un pipeline de prueba\nversion: 1\nsteps:\n  - id: uno\n    type: shell\n    run: "true"\n',
  );
  const runDir = join(root, '.runs', 'demo', '2026-08-29T01-00-00-000Z');
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, 'run.json'),
    JSON.stringify({
      id: '2026-08-29T01-00-00-000Z', pipeline: 'demo', pipelineVersion: 1,
      status: 'skipped', startedAt: '2026-08-29T01:00:00.000Z', params: {}, steps: {},
      skipReason: 'shell: <guarda> devolvió 1',
    }),
  );

  const runningDir = join(root, '.runs', 'demo', RUNNING_RUN_ID);
  await mkdir(runningDir, { recursive: true });
  await writeFile(join(runningDir, 'run.json'), runJson(RUNNING_RUN_ID, 'running', { steps: STEP }));
  await writeFile(join(runningDir, 'uno.log'), 'arrancando el paso\nsalida: <b>negrita</b>\n');

  return root;
}

/**
 * Repo de mentira ya servido: lo usan `server.test.ts`, `sse.test.ts` y
 * cualquier test posterior de la web, para no repetir en cada fichero el
 * `loadRepoContext` + `createServer` + montaje de la URL base.
 */
export async function serve(): Promise<{ server: Bun.Server<undefined>; base: string; root: string }> {
  const root = await fixture();
  const ctx = await loadRepoContext(root);
  const server = createServer(ctx, { port: 0 });
  return { server, base: `http://127.0.0.1:${server.port}`, root };
}

/**
 * Añade un pipeline a medio autoring: el directorio existe pero le falta
 * `pipeline.yaml`. Es exactamente el momento en que este visor es más útil
 * (a mitad de escribir un pipeline), y hoy es uno de los dos hostiles que tumban `GET /` con 500
 * porque `healthRows` no contiene el error de `loadPipeline`.
 */
export async function addUnparseablePipeline(root: string, name: string): Promise<void> {
  await mkdir(join(root, 'pipelines', name), { recursive: true });
}

/**
 * Añade un pipeline válido con un `run.json` truncado — el otro hostil del
 * de los dos: un fichero a medio escribir que `JSON.parse` no puede leer.
 * Sin contención, `store.listRuns` propaga el `SyntaxError` y tumba `healthRows`.
 */
export async function addPipelineWithTruncatedRun(
  root: string,
  name: string,
  runId: string,
): Promise<void> {
  await mkdir(join(root, 'pipelines', name), { recursive: true });
  await writeFile(
    join(root, 'pipelines', name, 'pipeline.yaml'),
    `name: ${name}\ndescription: Pipeline con un run corrupto\nversion: 1\nsteps:\n  - id: uno\n    type: shell\n    run: "true"\n`,
  );
  const dir = join(root, '.runs', name, runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'run.json'), '{"id": "trunc');
}

/**
 * Quita el bloque `<style>…</style>` de una página ya renderizada por
 * `layout()`. La hoja de estilos embebida (`render.ts`, `STYLES`) nombra
 * literalmente cada estado posible en sus selectores (`.s-success`,
 * `.s-failed`, `.s-skipped`, `.s-running`): una prueba que comprueba con
 * `toContain(<estado>)` contra la página completa puede dar un falso
 * positivo por la hoja de estilos —presente en TODA página que sirve este
 * servidor— y no por el dato que dice comprobar. Úsalo en cualquier prueba
 * cuya intención sea "el dato llegó a la página"; nunca en una que
 * compruebe la propia hoja de estilos o el layout.
 */
export function stripStyles(html: string): string {
  return html.replace(/<style>[\s\S]*?<\/style>/, '');
}
