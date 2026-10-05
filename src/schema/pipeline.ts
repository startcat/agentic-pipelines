import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { HARD_DENY_TOOLS, TOOL_FS_PROFILES } from '../runner/fs-guard.ts';

/** Error de parseo o validación de un pipeline.yaml. */
export class PipelineParseError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`pipeline.yaml inválido:\n  - ${issues.join('\n  - ')}`);
    this.name = 'PipelineParseError';
    this.issues = issues;
  }
}

/** Tipos de dato admitidos en un contrato `outputs`. */
const OUTPUT_TYPES = [
  'string',
  'number',
  'boolean',
  'string[]',
  'number[]',
  'boolean[]',
] as const;
export type OutputType = (typeof OUTPUT_TYPES)[number];

const durationSchema = z
  .string()
  .regex(/^\d+(s|m|h)$/, 'debe ser un número seguido de s, m o h (p. ej. 30m)');

const retrySchema = z.union([
  z.number().int().min(0),
  z.object({
    attempts: z.number().int().min(0),
    on: z.enum(['transient', 'any']).default('transient'),
  }),
]);

const throttleGuardSchema = z
  .object({
    throttle: z.union([
      durationSchema,
      z
        .object({
          every: durationSchema,
          since: z.enum(['last_success', 'last_attempt']).default('last_success'),
        })
        .strict(),
    ]),
  })
  .strict();
const changedGuardSchema = z
  .object({
    changed: z
      .object({
        path: z.string(),
        since: z.enum(['last_success', 'last_attempt']).default('last_success'),
      })
      .strict(),
  })
  .strict();
const shellGuardSchema = z.object({ shell: z.string() }).strict();
const betweenGuardSchema = z
  .object({
    between: z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/, 'debe tener la forma HH:MM-HH:MM'),
  })
  .strict();

const guardSchema = z.union([
  throttleGuardSchema,
  changedGuardSchema,
  shellGuardSchema,
  betweenGuardSchema,
]);

const GUARD_BRANCHES = {
  throttle: throttleGuardSchema,
  changed: changedGuardSchema,
  shell: shellGuardSchema,
  between: betweenGuardSchema,
} as const;
type GuardKey = keyof typeof GUARD_BRANCHES;
const GUARD_KEYS = Object.keys(GUARD_BRANCHES) as GuardKey[];

/**
 * Valida una guarda de `when:` (`raw`) contra el esquema de su rama real,
 * identificada por cuál de las cuatro claves conocidas trae el objeto.
 * Mismo motivo y mismo patrón que `parseStepAt` un poco más abajo: un
 * `z.union` desnudo da "no coincide con ninguna opción" sin nombrar el
 * campo real que falla.
 */
function parseGuardAt(raw: unknown, index: number): { data?: Guard; issues: string[] } {
  if (raw === null || typeof raw !== 'object') {
    return {
      issues: [`when.${index}: debe ser un objeto con una de las claves throttle, changed, shell o between`],
    };
  }
  const presentKeys = GUARD_KEYS.filter((k) => k in (raw as object));
  if (presentKeys.length !== 1) {
    return {
      issues: [
        presentKeys.length === 0
          ? `when.${index}: debe declarar una de las claves throttle, changed, shell o between`
          : `when.${index}: debe declarar una única clave de guarda, se encontraron: ${presentKeys.join(', ')}`,
      ],
    };
  }
  const key = presentKeys[0]!;
  const result = GUARD_BRANCHES[key].safeParse(raw);
  if (!result.success) {
    return {
      issues: result.error.issues.map(
        (i) => `when.${index}.${i.path.join('.') || key}: ${i.message}`,
      ),
    };
  }
  return { data: result.data as Guard, issues: [] };
}

const paramSchema = z.object({
  description: z.string(),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

const requiresSchema = z.object({
  agents: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  bin: z.array(z.string()).default([]),
  env: z.array(z.string()).default([]),
  net: z.array(z.string()).default([]),
});

/**
 * Servidor MCP stdio (`sdk.d.ts` `McpStdioServerConfig`): mismo shape que
 * `command`/`args`/`env` de un `.mcp.json`. Solo stdio por ahora — SSE/HTTP
 * no los necesita ningún pipeline real todavía; se añaden cuando haga falta.
 *
 * `env` es una lista de NOMBRES, no valores — igual que `requires.env`: el
 * valor se resuelve en runtime desde los secretos ya declarados en
 * `requires.env` y nunca vive en claro en el YAML.
 */
const mcpServerSchema = z
  .object({
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.array(z.string()).default([]),
    /**
     * Identifica de qué paquete MCP se trata, para el gobierno de `tools:`
     * — el nombre que el autor da al servidor en
     * `mcp_servers:` es arbitrario, así que el motor no puede saber por sí
     * solo si "pw" es Playwright. Sin declarar, ninguna tool de ese servidor
     * pasa `validate` — mismo criterio por-defecto-denegado que el resto.
     */
    kind: z.enum(['playwright']).optional(),
  })
  .strict();

const baseStepSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'debe ser kebab-case en minúsculas'),
    cwd: z.string().optional(),
    inputs: z.array(z.string()).default([]),
    outputs: z.record(z.enum(OUTPUT_TYPES)).optional(),
    when: z.string().optional(),
    retry: retrySchema.optional(),
    on_error: z.enum(['stop', 'continue']).optional(),
    timeout: durationSchema.optional(),
    effects: z.array(z.string()).default([]),
  })
  .strict();

const agentStepSchema = baseStepSchema.extend({
  type: z.literal('agent').default('agent'),
  agent: z.string(),
  prompt: z.string(),
  tools: z.array(z.string()).optional(),
  /** Nombres del registro `mcp_servers` del pipeline que este paso activa. */
  mcp_servers: z.array(z.string()).default([]),
  /** Directorios de solo lectura fuera de cwd que este paso puede alcanzar. */
  additional_dirs: z.array(z.string()).default([]),
  /**
   * Tope de gasto en USD para ESTE paso, mapeado 1:1 a `Options.maxBudgetUsd`
   * del Agent SDK (soporte nativo — `sdk.d.ts` ~1683). Sin tope si no se
   * declara.
   */
  max_cost_usd: z.number().positive().optional(),
});

const shellStepSchema = baseStepSchema.extend({
  type: z.literal('shell'),
  run: z.string(),
});

/**
 * Un paso de `always:` (nivel pipeline): lista de acciones de limpieza que
 * corren siempre al cerrar el run, éxito o fallo. Deliberadamente sin
 * `inputs`/`outputs`/`when`/`on_error`: no participan del grafo de
 * dependencias ni de la política de errores del run.
 */
const alwaysStepSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'debe ser kebab-case en minúsculas'),
    run: z.string(),
    cwd: z.string().optional(),
    timeout: durationSchema.optional(),
  })
  .strict();

type ShellStepData = z.infer<typeof shellStepSchema>;
type AgentStepData = z.infer<typeof agentStepSchema>;
type StepData = ShellStepData | AgentStepData;

/**
 * Valida un paso individual (`raw`) contra el esquema de su `type` real,
 * tratando la ausencia de `type` como 'agent'.
 *
 * Por qué esta indirección en vez de `z.discriminatedUnion('type', ...)`:
 * el discriminante `type` lleva `.default('agent')` en la rama agent (un
 * paso sin `type` debe parsear como agent), pero en zod 3.25.76 el
 * enrutamiento por discriminante ocurre ANTES de resolver los `.default()`
 * — comprobado empíricamente: un objeto sin `type` no encaja en ninguna
 * rama y el fallo es un "Invalid discriminator value" genérico. Peor aún,
 * cuando ambas ramas fallan por el mismo motivo (p. ej. falta un campo
 * requerido), Zod no puede decidir cuál era la rama "correcta" y colapsa el
 * error en un "Invalid input" que no nombra el campo real. Por eso se hace
 * aquí un segundo pase manual: se elige la rama a partir del `type` crudo y
 * se reparsea solo esa rama, de modo que el issue resultante nombra el
 * campo exacto que falta (p. ej. `steps.0.prompt`) en vez de un genérico
 * `steps.0: Invalid input`.
 */
function parseStepAt(raw: unknown, index: number): { data?: StepData; issues: string[] } {
  const rawType =
    raw !== null && typeof raw === 'object' && 'type' in raw
      ? (raw as { type?: unknown }).type
      : undefined;

  if (rawType !== undefined && rawType !== 'shell' && rawType !== 'agent') {
    return { issues: [`steps.${index}.type: debe ser "shell" o "agent"`] };
  }

  const schema = rawType === 'shell' ? shellStepSchema : agentStepSchema;
  const result = schema.safeParse(raw);
  if (!result.success) {
    return {
      issues: result.error.issues.map(
        (i) => `steps.${index}.${i.path.join('.') || '(raíz)'}: ${i.message}`,
      ),
    };
  }
  return { data: result.data, issues: [] };
}

const defaultsSchema = z
  .object({
    on_error: z.enum(['stop', 'continue']).default('stop'),
    retry: retrySchema.default(0),
    timeout: durationSchema.default('15m'),
  })
  .strict();

const pipelineSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'debe ser kebab-case en minúsculas'),
    description: z.string().min(1),
    version: z.number().int().min(1),
    params: z.record(paramSchema).default({}),
    requires: requiresSchema.default({}),
    // Misma forma que `id` (kebab-case): el nombre pasa a formar parte del
    // prefijo de herramienta `mcp__<nombre>__<tool>` que el autor escribe a
    // mano en `tools:`, así que un espacio o un `__` embebido lo haría
    // ilegible o ambiguo de escribir.
    mcp_servers: z
      .record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'debe ser kebab-case en minúsculas'), mcpServerSchema)
      .default({}),
    when: z.array(z.record(z.unknown())).default([]),
    triggers: z.array(z.object({ cron: z.string() })).default([]),
    // `stale_after`: dispara el canal cuando el pipeline lleva esa ventana sin
    // un solo run con éxito, sea cual sea el estado del run actual. Es la
    // señal que `on:` no sabe dar — un `on: [skipped]` a secas sería ruido
    // (con `throttle: 46h` sobre un cron diario, la mitad de las noches salta
    // por diseño), mientras que "lleva tres días sin ejecutarse de verdad" es
    // siempre digno de un aviso. Ver `notify/dispatch.ts`.
    //
    // `.strict()`: sin esto, un `stale_afer:` mal escrito se ignoraría en
    // silencio, que es exactamente la clase de fallo mudo que este campo
    // existe para detectar.
    notify: z
      .object({
        on: z.array(z.enum(['failed', 'success', 'skipped'])),
        stale_after: durationSchema.optional(),
        channel: z.string(),
      })
      .strict()
      .optional(),
    defaults: defaultsSchema.default({}),
    // La forma fina de cada paso (según su `type`) se valida aparte, en
    // parseStepAt — ver el comentario allí.
    steps: z.array(z.record(z.unknown())).min(1),
    always: z.array(alwaysStepSchema).default([]),
  })
  .strict();

/** Herramientas permitidas cuando un paso agéntico no declara `tools`. */
export const DEFAULT_TOOLS = ['Read', 'Grep', 'Glob'] as const;

/** Nombres de tool conocidos como "sin superficie de filesystem" para cada kind. */
const MCP_TOOLS_BY_KIND: Record<'playwright', ReadonlySet<string>> = {
  playwright: new Set(Object.keys(TOOL_FS_PROFILES).filter((name) => name.startsWith('browser_'))),
};

export type Guard = z.infer<typeof guardSchema>;
export type Requires = z.infer<typeof requiresSchema>;
export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type RetryPolicy = { attempts: number; on: 'transient' | 'any' };

type StepCommon = {
  id: string;
  cwd?: string;
  inputs: string[];
  outputs?: Record<string, OutputType>;
  when?: string;
  effects: string[];
  /** Resueltos ya contra `defaults`; nunca undefined tras el parseo. */
  retry: RetryPolicy;
  onError: 'stop' | 'continue';
  timeout: string;
};

export type AgentStep = StepCommon & {
  type: 'agent';
  agent: string;
  prompt: string;
  tools: string[];
  /** Nombres del registro `mcpServers` del pipeline que este paso activa. */
  mcpServers: string[];
  /** Nombres de directorio adicionales, ya interpolables como cwd (solo params, nunca secrets). */
  additionalDirs: string[];
  maxCostUsd?: number;
};

export type ShellStep = StepCommon & { type: 'shell'; run: string };

export type Step = AgentStep | ShellStep;

export type Pipeline = {
  name: string;
  description: string;
  version: number;
  params: Record<string, z.infer<typeof paramSchema>>;
  requires: Requires;
  mcpServers: Record<string, McpServerConfig>;
  when: Guard[];
  triggers: { cron: string }[];
  notify?: {
    on: ('failed' | 'success' | 'skipped')[];
    /** Ventana sin ningún run con éxito tras la cual notificar igualmente. */
    staleAfter?: string;
    channel: string;
  };
  steps: Step[];
  always: ShellStep[];
};

function normalizeRetry(raw: z.infer<typeof retrySchema>): RetryPolicy {
  return typeof raw === 'number' ? { attempts: raw, on: 'transient' } : raw;
}

/**
 * Parsea y valida un pipeline.yaml. Resuelve los `defaults` del pipeline
 * dentro de cada paso, de modo que el resto del sistema nunca ve un campo
 * de política sin valor.
 */
export function parsePipeline(yamlText: string): Pipeline {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new PipelineParseError([`YAML mal formado: ${(err as Error).message}`]);
  }

  const result = pipelineSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`,
    );
    throw new PipelineParseError(issues);
  }
  const parsed = result.data;

  // Segundo pase: cada paso se valida contra el esquema de su `type` real
  // (ver parseStepAt) para que los errores nombren el campo concreto.
  const stepIssues: string[] = [];
  const validatedSteps: StepData[] = [];
  parsed.steps.forEach((rawStep, index) => {
    const { data, issues } = parseStepAt(rawStep, index);
    if (data) validatedSteps.push(data);
    stepIssues.push(...issues);
  });
  if (stepIssues.length > 0) throw new PipelineParseError(stepIssues);

  // Segundo pase, mismo motivo que los pasos: cada guarda de `when` se
  // valida contra el esquema de su rama real (ver parseGuardAt) para que
  // los errores nombren el campo concreto.
  const guardIssues: string[] = [];
  const validatedGuards: Guard[] = [];
  parsed.when.forEach((rawGuard, index) => {
    const { data, issues } = parseGuardAt(rawGuard, index);
    if (data) validatedGuards.push(data);
    guardIssues.push(...issues);
  });
  if (guardIssues.length > 0) throw new PipelineParseError(guardIssues);

  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const step of validatedSteps) {
    if (seen.has(step.id)) duplicates.push(`steps: id duplicado "${step.id}"`);
    seen.add(step.id);
  }
  for (const step of parsed.always) {
    if (seen.has(step.id)) duplicates.push(`always: id duplicado "${step.id}"`);
    seen.add(step.id);
  }
  if (duplicates.length > 0) throw new PipelineParseError(duplicates);

  // Referencial, en las dos direcciones:
  //  1. Cada nombre en `steps[].mcp_servers` debe existir en el registro
  //     `mcp_servers` del pipeline. Detectarlo aquí (en vez de dejar que
  //     `runAgentStep` reciba un nombre sin resolver) da un error que nombra
  //     el campo exacto, igual que el resto de este parser.
  //  2. Toda herramienta `mcp__<servidor>__...` en `tools:` debe tener su
  //     `<servidor>` activado en `mcp_servers:` del mismo paso. Sin este
  //     sentido inverso, un autor puede listar la tool en `tools` (es
  //     obligatorio) y olvidar la línea `mcp_servers: [...]`: `validate` y
  //     `doctor` pasan, y el fallo solo aparece a mitad de una ejecución
  //     desatendida cuando el agente no tiene el servidor que su propia
  //     lista de herramientas promete.
  //  3. Gobierno de tools — deny-by-default: cada tool
  //     declarada en un paso agent debe estar en `TOOL_FS_PROFILES` (nativa)
  //     o ser una herramienta MCP válida para su servidor y su kind.
  const mcpIssues: string[] = [];
  validatedSteps.forEach((step, index) => {
    if (step.type !== 'agent') return;
    step.mcp_servers.forEach((name, mcpIndex) => {
      if (!(name in parsed.mcp_servers)) {
        mcpIssues.push(
          `steps.${index}.mcp_servers.${mcpIndex}: servidor MCP "${name}" no declarado en mcp_servers`,
        );
      }
    });

    // Comprobación de herramientas nativas (non-mcp__) — deny-by-default.
    step.tools?.forEach((tool, toolIndex) => {
      if (tool.startsWith('mcp__')) return; // cubierto en el forEach de abajo
      if (HARD_DENY_TOOLS.has(tool)) {
        mcpIssues.push(
          `steps.${index}.tools.${toolIndex}: "${tool}" no está permitida en un paso agent` +
            (tool === 'Bash' ? ' — si necesitas ejecutar comandos, usa un paso type: shell' : ''),
        );
        return;
      }
      if (!(tool in TOOL_FS_PROFILES)) {
        mcpIssues.push(`steps.${index}.tools.${toolIndex}: tool desconocida para el motor: "${tool}"`);
      }
    });

    // Comprobación de herramientas MCP (mcp__<servidor>__<sufijo>).
    step.tools?.forEach((tool, toolIndex) => {
      if (!tool.startsWith('mcp__')) return;
      const hasServer = step.mcp_servers.some((name) => tool.startsWith(`mcp__${name}__`));
      if (!hasServer) {
        mcpIssues.push(
          `steps.${index}.tools.${toolIndex}: la herramienta "${tool}" requiere activar su servidor en mcp_servers`,
        );
        return;
      }
      const serverName = step.mcp_servers.find((name) => tool.startsWith(`mcp__${name}__`))!;
      const kind = parsed.mcp_servers[serverName]?.kind;
      const suffix = tool.slice(`mcp__${serverName}__`.length);
      if (HARD_DENY_TOOLS.has(suffix)) {
        mcpIssues.push(
          `steps.${index}.tools.${toolIndex}: "${tool}" no está permitida en un paso agent — ejecuta código/JS arbitrario`,
        );
        return;
      }
      if (!kind) {
        mcpIssues.push(
          `steps.${index}.tools.${toolIndex}: "${tool}" no se puede conceder — el servidor "${serverName}" no declara kind: en mcp_servers`,
        );
        return;
      }
      if (!MCP_TOOLS_BY_KIND[kind].has(suffix)) {
        mcpIssues.push(
          `steps.${index}.tools.${toolIndex}: "${suffix}" no es una tool conocida para kind: ${kind}`,
        );
      }
    });
  });
  if (mcpIssues.length > 0) throw new PipelineParseError(mcpIssues);

  const steps: Step[] = validatedSteps.map((step) => {
    const common: StepCommon = {
      id: step.id,
      cwd: step.cwd,
      inputs: step.inputs,
      outputs: step.outputs,
      when: step.when,
      effects: step.effects,
      retry: normalizeRetry(step.retry ?? parsed.defaults.retry),
      onError: step.on_error ?? parsed.defaults.on_error,
      timeout: step.timeout ?? parsed.defaults.timeout,
    };
    if (step.type === 'shell') return { ...common, type: 'shell', run: step.run };
    return {
      ...common,
      type: 'agent',
      agent: step.agent,
      prompt: step.prompt,
      tools: step.tools ?? [...DEFAULT_TOOLS],
      mcpServers: step.mcp_servers,
      additionalDirs: step.additional_dirs,
      maxCostUsd: step.max_cost_usd,
    };
  });

  const always: ShellStep[] = parsed.always.map((step) => ({
    id: step.id,
    type: 'shell',
    run: step.run,
    cwd: step.cwd,
    inputs: [],
    outputs: undefined,
    when: undefined,
    effects: [],
    retry: { attempts: 0, on: 'transient' },
    onError: 'stop',
    timeout: step.timeout ?? parsed.defaults.timeout,
  }));

  return {
    name: parsed.name,
    description: parsed.description,
    version: parsed.version,
    params: parsed.params,
    requires: parsed.requires,
    mcpServers: parsed.mcp_servers,
    when: validatedGuards,
    triggers: parsed.triggers,
    notify: parsed.notify && {
      on: parsed.notify.on,
      staleAfter: parsed.notify.stale_after,
      channel: parsed.notify.channel,
    },
    steps,
    always,
  };
}
