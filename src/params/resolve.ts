import type { Pipeline } from '../schema/pipeline.ts';

export class MissingParamsError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(
      `Missing required params: ${missing.join(', ')}.\n` +
        `Pass them when installing or running: --set ${missing[0]}=<value>`,
    );
    this.name = 'MissingParamsError';
    this.missing = missing;
  }
}

export type ParamSources = {
  /** Read from .params.local.json, written by `pipelines install`. */
  local?: Record<string, string>;
  /** --set flags of the current invocation. */
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
   * Only filled in for interpolating the prompt of an `agent` step
   * (see `runAgentStep`) — the rest of the system (`run:`/`cwd:`/`shell:`
   * guard) builds the scope without this field on purpose, so
   * `{{secrets.X}}` never resolves there.
   */
  secrets?: Record<string, string>;
};

const REFERENCE_RE = /\{\{\s*([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)\s*\}\}/g;

/**
 * Validates the overrides against the declared params and applies the
 * precedence default < local < override. Returns what was resolved and the
 * required params without a value.
 * All values are normalized to string: the YAML may bring numbers or
 * booleans, but interpolation always produces text.
 */
function resolveWithMissing(
  pipeline: Pipeline,
  sources: ParamSources,
): { resolved: Record<string, string>; missing: string[] } {
  const declared = new Set(Object.keys(pipeline.params));

  for (const key of Object.keys(sources.overrides ?? {})) {
    if (!declared.has(key)) {
      throw new Error(
        `Param "${key}" is not declared in the pipeline. Declared: ${[...declared].join(', ') || '(none)'}`,
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

  return { resolved, missing };
}

/** Resolves the params with the precedence default < local < override. */
export function resolveParams(
  pipeline: Pipeline,
  sources: ParamSources,
): Record<string, string> {
  const { resolved, missing } = resolveWithMissing(pipeline, sources);
  if (missing.length > 0) throw new MissingParamsError(missing);
  return resolved;
}

/**
 * Like `resolveParams`, but without throwing on missing required params: it
 * returns what there is. It is for `doctor`, which must show ALL the checks
 * (including which secret cannot be named without a param) instead of stopping
 * at the first one. An undeclared override is still an error: it is usually a
 * typo in `--set`.
 */
export function resolveParamsLenient(
  pipeline: Pipeline,
  sources: ParamSources,
): Record<string, string> {
  return resolveWithMissing(pipeline, sources).resolved;
}

/** Extracts all `{{x.y}}` references from a text, in order of appearance. */
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
 * Replaces `{{x.y}}` references with their values. A reference that cannot
 * be resolved is an error: replacing it with an empty string would turn a
 * configuration failure into a silently wrong command.
 */
export function interpolate(text: string, scope: InterpolationScope): string {
  return text.replace(REFERENCE_RE, (_full, left: string, right: string) => {
    if (left === 'params') {
      const value = scope.params[right];
      if (value === undefined) throw new Error(`Unresolved reference: params.${right}`);
      return value;
    }
    if (left === 'secrets') {
      const value = scope.secrets?.[right];
      if (value === undefined) throw new Error(`Unresolved reference: secrets.${right}`);
      return value;
    }
    const step = scope.steps[left];
    if (step === undefined || !(right in step)) {
      throw new Error(`Unresolved reference: ${left}.${right}`);
    }
    const value = step[right];
    if (value === null || value === undefined) {
      throw new Error(`Unresolved reference: ${left}.${right}`);
    }
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
}

export type ShellInterpolation = { command: string; env: Record<string, string> };

/**
 * Like `interpolate()`, but for text that will be run with `sh -c`
 * (a `run:` of a `shell` step/`always:`, or a `shell:` guard). Instead of
 * substituting each reference with its value INSIDE the command text, it
 * replaces it with the name of a safe environment variable and returns the
 * real value separately, to pass through the child process `env`. That way
 * `sh` never parses the value again as shell syntax, whatever characters it
 * contains — it closes the real injection route of `interpolate()` followed
 * by `sh -c`.
 *
 * The token is inserted WITHOUT quotes added by this function: it respects
 * whatever quoting the YAML itself already has. A reference quoted in the
 * YAML (`"{{x.y}}"`) stays quoted (`"${__PIPELINES_REF_0}"`, correct); an
 * unquoted one stays unquoted (same word-splitting behavior that already
 * existed with raw substitution, not a new regression) — the only thing
 * that goes away is reinterpreting metacharacters as syntax.
 *
 * The token ALWAYS uses the braced form (`${__PIPELINES_REF_0}`), never a
 * bare `$__PIPELINES_REF_0`: in `sh`, an unbraced expansion extends up to
 * the first non-alphanumeric/non-`_` character, so a reference stuck to
 * text with no separator (`run: echo {{params.x}}_final`) would generate
 * `$__PIPELINES_REF_0_final` — a DIFFERENT variable name (nonexistent),
 * which silently expands to empty, with no error. Braces are not quotes:
 * an unquoted `${VAR}` splits words and expands paths exactly like an
 * unquoted `$VAR`, so this does not contradict the "no added quotes"
 * restriction above — it only delimits the variable name unambiguously.
 *
 * Reuses `interpolate()` on each match (`full`, the whole `{{x.y}}`
 * string) to resolve the value: `full` contains exactly one reference, so
 * `interpolate(full, scope)` resolves it with the same error logic as the
 * rest of the system, without duplicating it.
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
