import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  query,
  type AgentDefinition,
  type Options,
  type SDKAssistantMessageError,
  type SDKMessage,
  type SDKResultError,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { interpolate, type InterpolationScope } from '../params/resolve.ts';
import type { AgentStep, McpServerConfig, OutputType } from '../schema/pipeline.ts';
import {
  composeAgentEnv,
  redactOutputValues,
  validateOutputs,
  type StepContext,
  type StepOutcome,
} from './shell.ts';
import { redactSecrets } from '../runs/store.ts';
import { captureRoots, evaluateToolCall, type FsRoots } from './fs-guard.ts';
import type { HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
// `Denial` vive en `runs/types.ts` (no aquí) para evitar un ciclo de
// módulos — ver el comentario junto a su definición allí. Se re-exporta
// desde este fichero por comodidad de quien ya importa tipos de agent.ts.
import type { Denial } from '../runs/types.ts';
export type { Denial } from '../runs/types.ts';

export type JsonSchemaObject = {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
};

/**
 * Firma mínima que el runner necesita del SDK; inyectable para los tests.
 * Los mensajes son `SDKMessage`, el tipo real que exporta el propio SDK — no
 * una forma inventada — así que un fake de test o un cambio futuro del SDK
 * que no encaje falla en `tsc`, no en producción.
 */
export type QueryFn = (args: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<SDKMessage>;

export type AgentStepContext = StepContext & {
  repoRoot: string;
  /** Contenido del fichero de prompt, ya leído de disco. */
  promptText: string;
  /** Registro `mcp_servers` del pipeline; el paso activa un subconjunto por nombre. */
  mcpServers: Record<string, McpServerConfig>;
  queryFn?: QueryFn;
};

export type AgentOutcome = StepOutcome & {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  toolsUsed?: string[];
  /** Denegaciones del hook PreToolUse durante este paso — ver buildDenials. */
  denials?: Denial[];
};

/**
 * Cruza el log propio del hook (motivo, por tool_use_id) contra
 * `result.permission_denials` del SDK (recuento autoritativo, sin motivo).
 * Un desajuste entre las dos fuentes es la señal más valiosa: una entrada
 * de `hookLog` sin pareja en `sdkDenials` sugiere que el hook denegó pero el
 * SDK no lo registró (inesperado); una entrada de `sdkDenials` sin pareja en
 * `hookLog` sugiere que algo ajeno al propio hook produjo la denegación —
 * en ambos casos, exactamente el tipo de discrepancia que un fallo-abierto
 * silencioso produciría — y el sandbox nunca debe fallar abierto sin que
 * se note.
 */
function buildDenials(
  hookLog: Map<string, { toolName: string; reason: string }>,
  sdkDenials: ReadonlyArray<{ tool_name: string; tool_use_id: string }>,
): Denial[] {
  const denials: Denial[] = [];
  const sdkByToolUseId = new Map(sdkDenials.map((d) => [d.tool_use_id, d]));
  for (const [toolUseId, entry] of hookLog) {
    const inSdk = sdkByToolUseId.has(toolUseId);
    denials.push({
      toolName: entry.toolName,
      toolUseId,
      reason: entry.reason,
      source: inSdk ? 'both' : 'hook-log',
    });
    sdkByToolUseId.delete(toolUseId);
  }
  for (const [toolUseId, entry] of sdkByToolUseId) {
    denials.push({ toolName: entry.tool_name, toolUseId, source: 'sdk-result' });
  }
  return denials;
}

/**
 * El SDK entrega el nombre de una tool MCP en su forma CUALIFICADA
 * (`mcp__<servidor>__<tool>`, p. ej. `mcp__playwright__browser_take_screenshot`),
 * pero `TOOL_FS_PROFILES` (fs-guard.ts) está indexada por el sufijo
 * DESNUDO (`browser_take_screenshot`) — igual que ya hacen el gobierno
 * estático de `tools:` en `schema/pipeline.ts` (`parsePipeline`) y la deriva
 * de esquema de `doctor` (`preflight/check.ts`), ambos quitando el mismo
 * prefijo antes de consultar la tabla. Este hook era el único de los tres
 * consumidores que NO lo hacía, y sin esta normalización TODA llamada a una tool MCP real caía
 * en `if (!profile) return deny('tool desconocida para el motor')` de
 * `evaluateToolCall`, denegando en la práctica las 18+ tools de Playwright
 * que un pipeline real concede — fallando cerrado (nunca una fuga de
 * seguridad), pero dejando la mitad MCP de la tabla sin aplicar nunca.
 *
 * Solo se quita el prefijo para un servidor que ESTE paso activó de verdad
 * (`mcpServerNames`, `step.mcpServers`) — nunca a ciegas para cualquier
 * `mcp__<algo>__`: si se quitara sin comprobar el nombre del servidor, una
 * tool de un servidor no gobernado o inesperado podría heredar por accidente
 * el perfil de una tool de Playwright que solo comparte sufijo. Un nombre
 * nativo sin prefijo (`Read`, `Bash`...) no casa con ningún patrón y se
 * devuelve tal cual.
 */
function normalizeToolName(toolName: string, mcpServerNames: readonly string[]): string {
  for (const server of mcpServerNames) {
    const prefix = `mcp__${server}__`;
    if (toolName.startsWith(prefix)) return toolName.slice(prefix.length);
  }
  return toolName;
}

/**
 * Construye el hook `PreToolUse` para un paso, cerrado sobre `roots`, un
 * log mutable de denegaciones (`hookLog`, poblado como efecto lateral cada
 * vez que el hook deniega — `buildDenials` lo consume al final del paso) y
 * los nombres de servidor MCP que el paso activó (`mcpServerNames`, para
 * `normalizeToolName`). El cuerpo entero está envuelto en un único
 * `try/catch` que nunca deja escapar una excepción — `evaluateToolCall` ya
 * no lanza por su cuenta, pero esta capa es la red de seguridad si algo en
 * el futuro rompiera esa garantía sin que un test lo detectara primero: el
 * sandbox nunca falla abierto, ante cualquier duda deniega.
 */
function makePreToolUseHook(
  roots: FsRoots,
  hookLog: Map<string, { toolName: string; reason: string }>,
  mcpServerNames: readonly string[],
): (input: HookInput, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<HookJSONOutput> {
  return async (input, toolUseId) => {
    try {
      if (input.hook_event_name !== 'PreToolUse') return {};
      // `hookLog`/el resultado final SIEMPRE usan el nombre tal cual lo
      // reportó el SDK (`input.tool_name`, cualificado si es MCP) — es lo
      // que `result.permission_denials` también usa, así que `buildDenials`
      // los empareja por el mismo nombre. Solo la CONSULTA a
      // `TOOL_FS_PROFILES` usa el sufijo normalizado.
      const normalized = normalizeToolName(input.tool_name, mcpServerNames);
      const result = evaluateToolCall(normalized, input.tool_input, roots);
      if (result.allowed) {
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
      }
      if (toolUseId) hookLog.set(toolUseId, { toolName: input.tool_name, reason: result.reason });
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: result.reason,
        },
      };
    } catch (err) {
      const reason = `error interno del hook — se deniega por defecto (${(err as Error).message})`;
      if (toolUseId) hookLog.set(toolUseId, { toolName: (input as { tool_name?: string }).tool_name ?? '?', reason });
      return {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
      };
    }
  };
}

/**
 * Categorías de error que el propio SDK asigna a un turno de `assistant`
 * fallido (`SDKAssistantMessage.error`, `sdk.d.ts` línea ~2933) o a un
 * reintento interno que el propio CLI realiza (`SDKAPIRetryMessage.error`,
 * línea ~2924) — mismo tipo `SDKAssistantMessageError` en ambos sitios
 * (línea ~2976). Son las tres categorías cuyo origen es el lado del
 * servidor/red, no el contenido de la petición: la misma petición puede
 * tener éxito en un segundo intento. El resto de categorías del enum
 * ('authentication_failed', 'oauth_org_not_allowed', 'billing_error',
 * 'invalid_request', 'model_not_found', 'max_output_tokens') son de
 * configuración, credenciales o contenido — reintentar la misma petición no
 * las resuelve.
 */
const TRANSIENT_ASSISTANT_ERRORS: ReadonlySet<SDKAssistantMessageError> = new Set([
  'rate_limit',
  'overloaded',
  'server_error',
]);

/**
 * Subtipos de `SDKResultError` (`sdk.d.ts` línea ~4352) que NO son un fallo
 * transitorio del lado del servidor bajo ninguna interpretación: agotar el
 * número de turnos, el presupuesto en USD o los reintentos de salida
 * estructurada son condiciones de configuración o de contenido, no de red —
 * repetir la misma petición no las resuelve. Solo `error_during_execution`
 * es un cajón de sastre que puede o no ser un error de API real; para ese
 * caso se recurre al respaldo de coincidencia de texto (`isTransientText`)
 * cuando no se ha observado ninguna categoría estructurada durante el flujo.
 */
const NON_TRANSIENT_RESULT_SUBTYPES: ReadonlySet<SDKResultError['subtype']> = new Set([
  'error_max_turns',
  'error_max_budget_usd',
  'error_max_structured_output_retries',
]);

/**
 * Respaldo de coincidencia de texto para dos casos que no traen una
 * categoría estructurada del SDK: una excepción lanzada por `queryFn` (fallo
 * de transporte antes de que exista ningún mensaje) y un `SDKResultError`
 * con `subtype: 'error_during_execution'` en el que nunca se observó
 * `SDKAssistantMessage.error` ni `SDKAPIRetryMessage.error` durante el flujo.
 *
 * Se comparan como fragmentos delimitados, no como subcadena libre: un
 * `.includes('429')` ingenuo confundiría el código HTTP 429 con, por
 * ejemplo, el número "14290" en "processed 14290 items". El delimitador no
 * puede ser el `\b` nativo de JavaScript porque trata `_` como carácter de
 * palabra, y los tipos de error reales de la API de Anthropic son snake_case
 * (`overloaded_error`, `rate_limit_error`): con `\b`, `/\boverloaded\b/` NO
 * casa dentro de "overloaded_error" porque no hay límite de palabra entre
 * "d" y "_". Aquí el límite se define como "no alfanumérico" (incluye `_`,
 * espacios, `:`, inicio/fin de cadena), así que un patrón aislado por
 * guiones bajos sigue casando.
 */
const TRANSIENT_TEXT_PATTERNS = [
  'overloaded',
  'rate_limit',
  'timeout',
  'econnreset',
  'etimedout',
  'socket hang up',
  '429',
  '529',
  '503',
];

/** ¿Aparece `pattern` en `text` delimitado por caracteres no alfanuméricos (o los extremos de la cadena)? */
function containsDelimited(text: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`).test(text);
}

/**
 * Un texto libre se clasifica como transitorio solo si casa con un patrón
 * conocido. Un error sin reconocer se clasifica como NO transitorio
 * (permanente): un paso agéntico puede tener `Bash` u otras herramientas con
 * efectos reales en `tools`, así que reintentar a ciegas ante un error que
 * no se entiende arriesga repetir esos efectos y gastar presupuesto de la
 * API sin garantía de éxito. La clasificación conservadora es detener la
 * ejecución y dejar que una persona decida, no reintentar por defecto. Mismo
 * default seguro que usa `classifyResultError` para su propia categoría
 * "sin reconocer".
 */
function isTransientText(message: string): boolean {
  const lower = message.toLowerCase();
  return TRANSIENT_TEXT_PATTERNS.some((p) => containsDelimited(lower, p));
}

/**
 * Clasifica un `SDKResultError` como transitorio o permanente. `subtype`
 * manda primero, no `lastStructuredError`: los tres subtipos de agotamiento
 * (turnos, presupuesto, reintentos de salida estructurada) son SIEMPRE
 * permanentes con independencia de lo que haya pasado por el camino — si un
 * turno intermedio vio 'overloaded' y el propio CLI lo reintentó con éxito
 * (ver `SDKAPIRetryMessage` más abajo), pero la query acabó agotando turnos
 * de todos modos, el motivo real del fallo es "se acabaron los turnos", no
 * "el servidor estaba sobrecargado" — ese hipo ya quedó absorbido y
 * reintentar nuestro paso desde cero no lo va a arreglar solo por eso. Por
 * eso `lastStructuredError` solo se consulta dentro de la categoría
 * ambigua `error_during_execution`; si tampoco hay ninguna, cae al
 * respaldo de texto sobre `errors`. Un `subtype`/categoría sin reconocer cae
 * del lado seguro (no transitorio), igual que `isTransientText`.
 */
function classifyResultError(
  result: SDKResultError,
  lastStructuredError: SDKAssistantMessageError | undefined,
): boolean {
  if (NON_TRANSIENT_RESULT_SUBTYPES.has(result.subtype)) return false;
  if (lastStructuredError) return TRANSIENT_ASSISTANT_ERRORS.has(lastStructuredError);
  return isTransientText(result.errors.join(' '));
}

function typeToSchema(type: OutputType): unknown {
  if (type.endsWith('[]')) {
    return { type: 'array', items: { type: type.slice(0, -2) } };
  }
  return { type };
}

/** Traduce el contrato `outputs` a un JSON Schema para `outputFormat` del SDK. */
export function outputsToJsonSchema(
  contract: Record<string, OutputType>,
): JsonSchemaObject {
  const properties: Record<string, unknown> = {};
  for (const [name, type] of Object.entries(contract)) {
    properties[name] = typeToSchema(type);
  }
  return {
    type: 'object',
    properties,
    required: Object.keys(contract),
    additionalProperties: false,
  };
}

/**
 * Variables de red no-secretas que se reenvían a TODO servidor MCP
 * declarado, además de los nombres explícitos de `env` de cada uno. El
 * `command` típico de un servidor MCP es `npx`, que resuelve el paquete
 * contra el registro en cada arranque; sin esto, un pipeline detrás de un
 * proxy corporativo falla a arrancar el servidor con un error de red que
 * nada en el YAML explica, y no hay forma de declararlas vía `env` porque
 * ese campo solo resuelve nombres presentes en `requires.env` (pensado para
 * secretos, no para configuración de red). Lista distinta de
 * `AGENT_AUTH_ENV_KEYS` en `shell.ts` a propósito: esas llevan credenciales
 * (`ANTHROPIC_API_KEY`...) que un servidor MCP genérico no necesita ver;
 * estas no son secretas, así que se reenvían siempre, no solo cuando el
 * pipeline las declara.
 */
const MCP_NETWORK_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE'];

/**
 * Resuelve los nombres de `step.mcpServers` contra el registro `mcp_servers`
 * del pipeline, en la forma `McpStdioServerConfig` que espera `Options`
 * (`sdk.d.ts` ~1167). El tipo de retorno se ancla a `Options['mcpServers']`
 * del propio SDK (no a una forma inventada): si una versión futura del SDK
 * cambia esa forma, esto rompe `tsc`, no un cron a las 3am — mismo criterio
 * que ya rige `SDKMessage` en el resto de este módulo. `parsePipeline` ya
 * garantiza que todo nombre referenciado por un paso existe en el registro
 * — el `!` de abajo se apoya en esa garantía, no es una suposición de este
 * módulo.
 *
 * `command`/`args` se interpolan contra `scope` igual que `cwd`/`prompt`
 * (mismo mecanismo, misma razón: un `command` o `args` dependiente de
 * `{{params.*}}` sin hardcodear una ruta de máquina, p. ej. un binario
 * instalado en una ruta de usuario distinta en cada equipo). El grafo de
 * dependencias NO ve estas referencias — mismo límite ya aceptado para el
 * contenido de los ficheros de prompt: un servidor MCP
 * cuyo `command` dependiera de la salida de OTRO paso queda fuera de lo que
 * este campo cubre.
 *
 * `env` de cada servidor son NOMBRES (ver `mcpServerSchema` en
 * `schema/pipeline.ts`), resueltos aquí contra `secrets` — los mismos
 * valores que ya filtró `requires.env`. Un nombre sin valor en `secrets`
 * (declarado en el servidor pero no en `requires.env` del pipeline) se omite
 * en vez de lanzar: el servidor MCP arrancará sin esa variable y fallará con
 * su propio error de autenticación, que es más diagnosticable para quien
 * escribe el pipeline que una excepción genérica de este runner.
 */
function resolveMcpServers(
  names: string[],
  registry: Record<string, McpServerConfig>,
  secrets: Record<string, string>,
  scope: InterpolationScope,
): NonNullable<Options['mcpServers']> {
  const resolved: NonNullable<Options['mcpServers']> = {};
  for (const name of names) {
    const config = registry[name]!;
    const env: Record<string, string> = {};
    for (const key of MCP_NETWORK_ENV_KEYS) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    for (const key of config.env) {
      const value = secrets[key];
      if (value !== undefined) env[key] = value;
    }
    resolved[name] = {
      command: interpolate(config.command, scope),
      args: config.args.map((arg) => interpolate(arg, scope)),
      env,
    };
  }
  return resolved;
}

/**
 * Separa el front matter YAML (delimitado por `---` al principio del
 * fichero) del cuerpo de un agente en Markdown. El cuerpo es el prompt del
 * agente tal cual lo espera `AgentDefinition.prompt`.
 *
 * Un fichero SIN delimitadores `---` no es un error: se trata como si todo
 * fuera cuerpo (front matter vacío) — es el caso normal de un prompt sin
 * metadatos, y `loadRepoAgents` debe seguir cargándolo.
 *
 * Cuando SÍ hay delimitadores pero lo de dentro no sirve como front matter
 * — YAML sintácticamente inválido, o YAML válido que no es un mapeo
 * clave-valor (una lista, un escalar...) — esta función lanza. Es
 * intencional: `loadRepoAgents` atrapa esa excepción por fichero, para que
 * un agente roto se omita con un aviso en vez de tumbar a los demás.
 */
function parseAgentMarkdown(text: string): { frontMatter: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { frontMatter: {}, body: text };
  const parsed: unknown = parseYaml(match[1] ?? '');
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('el front matter no es un mapeo YAML de clave: valor');
  }
  return { frontMatter: parsed as Record<string, unknown>, body: match[2] ?? '' };
}

/**
 * Carga los agentes propios del repo de pipelines (`<repoRoot>/agents/*.md`)
 * en la forma que espera `Options.agents` del SDK (`AgentDefinition`,
 * `sdk.d.ts` ~38-70): `description` del front matter y el cuerpo Markdown
 * como `prompt`. El nombre del agente es el nombre de fichero sin `.md`,
 * igual que ya hace `preflight` (`markdownNames` en `preflight/check.ts`)
 * para el check `✓ agent <name> repo` de `doctor` — así que un agente que
 * pasa esa comprobación es exactamente el que aquí se carga y se pasa al
 * SDK. Antes de esta función `AgentStepContext.repoRoot` se recibía pero
 * nunca se leía: el runner nunca llegaba a inyectar los agentes del repo.
 *
 * Un directorio `agents/` ausente es normal (no todo pipeline trae agentes
 * propios) y no lanza, igual que `markdownNames`.
 *
 * La carga de cada fichero es independiente: es descubrimiento best-effort,
 * no una puerta de validación. Un fichero que no se puede leer o cuyo front
 * matter no se puede interpretar se OMITE con un aviso que nombra el
 * fichero y el motivo — nunca aborta el directorio entero. Antes, una
 * excepción de `parseAgentMarkdown` en un solo `.md` roto escapaba del
 * bucle y descartaba también los agentes válidos ya cargados; un paso que
 * ni siquiera usaba el agente roto fallaba igualmente.
 */
export async function loadRepoAgents(repoRoot: string): Promise<Record<string, AgentDefinition>> {
  let entries: string[];
  try {
    entries = await readdir(join(repoRoot, 'agents'));
  } catch {
    return {};
  }

  const agents: Record<string, AgentDefinition> = {};
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const name = entry.slice(0, -3);
    const path = join(repoRoot, 'agents', entry);

    let frontMatter: Record<string, unknown>;
    let body: string;
    try {
      const text = await readFile(path, 'utf8');
      ({ frontMatter, body } = parseAgentMarkdown(text));
    } catch (err) {
      console.warn(
        `Aviso: se omite el agente "${name}" (${path}): ${(err as Error).message}`,
      );
      continue;
    }

    const definition: AgentDefinition = {
      description: typeof frontMatter.description === 'string' ? frontMatter.description : '',
      prompt: body.trim(),
    };
    if (Array.isArray(frontMatter.tools) && frontMatter.tools.every((t) => typeof t === 'string')) {
      definition.tools = frontMatter.tools as string[];
    } else if (typeof frontMatter.tools === 'string') {
      definition.tools = frontMatter.tools
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
    }
    if (typeof frontMatter.model === 'string') definition.model = frontMatter.model;
    agents[name] = definition;
  }
  return agents;
}

/**
 * Redacta el `reason` de cada denegación (donde exista) — igual criterio que
 * el resto de `redactOutcome`, aplicado aparte porque `denials` es un array
 * anidado que `redactSecrets` (pensado para texto plano) no puede tocar por
 * sí solo. Necesario porque `reason` (`evaluateToolCall`, fs-guard.ts)
 * incrusta la ruta cruda tal cual la pidió el modelo (`"${raw}" resuelve
 * fuera de toda raíz permitida...`), y un prompt agéntico SÍ puede
 * interpolar `{{secrets.X}}` en su propio texto (ver el comentario sobre
 * `scope`/`secrets` en `runAgentStep`) — así que un secreto que acabe dentro
 * de una ruta denegada llegaría en claro hasta el `run.json` de ese run
 * dentro de `.runs/` sin este paso.
 */
function redactDenials(denials: Denial[] | undefined, values: string[]): Denial[] | undefined {
  if (!denials) return denials;
  return denials.map((d) =>
    d.reason === undefined ? d : { ...d, reason: redactSecrets(d.reason, values) },
  );
}

/**
 * Redacta los valores de secreto de un AgentOutcome antes de que salga de
 * esta función, en cada camino de retorno de `runAgentStep` (éxito, fallo,
 * timeout, incumplimiento de contrato). Mismo criterio que `redactOutcome`
 * en `shell.ts`: el valor de secreto
 * existe en claro solo dentro de esta función (hay que pasarlo al SDK vía
 * `env`), así que es también el único punto donde hay que garantizar que no
 * sobreviva a la salida — de aquí en adelante el outcome se escribe en
 * `.runs/` y se imprime por la CLI. Se redactan `log`, `error`, los valores
 * de texto dentro de `outputs` y el `reason` de cada denegación
 * (`denials[].reason`, ver `redactDenials`); un paso agéntico con `Bash` en
 * `tools` puede ecoar un secreto en su propio resultado exactamente igual
 * que un paso `shell`, así que el mismo tratamiento aplica aquí.
 *
 * Las dos ramas que hacen `{ ...outcome, ... }` (éxito sin incumplimiento de
 * contrato, y fallo) NO heredan `denials` ya redactado solo por el spread:
 * `outcome.denials` viaja tal cual dentro de ese spread salvo que se
 * sobrescriba explícitamente aquí — de ahí el `denials: redactDenials(...)`
 * en las tres ramas, no solo en la que construye un objeto nuevo.
 */
function redactOutcome(outcome: AgentOutcome, secrets: Record<string, string>): AgentOutcome {
  const values = Object.values(secrets);
  if (outcome.ok) {
    const redacted = redactOutputValues(outcome.outputs, values);
    if (!redacted.ok) {
      const issues = redacted.violatingFields.map(
        (field) => `el campo "${field}" contiene un valor de secreto`,
      );
      return {
        ok: false,
        error: redactSecrets(`Contrato incumplido: ${issues.join('; ')}`, values),
        transient: false,
        log: redactSecrets(outcome.log, values),
        durationMs: outcome.durationMs,
        costUsd: outcome.costUsd,
        inputTokens: outcome.inputTokens,
        outputTokens: outcome.outputTokens,
        toolsUsed: outcome.toolsUsed,
        denials: redactDenials(outcome.denials, values),
      };
    }
    return {
      ...outcome,
      outputs: redacted.outputs,
      log: redactSecrets(outcome.log, values),
      denials: redactDenials(outcome.denials, values),
    };
  }
  return {
    ...outcome,
    log: redactSecrets(outcome.log, values),
    error: redactSecrets(outcome.error, values),
    denials: redactDenials(outcome.denials, values),
  };
}

/**
 * Ejecuta un paso agéntico contra el Claude Agent SDK.
 *
 * `permissionMode: 'bypassPermissions'` es deliberado: una ejecución
 * desatendida no tiene a nadie que apruebe nada. El control real de lo que
 * el paso puede hacer es `tools` (decisión 15): `allowedTools` por sí solo
 * NO restringe nada — es solo la lista que se auto-aprueba sin preguntar
 * (`sdk.d.ts` ~1369-1371, "To restrict which tools are available, use the
 * `tools` option instead") — así que se pasan ambos: `tools` para que el
 * SDK no exponga al modelo nada fuera de lo declarado en el YAML, y
 * `allowedTools` para que lo declarado no dispare un prompt de permiso que,
 * bajo `bypassPermissions`, nunca tendría quien lo respondiera.
 *
 * `strictMcpConfig: true` es la misma lógica aplicada a `mcpServers`: sin
 * ella, `Options.mcpServers` es ADITIVO a cualquier `.mcp.json` de proyecto,
 * servidor MCP de usuario o de plugin que ya esté configurado en la máquina
 * que ejecuta el pipeline (`sdk.d.ts` ~2006) — el pipeline declararía un
 * servidor y el paso arrancaría ese MÁS los que hubiera alrededor, sin que
 * `mcp_servers:` ni `doctor` supieran nada de ellos. Verificado en una
 * revisión de este mismo cambio: un `.mcp.json` de otro repo con
 * credenciales de base de datos en claro en sus `args` es exactamente la
 * clase de servidor "ambiental" que esto evita cargar.
 *
 * `settingSources: []`: sin fuentes ambientales, ni `user` ni `project`.
 * Antes se pasaba `['user']` sin justificación escrita — cargaba el
 * `~/.claude/settings.json` GLOBAL del operador, hooks incluidos. Verificado
 * en vivo: basta un plugin instalado que traiga un hook `SessionStart`
 * bloqueante para colgar un run desatendido, el mismo tipo de cuelgue que el
 * script bash original evitaba a propósito con `--setting-sources project`.
 * Mismo criterio que `strictMcpConfig: true`: un pipeline no hereda nada de
 * la máquina que lo ejecuta salvo lo que su propio YAML declara.
 */
export async function runAgentStep(
  step: AgentStep,
  ctx: AgentStepContext,
): Promise<AgentOutcome> {
  const started = Date.now();
  // Copia local del scope, solo para el prompt: `ctx.scope` en sí nunca
  // lleva `secrets` (lo construye orchestrate.ts sin ese campo), así que
  // `{{secrets.X}}` no puede resolver en ningún otro sitio (`cwd:` de este
  // mismo paso, `run:`/guarda `shell:` de cualquier otro): un secreto solo
  // llega al prompt del paso agéntico que lo pide.
  const prompt = interpolate(ctx.promptText, { ...ctx.scope, secrets: ctx.secrets });
  const cwd = step.cwd ? interpolate(step.cwd, ctx.scope) : ctx.defaultCwd;
  const additionalDirs = step.additionalDirs.map((d) => interpolate(d, ctx.scope));
  // Resolución de raíces ANTES de crear el AbortController/timer: si
  // `captureRoots` lanza (una raíz no existe), el paso debe cerrarse como
  // error de configuración sin fugar un timer de hasta 50 minutos que nadie
  // limpiaría. Por eso el orden de estas líneas importa.
  const roots = captureRoots(cwd, additionalDirs);
  const hookLog = new Map<string, { toolName: string; reason: string }>();
  const agents = await loadRepoAgents(ctx.repoRoot);
  const mcpServers = resolveMcpServers(step.mcpServers, ctx.mcpServers, ctx.secrets, ctx.scope);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);

  const options: Record<string, unknown> = {
    agent: step.agent,
    agents,
    allowedTools: step.tools,
    tools: step.tools,
    cwd,
    additionalDirectories: additionalDirs, // informativo para el SDK/modelo — la aplicación real es el hook
    env: composeAgentEnv(ctx.secrets),
    settingSources: [],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    strictMcpConfig: true,
    abortController: controller,
    persistSession: false,
    hooks: { PreToolUse: [{ hooks: [makePreToolUseHook(roots, hookLog, step.mcpServers)] }] },
  };
  if (step.outputs) {
    options.outputFormat = { type: 'json_schema', schema: outputsToJsonSchema(step.outputs) };
  }
  if (Object.keys(mcpServers).length > 0) options.mcpServers = mcpServers;
  if (step.maxCostUsd !== undefined) options.maxBudgetUsd = step.maxCostUsd;

  // `options` se construye como `Record<string, unknown>` para coincidir con
  // la firma de `QueryFn` (la que se testea), mientras que `query()` real
  // espera `Options`, un tipo con decenas de campos concretos. No hace falta
  // ningún cast para pasar de uno a otro: en `Options` (SDK 0.3.223) todos
  // los campos de primer nivel son opcionales, así que TypeScript no exige
  // que la firma de índice de `Record<string, unknown>` sea compatible con
  // el tipo concreto de cada campo — solo comprueba que no falte ningún
  // campo obligatorio, y no hay ninguno. El valor de retorno de `query()`
  // tampoco necesita cast: `Query` extiende `AsyncGenerator<SDKMessage,
  // void>`, que ya es un `AsyncIterable<SDKMessage>` — exactamente lo que
  // `QueryFn` declara. Verificado quitando ambos casts y comprobando que
  // `bun run typecheck` sigue limpio: no hacían falta y no ocultaban ningún
  // error real.
  const run = ctx.queryFn ?? ((args) => query(args));

  const toolsUsed: string[] = [];
  const transcript: string[] = [];
  let result: SDKResultMessage | undefined;
  // Última categoría de error estructurada vista en el flujo, de
  // `SDKAssistantMessage.error` o `SDKAPIRetryMessage.error` (ver
  // `classifyResultError`). Se sobrescribe con la más reciente: si el CLI
  // reintentó internamente varias veces, la categoría más próxima al fallo
  // final es la más representativa de por qué terminó fallando.
  let lastStructuredError: SDKAssistantMessageError | undefined;

  try {
    for await (const message of run({ prompt, options })) {
      if (message.type === 'assistant') {
        // El uso de herramientas viaja dentro de los bloques de contenido
        // del mensaje `assistant` (`BetaContentBlock` con
        // `type: 'tool_use'`), no como mensajes `tool_use` sueltos — el SDK
        // real no los emite así.
        for (const block of message.message.content) {
          if (block.type === 'tool_use' && !toolsUsed.includes(block.name)) {
            toolsUsed.push(block.name);
            transcript.push(`[tool] ${block.name}`);
          }
        }
        if (message.error) lastStructuredError = message.error;
      } else if (message.type === 'system' && message.subtype === 'api_retry') {
        lastStructuredError = message.error;
      } else if (message.type === 'result') {
        result = message;
      }
    }
  } catch (err) {
    clearTimeout(timer);
    const message = (err as Error).message;
    return redactOutcome(
      {
        ok: false,
        error: controller.signal.aborted ? `timeout tras ${ctx.timeoutMs} ms` : message,
        transient: controller.signal.aborted || isTransientText(message),
        log: transcript.join('\n'),
        durationMs: Date.now() - started,
        toolsUsed,
        denials: buildDenials(hookLog, []),
      },
      ctx.secrets,
    );
  }

  clearTimeout(timer);

  if (!result) {
    // El flujo terminó (sin lanzar) sin emitir nunca un mensaje `result`. Es
    // una condición sin reconocer, no un artefacto de transporte conocido:
    // no hay nada en los tipos del SDK que la documente como transitoria, y
    // no se puede distinguir "el agente no hizo nada" de "hizo todo y perdió
    // el mensaje final". El mismo criterio que rige el resto de esta
    // clasificación aplica aquí: ante lo desconocido, NO transitorio — un
    // paso agéntico puede tener `Bash` con efectos reales en `tools`, y
    // reintentar a ciegas arriesga repetirlos.
    return redactOutcome(
      {
        ok: false,
        error: 'el SDK terminó el flujo sin emitir ningún mensaje de resultado',
        transient: false,
        log: transcript.join('\n'),
        durationMs: Date.now() - started,
        toolsUsed,
        denials: buildDenials(hookLog, []),
      },
      ctx.secrets,
    );
  }

  const durationMs = result.duration_ms;
  const metrics = {
    costUsd: result.total_cost_usd,
    inputTokens: result.usage.input_tokens,
    outputTokens: result.usage.output_tokens,
    toolsUsed,
    denials: buildDenials(hookLog, result.permission_denials),
  };

  if (result.subtype !== 'success') {
    const log = [...transcript, result.errors.join('\n')].join('\n');
    return redactOutcome(
      {
        ok: false,
        error: result.errors.join('; ') || `fallo del SDK: ${result.subtype}`,
        transient: classifyResultError(result, lastStructuredError),
        log,
        durationMs,
        ...metrics,
      },
      ctx.secrets,
    );
  }

  const log = [...transcript, result.result].join('\n');

  if (!step.outputs) return redactOutcome({ ok: true, outputs: {}, log, durationMs, ...metrics }, ctx.secrets);

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.result);
  } catch {
    return redactOutcome(
      {
        ok: false,
        error: 'el paso declara outputs pero el resultado no es JSON válido',
        transient: false,
        log,
        durationMs,
        ...metrics,
      },
      ctx.secrets,
    );
  }

  try {
    return redactOutcome(
      { ok: true, outputs: validateOutputs(parsed, step.outputs, step.id), log, durationMs, ...metrics },
      ctx.secrets,
    );
  } catch (err) {
    return redactOutcome(
      { ok: false, error: (err as Error).message, transient: false, log, durationMs, ...metrics },
      ctx.secrets,
    );
  }
}
