import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NotifyRecord, RunRecord, RunStatus, StepRecord } from './types.ts';

export type { NotifyRecord, RunRecord, RunStatus, StepRecord, StepStatus } from './types.ts';

/** Marcador con el que se sustituye cualquier valor de secreto. */
export const REDACTION = '«redactado»';

/**
 * Sustituye los valores de secreto que aparezcan en un texto. Se aplica a todo
 * lo que se escribe en disco o se muestra por pantalla.
 */
export function redactSecrets(text: string, secrets: string[]): string {
  let output = text;
  for (const secret of secrets) {
    if (!secret) continue;
    output = output.split(secret).join(REDACTION);
  }
  return output;
}

/**
 * Un id de run legible, ordenable lexicográficamente (el orden alfabético de
 * los ids coincide con el orden cronológico) y seguro para nombres de fichero
 * (sin `:`, que es un carácter ilegal en rutas de algunos sistemas de
 * archivos). Conserva los milisegundos: con solo segundos de resolución,
 * dos runs separados por pocos milisegundos producirían el mismo id y el
 * segundo pisaría el directorio del primero en `.runs/`. Dos runs dentro del
 * mismo milisegundo siguen colisionando, pero eso requiere concurrencia real
 * y se cubre con el lock de `guards/lock.ts`, no aquí.
 */
function newRunId(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

/**
 * Comprueba si un error de `fs` es ENOENT (ruta inexistente), el único caso
 * en que "no hay dato" es una respuesta válida. Cualquier otro error
 * (permisos, disco lleno, etc.) se deja propagar: confundir un fallo real de
 * infraestructura con un run que nunca existió llevaría a `resume`
 * a reiniciar en silencio en vez de detenerse ante el problema real.
 */
function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * Persistencia de ejecuciones en `<repoRoot>/.runs/<pipeline>/<runId>/`.
 * El estado se escribe tras cada paso, nunca solo al final: si el proceso
 * muere a media ejecución, lo ya completado sigue en disco y `resume` puede
 * retomarlo.
 */
export class RunStore {
  constructor(private readonly repoRoot: string) {}

  private runsDir(pipeline: string): string {
    return join(this.repoRoot, '.runs', pipeline);
  }

  private runDir(pipeline: string, runId: string): string {
    return join(this.runsDir(pipeline), runId);
  }

  async createRun(
    pipeline: string,
    pipelineVersion: number,
    params: Record<string, string>,
    now: Date = new Date(),
    forced = false,
  ): Promise<RunRecord> {
    const run: RunRecord = {
      id: newRunId(now),
      pipeline,
      pipelineVersion,
      status: 'running',
      startedAt: now.toISOString(),
      params,
      steps: {},
      // Solo cuando es cierto: así el run.json de una ejecución normal no
      // gana un campo que no dice nada.
      ...(forced ? { forced: true } : {}),
    };
    await mkdir(this.runDir(pipeline, run.id), { recursive: true });
    await this.persist(run);
    return run;
  }

  /** Escribe el resultado de un paso y actualiza run.json inmediatamente. */
  async writeStep(run: RunRecord, step: StepRecord): Promise<void> {
    run.steps[step.id] = step;
    await this.persist(run);
  }

  /** Guarda la transcripción de un paso, ya redactada por el llamante. */
  async writeStepLog(run: RunRecord, stepId: string, contents: string): Promise<void> {
    await writeFile(join(this.runDir(run.pipeline, run.id), `${stepId}.log`), contents, 'utf8');
  }

  async finishRun(run: RunRecord, status: RunStatus, skipReason?: string): Promise<void> {
    run.status = status;
    run.finishedAt = new Date().toISOString();
    if (skipReason !== undefined) run.skipReason = skipReason;
    run.totalCostUsd = Object.values(run.steps).reduce(
      (sum, step) => sum + (step.costUsd ?? 0),
      0,
    );
    await this.persist(run);
  }

  /**
   * Guarda el rastro del canal de notify en run.json. Se llama DESPUÉS de
   * `finishRun`: el canal solo se invoca con el run ya cerrado.
   */
  async writeNotify(run: RunRecord, notify: NotifyRecord): Promise<void> {
    run.notify = notify;
    await this.persist(run);
  }

  async readRun(pipeline: string, runId: string): Promise<RunRecord | undefined> {
    try {
      const text = await readFile(join(this.runDir(pipeline, runId), 'run.json'), 'utf8');
      return JSON.parse(text) as RunRecord;
    } catch (err) {
      if (isEnoent(err)) return undefined;
      throw err;
    }
  }

  /** Runs del pipeline, del más reciente al más antiguo. */
  async listRuns(pipeline: string): Promise<RunRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(this.runsDir(pipeline));
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
    const runs: RunRecord[] = [];
    for (const id of entries.sort().reverse()) {
      const run = await this.readRun(pipeline, id);
      if (run) runs.push(run);
    }
    return runs;
  }

  /** Último run con estado 'success'. Base del throttle: un run fallido no consume la ventana. */
  async lastSuccess(pipeline: string): Promise<RunRecord | undefined> {
    const runs = await this.listRuns(pipeline);
    return runs.find((r) => r.status === 'success');
  }

  /**
   * Último run que EJECUTÓ algo, con éxito o con fallo. Ancla de
   * `throttle`/`changed` cuando declaran `since: last_attempt`.
   *
   * Los runs saltados no cuentan, y ese matiz es el arreglo de un fallo
   * real: antes devolvía cualquier run terminado, así
   * que un pipeline con `since: last_attempt` empujaba el ancla de su propia
   * ventana con cada tick que él mismo saltaba — por guarda o por lock — y la
   * ventana no vencía nunca. `since: last_attempt` existe para espaciar
   * TRABAJO; su única diferencia con `last_success` es que cuenta también los
   * intentos fallidos, para que un pipeline que falla no machaque. Un run
   * saltado no hizo trabajo alguno, así que anclar en él es un contrasentido.
   */
  async lastAttempt(pipeline: string): Promise<RunRecord | undefined> {
    const runs = await this.listRuns(pipeline);
    return runs.find((r) => r.status === 'success' || r.status === 'failed');
  }

  /**
   * Escribe `run.json` de forma atómica: primero vuelca el contenido a un
   * fichero temporal en el mismo directorio del run (mismo sistema de
   * ficheros, para que el `rename` de abajo sea atómico de verdad y no
   * degrade a una copia si el temporal cayera en otro filesystem) y luego lo
   * renombra sobre el destino. Quien lea `run.json` en cualquier instante ve
   * siempre la versión anterior completa o la nueva completa, nunca un
   * fichero a medio escribir — justo el escenario que este módulo existe
   * para sobrevivir (un proceso que muere a media ejecución). El nombre del
   * temporal lleva un UUID para que dos escrituras concurrentes sobre el
   * mismo run no compartan fichero temporal entre sí. Si la escritura falla,
   * se intenta borrar el temporal para no dejar basura en `.runs/`.
   */
  private async persist(run: RunRecord): Promise<void> {
    const targetPath = join(this.runDir(run.pipeline, run.id), 'run.json');
    const tmpPath = `${targetPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmpPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
      await rename(tmpPath, targetPath);
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      throw err;
    }
  }
}
