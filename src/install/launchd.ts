/**
 * Traducción de triggers.cron (sintaxis cron, 5 campos) a
 * StartCalendarInterval de launchd, y render del plist que la lleva.
 *
 * Módulo PURO a propósito: ni E/S ni launchctl. Los efectos viven en
 * src/install/launchctl.ts y en los comandos de src/cli/index.ts. Mismo
 * reparto que runner/fs-guard.ts, por el mismo motivo: la lógica
 * que decide se testea entera sin tocar el sistema de la máquina.
 */

import { dirname, join } from 'node:path';
import type { Guard } from '../schema/pipeline.ts';

export type CalendarInterval = {
  Minute?: number;
  Hour?: number;
  Day?: number;
  Month?: number;
  Weekday?: number;
};

/**
 * Tope de horarios que puede generar un solo triggers.cron. Una expansión
 * mayor casi siempre significa que el autor quería un paso con slash (step),
 * que este subconjunto no soporta a propósito — mejor un error que un plist
 * con cuarenta diccionarios que nadie va a revisar.
 */
export const MAX_CALENDAR_INTERVALS = 24;

type FieldSpec = { key: keyof CalendarInterval; min: number; max: number };

// El orden es el de cron: minuto, hora, día del mes, mes, día de la semana.
const CRON_FIELDS: FieldSpec[] = [
  { key: 'Minute', min: 0, max: 59 },
  { key: 'Hour', min: 0, max: 23 },
  { key: 'Day', min: 1, max: 31 },
  { key: 'Month', min: 1, max: 12 },
  { key: 'Weekday', min: 0, max: 7 },
];

/** Valores de un campo, o null para asterisco (que launchd expresa omitiéndolo). */
function parseField(raw: string, field: FieldSpec, cron: string): number[] | null {
  if (raw === '*') return null;

  if (raw.includes('/') || raw.includes('-')) {
    throw new Error(
      `triggers.cron "${cron}": el campo ${field.key} usa "${raw}". launchd no sabe expresar ` +
        `rangos ni pasos; escríbelo como lista separada por comas (p. ej. "0,15,30,45").`,
    );
  }

  const values: number[] = [];
  for (const part of raw.split(',')) {
    const value = Number(part);
    if (!Number.isInteger(value) || value < field.min || value > field.max) {
      throw new Error(
        `triggers.cron "${cron}": el campo ${field.key} tiene "${part}", que no es un entero ` +
          `entre ${field.min} y ${field.max}.`,
      );
    }
    // Domingo es 0 en cron y 0 (o 7) en launchd: se normaliza a 0 para que
    // "0" y "7" no generen dos horarios distintos que son el mismo día.
    const normalized = field.key === 'Weekday' && value === 7 ? 0 : value;
    if (!values.includes(normalized)) values.push(normalized);
  }
  return values;
}

export function cronToCalendarIntervals(cron: string): CalendarInterval[] {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `triggers.cron "${cron}": se esperaban 5 campos (minuto hora día mes día-de-semana), ` +
        `hay ${fields.length}.`,
    );
  }

  let intervals: CalendarInterval[] = [{}];
  fields.forEach((raw, index) => {
    const field = CRON_FIELDS[index]!;
    const values = parseField(raw, field, cron);
    if (values === null) return;

    const expanded: CalendarInterval[] = [];
    for (const base of intervals) {
      for (const value of values) expanded.push({ ...base, [field.key]: value });
    }
    if (expanded.length > MAX_CALENDAR_INTERVALS) {
      throw new Error(
        `triggers.cron "${cron}": la expansión da ${expanded.length} horarios, más del máximo ` +
          `de ${MAX_CALENDAR_INTERVALS}. Declara varios triggers más simples.`,
      );
    }
    intervals = expanded;
  });
  return intervals;
}

/**
 * Prefijo de la etiqueta del job. Constante en un solo sitio a propósito: es
 * la misma que ya usa el job instalado a mano el 2026-08-19, de modo que el
 * primer `install` real lo ADOPTA (mismo label = reemplazo) en vez de dejar
 * dos jobs en paralelo sobre el mismo repo.
 */
export const LABEL_PREFIX = 'cat.start.pipelines';

export function labelFor(pipelineName: string): string {
  return `${LABEL_PREFIX}.${pipelineName}`;
}

export type WhichFn = (name: string, path?: string) => string | null;

/**
 * Suelo de directorios de sistema, añadido SIEMPRE al final del `PATH`
 * generado (los derivados de `requires.bin`/`mcp_servers` siguen ganando por
 * orden, ya que van antes). macOS solo tiene `sh` en `/bin/sh`; sin este
 * suelo, un pipeline cuyos binarios declarados no comparten directorio con
 * `/bin` genera un `PATH` que ni siquiera puede lanzar `sh -c`, que es
 * exactamente lo que hacen `runner/shell.ts` y `guards/evaluate.ts` para
 * cualquier paso `shell` o guarda `shell:`. Verificado en vivo:
 * "Executable not found in $PATH: sh" con el PATH sin este
 * suelo — el job instalado moriría en el primer paso.
 */
const SYSTEM_PATH_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/**
 * `PATH` del job, CALCULADO a partir de los binarios declarados en vez de
 * copiado de otro sitio. El plist escrito a mano del 2026-08-19 llevaba un
 * `PATH` heredado de otro job que no cubría todos los binarios que el
 * pipeline declara; calcularlo convierte ese fallo en imposible.
 *
 * `extraDirs` va primero (el directorio del propio `bun`, que el job necesita
 * para arrancar el motor y que no sale de `requires.bin`).
 */
export function computePath(
  binaries: string[],
  which: WhichFn,
  extraDirs: string[] = [],
): string {
  const dirs: string[] = [];
  const push = (dir: string): void => {
    if (!dirs.includes(dir)) dirs.push(dir);
  };

  for (const dir of extraDirs) push(dir);
  for (const binary of binaries) {
    const resolved = which(binary);
    if (resolved === null) {
      throw new Error(
        `El binario "${binary}" (requires.bin) no está en el PATH de esta máquina, así que el ` +
          `job instalado tampoco lo encontraría.`,
      );
    }
    push(dirname(resolved));
  }
  for (const dir of SYSTEM_PATH_DIRS) push(dir);
  return dirs.join(':');
}

/**
 * Cinturón, no solo el suelo de arriba: comprueba que TODOS los binarios
 * declarados, MÁS `sh`, resuelven contra el `PATH` YA CALCULADO — el que se
 * va a escribir en el plist, no el del operador que ejecuta `install`. Es la
 * regla general que deja el incidente de origen: validar contra el entorno
 * de destino, no contra el propio. `sh` se comprueba SIEMPRE, aunque no
 * aparezca en `requires.bin`: es el intérprete que invoca cualquier paso
 * `shell` o guarda `shell:`, así que su ausencia en el PATH escrito revienta
 * el job instalado en el primer paso, incluso si `doctor` (que valida contra
 * el PATH del operador) estuviera en verde.
 *
 * Devuelve los nombres que NO resuelven; vacío si todo está cubierto.
 */
export function unresolvedInPath(path: string, binaries: string[], which: WhichFn): string[] {
  const mustResolve = [...binaries, 'sh'];
  return mustResolve.filter((bin) => which(bin, path) === null);
}

export type PlistSpec = {
  label: string;
  programArguments: string[];
  environmentVariables: Record<string, string>;
  calendarIntervals: CalendarInterval[];
  logPath: string;
  /** Ruta del `pipeline.yaml` del que sale este plist, para la cabecera. */
  sourcePipelineYaml: string;
  generatedAt: string;
  /** Si launchd debe disparar el job al cargar el dominio. Ver `grantsRunAtLoad`. */
  runAtLoad: boolean;
};

export function logPathFor(home: string, pipelineName: string): string {
  return join(home, 'Library', 'Logs', `pipelines-${pipelineName}.log`);
}

export type PlistSpecInput = {
  pipelineName: string;
  repoRoot: string;
  /** Ruta del binario de bun que ejecuta el motor (`process.execPath`). */
  bunPath: string;
  /** Ruta del punto de entrada del CLI (`src/cli/index.ts`). */
  cliEntry: string;
  home: string;
  path: string;
  calendarIntervals: CalendarInterval[];
  generatedAt: string;
  /** Las guardas `when:` del pipeline. Deciden `runAtLoad` — ver `grantsRunAtLoad`. */
  guards: Guard[];
};

/**
 * ¿Se le concede `RunAtLoad` a un pipeline con estas guardas?
 *
 * El problema que resuelve: launchd NO repite un `StartCalendarInterval` que
 * cae mientras el dominio `gui/$UID` no está cargado, y ese dominio no se
 * carga hasta que el usuario entra. El lunes 2026-08-31 la máquina reinició a
 * las 06:31 y nadie entró hasta las 09:41: el job de las 07:30 no se ejecutó,
 * no escribió un byte, y nada avisó — `notify.stale_after` solo se evalúa
 * cuando un run TERMINA, así que un job que no arranca es invisible.
 *
 * `RunAtLoad` recupera ese disparo al siguiente login. Pero a secas haría
 * correr el pipeline en CADA carga del dominio, que es justo lo contrario de
 * lo que se quiere. Por eso se concede solo a quien declara una guarda
 * `throttle`: ella decide si de verdad toca, y el disparo de más se salta
 * limpio. Es la única guarda que sirve — `shell`, `changed` y `between`
 * responden a otra pregunta y no acotan la frecuencia.
 *
 * Seguro para las dos formas de `throttle` y para sus dos `since`: un run
 * saltado no cuenta como intento (`RunStore.lastAttempt`), así que
 * un disparo de login que la guarda salte no empuja el ancla de la ventana.
 */
export function grantsRunAtLoad(guards: Guard[]): boolean {
  return guards.some((guard) => 'throttle' in guard);
}

/**
 * Monta el `PlistSpec` a partir de entradas EXPLÍCITAS — nada de `homedir()`
 * ni `process.execPath` aquí dentro. Vive en el módulo puro porque tiene dos
 * consumidores: `install`, que lo escribe, y la web, que lo genera solo para
 * compararlo con el de disco y decidir si el job instalado se ha desviado
 * (estado `drifted`). Dos generadores distintos podrían discrepar;
 * uno solo, no.
 */
export function buildPlistSpec(input: PlistSpecInput): PlistSpec {
  return {
    label: labelFor(input.pipelineName),
    programArguments: [
      input.bunPath, 'run', input.cliEntry,
      '--repo', input.repoRoot,
      'run', input.pipelineName,
    ],
    environmentVariables: { PATH: input.path, HOME: input.home },
    calendarIntervals: input.calendarIntervals,
    logPath: logPathFor(input.home, input.pipelineName),
    sourcePipelineYaml: join(input.repoRoot, 'pipelines', input.pipelineName, 'pipeline.yaml'),
    generatedAt: input.generatedAt,
    runAtLoad: grantsRunAtLoad(input.guards),
  };
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderPlist(spec: PlistSpec): string {
  const args = spec.programArguments
    .map((arg) => `\t\t<string>${escapeXml(arg)}</string>`)
    .join('\n');

  const env = Object.entries(spec.environmentVariables)
    .map(([key, value]) => `\t\t<key>${escapeXml(key)}</key>\n\t\t<string>${escapeXml(value)}</string>`)
    .join('\n');

  const intervals = spec.calendarIntervals
    .map((interval) => {
      const entries = Object.entries(interval)
        .map(([key, value]) => `\t\t\t<key>${key}</key>\n\t\t\t<integer>${value}</integer>`)
        .join('\n');
      return entries === '' ? '\t\t<dict/>' : `\t\t<dict>\n${entries}\n\t\t</dict>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!--
  GENERADO POR \`pipelines install\` — NO EDITAR A MANO.
  Origen:    ${escapeXml(spec.sourcePipelineYaml)}
  Generado:  ${spec.generatedAt}

  Para cambiar la cadencia, edita \`triggers.cron\` en ese fichero y vuelve a
  ejecutar \`pipelines install\`. Para cambiar un parámetro, edita
  \`.params.local.json\` en el repo de datos: este plist no lleva ninguno.
-->
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${escapeXml(spec.label)}</string>

\t<key>ProgramArguments</key>
\t<array>
${args}
\t</array>

\t<key>EnvironmentVariables</key>
\t<dict>
${env}
\t</dict>

\t<key>StartCalendarInterval</key>
\t<array>
${intervals}
\t</array>

\t<key>StandardOutPath</key>
\t<string>${escapeXml(spec.logPath)}</string>
\t<key>StandardErrorPath</key>
\t<string>${escapeXml(spec.logPath)}</string>

\t<key>RunAtLoad</key>
\t${spec.runAtLoad ? '<true/>' : '<false/>'}
</dict>
</plist>
`;
}

/**
 * Jobs de launchd AJENOS que mencionan alguna de las rutas que este pipeline
 * va a tocar. Red de seguridad contra la colisión del 2026-08-29 (dos jobs a
 * la misma hora sobre el mismo repo), NO una garantía: un job que calcula la
 * ruta dentro de su propio script no la lleva en el plist y no se detecta.
 * Por eso `install` avisa y pide `--force`, en vez de bloquear.
 *
 * Solo se buscan rutas absolutas (lo decide el llamante): buscar valores
 * cualesquiera daría falsos positivos absurdos con cadenas cortas.
 */
export function foreignJobsMentioning(
  paths: string[],
  agents: { label: string; contents: string }[],
  ownLabel: string,
): string[] {
  const hits: string[] = [];
  for (const agent of agents) {
    if (agent.label === ownLabel) continue;
    if (paths.some((path) => agent.contents.includes(path))) hits.push(agent.label);
  }
  return hits;
}

/**
 * Otros jobs de launchd CARGADOS cuyo nombre acaba en el del pipeline.
 *
 * Es la red que faltó al relevar un job antiguo por un pipeline real:
 * `foreignJobsMentioning`, la otra comprobación de este módulo, compara RUTAS
 * —los valores de tipo ruta de los params contra el contenido de los otros
 * plists— y funcionó exactamente como promete. Quedó ciega por una razón que
 * conviene no olvidar: **fue la decisión de dar a cada pipeline un espacio de
 * trabajo propio la que eliminó la ruta compartida** con el script de bash al
 * que relevaba. Uno trabajaba en el checkout del operador y el otro en
 * `workspaces/<pipeline>`: cero solapamiento de ficheros, y aun así el mismo
 * trabajo, el mismo correo y las mismas tres personas.
 *
 * Esa colisión es SEMÁNTICA, y lo único que la delata desde fuera es el
 * nombre. De ahí esta segunda red, deliberadamente distinta y no un parche
 * sobre la primera.
 *
 * Los jobs `disabled` quedan fuera, y no es un detalle: el plist del
 * predecesor se deja EN DISCO a propósito como vía de vuelta, y quien lee los
 * candidatos (`readLaunchAgents`) lee ficheros, no jobs cargados. Sin esta
 * exclusión el aviso saltaría en cada reinstalación posterior a un relevo bien
 * hecho, para siempre — el ruido que enseña a ignorar los avisos. Un job
 * deshabilitado no puede correr, así que no duplica nada.
 *
 * El límite es un punto —el separador de segmentos de una etiqueta de
 * launchd— y no un `endsWith` a secas: `com.example.otro-<nombre>` es un job
 * distinto que casualmente acaba igual, y avisar de él sería ruido que enseña
 * a ignorar el aviso.
 */
export function jobsNamedAfter(
  pipelineName: string,
  agents: { label: string; contents: string }[],
  ownLabel: string,
  disabledLabels: string[],
): string[] {
  const disabled = new Set(disabledLabels);
  return agents
    .filter((agent) => agent.label !== ownLabel)
    .filter((agent) => agent.label.endsWith(`.${pipelineName}`))
    .filter((agent) => !disabled.has(agent.label))
    .map((agent) => agent.label);
}

/**
 * Etiquetas marcadas como `disabled` en la salida de `launchctl print-disabled`.
 * El formato es `"<label>" => disabled` o `=> enabled`, una por línea.
 *
 * Formato VERIFICADO EN VIVO, no asumido: ejecutando
 * `launchctl print-disabled gui/501` en macOS Darwin 25.6, cuya salida real
 * es `"<label>" => enabled` / `=> disabled`, una entrada por línea, exactamente
 * lo que este parser espera.
 */
export function parseDisabledLabels(stdout: string): string[] {
  const labels: string[] = [];
  for (const line of stdout.split('\n')) {
    const match = /"([^"]+)"\s*=>\s*disabled/.exec(line);
    if (match) labels.push(match[1]!);
  }
  return labels;
}

/**
 * Quita la marca de tiempo de la cabecera para poder comparar dos plists por
 * su CONTENIDO. Sin esto, el plist de disco y el que `install` generaría
 * ahora mismo difieren siempre, y el veredicto `drifted` sería un
 * falso positivo permanente.
 */
export function stripGeneratedAt(plist: string): string {
  return plist.replace(/^\s*Generado:.*$/m, '');
}
