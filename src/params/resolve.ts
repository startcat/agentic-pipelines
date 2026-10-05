import type { Pipeline } from '../schema/pipeline.ts';

export class MissingParamsError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(
      `Faltan params obligatorios: ${missing.join(', ')}.\n` +
        `Indícalos al instalar o al ejecutar: --set ${missing[0]}=<valor>`,
    );
    this.name = 'MissingParamsError';
    this.missing = missing;
  }
}

export type ParamSources = {
  /** Leído de .params.local.json, escrito por `pipelines install`. */
  local?: Record<string, string>;
  /** Flags --set de la invocación actual. */
  overrides?: Record<string, string>;
};

export type Reference =
  | { kind: 'param'; name: string }
  | { kind: 'secret'; name: string }
  | { kind: 'step'; step: string; field: string };

export type InterpolationScope = {
  params: Record<string, string>;
  steps: Record<string, Record<string, unknown>>;
  /**
   * Solo se rellena para la interpolación del prompt de un paso `agent`
   * (ver `runAgentStep`) — el resto del sistema (`run:`/`cwd:`/guarda
   * `shell:`) construye el scope sin este campo a propósito, así que
   * `{{secrets.X}}` nunca resuelve ahí.
   */
  secrets?: Record<string, string>;
};

const REFERENCE_RE = /\{\{\s*([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)\s*\}\}/g;

/**
 * Resuelve los params con la precedencia default < local < override.
 * Todos los valores se normalizan a string: el YAML puede traer números o
 * booleanos, pero la interpolación siempre produce texto.
 */
export function resolveParams(
  pipeline: Pipeline,
  sources: ParamSources,
): Record<string, string> {
  const declared = new Set(Object.keys(pipeline.params));

  for (const key of Object.keys(sources.overrides ?? {})) {
    if (!declared.has(key)) {
      throw new Error(
        `El param "${key}" no está declarado en el pipeline. Declarados: ${[...declared].join(', ') || '(ninguno)'}`,
      );
    }
  }

  const resolved: Record<string, string> = {};
  const missing: string[] = [];

  for (const [name, spec] of Object.entries(pipeline.params)) {
    const value =
      sources.overrides?.[name] ?? sources.local?.[name] ?? spec.default;
    if (value === undefined) {
      if (spec.required) missing.push(name);
      continue;
    }
    resolved[name] = String(value);
  }

  if (missing.length > 0) throw new MissingParamsError(missing);
  return resolved;
}

/** Extrae todas las referencias `{{x.y}}` de un texto, en orden de aparición. */
export function findReferences(text: string): Reference[] {
  const refs: Reference[] = [];
  for (const match of text.matchAll(REFERENCE_RE)) {
    const left = match[1]!;
    const right = match[2]!;
    refs.push(
      left === 'params'
        ? { kind: 'param', name: right }
        : left === 'secrets'
          ? { kind: 'secret', name: right }
          : { kind: 'step', step: left, field: right },
    );
  }
  return refs;
}

/**
 * Sustituye las referencias `{{x.y}}` por sus valores. Una referencia que no
 * se puede resolver es un error: sustituirla por cadena vacía convertiría un
 * fallo de configuración en un comando silenciosamente incorrecto.
 */
export function interpolate(text: string, scope: InterpolationScope): string {
  return text.replace(REFERENCE_RE, (_full, left: string, right: string) => {
    if (left === 'params') {
      const value = scope.params[right];
      if (value === undefined) throw new Error(`Referencia sin resolver: params.${right}`);
      return value;
    }
    if (left === 'secrets') {
      const value = scope.secrets?.[right];
      if (value === undefined) throw new Error(`Referencia sin resolver: secrets.${right}`);
      return value;
    }
    const step = scope.steps[left];
    if (step === undefined || !(right in step)) {
      throw new Error(`Referencia sin resolver: ${left}.${right}`);
    }
    const value = step[right];
    if (value === null || value === undefined) {
      throw new Error(`Referencia sin resolver: ${left}.${right}`);
    }
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
}

export type ShellInterpolation = { command: string; env: Record<string, string> };

/**
 * Como `interpolate()`, pero para texto que se va a ejecutar con `sh -c`
 * (un `run:` de paso `shell`/`always:`, o una guarda `shell:`). En vez de
 * sustituir cada referencia por su valor DENTRO del texto del comando, la
 * sustituye por el nombre de una variable de entorno segura y devuelve el
 * valor real aparte, para pasarlo por `env` del proceso hijo. Así `sh`
 * nunca vuelve a parsear el valor como sintaxis de shell, sin importar qué
 * caracteres contenga — cierra la vía de inyección real de `interpolate()`
 * seguido de `sh -c`.
 *
 * El token se inserta SIN comillas añadidas por esta función: respeta el
 * entrecomillado que ya tenga el propio YAML. Una referencia citada en el
 * YAML (`"{{x.y}}"`) queda citada (`"${__PIPELINES_REF_0}"`, correcto); una
 * sin citar queda sin citar (mismo comportamiento de división de palabras
 * que ya existía con sustitución cruda, no una regresión nueva) — lo único
 * que desaparece es la reinterpretación de metacaracteres como sintaxis.
 *
 * El token usa SIEMPRE la forma con llaves (`${__PIPELINES_REF_0}`), nunca
 * `$__PIPELINES_REF_0` a secas: en `sh`, una expansión sin llaves se
 * extiende hasta el primer carácter no alfanumérico/no `_`, así que una
 * referencia pegada a texto sin separador (`run: echo {{params.x}}_final`)
 * generaría `$__PIPELINES_REF_0_final` — un nombre de variable DISTINTO
 * (inexistente), que se expande a vacío en silencio, sin error. Las llaves
 * no son comillas: `${VAR}` sin comillas divide palabras y expande rutas
 * exactamente igual que `$VAR` sin comillas, así que esto no contradice la
 * restricción de "sin comillas añadidas" de más arriba — solo delimita el
 * nombre de variable de forma inequívoca.
 *
 * Reutiliza `interpolate()` sobre cada coincidencia (`full`, la cadena
 * `{{x.y}}` completa) para resolver el valor: `full` contiene exactamente
 * una referencia, así que `interpolate(full, scope)` la resuelve con la
 * misma lógica de errores que el resto del sistema, sin duplicarla.
 */
export function interpolateForShell(text: string, scope: InterpolationScope): ShellInterpolation {
  const env: Record<string, string> = {};
  let index = 0;
  const command = text.replace(REFERENCE_RE, (full) => {
    const resolved = interpolate(full, scope);
    const varName = `__PIPELINES_REF_${index}`;
    env[varName] = resolved;
    index += 1;
    return `\${${varName}}`;
  });
  return { command, env };
}
