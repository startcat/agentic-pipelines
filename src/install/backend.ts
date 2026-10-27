/**
 * La interfaz del programador de tareas. `install`, `uninstall` y el panel
 * hablan SOLO con esto, nunca con launchd o systemd directamente: así un
 * mismo comando programa un
 * pipeline en macOS y en Linux, y lo que cambia entre los dos queda encerrado
 * en una implementación por plataforma.
 */
import type { Guard } from '../schema/pipeline.ts';
import type { CalendarInterval } from './common.ts';
import { launchdBackend } from './launchd-backend.ts';
import { systemdBackend } from './systemd-backend.ts';

/** Todo lo que hace falta para generar los ficheros de un job, en entradas EXPLÍCITAS. */
export type JobSpecInput = {
  pipelineName: string;
  repoRoot: string;
  /** Ruta del binario de bun que ejecuta el motor (ver `stableBunPath`). */
  bunPath: string;
  /** Ruta del punto de entrada del CLI (`src/cli/index.ts`). */
  cliEntry: string;
  home: string;
  path: string;
  calendarIntervals: CalendarInterval[];
  generatedAt: string;
  /** Las guardas `when:` del pipeline. Deciden `RunAtLoad` — ver `grantsRunAtLoad`. */
  guards: Guard[];
};

export type JobFile = { path: string; contents: string };

export type PlatformCheck = { name: string; ok: boolean; detail: string; fix?: string };

export type SchedulerBackend = {
  kind: 'launchd' | 'systemd';
  /** Nombre para los mensajes: "launchd" / "systemd". */
  label: string;
  /** Ficheros que `install` escribiría ahora: uno en launchd (plist), dos en systemd (service, timer). */
  jobFiles(input: JobSpecInput): JobFile[];
  /** Las rutas de los ficheros del job, existan o no: uno en launchd, dos en systemd. */
  jobPaths(label: string, home: string): string[];
  logPath(home: string, pipelineName: string): string;
  /** Los jobs del usuario con su contenido crudo, para el escaneo de colisiones. */
  readUserJobs(): Promise<{ label: string; contents: string }[]>;
  /** De `labels`, los que están deshabilitados en el programador. */
  disabledLabels(labels: string[]): Promise<string[]>;
  /** Puertas propias de la plataforma antes de instalar. Ninguna en launchd. */
  preInstallChecks(): Promise<PlatformCheck[]>;
  activate(label: string, files: JobFile[]): Promise<{ code: number; stderr: string }>;
  /**
   * Descarga el job y borra sus ficheros si existen. Idempotente. Devuelve un
   * `warning` cuando no pudo asegurar la descarga (systemd sin bus de usuario:
   * los ficheros se borran, pero el temporizador puede seguir cargado).
   */
  deactivate(label: string): Promise<{ warning?: string }>;
  facts(
    label: string,
    home: string,
  ): Promise<{ loaded: boolean; disabled: boolean; artifactOnDisk?: string }>;
  /** Cómo retirar a mano un job homónimo, para el aviso de colisión. */
  retireHint(label: string): string;
};

/**
 * El backend de esta máquina. `PIPELINES_SCHEDULER` manda si está definido —
 * es el seam con el que los tests fuerzan un backend sin depender de la
 * plataforma—; si no, decide `process.platform`. En producción no se define.
 */
export function schedulerFor(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): SchedulerBackend {
  const forced = env.PIPELINES_SCHEDULER;
  if (forced !== undefined && forced !== 'launchd' && forced !== 'systemd') {
    throw new Error(
      `PIPELINES_SCHEDULER="${forced}" no es un programador conocido; usa "launchd" o "systemd".`,
    );
  }
  const kind = forced ?? (platform === 'darwin' ? 'launchd' : platform === 'linux' ? 'systemd' : undefined);
  if (kind === 'launchd') return launchdBackend;
  if (kind === 'systemd') return systemdBackend;
  throw new Error(
    `Programar pipelines solo está soportado en macOS (launchd) y Linux (systemd); esta máquina es ${platform}.`,
  );
}
