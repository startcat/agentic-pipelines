/**
 * Render del plist de launchd a partir de los horarios que calcula
 * `common.ts`, e interpretación de la salida de `launchctl print-disabled`.
 *
 * Módulo PURO a propósito: ni E/S ni launchctl. Los efectos viven en
 * src/install/launchctl.ts y los envuelve `launchd-backend.ts`, que es lo
 * único que ven los comandos y el panel. Mismo reparto que
 * runner/fs-guard.ts, por el mismo motivo: la lógica que decide se
 * testea entera sin tocar el sistema de la máquina.
 */

import { join } from 'node:path';
import type { JobSpecInput } from './backend.ts';
import { grantsRunAtLoad, labelFor, type CalendarInterval } from './common.ts';

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

/**
 * Monta el `PlistSpec` a partir de entradas EXPLÍCITAS — nada de `homedir()`
 * ni `process.execPath` aquí dentro. Vive en el módulo puro porque tiene dos
 * consumidores: `install`, que lo escribe, y la web, que lo genera solo para
 * compararlo con el de disco y decidir si el job instalado se ha desviado
 * (estado `drifted`). Dos generadores distintos podrían discrepar;
 * uno solo, no.
 */
export function buildPlistSpec(input: JobSpecInput): PlistSpec {
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
