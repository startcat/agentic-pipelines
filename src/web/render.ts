/**
 * HTML renderizado en el servidor. Sin plantillas, sin dependencias y sin
 * lógica de dominio: quién está sano lo decide `health/evaluate.ts`; aquí solo
 * se pinta.
 */
import { homedir } from 'node:os';
import type { Health } from '../health/evaluate.ts';
import { logPathFor } from '../install/launchd.ts';
import type { RunRecord } from '../runs/store.ts';
import type { Guard, Pipeline } from '../schema/pipeline.ts';
import { STYLES } from './styles.ts';
import { cuando, describeCron, dinero, duracion } from './format.ts';
import { agrupaHistorial } from './skips.ts';
import { resumenPanel, veredicto } from './verdict.ts';

/**
 * El ÚNICO helper de escapado del proyecto. Todo lo que se
 * interpola pasa por aquí. Acepta `unknown` a propósito: obligar a convertir en
 * cada sitio de llamada es justo lo que hace que un día alguien interpole
 * directo y se salte el escapado.
 */
export function escapeHtml(text: unknown): string {
  if (text === undefined || text === null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function statusClass(status: string): string {
  return `s-${status.replace(/[^a-z-]/g, '')}`;
}

/**
 * El cliente del vivo, compartido por las dos páginas que lo usan. No renderiza
 * nada: el servidor manda fragmentos ya montados.
 *
 * El evento `log` manda `{ stepId, delta }` (ver `sseEvent` en server.ts) porque
 * un stream de run puede tener varios pasos: sin el id, la página del paso no
 * tendría forma de distinguir su propio delta del de cualquier otro paso que
 * también estuviera corriendo. `stepId` es el id del paso QUE MUESTRA ESTA
 * PÁGINA — se lo pasa el servidor (`layout()`), nunca se infiere de la URL en
 * el navegador. Solo la página de un paso lo recibe; la del run no, así que en
 * ella la comparación no forma parte del script emitido.
 */
const SSE_CLIENT = (url: string, stepId?: string): string => `
<script>
  const es = new EventSource(${JSON.stringify(url)});
  es.addEventListener('panel', e => {
    const el = document.getElementById('live');
    if (el) el.innerHTML = JSON.parse(e.data);
  });
  es.addEventListener('log', e => {
    const el = document.getElementById('log');
    if (!el) return;
    const payload = JSON.parse(e.data);
    ${stepId !== undefined ? `if (payload.stepId !== ${JSON.stringify(stepId)}) return;` : ''}
    el.append(payload.delta);
  });
  es.addEventListener('done', () => es.close());
</script>`;

export function layout(
  title: string,
  body: string,
  opts: { sse?: string; stepId?: string } = {},
): string {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head><body>
<div class="top"><a class="wordmark" href="/">PIPELINES</a></div>
${body}
${opts.sse ? SSE_CLIENT(opts.sse, opts.stepId) : ''}
</body></html>`;
}

export type HealthRow =
  | {
      name: string;
      description: string;
      health: Health;
      /** Pasos declarados del pipeline, para el «N de M pasos» de un run vivo. */
      pasosTotales: number;
      /** Cola del log del job de launchd. Solo se rellena en el caso de contradicción. */
      jobLogTail?: string;
    }
  | {
      name: string;
      /**
       * `loadPipeline` y `store.listRuns` son E/S ordinaria que lanza en
       * condiciones normales: un directorio a medio autoring sin
       * `pipeline.yaml`, o un `run.json` truncado a media escritura. Un
       * pipeline roto no puede tumbar el panel de los demás — se pinta como
       * fila de error, con el motivo, en vez de desaparecer.
       */
      error: string;
    };

/** La fila de la contradicción: la única de la página que se toma el ancho
 *  entero. La cola del log del job es el único rastro de un motor que muere
 *  antes de escribir `run.json`. */
function renderAlarma(row: Extract<HealthRow, { health: Health }>, linea: string): string {
  const cola = row.jobLogTail
    ? `<div class="alarmbody">Últimas líneas de su log:</div>
       <pre class="tail">${escapeHtml(row.jobLogTail)}</pre>`
    : `<div class="alarmbody">Su log
         (<code>${escapeHtml(logPathFor(homedir(), row.name))}</code>) está vacío o no existe:
         el job no llegó ni a arrancar.</div>`;
  return `<div class="alarmbox">
    <div class="name"><a href="/p/${encodeURIComponent(row.name)}">${escapeHtml(row.name)}</a></div>
    <div class="alarmhead">${escapeHtml(linea)}</div>
    <div class="alarmbody">
      launchd dice que dispara este pipeline y no hay ni un run en la ventana. No llegó a
      arrancar: máquina dormida a la hora del disparo, el <code>bun</code> del PATH que ya no
      está, o el motor muriendo antes de escribir <code>run.json</code>.
    </div>
    ${cola}
  </div>`;
}

/**
 * El panel. Lo que devuelve esta función es EXACTAMENTE lo que va dentro de
 * `#live`, el titular incluido: `SSE_CLIENT` sustituye ese nodo entero, así que
 * cualquier cosa que se saque de aquí nace rancia y se queda congelada en el
 * estado que tenía al abrir la pestaña.
 *
 * `now` entra como parámetro porque `cuando()` es puro y no tiene reloj: mismo
 * reparto que `health/evaluate.ts`.
 */
export function renderHealthPanel(rows: HealthRow[], now: Date): string {
  const sanas = rows.flatMap((row) => ('error' in row ? [] : [row.health]));
  const rotos = rows.length - sanas.length;
  const resumen = resumenPanel(sanas, rotos);

  const cuerpo = rows
    .map((row) => {
      if ('error' in row) {
        return `<div class="row">
          <span class="dot warn"></span>
          <div>
            <div class="name">${escapeHtml(row.name)}</div>
            <div class="verdict">No se pudo leer: ${escapeHtml(row.error)}</div>
          </div>
          <div class="right"><div class="when">—</div></div>
        </div>`;
      }

      const v = veredicto(row.health, row.pasosTotales);
      if (row.health.contradiction) return renderAlarma(row, v.line);

      const last = row.health.lastRun;
      const { day, time } = cuando(last?.startedAt, now);
      return `<div class="row">
        <span class="dot ${escapeHtml(v.tono)}"></span>
        <div>
          <div class="name"><a href="/p/${encodeURIComponent(row.name)}">${escapeHtml(row.name)}</a></div>
          <div class="verdict ${escapeHtml(v.tono)}">${escapeHtml(v.line)}</div>
          <div class="axes">disparo <b>${escapeHtml(v.trigger)}</b> · trabajo <b>${escapeHtml(v.work)}</b></div>
          <div class="desc">${escapeHtml(row.description)}</div>
        </div>
        <div class="right">
          <div class="when">${escapeHtml(day)}${time ? ` · <em>${escapeHtml(time)}</em>` : ''}</div>
          <div class="cost">${escapeHtml(dinero(last?.totalCostUsd))}</div>
        </div>
      </div>`;
    })
    .join('\n');

  // Sin reloj en el subtítulo, a propósito. `createHealthStream` compara el
  // HTML con el del tick anterior (`rendered === last`) para no reemitir
  // cuando nada ha cambiado; con la hora dentro, el fragmento cambiaba cada
  // minuto y el panel se reemitía siempre — se perdía la única señal que
  // distingue "ha pasado algo" de "sigue todo igual".
  return `<div class="headline ${escapeHtml(resumen.tono)}">${escapeHtml(resumen.line)}</div>
    <div class="subhead">${escapeHtml(resumen.sub)}</div>
    ${cuerpo}`;
}

/**
 * Una guarda de `when:` dicha en castellano, no en su JSON escapado. Las
 * cuatro ramas del esquema tienen forma conocida (`schema/pipeline.ts`), así
 * que las cuatro se pueden contar; el `default` existe para que un
 * pipeline.yaml de una versión futura del esquema no deje un hueco mudo.
 */
function renderGuard(guard: Guard): string {
  const fila = (nombre: string, dice: string): string => `<div class="guard">
    <div class="gname">${escapeHtml(nombre)}</div>
    <div class="gsay">${dice}</div>
  </div>`;

  if ('throttle' in guard) {
    return fila('throttle', `No corre si la última pasada fue hace menos de
      <b>${escapeHtml(guard.throttle)}</b>.`);
  }
  if ('shell' in guard) {
    return fila('shell', `Corre solo si este comando devuelve 0.
      <pre class="cmd">${escapeHtml(guard.shell)}</pre>`);
  }
  if ('changed' in guard) {
    const desde = guard.changed.since === 'last_attempt' ? 'el último intento' : 'la última pasada con éxito';
    return fila('changed', `Corre solo si algo cambió en
      <code>${escapeHtml(guard.changed.path)}</code> desde ${escapeHtml(desde)}.`);
  }
  if ('between' in guard) {
    return fila('between', `Corre solo entre las <b>${escapeHtml(guard.between)}</b>.`);
  }
  return fila('guarda', `<pre class="cmd">${escapeHtml(JSON.stringify(guard))}</pre>`);
}

const ESTADO_RUN: Record<string, string> = {
  success: 'éxito', failed: 'falló', skipped: 'saltado', running: 'corriendo',
};

/** Una fila del historial. El motivo del salto se pinta aquí, escapado: viene
 *  de un fichero y lleva `<`, `>` y comillas. */
function renderRunRow(pipeline: string, run: RunRecord, now: Date): string {
  const { day, time } = cuando(run.startedAt, now);
  const href = `/p/${encodeURIComponent(pipeline)}/runs/${encodeURIComponent(run.id)}`;
  const nota = [
    run.forced ? '<span class="chip">forzado</span>' : '',
    run.skipReason ? escapeHtml(run.skipReason) : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `<div class="run">
    <span class="rday"><a href="${href}">${escapeHtml(day)}</a></span>
    <span class="rtime">${escapeHtml(time)}</span>
    <span class="rstate ${statusClass(run.status)}">${escapeHtml(ESTADO_RUN[run.status] ?? run.status)}</span>
    <span class="rnote">${nota}</span>
    <span class="rcost">${escapeHtml(dinero(run.totalCostUsd))}</span>
  </div>`;
}

export function renderPipelinePage(
  pipeline: Pipeline,
  runs: RunRecord[],
  health: Health,
  now: Date,
): string {
  const v = veredicto(health, pipeline.steps.length);
  const conAgente = pipeline.steps.filter((step) => step.type === 'agent').length;

  const steps = pipeline.steps
    .map(
      (step, i) => `<div class="step">
        <span class="num">${i + 1}</span>
        <span class="sid"><code>${escapeHtml(step.id)}</code></span>
        <span class="kind${step.type === 'agent' ? ' agent' : ''}">${escapeHtml(step.type)}</span>
      </div>`,
    )
    .join('');

  const guards = pipeline.when.map(renderGuard).join('');

  const params = Object.entries(pipeline.params)
    .map(
      ([key, spec]) => `<div class="param">
        <div class="pname">${escapeHtml(key)}</div>
        <div class="gsay">${escapeHtml(spec.description)}</div>
      </div>`,
    )
    .join('');

  // Ocho párrafos con el mismo grep de doscientos caracteres eran ruido: el
  // HECHO es "ocho noches, misma guarda", y se dice una vez. Las fechas del
  // bloque siguen siendo enlaces, así que no se pierde el acceso a ningún run.
  const historial = agrupaHistorial(runs)
    .map((tramo) => {
      if (tramo.kind === 'run') return renderRunRow(pipeline.name, tramo.run, now);
      const fechas = tramo.runs
        .map((run) => {
          const { day, time } = cuando(run.startedAt, now);
          const href = `/p/${encodeURIComponent(pipeline.name)}/runs/${encodeURIComponent(run.id)}`;
          return `<a href="${href}">${escapeHtml(day)}${time ? ` ${escapeHtml(time)}` : ''}</a>`;
        })
        .join('');
      const n = tramo.runs.length;
      return `<div class="colapso">
        <div class="cchead">${n} noches saltadas seguidas</div>
        <div class="ccwhy">Misma guarda las ${n} veces:
          <code>${escapeHtml(tramo.guarda)}</code></div>
        <div class="ccdates">${fechas}</div>
      </div>`;
    })
    .join('');

  const vacia = (que: string): string =>
    `<div class="param"><div class="pname">—</div><div class="gsay">${que}</div></div>`;

  return `
    <h1>${escapeHtml(pipeline.name)}</h1>
    <div class="verdict ${escapeHtml(v.tono)}">${escapeHtml(v.line)}</div>
    <div class="desc">${escapeHtml(pipeline.description)}</div>
    <div class="meta">
      <div><span>Disparo</span><b>${escapeHtml(v.trigger)}</b></div>
      <div><span>Trabajo</span><b>${escapeHtml(v.work)}</b></div>
      <div><span>Cadencia</span><em>${escapeHtml(describeCron(pipeline.triggers.map((t) => t.cron)))}</em></div>
    </div>
    <h2>Pasos <i>— ${pipeline.steps.length}${conAgente > 0 ? `, ${conAgente} con agente` : ''}</i></h2>
    <div class="steps">${steps}</div>
    <h2>Guardas <i>— se comprueban antes de cada pasada</i></h2>
    ${guards || vacia('Ninguna: nada puede impedir que corra.')}
    <h2>Params</h2>
    ${params || vacia('Ninguno.')}
    <h2>Ejecuciones <i>— ${runs.length}</i></h2>
    ${historial}`;
}

/**
 * Lo que va dentro de `#live` en la página de un run: la cabecera, los pasos y
 * las denegaciones. Los tres cambian mientras el run corre, así que los tres
 * tienen que estar aquí — `SSE_CLIENT` hace `el.innerHTML = ...` sobre ese
 * contenedor, y lo que quede fuera se congela en el estado que tenía al abrir
 * la pestaña. Antes la cabecera vivía fuera: un run que terminaba mientras
 * mirabas seguía diciendo «corriendo» hasta que recargabas.
 *
 * Por el mismo motivo esta función NO devuelve la página: si devolviera el
 * título y el `<div id="live">`, el cliente anidaría una copia dentro de sí
 * misma en cada tick. Empieza siempre por `<div class="bigline`, y hay un test
 * que fija esa forma.
 *
 * `step.durationMs` y `step.attempts` pasan por `escapeHtml` como todo lo demás
 * aunque su tipo diga `number`: `JSON.parse(...) as RunRecord`
 * (`RunStore.readRun`) no valida nada, así que ese tipo es una promesa, no una
 * garantía.
 */
export function renderRunLive(run: RunRecord): string {
  const pasos = Object.values(run.steps);
  const GLIFO: Record<string, string> = { success: '✓', failed: '✕', skipped: '–', running: '▸' };

  // El paso más largo fija la escala. El `|| 1` no es defensa de más: un run
  // recién empezado tiene todos los pasos a 0 ms, y sin él cada barra saldría
  // con `width: NaN%`.
  const masLargo = Math.max(...pasos.map((step) => step.durationMs), 0) || 1;
  const total = pasos.reduce((acc, step) => acc + step.durationMs, 0);
  const fallo = pasos.find((step) => step.status === 'failed');

  const filas = pasos
    .map((step, i) => {
      const pct = ((step.durationMs / masLargo) * 100).toFixed(1);
      const href = `/p/${encodeURIComponent(run.pipeline)}/runs/${encodeURIComponent(run.id)}/${encodeURIComponent(step.id)}`;
      // Un solo renglón secundario por paso, y solo si hay algo que decir: el
      // error manda sobre el motivo del salto, y las herramientas solo salen
      // cuando el paso no tiene ninguno de los dos.
      const nota = step.error ?? step.skipReason ?? step.toolsUsed?.join(' · ') ?? '';
      const subnota = nota
        ? `<div class="st note"><span></span><span></span><span></span>
             <span class="subnote${step.error ? ' err' : ''}">${escapeHtml(nota)}</span></div>`
        : '';
      return `<div class="st">
        <span class="num">${i + 1}</span>
        <span class="id"><a href="${href}">${escapeHtml(step.id)}</a></span>
        <span class="state ${statusClass(step.status)}">${escapeHtml(ESTADO_RUN[step.status] ?? step.status)}</span>
        <span class="bar"><i class="${step.status === 'failed' ? 'bad' : ''}" style="width: ${escapeHtml(pct)}%"></i></span>
        <span class="dur">${escapeHtml(duracion(step.durationMs))}</span>
        <span class="stcost">${escapeHtml(dinero(step.costUsd))}</span>
      </div>${subnota}`;
    })
    .join('');

  // El `reason` es la parte útil: dice POR QUÉ el sandbox no dejó pasar la
  // herramienta. Antes se imprimía solo `redact: Read (both)` y se tiraba.
  const denegaciones = pasos
    .flatMap((step) => (step.denials ?? []).map((d) => ({ step, d })))
    .map(
      ({ step, d }) => `<div class="denial">
        <div class="dtop">${escapeHtml(step.id)} · ${escapeHtml(d.toolName)} · ${escapeHtml(d.source)}</div>
        ${d.reason ? `<div class="dwhy">${escapeHtml(d.reason)}</div>` : ''}
      </div>`,
    )
    .join('');

  const enPaso = fallo ? ` en <code>${escapeHtml(fallo.id)}</code>` : '';
  return `<div class="bigline ${statusClass(run.status)}">${escapeHtml(GLIFO[run.status] ?? '')} ${escapeHtml(ESTADO_RUN[run.status] ?? run.status)}${enPaso}</div>
    <div class="meta">
      <div><span>Duración</span><b>${escapeHtml(duracion(total))}</b></div>
      <div><span>Coste</span><b>${escapeHtml(dinero(run.totalCostUsd) || '—')}</b></div>
      <div><span>Pasos</span><b>${pasos.length}</b></div>
      ${run.forced ? '<div><span>Guardas</span><b>omitidas — forzado</b></div>' : ''}
    </div>
    ${run.skipReason ? `<div class="bigwhy">${escapeHtml(run.skipReason)}</div>` : ''}
    <h2>Pasos de este run <i>— la barra es la duración contra el paso más largo</i></h2>
    ${filas}
    ${denegaciones ? `<h2>Denegaciones del sandbox</h2>${denegaciones}` : ''}`;
}

export function renderRunPage(name: string, run: RunRecord): string {
  return `<div class="crumb"><a href="/p/${encodeURIComponent(name)}">${escapeHtml(name)}</a> / ${escapeHtml(run.id)}</div>
    <div id="live">${renderRunLive(run)}</div>`;
}
