export type RunStatus = 'running' | 'success' | 'failed' | 'skipped';
export type StepStatus = 'success' | 'failed' | 'skipped';

/**
 * Una denegación del hook `PreToolUse` de un paso `agent` (`runner/agent.ts`,
 * `buildDenials`), persistida como parte de su `StepRecord` para que la capa
 * detectiva del sandbox de filesystem sea visible vía
 * `pipelines show`, no solo en memoria durante el run.
 *
 * Definido aquí (no en `runner/agent.ts`) para que `runner/agent.ts` pueda
 * importar este tipo sin crear un ciclo: `runner/agent.ts` ya depende de
 * `runs/store.ts` (para `redactSecrets`), que a su vez depende de este
 * fichero — si `Denial` viviera en `runner/agent.ts` e importara algo de
 * vuelta desde `runs/types.ts`, o si este fichero importara desde
 * `runner/agent.ts`, se cerraría el ciclo `runs/types.ts` -> `runner/agent.ts`
 * -> `runs/store.ts` -> `runs/types.ts`. `runs/types.ts` no importa nada hoy
 * (es una hoja del grafo de módulos) — mismo patrón que ya usa
 * `notify/dispatch.ts`, que importa `RunRecord` directamente desde este
 * fichero en vez de a través de `runs/store.ts`.
 */
export type Denial = {
  toolName: string;
  toolUseId: string;
  reason?: string;
  /** 'hook-log': solo el hook lo registró. 'sdk-result': solo permission_denials
   *  lo registró (señal de que algo ajeno al propio hook denegó — o de que el
   *  hook falló abierto sin que su log lo capturara). 'both': ambas fuentes
   *  coinciden, el caso normal de una denegación real del hook. */
  source: 'hook-log' | 'sdk-result' | 'both';
};

export type StepRecord = {
  id: string;
  status: StepStatus;
  startedAt: string;
  durationMs: number;
  /** Outputs validados contra el contrato. Vacío si el paso no declara ninguno. */
  outputs: Record<string, unknown>;
  effects: string[];
  /** Intentos consumidos, incluido el primero. */
  attempts: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  toolsUsed?: string[];
  error?: string;
  /** Motivo del salto, cuando status es 'skipped'. */
  skipReason?: string;
  /** Denegaciones del hook PreToolUse de un paso agent — ver `Denial`. */
  denials?: Denial[];
};

/**
 * Rastro del canal de `notify:` de un run: qué canal se invocó, con qué
 * código salió, cuándo, y la cola de su salida (stdout+stderr, redactada con
 * los secretos del canal). Antes el motor descartaba esa salida (`stdout:
 * 'ignore'`) y un envío de correo no dejaba ninguna prueba de haber
 * ocurrido — el script bash al que sustituye sí escribía `notify sent (200)
 * id=…`. Destapado al migrar un pipeline real.
 */
export type NotifyRecord = {
  channel: string;
  code: number;
  at: string;
  log: string;
};

export type RunRecord = {
  id: string;
  pipeline: string;
  pipelineVersion: number;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  params: Record<string, string>;
  steps: Record<string, StepRecord>;
  totalCostUsd?: number;
  skipReason?: string;
  /**
   * El run se lanzó con `run --force`, saltándose la evaluación de `when:`.
   * Solo presente cuando es cierto: un run normal no lleva el campo.
   *
   * Se persiste porque un run forzado NO demuestra que las guardas habrían
   * dejado pasar, y sin la marca el historial de `.runs/` no distingue "corrió
   * porque tocaba" de "corrió porque alguien insistió" — justo la clase de
   * ambigüedad que este proyecto paga cara cuando lee su propio pasado.
   */
  forced?: boolean;
  /** Rastro del canal de notify, si se invocó — ver `NotifyRecord`. */
  notify?: NotifyRecord;
};
