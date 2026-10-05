/**
 * El cruce de los dos ejes, dicho en una frase. Módulo PURO: `evaluateHealth`
 * ya decidió; aquí solo se elige cómo contarlo.
 *
 * La regla de fondo: la página NUNCA muestra el valor crudo del enum, muestra
 * la frase. Y el vocabulario es UNO — `silent` es «mudo» en toda la interfaz,
 * nunca «silencio».
 */
import type { Health, TriggerHealth, WorkHealth } from '../health/evaluate.ts';

export type Tono = 'ok' | 'warn' | 'bad' | 'live' | 'neutral';
export type Veredicto = { line: string; tono: Tono; trigger: string; work: string };
export type Resumen = { line: string; tono: Tono; sub: string };

const DISPARO: Record<TriggerHealth, string> = {
  'no-trigger': 'sin cron',
  'not-installed': 'no instalado',
  disabled: 'deshabilitado',
  drifted: 'desviado',
  installed: 'cargado',
};

const TRABAJO: Record<WorkHealth, string> = {
  'never-worked': 'nunca ha trabajado',
  working: 'trabajando',
  failing: 'fallando',
  stuck: 'atascado',
  silent: 'mudo',
};

export const etiquetaDisparo = (t: TriggerHealth): string => DISPARO[t];
export const etiquetaTrabajo = (w: WorkHealth): string => TRABAJO[w];

const noches = (n: number): string => `${n} ${n === 1 ? 'noche' : 'noches'}`;

export function veredicto(health: Health, pasosTotales: number): Veredicto {
  const trigger = etiquetaDisparo(health.trigger);
  const work = etiquetaTrabajo(health.work);
  const di = (line: string, tono: Tono): Veredicto => ({ line, tono, trigger, work });

  // La alarma primero, por encima incluso de un run corriendo: es la única
  // casilla que existe para verse antes que nada. `contradiction` ya cubre
  // `installed` y `drifted` — los dos significan "launchd lo tiene cargado".
  if (health.contradiction) return di('CARGADO Y SIN PRODUCIR NADA', 'bad');

  // Después el eje de disparo, cuando dice que no lo dispara nadie: da igual lo
  // bien que fuera el último trabajo si desde entonces no lo lanza nada.
  if (health.trigger === 'not-installed') {
    return di('No está instalado en launchd. Nadie lo dispara.', 'bad');
  }
  if (health.trigger === 'disabled') {
    return di('Deshabilitado en launchd. Nadie lo dispara.', 'bad');
  }

  const manual = health.trigger === 'no-trigger';

  if (health.lastRun?.status === 'running') {
    const hechos = Object.keys(health.lastRun.steps).length;
    return di(`Corriendo ahora — ${hechos} de ${pasosTotales} pasos.`, 'live');
  }

  switch (health.work) {
    case 'silent':
      // INALCANZABLE por construcción, y está aquí para que el `switch` sea
      // exhaustivo: `silent` exige ventana, la ventana exige cadencia, y con
      // cadencia el disparo solo puede ser `installed`/`drifted` (los dos ya
      // salieron por `contradiction`), `not-installed` o `disabled` (los dos ya
      // salieron arriba). Si algún día se alcanza, el texto no miente.
      return di('Sin un solo run en la ventana de vigilancia.', 'bad');
    case 'stuck':
      return di(`Salta ${noches(health.consecutiveSkips)} seguidas sin llegar a trabajar.`, 'warn');
    case 'failing':
      return di(manual ? 'Falló la última vez que se lanzó a mano.' : 'Falló la última pasada.', 'bad');
    case 'never-worked':
      return di(
        manual ? 'No se ha lanzado nunca. Se lanza a mano.' : 'Instalado, pero no ha corrido todavía.',
        'neutral',
      );
    case 'working':
      return di(manual ? 'Al día. Se lanza a mano y la última vez salió bien.' : 'Al día.', 'ok');
  }
}

/**
 * La respuesta de tres segundos, arriba del todo. Va DENTRO de `#live`: el
 * stream de salud sustituye ese nodo entero, y un titular fuera de él nacería
 * rancio a la primera pasada.
 */
export function resumenPanel(healths: readonly Health[], rotos: number): Resumen {
  const sub = [
    `${healths.length + rotos} pipelines`,
    ...(rotos > 0 ? [`${rotos} ilegible${rotos === 1 ? '' : 's'}`] : []),
  ].join(' · ');

  if (healths.length === 0 && rotos === 0) {
    return { line: 'Este repo no tiene ningún pipeline.', tono: 'neutral', sub: '' };
  }
  if (healths.length === 0) return { line: 'Ningún pipeline se puede leer.', tono: 'bad', sub };

  const alarmas = healths.filter((h) => h.contradiction).length;
  if (alarmas > 0) {
    return {
      line:
        alarmas === 1
          ? 'Un pipeline está cargado y no produce nada.'
          : `${alarmas} pipelines están cargados y no producen nada.`,
      tono: 'bad',
      sub: `${sub} · ${alarmas} en alarma`,
    };
  }

  // `stuck` no es alarma, pero diez noches saltando tampoco es "todo en orden":
  // es la vecina de la casilla que este panel existe para cazar.
  const parados = healths.filter((h) => h.work === 'silent' || h.work === 'stuck').length;
  if (parados > 0) {
    return {
      line:
        parados === 1
          ? 'Un pipeline lleva noches sin trabajar.'
          : `${parados} pipelines llevan noches sin trabajar.`,
      tono: 'warn',
      sub,
    };
  }

  const fallando = healths.filter((h) => h.work === 'failing').length;
  if (fallando > 0) {
    return {
      line:
        fallando === 1
          ? 'Un pipeline falló su última pasada.'
          : `${fallando} pipelines fallaron su última pasada.`,
      tono: 'bad',
      sub,
    };
  }

  const corriendo = healths.filter((h) => h.lastRun?.status === 'running').length;
  return {
    line: corriendo > 0 ? 'Todo en orden. Una pasada corriendo ahora mismo.' : 'Todo en orden.',
    tono: 'ok',
    sub: `${sub} · ninguno mudo`,
  };
}
