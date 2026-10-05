import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildGraph } from '../graph/build.ts';
import { evaluateWhen } from '../expr/evaluate.ts';
import type { InterpolationScope } from '../params/resolve.ts';
import { RunStore, redactSecrets, type RunRecord, type StepRecord } from '../runs/store.ts';
import type { Pipeline, Step } from '../schema/pipeline.ts';
import { parseDuration } from '../guards/evaluate.ts';
import { runAgentStep, type AgentOutcome } from './agent.ts';
import { runShellStep } from './shell.ts';

export type RunOptions = {
  pipeline: Pipeline;
  repoRoot: string;
  store: RunStore;
  params: Record<string, string>;
  /** Valores de los secretos declarados en requires.env. */
  secrets: Record<string, string>;
  /** Credencial de Claude del `.env` del repo de datos, solo para los pasos `agent`. */
  agentAuth?: Record<string, string>;
  /** Run previo a retomar. Sus pasos correctos no se re-ejecutan. */
  resumeFrom?: RunRecord;
  /** El run se lanzó con `run --force`: queda anotado en el registro. */
  forced?: boolean;
  /** Inyectable para tests; por defecto el runner agéntico real. */
  agentRunner?: typeof runAgentStep;
  /** Inyectable para tests: evita esperas reales entre reintentos. */
  sleepFn?: (ms: number) => Promise<void>;
};

const PIPELINE_DIR = 'pipelines';

/** Espera con backoff exponencial: 1s, 2s, 4s… */
function backoffMs(attempt: number): number {
  return 1000 * 2 ** (attempt - 1);
}

async function executeOnce(
  step: Step,
  options: RunOptions,
  scope: InterpolationScope,
  pipelineDir: string,
): Promise<AgentOutcome> {
  const ctx = {
    scope,
    secrets: options.secrets,
    defaultCwd: pipelineDir,
    timeoutMs: parseDuration(step.timeout),
  };

  if (step.type === 'shell') return runShellStep(step, ctx);

  const promptText = await readFile(join(pipelineDir, step.prompt), 'utf8');
  const runner = options.agentRunner ?? runAgentStep;
  return runner(step, {
    ...ctx,
    repoRoot: options.repoRoot,
    promptText,
    mcpServers: options.pipeline.mcpServers,
    agentAuth: options.agentAuth,
  });
}

/**
 * Ejecuta una tentativa de un paso, atrapando cualquier excepción que pueda
 * escapar antes de que exista un `StepOutcome`. `interpolate()`
 * (params/resolve.ts) lanza deliberadamente si una referencia `{{...}}` no
 * se puede resolver, y tanto `runShellStep` como `runAgentStep` la invocan
 * sin capturarla — es una decisión de esos módulos, no un descuido: la
 * responsabilidad de convertir esa excepción en un fallo de paso (en vez de
 * abortar TODO el run sin capturar) es de este orquestador. El mensaje se
 * redacta por si acaso: es texto que este módulo compone a partir de una
 * excepción, no un `outcome` que un runner ya haya redactado.
 */
async function attempt(
  step: Step,
  options: RunOptions,
  scope: InterpolationScope,
  pipelineDir: string,
): Promise<AgentOutcome> {
  const started = Date.now();
  try {
    return await executeOnce(step, options, scope, pipelineDir);
  } catch (err) {
    const secretValues = Object.values(options.secrets);
    return {
      ok: false,
      error: redactSecrets((err as Error).message, secretValues),
      transient: false,
      log: '',
      durationMs: Date.now() - started,
    };
  }
}

/**
 * Ejecuta un pipeline paso a paso.
 *
 * El estado se persiste tras cada paso, nunca solo al final: si el proceso
 * muere a mitad, `resumeFrom` puede retomar exactamente donde se quedó.
 */
export async function runPipeline(options: RunOptions): Promise<RunRecord> {
  const { pipeline, store } = options;

  if (options.resumeFrom && options.resumeFrom.pipelineVersion !== pipeline.version) {
    throw new Error(
      `No se puede reanudar: el run es de la versión ${options.resumeFrom.pipelineVersion} ` +
        `y el pipeline está en la versión ${pipeline.version}. Ejecuta uno nuevo.`,
    );
  }

  const graph = buildGraph(pipeline);
  const byId = new Map(pipeline.steps.map((s) => [s.id, s]));

  // El cwd por defecto de un paso es el directorio del propio pipeline (donde
  // viven pipeline.yaml y los prompts .md). En uso real ya existe porque de
  // ahí se cargó el pipeline; se crea aquí también porque los tests de este
  // módulo construyen el Pipeline en memoria (parsePipeline sobre un string)
  // sin que ese directorio llegue a existir en disco, y `Bun.spawn` falla si
  // su `cwd` no existe.
  const pipelineDir = join(options.repoRoot, PIPELINE_DIR, pipeline.name);
  await mkdir(pipelineDir, { recursive: true });

  // No reutilizar el objeto `steps` de `resumeFrom` tal cual: este run va a
  // escribir en `run.steps` según avanza, y hacerlo sobre la misma
  // referencia mutaría también el RunRecord que el llamante conserva.
  const run: RunRecord = options.resumeFrom
    ? { ...options.resumeFrom, status: 'running', steps: { ...options.resumeFrom.steps } }
    : await store.createRun(
        pipeline.name,
        pipeline.version,
        options.params,
        new Date(),
        options.forced ?? false,
      );

  const scope: InterpolationScope = { params: options.params, steps: {} };
  for (const [id, record] of Object.entries(run.steps)) {
    // Solo se importan las salidas de lo ya completado con éxito. Los pasos
    // `failed`/`skipped` del run anterior NO se marcan aquí como bloqueados:
    // en esta pasada se les da una oportunidad real de ejecutarse (por eso
    // no se hace `continue` para ellos más abajo), y su resultado de fallo o
    // salto —y el de sus dependientes— se recalcula desde cero en esta
    // misma pasada. Sembrarlo con el estado del intento anterior dejaría a un
    // paso que ahora tiene éxito marcado como "fallido" para sus
    // dependientes, solo porque lo estuvo en un intento previo.
    if (record.status === 'success') scope.steps[id] = record.outputs;
  }

  // Cascada de saltos: id de paso bloqueado -> id del paso que lo bloquea.
  // Se construye hacia delante con `graph.dependents` (nunca re-derivada de
  // `graph.dependencies`) justo cuando cada paso queda resuelto como
  // `skipped` o `failed`, así que por construcción es transitiva: si "a"
  // bloquea a "b", en cuanto "b" se marca `skipped` este mismo mecanismo
  // propaga el salto a los dependientes de "b" (p. ej. "c"), atribuyendo
  // cada salto a su bloqueador más cercano.
  const cascaded = new Map<string, string>();
  function propagateSkip(id: string): void {
    for (const dependent of graph.dependents.get(id) ?? []) {
      if (!cascaded.has(dependent)) cascaded.set(dependent, id);
    }
  }

  /**
   * Escribe el `StepRecord` de un paso saltado y propaga la cascada a sus
   * dependientes. Único punto de escritura para los dos motivos de salto
   * (bloqueado por cascada, `when` falso): ambos producen exactamente el
   * mismo `StepRecord`, solo cambia el texto de `skipReason`.
   */
  async function skipStep(id: string, startedAt: string, reason: string): Promise<void> {
    await store.writeStep(run, {
      id,
      status: 'skipped',
      startedAt,
      durationMs: 0,
      outputs: {},
      effects: [],
      attempts: 0,
      skipReason: reason,
    });
    propagateSkip(id);
  }

  // Distinto de "hubo algún fallo": solo cuenta un fallo cuya política NO
  // fuera on_error: continue. Como on_error: continue es lo único que deja
  // seguir el bucle tras un fallo (on_error: stop, el default, corta con
  // `break`), antes esto colapsaba "hubo algún fallo" y "hubo un fallo
  // tolerado explícitamente" en el mismo resultado — rompía el ancla de
  // throttle (since: last_success) para cualquier pipeline que usara
  // on_error: continue con intención.
  let sawHardFailure = false;

  for (const id of graph.order) {
    if (run.steps[id]?.status === 'success') continue;

    const step = byId.get(id)!;
    const startedAt = new Date().toISOString();

    const blocker = cascaded.get(id);
    if (blocker) {
      await skipStep(id, startedAt, `el paso "${blocker}" no produjo salida`);
      continue;
    }

    if (step.when && !evaluateWhen(step.when, scope)) {
      await skipStep(id, startedAt, `when: ${step.when}`);
      continue;
    }

    let outcome = await attempt(step, options, scope, pipelineDir);
    let attempts = 1;

    while (
      !outcome.ok &&
      attempts <= step.retry.attempts &&
      (step.retry.on === 'any' || outcome.transient)
    ) {
      await (options.sleepFn ?? Bun.sleep)(backoffMs(attempts));
      outcome = await attempt(step, options, scope, pipelineDir);
      attempts += 1;
    }

    const record: StepRecord = {
      id,
      status: outcome.ok ? 'success' : 'failed',
      startedAt,
      durationMs: outcome.durationMs,
      outputs: outcome.ok ? outcome.outputs : {},
      effects: step.effects,
      attempts,
      costUsd: outcome.costUsd,
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens,
      toolsUsed: outcome.toolsUsed,
      error: outcome.ok ? undefined : outcome.error,
      // Presente solo para pasos `agent` (el hook PreToolUse de
      // `runAgentStep`); `undefined` para pasos `shell`, que no tienen hook.
      // Persistirlo aquí es lo que hace visible la capa detectiva del
      // sandbox de filesystem vía `pipelines show` — sin esto,
      // `AgentOutcome.denials` se calculaba correctamente pero se perdía
      // entre el valor de retorno de `runAgentStep` y `.runs/`.
      denials: outcome.denials,
    };

    await store.writeStep(run, record);
    // `outcome.log` ya llega redactado desde el propio runner (shell.ts y
    // agent.ts redactan en cada camino de retorno): NO se redacta una segunda
    // vez aquí. Un segundo filtro invita a relajar el primero.
    await store.writeStepLog(run, id, outcome.log);

    if (outcome.ok) {
      scope.steps[id] = outcome.outputs;
      continue;
    }

    if (step.onError !== 'continue') sawHardFailure = true;
    propagateSkip(id);
    if (step.onError === 'stop') break;
  }

  // `always:` corre siempre que se llega aquí — es decir, después de que
  // las guardas de pipeline ya hayan dejado arrancar `runPipeline` (si una
  // guarda salta el run entero, cli/index.ts nunca llama a esta función, así
  // que no hay ningún efecto secundario que limpiar). Cada paso se registra
  // como cualquier otro, pero su resultado NUNCA toca `sawHardFailure`: es
  // información de diagnóstico, no parte del contrato de éxito/fallo del
  // run.
  for (const step of pipeline.always) {
    const startedAt = new Date().toISOString();
    const outcome = await attempt(step, options, scope, pipelineDir);
    await store.writeStep(run, {
      id: step.id,
      status: outcome.ok ? 'success' : 'failed',
      startedAt,
      durationMs: outcome.durationMs,
      outputs: outcome.ok ? outcome.outputs : {},
      effects: [],
      attempts: 1,
      costUsd: outcome.costUsd,
      error: outcome.ok ? undefined : outcome.error,
    });
    await store.writeStepLog(run, step.id, outcome.log);
  }

  await store.finishRun(run, sawHardFailure ? 'failed' : 'success');
  return run;
}
