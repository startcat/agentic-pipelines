import { existsSync } from 'node:fs';
import { interpolate, interpolateForShell, type InterpolationScope } from '../params/resolve.ts';
import type { OutputType, ShellStep } from '../schema/pipeline.ts';
import { redactSecrets } from '../runs/store.ts';

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractError';
  }
}

export type StepContext = {
  scope: InterpolationScope;
  /** Solo los secretos declarados en `requires.env` del pipeline. */
  secrets: Record<string, string>;
  defaultCwd: string;
  timeoutMs: number;
};

/**
 * Variables del proceso que un paso necesita para funcionar. Todo lo demás se
 * descarta: sin esta lista, `sh` no encontraría ni sus propios binarios; con
 * `process.env` entero, un paso vería credenciales de pipelines vecinos.
 */
const BASE_ENV_KEYS = ['PATH', 'HOME', 'SHELL', 'USER', 'TZ', 'TMPDIR'];

/**
 * Locale de TODO subproceso que arranca el motor, fijado en vez de heredado
 * — `LANG`/`LC_ALL` salieron a propósito de `BASE_ENV_KEYS`, no se olvidaron.
 *
 * Heredarlo hacía que un pipeline se comportara distinto según quién lo
 * lanzara: una terminal exporta `LANG` (UTF-8), un plist de launchd solo
 * declara `PATH` y `HOME`, así que en cron los subprocesos caían al locale C.
 * En C, el `.` de una expresión regular casa UN BYTE, y un carácter acentuado
 * en UTF-8 son dos — un patrón que casa a mano falla en cron, en silencio.
 * Pasó de verdad: una guarda `shell:` de un pipeline real con `.ltima
 * revisió` saltó el pipeline diez noches seguidas.
 *
 * `C.UTF-8` y no `en_US.UTF-8` porque da las dos mitades que hacen falta:
 * semántica de carácter UTF-8 en las regex, y colación bytewise como la del
 * locale C — así fijarlo no reordena ningún `sort` de un pipeline que hoy ya
 * corre bajo cron. Mismo criterio que `settingSources: []` y
 * `strictMcpConfig: true`: el motor no hereda la configuración de la máquina.
 *
 * Nota de portabilidad: `C.UTF-8` existe en macOS (verificado con `locale -a`)
 * y en glibc >= 2.35; en una distro más vieja habría que revisar esta
 * constante.
 */
const FIXED_LOCALE_ENV = { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };

/** Entorno del proceso hijo: base mínima, locale fijo y los secretos declarados. */
export function composeEnv(secrets: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BASE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...FIXED_LOCALE_ENV, ...secrets };
}

/**
 * Variables de autenticación y red que necesita el subproceso del SDK del
 * Agent (el CLI de Claude Code que arranca `query()`), verificadas contra el
 * propio bundle instalado (`@anthropic-ai/claude-agent-sdk/sdk.mjs`): las
 * ocho aparecen literalmente ahí. `Options.env` del SDK REEMPLAZA el entorno
 * del subproceso entero, no lo fusiona con `process.env` (`sdk.d.ts`
 * ~1436-1441) — sin esto, un paso agéntico en una máquina autenticada por
 * `ANTHROPIC_API_KEY` fallaría siempre al autenticar, aunque `doctor` haya
 * dado el visto bueno viendo esa misma variable en ESTE proceso.
 *
 * Por qué esta lista es distinta de `BASE_ENV_KEYS`/`composeEnv` en vez de
 * reutilizarla tal cual: `composeEnv` es correcta para `sh -c` en
 * `runShellStep`, que ejecuta el `run:` del propio YAML del pipeline — un
 * payload que no es de confianza, así que ahí no se debe aflojar la lista.
 * El subproceso del SDK, en cambio, es NUESTRO propio proceso (el CLI que
 * nosotros arrancamos), y necesita la credencial con la que se autentica
 * contra la API. La tensión real, y por eso la lista sigue siendo estrecha
 * y no un `...process.env` en bruto: el `Bash` de un paso agéntico hereda
 * este mismo entorno, así que ensancharlo aquí sería la misma fuga que
 * `composeEnv` evita para `sh -c`, solo que con un vector distinto.
 */
const AGENT_AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CONFIG_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
];

/**
 * Entorno del subproceso del SDK del Agent: la misma base mínima y el mismo
 * locale fijo que `composeEnv`, más las variables de autenticación/red de
 * `AGENT_AUTH_ENV_KEYS`, más los secretos declarados. Los secretos se
 * aplican al final para que, si un pipeline declarase un secreto con el
 * mismo nombre que una de estas variables, gane el valor declarado — igual
 * que ya hace `composeEnv`.
 */
export function composeAgentEnv(secrets: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [...BASE_ENV_KEYS, ...AGENT_AUTH_ENV_KEYS]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...FIXED_LOCALE_ENV, ...secrets };
}

export type StepOutcome =
  | { ok: true; outputs: Record<string, unknown>; log: string; durationMs: number }
  | { ok: false; error: string; transient: boolean; log: string; durationMs: number };

function matchesType(value: unknown, type: OutputType): boolean {
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  const element = type.slice(0, -2) as 'string' | 'number' | 'boolean';
  return Array.isArray(value) && value.every((v) => matchesType(v, element));
}

/** Nombre legible del tipo recibido, en el mismo vocabulario que `OutputType`. */
function describeReceivedType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    const elementTypes = new Set(value.map((v) => typeof v));
    const [onlyType] = elementTypes;
    if (elementTypes.size === 1 && (onlyType === 'string' || onlyType === 'number' || onlyType === 'boolean')) {
      return `${onlyType}[]`;
    }
    return 'array';
  }
  return typeof value;
}

/**
 * Extracto del valor recibido, o `''` si no hay nada que añadir, decidido por
 * CONCEPTO — no por si el nombre del campo o la forma del valor «huelen» a
 * secreto (esa heurística se quitó: dejaba pasar una credencial a mitad de
 * frase bajo un campo de nombre inocente, p.ej. `summary: "Payment created
 * with key sk_live_…"`, que sí entraba en el extracto de 40 caracteres).
 *
 * La regla es por tipo:
 * - `string`: NUNCA su contenido, solo cuántos caracteres tiene. Es el único
 *   tipo que puede llevar texto arbitrario — una URL con credenciales, un
 *   JWT, una clave a mitad de frase — así que es el único que hay que ocultar
 *   siempre, sin excepción y sin heurística.
 * - `number` / `boolean`: el valor entero. Ninguno de los dos puede llevar
 *   texto, así que no hay nada que ocultar.
 * - `null`: nada que añadir — el tipo ya lo dice todo.
 * - `array` / `object`: como mucho la forma (longitud, o las claves de primer
 *   nivel), nunca los valores — cualquiera de ellos podría ser el string
 *   peligroso de más arriba.
 */
function excerptOf(value: unknown): string {
  if (typeof value === 'string') {
    return ` (${value.length} caracteres)`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return ` (${value})`;
  }
  if (value === null) {
    return '';
  }
  if (Array.isArray(value)) {
    return ` (length ${value.length})`;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  // Solo el NÚMERO de claves: una clave puede ser el propio secreto (un mapa
  // indexado por token o por email), y listarlas todas no tiene tope.
  return keys.length === 1 ? ' (1 clave)' : ` (${keys.length} claves)`;
}

/**
 * Valida una salida contra el contrato `outputs` y descarta lo no declarado.
 * Descartar en vez de propagar mantiene honesto el contrato: un paso posterior
 * solo puede depender de lo que el YAML declara.
 *
 * El mensaje de cada violación de tipo nombra el paso, el campo, el tipo
 * esperado, el tipo recibido y un extracto acotado del valor. Antes de esto, todas las violaciones de tipo llegaban al correo como el
 * mismo «Contrato incumplido» genérico, sin decir qué falló.
 */
export function validateOutputs(
  raw: unknown,
  contract: Record<string, OutputType>,
  stepId: string,
): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ContractError(
      `Contrato incumplido en «${stepId}»: la salida debe ser un objeto JSON; se recibió ${Array.isArray(raw) ? 'un array' : typeof raw}`,
    );
  }
  const source = raw as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const issues: string[] = [];

  for (const [name, type] of Object.entries(contract)) {
    if (!(name in source)) {
      issues.push(`falta el campo "${name}" (${type})`);
      continue;
    }
    const value = source[name];
    if (!matchesType(value, type)) {
      issues.push(`${name} esperaba ${type}, recibió ${describeReceivedType(value)}${excerptOf(value)}`);
      continue;
    }
    result[name] = value;
  }

  if (issues.length > 0) {
    throw new ContractError(`Contrato incumplido en «${stepId}»: ${issues.join('; ')}`);
  }
  return result;
}

/**
 * ¿Aparece literalmente alguno de los secretos dentro de `text`? Exportada
 * (junto con `redactOutputValues`) para que `agent.ts` la reutilice en vez
 * de mantener una segunda copia: es lógica de seguridad que se ejecuta al
 * redactar `outputs`, así que una sola implementación evita que un runner se
 * quede con una regla más débil que el otro si algún día se refuerza aquí.
 */
export function containsSecret(text: string, secrets: string[]): boolean {
  return secrets.some((secret) => secret !== '' && text.includes(secret));
}

export type OutputRedactionResult =
  | { ok: true; outputs: Record<string, unknown> }
  | { ok: false; violatingFields: string[] };

/**
 * Redacta los valores de secreto que puedan aparecer dentro de `outputs`.
 * `outputs` se valida contra el `stdout` crudo del proceso (no contra `log`,
 * que ya está redactado), así que un paso que ecoa su propio secreto en un
 * campo declarado llegaría intacto hasta aquí si no se tratara aparte.
 *
 * Los campos `string` (y los elementos `string` de un array) se sustituyen
 * en el sitio por REDACTION, igual que en `log`/`error`. Los campos
 * `number`/`boolean` (y sus formas en array) no admiten esa sustitución sin
 * romper el tipo que el propio contrato declaró — un número no puede valer
 * «redactado» — así que si contienen un secreto se reportan como campo en
 * violación: el llamante debe convertir el resultado en un fallo del paso
 * en vez de dejar pasar el valor crudo.
 *
 * Exportada por el mismo motivo que `containsSecret`: `agent.ts` la
 * reutiliza en vez de duplicarla, así que la regla de qué se redacta y qué
 * hace fallar el paso vive en un único sitio para los dos runners.
 */
export function redactOutputValues(
  outputs: Record<string, unknown>,
  secrets: string[],
): OutputRedactionResult {
  const result: Record<string, unknown> = {};
  const violatingFields: string[] = [];

  for (const [key, value] of Object.entries(outputs)) {
    if (typeof value === 'string') {
      result[key] = redactSecrets(value, secrets);
    } else if (Array.isArray(value)) {
      if (value.every((v) => typeof v === 'string')) {
        result[key] = value.map((v) => redactSecrets(v as string, secrets));
      } else if (value.some((v) => containsSecret(String(v), secrets))) {
        violatingFields.push(key);
      } else {
        result[key] = value;
      }
    } else if (containsSecret(String(value), secrets)) {
      violatingFields.push(key);
    } else {
      result[key] = value;
    }
  }

  if (violatingFields.length > 0) return { ok: false, violatingFields };
  return { ok: true, outputs: result };
}

/**
 * Redacta los valores de secreto de un StepOutcome antes de que salga de esta
 * función. Este es el único punto del motor donde un valor de secreto existe
 * en claro (hay que pasarlo al proceso hijo), así que es también el único
 * punto donde hay que garantizar que no sobreviva a la salida: de aquí en
 * adelante el outcome se escribe en `.runs/` y se imprime por la CLI. Se
 * redactan `log`, `error` y los valores de texto dentro de `outputs` — no
 * basta con `log`, porque `outputs` se construye a partir del `stdout` sin
 * redactar (ver `redactOutputValues`).
 *
 * Si `outputs` trae un secreto en un campo `number`/`boolean` que no se
 * puede redactar en el sitio, el outcome se convierte aquí mismo en un
 * fallo del paso (contrato incumplido) en vez de devolver el valor crudo.
 * Toda la lógica de secretos vive en esta única función: ningún otro sitio
 * de `runShellStep` decide si algo se redacta o se rechaza.
 */
function redactOutcome(outcome: StepOutcome, secrets: Record<string, string>): StepOutcome {
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
      };
    }
    return {
      ...outcome,
      outputs: redacted.outputs,
      log: redactSecrets(outcome.log, values),
    };
  }
  return {
    ...outcome,
    log: redactSecrets(outcome.log, values),
    error: redactSecrets(outcome.error, values),
  };
}

/**
 * Mensaje de un `Bun.spawn` que ni llegó a arrancar.
 *
 * El caso corriente —y el que motivó separarlo— es un `cwd` que no existe:
 * `posix_spawn` falla con ENOENT y Bun lo reporta nombrando el ejecutable
 * (`posix_spawn \'sh\'`), no el directorio. El mensaje crudo dice entonces que
 * no encuentra `sh`, que está donde siempre, y manda a quien lo lea a buscar
 * un problema de PATH inexistente. Pasó de verdad el 2026-08-31, validando el
 * canal de notify: ese texto es el que viaja en el correo de una fallada
 * nocturna, así que es lo primero que se ve y lo último que conviene que
 * mienta.
 *
 * `cwdExists` se pasa desde fuera en vez de comprobarlo aquí para que la
 * decisión sea pura y se pueda probar sin tocar el disco.
 */
export function launchFailureMessage(cwd: string, cause: string, cwdExists: boolean): string {
  if (!cwdExists) {
    return `el directorio de trabajo no existe: ${cwd} (el sistema lo reportó como: ${cause})`;
  }
  return `no se pudo lanzar el comando: ${cause}`;
}

/**
 * Ejecuta un paso `shell`. Si el paso declara `outputs`, su stdout se parsea
 * como JSON y se valida; si no, stdout solo se registra en el log.
 */
/** Líneas de stderr que caben en el `error` de un paso fallido. */
const STDERR_TAIL_LINES = 5;
const STDERR_TAIL_MAX_CHARS = 400;

/**
 * Las últimas líneas no vacías de stderr, en una sola línea separada por
 * " / ", con tope de caracteres. Cinco líneas bastan para el motivo de un
 * `exit 1` escrito a mano (un `echo … >&2` antes de salir); el log completo
 * sigue en el fichero del paso.
 */
export function stderrTail(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  const tail = lines.slice(-STDERR_TAIL_LINES).join(' / ');
  return tail.length > STDERR_TAIL_MAX_CHARS ? `${tail.slice(0, STDERR_TAIL_MAX_CHARS)}…` : tail;
}

/**
 * Margen entre matar el grupo de procesos con `SIGTERM` y rematarlo con
 * `SIGKILL` si sigue vivo. Acota la espera de las tuberías del paso: sin
 * esto, un hijo que atrapa `SIGTERM` (visto de verdad con `claude` colgado en
 * red) dejaría a `runShellStep` esperando indefinidamente a que cierre su
 * copia heredada de stdout/stderr, con el `timeout` del pipeline convertido
 * en decorativo.
 */
const KILL_ESCALATION_GRACE_MS = 300;

/**
 * Mata el GRUPO de procesos del paso, no solo el `sh` que lo encabeza.
 *
 * `proc.kill()` a secas solo envía la señal al PID de `sh`: si el `run:` del
 * paso arranca algo en segundo plano (`caffeinate -i claude -p … &`, el
 * patrón headless de `aeacc-nightly`/`hub-maintenance`), ese hijo hereda la
 * tubería de stdout/stderr y sigue vivo tras matar a `sh`, así que el motor
 * se queda esperando a que EL cierre su copia del fd — el `timeout` del
 * pipeline no interrumpe nada, solo tarda lo que tarde el huérfano.
 *
 * El grupo existe porque `runShellStep` arranca `sh` con `detached: true`
 * (`setsid`, `pid === pgid`): matar con PID negativo llega a todo el grupo,
 * huérfanos en segundo plano incluidos, porque heredan el mismo `pgid` salvo
 * que ellos mismos llamen a `setpgid`. Si el grupo ya no existe (el proceso
 * murió por su cuenta entre medias), `process.kill` lanza y aquí se ignora:
 * no hay nada que matar.
 */
function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // El grupo ya no existe (el proceso terminó por su cuenta) o nunca llegó
    // a arrancar como líder de grupo (spawn falló antes del setsid).
  }
}

export async function runShellStep(
  step: ShellStep,
  ctx: StepContext,
): Promise<StepOutcome> {
  const started = Date.now();
  const { command, env: refEnv } = interpolateForShell(step.run, ctx.scope);
  const cwd = step.cwd ? interpolate(step.cwd, ctx.scope) : ctx.defaultCwd;

  let stdout = '';
  let stderr = '';
  let exitCode: number;
  let timedOut = false;

  // El timeout se aplica matando el proceso, no con AbortSignal: es el
  // comportamiento uniforme en todas las versiones de Bun y deja el stdout
  // producido hasta ese momento disponible para el log.
  //
  // El tipo se anota explícitamente con los mismos literales ('ignore',
  // 'pipe', 'pipe') que se pasan a `Bun.spawn` más abajo: `ReturnType<typeof
  // Bun.spawn>` no sirve aquí porque `Bun.spawn` es una función genérica y,
  // sin argumentos que instancien sus parámetros, `ReturnType` los deja sin
  // resolver a sus valores por defecto — `proc.stdout`/`proc.stderr` quedan
  // tipados como `number | ReadableStream | undefined` en vez de
  // `ReadableStream`, lo que no compila más abajo.
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  try {
    proc = Bun.spawn(['sh', '-c', command], {
      cwd,
      env: { ...composeEnv(ctx.secrets), ...refEnv },
      stdout: 'pipe',
      stderr: 'pipe',
      // `setsid()`: `sh` nace como líder de su propio grupo (pid === pgid),
      // así que matar el grupo entero (ver `killProcessGroup`) es posible
      // aunque el paso arranque hijos en segundo plano.
      detached: true,
    });
  } catch (err) {
    return redactOutcome(
      {
        ok: false,
        error: launchFailureMessage(cwd, (err as Error).message, existsSync(cwd)),
        transient: false,
        log: '',
        durationMs: Date.now() - started,
      },
      ctx.secrets,
    );
  }

  let escalation: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessGroup(proc.pid, 'SIGTERM');
    escalation = setTimeout(() => killProcessGroup(proc.pid, 'SIGKILL'), KILL_ESCALATION_GRACE_MS);
  }, ctx.timeoutMs);

  [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  exitCode = await proc.exited;
  clearTimeout(timer);
  clearTimeout(escalation);

  const durationMs = Date.now() - started;
  const log = stdout + stderr;

  if (timedOut) {
    return redactOutcome(
      { ok: false, error: `timeout tras ${ctx.timeoutMs} ms`, transient: true, log, durationMs },
      ctx.secrets,
    );
  }

  if (exitCode !== 0) {
    // El error lleva la cola de stderr, no solo el código: `failureReason`
    // (notify/dispatch.ts) lo pone en el correo, y «verdict: exit code 1»
    // sin las líneas que el paso escribió a stderr obligaba a ir a mirar el
    // log a mano (pasó en un ensayo al migrar un pipeline real).
    const tail = stderrTail(stderr);
    return redactOutcome(
      {
        ok: false,
        error: tail ? `exit code ${exitCode} — ${tail}` : `exit code ${exitCode}`,
        transient: false,
        log,
        durationMs,
      },
      ctx.secrets,
    );
  }

  if (!step.outputs) return redactOutcome({ ok: true, outputs: {}, log, durationMs }, ctx.secrets);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return redactOutcome(
      {
        ok: false,
        error: 'el paso declara outputs pero su stdout no es JSON válido',
        transient: false,
        log,
        durationMs,
      },
      ctx.secrets,
    );
  }

  try {
    return redactOutcome(
      { ok: true, outputs: validateOutputs(parsed, step.outputs, step.id), log, durationMs },
      ctx.secrets,
    );
  } catch (err) {
    return redactOutcome(
      { ok: false, error: (err as Error).message, transient: false, log, durationMs },
      ctx.secrets,
    );
  }
}
