/**
 * El veredicto de salud de un pipeline: dos ejes independientes que se
 * vigilan entre sí.
 *
 * Módulo PURO a propósito, igual que `install/launchd.ts` y
 * `runner/fs-guard.ts`: sin E/S, sin subprocesos y sin reloj propio — el
 * instante entra como parámetro. Así la tabla de casos se ejecuta entera sin
 * levantar un servidor ni depender de macOS.
 */
import { cronToCalendarIntervals, stripGeneratedAt, type CalendarInterval } from '../install/launchd.ts';
import type { RunRecord } from '../runs/types.ts';
import type { Pipeline } from '../schema/pipeline.ts';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Periodo entre disparos, derivado de los horarios de launchd — NO volviendo
 * a interpretar cron, que solo hace `cronToCalendarIntervals`.
 *
 * La regla: la granularidad más gruesa que los horarios no fijan es la que
 * manda (si no fijan minuto, dispara cada minuto), repartida entre el número
 * de horarios. Es una aproximación deliberada: alimenta una VENTANA de
 * vigilancia, no una planificación — nadie decide cuándo correr con esto.
 */
export function triggerPeriodMs(intervals: CalendarInterval[]): number {
  if (intervals.length === 0) return DAY_MS;
  const someMissing = (key: keyof CalendarInterval): boolean =>
    intervals.some((interval) => interval[key] === undefined);

  const base = someMissing('Minute')
    ? MINUTE_MS
    : someMissing('Hour')
      ? HOUR_MS
      : !someMissing('Weekday')
        ? 7 * DAY_MS
        : !someMissing('Day') || !someMissing('Month')
          ? 30 * DAY_MS
          : DAY_MS;

  return Math.round(base / intervals.length);
}

export type TriggerHealth = 'no-trigger' | 'not-installed' | 'disabled' | 'drifted' | 'installed';

export type JobFacts = {
  loaded: boolean;
  disabled: boolean;
  /** Contenido del plist en disco, si existe. */
  plistOnDisk?: string;
  /** El plist que `install` generaría ahora mismo. */
  plistExpected?: string;
};

/**
 * Eje 1: ¿lo dispara alguien?
 *
 * `disabled` se evalúa ANTES que `not-installed` porque un job deshabilitado
 * suele estar también descargado, y de los dos diagnósticos el accionable es
 * el primero: dice qué hacer. Con el segundo, el operador reinstalaría y el
 * override del dominio seguiría mordiendo.
 */
export function evaluateTrigger(hasTriggers: boolean, job: JobFacts): TriggerHealth {
  if (!hasTriggers) return 'no-trigger';
  if (job.disabled) return 'disabled';
  if (!job.loaded) return 'not-installed';
  // Sin los dos lados no hay comparación posible, y afirmar una desviación
  // que no se ha podido medir sería inventarse un diagnóstico.
  if (job.plistOnDisk === undefined || job.plistExpected === undefined) return 'installed';
  return stripGeneratedAt(job.plistOnDisk) === stripGeneratedAt(job.plistExpected)
    ? 'installed'
    : 'drifted';
}

export type WorkHealth = 'never-worked' | 'working' | 'failing' | 'stuck' | 'silent';

export type Health = {
  trigger: TriggerHealth;
  work: WorkHealth;
  /** Ventana de vigilancia en ms; undefined si el pipeline no declara cadencia. */
  windowMs?: number;
  lastRun?: RunRecord;
  lastWork?: RunRecord;
  consecutiveSkips: number;
  /** `installed` + `silent`: launchd dice que dispara y no hay rastro de nada. */
  contradiction: boolean;
};

/** Un run que EJECUTÓ algo, con éxito o con fallo. Mismo criterio que `RunStore.lastAttempt`. */
function isWork(run: RunRecord): boolean {
  return run.status === 'success' || run.status === 'failed';
}

/**
 * Horarios de launchd para `triggers`, o `[]` si el cron usa sintaxis que
 * `cronToCalendarIntervals` no soporta (rangos, pasos). Ese pipeline no se
 * podría INSTALAR, pero sí puede existir en un pipeline.yaml del repo —
 * dejar que la excepción se propague tumbaría el panel entero, que es el
 * único sitio pensado para que nada falle en silencio. El resultado es el
 * mismo camino que un pipeline sin triggers: sin ventana, el eje de trabajo
 * solo puede ser `never-worked`, `failing` o `working`.
 */
function safeIntervals(pipeline: Pipeline): CalendarInterval[] {
  try {
    return pipeline.triggers.flatMap((t) => cronToCalendarIntervals(t.cron));
  } catch {
    return [];
  }
}

/**
 * Veredicto completo. `runs` llega del más reciente al más antiguo, tal como
 * lo devuelve `RunStore.listRuns()`.
 *
 * La ventana es DOS veces el periodo declarado. El margen es
 * deliberado: una noche perdida —un portátil cerrado— no debe pintar nada de
 * rojo; dos seguidas ya no es casualidad.
 */
export function evaluateHealth(
  pipeline: Pipeline,
  runs: RunRecord[],
  job: JobFacts,
  now: Date,
): Health {
  const hasTriggers = pipeline.triggers.length > 0;
  const trigger = evaluateTrigger(hasTriggers, job);

  const lastRun = runs[0];
  const lastWork = runs.find(isWork);

  let consecutiveSkips = 0;
  for (const run of runs) {
    if (run.status !== 'skipped') break;
    consecutiveSkips += 1;
  }

  const intervals = hasTriggers ? safeIntervals(pipeline) : [];
  const windowMs = hasTriggers && intervals.length > 0 ? 2 * triggerPeriodMs(intervals) : undefined;
  const inWindow = (run: RunRecord): boolean =>
    windowMs !== undefined && now.getTime() - new Date(run.startedAt).getTime() <= windowMs;

  let work: WorkHealth;
  if (windowMs === undefined) {
    // Sin cadencia declarada (o sin una que se sepa traducir) no hay disparo
    // que echar de menos: un pipeline manual no puede estar `stuck` ni `silent`.
    work = lastWork === undefined ? 'never-worked' : lastWork.status === 'failed' ? 'failing' : 'working';
  } else if (lastRun === undefined) {
    // `never-worked`, no `silent`: `silent` significa "corría y dejó de
    // correr", y decir eso de un pipeline recién instalado sería mentir.
    work = 'never-worked';
  } else if (!inWindow(lastRun)) {
    work = 'silent';
  } else if (lastWork !== undefined && inWindow(lastWork)) {
    work = lastWork.status === 'failed' ? 'failing' : 'working';
  } else {
    work = 'stuck';
  }

  return {
    trigger,
    work,
    windowMs,
    lastRun,
    lastWork,
    consecutiveSkips,
    // launchd afirma que dispara; el registro afirma que no arrancó nada.
    // Ninguna de las dos fuentes lo detecta sola.
    //
    // `drifted` cuenta igual que `installed`: un plist desviado SIGUE cargado
    // en launchd — la desviación dice que no es el que `install` generaría hoy,
    // no que no dispare. Exigir exactamente `installed` dejaba esa casilla sin
    // alarma y, peor, sin la cola del log del job: `server.ts` solo la lee
    // cuando este campo es cierto, y es el único rastro de un motor que muere
    // antes de escribir `run.json`.
    contradiction: (trigger === 'installed' || trigger === 'drifted') && work === 'silent',
  };
}
