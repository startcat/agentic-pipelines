/**
 * Render de las unidades de systemd (service + timer) a partir de los
 * horarios que calcula `common.ts`. Módulo PURO, como `launchd.ts`: ni E/S ni
 * systemctl; los efectos viven en el backend que lo envuelve.
 */

import { join } from 'node:path';
import type { JobFile, JobSpecInput } from './backend.ts';
import { grantsRunAtLoad, labelFor, type CalendarInterval } from './common.ts';

type Env = Record<string, string | undefined>;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const two = (value: number | undefined): string =>
  value === undefined ? '*' : String(value).padStart(2, '0');

function calendarLine(interval: CalendarInterval, weekday: boolean, day: boolean): string {
  const date = `*-${two(interval.Month)}-${day ? two(interval.Day) : '*'}`;
  const time = `${two(interval.Hour)}:${two(interval.Minute)}:00`;
  const prefix = weekday && interval.Weekday !== undefined ? `${DAYS[interval.Weekday]} ` : '';
  return `${prefix}${date} ${time}`;
}

/**
 * Líneas `OnCalendar=` de un conjunto de horarios. Con día del mes Y día de la
 * semana, cron los une con OR (launchd también); systemd los une con AND en
 * una sola línea, así que se emiten dos. Los duplicados exactos se quitan.
 */
export function onCalendarLines(intervals: CalendarInterval[]): string[] {
  const lines: string[] = [];
  for (const interval of intervals) {
    if (interval.Day !== undefined && interval.Weekday !== undefined) {
      lines.push(calendarLine(interval, false, true), calendarLine(interval, true, false));
    } else {
      lines.push(calendarLine(interval, true, true));
    }
  }
  return [...new Set(lines)];
}

/** Entrecomilla un valor para una línea de unidad: escapa `\` y `"`, y `%` → `%%`. */
export function systemdQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

/**
 * Un argumento de `ExecStart=`: como `systemdQuote`, y además `$` → `$$`.
 * systemd expande `$VAR` y `${VAR}` en `ExecStart=` aunque vayan entre
 * comillas; en `Environment=` no expande nada, así que ahí no se toca.
 */
export function systemdExecArg(value: string): string {
  return systemdQuote(value).replace(/\$/g, () => '$$');
}

export function userUnitDir(home: string, env: Env = process.env): string {
  const base = env.XDG_CONFIG_HOME ? env.XDG_CONFIG_HOME : join(home, '.config');
  return join(base, 'systemd', 'user');
}

export function systemdLogPath(home: string, pipelineName: string, env: Env = process.env): string {
  const base = env.XDG_STATE_HOME ? env.XDG_STATE_HOME : join(home, '.local', 'state');
  return join(base, 'pipelines', 'logs', `pipelines-${pipelineName}.log`);
}

function header(input: JobSpecInput): string {
  const source = join(input.repoRoot, 'pipelines', input.pipelineName, 'pipeline.yaml');
  return (
    `# Generado por \`pipelines install\` desde ${source}\n` +
    `# Generado: ${input.generatedAt}\n` +
    `# No editar a mano: se regenera con \`pipelines install ${input.pipelineName}\`.\n`
  );
}

export function renderServiceUnit(input: JobSpecInput, logPath: string): string {
  // `append:` no admite comillas, así que una ruta con espacios no se puede expresar.
  if (/\s/.test(logPath)) {
    throw new Error(
      `La ruta del log "${logPath}" tiene espacios y systemd no admite comillas en ` +
        `StandardOutput=append:. Revisa HOME / XDG_STATE_HOME.`,
    );
  }
  const log = logPath.replace(/%/g, '%%');
  const exec = [input.bunPath, 'run', input.cliEntry, '--repo', input.repoRoot, 'run', input.pipelineName]
    .map(systemdExecArg)
    .join(' ');
  return `${header(input)}
[Unit]
Description=agentic-pipelines: ${input.pipelineName}

[Service]
Type=oneshot
ExecStart=${exec}
Environment=${systemdQuote(`PATH=${input.path}`)}
Environment=${systemdQuote(`HOME=${input.home}`)}
StandardOutput=append:${log}
StandardError=append:${log}
`;
}

export function renderTimerUnit(input: JobSpecInput): string {
  const calendar = onCalendarLines(input.calendarIntervals)
    .map((line) => `OnCalendar=${line}\n`)
    .join('');
  const persistent = grantsRunAtLoad(input.guards) ? 'Persistent=true\n' : '';
  return `${header(input)}
[Unit]
Description=agentic-pipelines: ${input.pipelineName} (horario)

[Timer]
${calendar}Unit=${labelFor(input.pipelineName)}.service
${persistent}
[Install]
WantedBy=timers.target
`;
}

export function systemdJobFiles(input: JobSpecInput, env: Env = process.env): JobFile[] {
  const dir = userUnitDir(input.home, env);
  const label = labelFor(input.pipelineName);
  return [
    {
      path: join(dir, `${label}.service`),
      contents: renderServiceUnit(input, systemdLogPath(input.home, input.pipelineName, env)),
    },
    { path: join(dir, `${label}.timer`), contents: renderTimerUnit(input) },
  ];
}
