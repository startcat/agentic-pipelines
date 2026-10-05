import { collectSecrets, type RepoContext } from '../cli/context.ts';
import { composeEnv } from '../runner/shell.ts';
import type { Pipeline } from '../schema/pipeline.ts';
import { redactSecrets } from '../runs/store.ts';
import type { NotifyRecord, RunRecord } from '../runs/types.ts';

/**
 * Firma inyectable para tests: ejecuta el comando del canal, devuelve su
 * exit code y su salida (stdout+stderr, sin redactar — la redacción la hace
 * `dispatchNotify`, que es quien conoce los secretos del canal).
 */
export type SpawnChannelFn = (
  command: string,
  env: Record<string, string>,
  cwd: string,
) => Promise<{ code: number; log: string }>;

/** Tope de la cola de salida del canal que se guarda en run.json. */
const NOTIFY_LOG_MAX_CHARS = 2000;

/**
 * Un canal que sale con código distinto de 0 lanza esto: el mensaje para la
 * consola, y el rastro para que el llamante lo persista igualmente — un
 * envío fallido es justo el que más falta hace poder leer después.
 */
export class ChannelFailedError extends Error {
  constructor(message: string, readonly notify: NotifyRecord) {
    super(message);
    this.name = 'ChannelFailedError';
  }
}

// Una notificación debe ser rápida; un canal colgado (p. ej. un `curl` contra
// un endpoint atascado) no debe sostener indefinidamente el lock del
// pipeline, porque `dispatchNotify` corre dentro de la región que `withLock`
// protege en `cli/index.ts` — mismo patrón de kill-timer que
// `runShellStep` en `runner/shell.ts`, sin config por canal (no hay campo en
// el esquema para eso) así que aquí es una constante fija.
const NOTIFY_TIMEOUT_MS = 60_000;

async function defaultSpawnChannel(
  command: string,
  env: Record<string, string>,
  cwd: string,
): Promise<{ code: number; log: string }> {
  // stdout y stderr se capturan, no se descartan: son la única prueba de que
  // el correo salió (o de por qué no), y antes se perdían — ver
  // `NotifyRecord` en runs/types.ts.
  const proc = Bun.spawn(['sh', '-c', command], { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), NOTIFY_TIMEOUT_MS);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, log: stdout + stderr };
}

export type NotifyOptions = {
  /**
   * Instante ISO del último run con éxito del pipeline, si lo hay — lo
   * resuelve el llamante (`cli/index.ts`) porque es quien tiene el
   * `RunStore` a mano, y así esta función se testea sin tocar disco.
   * Debe consultarse DESPUÉS de cerrar el run actual, para que un run que
   * acaba de ir bien cuente como su propio último éxito.
   */
  lastSuccessAt?: string;
  spawnChannel?: SpawnChannelFn;
};

/**
 * Tope del motivo derivado. Un error de un paso `agent` puede ocupar miles de
 * caracteres, y un correo que no se puede leer no informa de nada.
 */
const MAX_REASON_LENGTH = 500;

/**
 * Motivo de un run fallido, derivado de los pasos que fallaron.
 *
 * El motor solo rellenaba `PIPELINES_NOTIFY_REASON` para los saltos por
 * guarda, así que un correo de fallo llegaba sin decir qué había fallado y
 * obligaba a ir a mirar `.runs/` a mano. Los `error` de cada paso ya vienen
 * redactados en origen (`redactOutcome` en `runner/shell.ts`, `redactSecrets`
 * en `runner/orchestrate.ts`), así que llevarlos al canal no abre ninguna vía
 * de fuga nueva.
 *
 * Cadena vacía si no hay ningún paso en `failed` — posible si algo revienta
 * antes o entre pasos. Devolverla vacía deja que el canal caiga a su propio
 * fallback en vez de inventar un motivo.
 */
export function failureReason(run: RunRecord): string {
  const parts: string[] = [];
  for (const step of Object.values(run.steps)) {
    if (step.status !== 'failed') continue;
    parts.push(`${step.id}: ${step.error ?? '(sin mensaje de error)'}`);
  }
  const reason = parts.join('; ');
  return reason.length > MAX_REASON_LENGTH
    ? `${reason.slice(0, MAX_REASON_LENGTH)}…`
    : reason;
}

/**
 * Decide si el pipeline lleva demasiado tiempo sin un solo run con éxito.
 *
 * Un pipeline que nunca ha tenido un éxito se considera stale en cuanto
 * declara la ventana: está instalado y todavía no ha producido nada, que es
 * justo lo que hay que saber.
 */
function isStale(pipeline: Pipeline, run: RunRecord, lastSuccessAt?: string): boolean {
  const window = pipeline.notify?.staleAfter;
  if (!window) return false;
  if (!lastSuccessAt) return true;
  const match = /^(\d+)(s|m|h)$/.exec(window);
  if (!match) return false; // el esquema ya lo valida; aquí solo estrecha el tipo
  const unitMs = match[2] === 's' ? 1000 : match[2] === 'm' ? 60_000 : 3_600_000;
  const elapsed = new Date(run.startedAt).getTime() - new Date(lastSuccessAt).getTime();
  return elapsed > Number(match[1]) * unitMs;
}

/**
 * Ejecuta el canal declarado en `notify:` del pipeline cuando `run.status`
 * coincide con `notify.on`, o cuando el pipeline lleva más de
 * `notify.stale_after` sin un solo run con éxito. Best-effort: cualquier
 * fallo (canal inexistente en `pipelines.yaml`, comando que sale con código
 * distinto de 0) se propaga como excepción — es responsabilidad del llamante
 * decidir cómo registrarlo, nunca cambia el resultado del run en sí, que ya
 * está cerrado cuando esto se invoca. Devuelve el rastro del canal
 * (`NotifyRecord`) cuando lo invoca, para que el llamante lo persista; si el
 * canal falla, el rastro viaja dentro de `ChannelFailedError`.
 *
 * Se llama desde TODOS los caminos que cierran un run, incluidos el
 * guard-skip y el lock-blocked de `cli/index.ts`. Antes no: eso hacía que un
 * pipeline saltado noche tras noche no avisara a nadie, y un pipeline real
 * estuvo diez días sin ejecutarse en silencio. Que un salto rutinario no
 * genere ruido lo decide ahora el pipeline con `on:`/`stale_after`, no la
 * ausencia de la llamada.
 *
 * Mientras siga stale avisa en cada run, sin estado de deduplicación: el
 * aviso se apaga solo en cuanto el pipeline vuelve a correr en verde.
 */
export async function dispatchNotify(
  pipeline: Pipeline,
  run: RunRecord,
  ctx: RepoContext,
  options: NotifyOptions = {},
): Promise<NotifyRecord | undefined> {
  if (!pipeline.notify) return undefined;
  if (run.status === 'running') return undefined; // nunca debería llegar aquí; estrecha el tipo
  const stale = isStale(pipeline, run, options.lastSuccessAt);
  if (!pipeline.notify.on.includes(run.status) && !stale) return undefined;

  const channel = ctx.config.channels[pipeline.notify.channel];
  if (!channel) {
    throw new Error(
      `El pipeline "${pipeline.name}" declara notify.channel "${pipeline.notify.channel}", ` +
        `que no existe en pipelines.yaml.`,
    );
  }

  const secrets = collectSecrets(ctx, channel.env);
  // `composeEnv(secrets)` va al final: si un canal declarase un secreto con
  // el mismo nombre que una de las variables PIPELINES_NOTIFY_*, debe ganar
  // el valor declarado — mismo convenio que documenta `composeAgentEnv` en
  // `runner/shell.ts`.
  const env = {
    PIPELINES_NOTIFY_NAME: pipeline.name,
    PIPELINES_NOTIFY_RUN_ID: run.id,
    PIPELINES_NOTIFY_STATUS: run.status,
    // `skipReason` manda cuando existe: un run saltado no tiene pasos fallidos
    // que mirar, y su motivo real es la guarda que lo paró.
    PIPELINES_NOTIFY_REASON:
      run.skipReason ?? (run.status === 'failed' ? failureReason(run) : ''),
    // '1' o '' — un canal en shell puede ramificar con `[ -n "$..." ]` sin
    // parsear nada. `LAST_SUCCESS` va vacío si el pipeline no ha tenido
    // nunca un run con éxito.
    PIPELINES_NOTIFY_STALE: stale ? '1' : '',
    PIPELINES_NOTIFY_LAST_SUCCESS: options.lastSuccessAt ?? '',
    ...composeEnv(secrets),
  };
  const { code, log } = await (options.spawnChannel ?? defaultSpawnChannel)(channel.run, env, ctx.root);
  const record: NotifyRecord = {
    channel: pipeline.notify.channel,
    code,
    at: new Date().toISOString(),
    log: notifyLogTail(redactSecrets(log, Object.values(secrets))),
  };
  if (code !== 0) {
    throw new ChannelFailedError(
      `El canal "${pipeline.notify.channel}" (notify de "${pipeline.name}") salió con código ${code}.`,
      record,
    );
  }
  return record;
}

/** La cola de la salida del canal, sin el salto final y con tope. */
function notifyLogTail(log: string): string {
  const trimmed = log.trimEnd();
  return trimmed.length > NOTIFY_LOG_MAX_CHARS ? trimmed.slice(-NOTIFY_LOG_MAX_CHARS) : trimmed;
}
