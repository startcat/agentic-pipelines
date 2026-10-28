import type { InterpolationScope } from '../params/resolve.ts';

export class ExpressionError extends Error {
  constructor(expression: string, reason: string) {
    super(
      `Unsupported "when" expression: ${expression}\n  ${reason}\n` +
        `  Supported forms: "{{step.field}}" or "{{step.field}} <op> <literal>" with op in == != > >= < <=`,
    );
    this.name = 'ExpressionError';
  }
}

const BARE_RE = /^\s*\{\{\s*([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)\s*\}\}\s*$/;

/**
 * True if `expression` is exactly a bare reference (`{{x.y}}`, no
 * comparison). Exported for `install/params.ts`: an absent bare reference
 * is skipped for certain (`isTruthy(undefined)` is false), but one inside a
 * comparison (`{{x.y}} != "..."`) can end up with either result depending on
 * the operator — telling the two forms apart is what keeps the "no value"
 * warning from claiming something that is not always true.
 */
export function isBareReference(expression: string): boolean {
  return BARE_RE.test(expression);
}

const COMPARISON_RE =
  /^\s*\{\{\s*([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)\s*\}\}\s*(==|!=|>=|<=|>|<)\s*(.+?)\s*$/;

/** Parses a literal: number, boolean, or string with or without quotes. */
function parseLiteral(raw: string): string | number | boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  const quoted = /^(["'])(.*)\1$/.exec(raw);
  return quoted ? quoted[2]! : raw;
}

/**
 * Returns the value of a reference, or undefined if it does not exist.
 *
 * `resolveParams` normalizes every param to a string (interpolation and the
 * child process env need it that way), so a param declared `dry_run: false`
 * or `retries: 0` in pipeline.yaml arrives here as the string "false" or
 * "0". The same `parseLiteral` that is already applied to the literal on the
 * other side of a comparison is reused to rebuild its real type, so both
 * sides of a comparison are symmetric.
 *
 * Step outputs in `scope.steps` come from run records in JSON and already
 * have the right type (number, boolean, list) — coercing them would corrupt
 * real data, so it is only applied to `params`.
 */
function lookup(scope: InterpolationScope, left: string, right: string): unknown {
  if (left === 'params') {
    const raw = scope.params[right];
    return raw === undefined ? undefined : parseLiteral(raw);
  }
  return scope.steps[left]?.[right];
}

/** Template-style truthiness: empty, zero, false and null are falsy. */
function isTruthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (value === 0) return false;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Evaluates a `when`. Deliberately limited: two forms and nothing more.
 * An absent reference is false, not an error — a step whose predecessor was
 * skipped must be skipped too, not blow up.
 */
export function evaluateWhen(expression: string, scope: InterpolationScope): boolean {
  const bare = BARE_RE.exec(expression);
  if (bare) return isTruthy(lookup(scope, bare[1]!, bare[2]!));

  const comparison = COMPARISON_RE.exec(expression);
  if (!comparison) {
    throw new ExpressionError(expression, 'does not match any supported form');
  }

  const [, left, right, operator, rawLiteral] = comparison;
  if (rawLiteral!.includes('{{')) {
    throw new ExpressionError(expression, 'two references cannot be compared with each other');
  }

  const value = lookup(scope, left!, right!);
  const literal = parseLiteral(rawLiteral!);

  if (operator === '==') return value === literal;
  if (operator === '!=') return value !== literal;

  // Ordering comparisons: an absent field is false (so a step whose
  // predecessor was skipped is skipped too, without blowing up), but a
  // present value that is not numeric is a configuration error — it fails
  // loudly, like interpolate() with an unresolved reference.
  if (value === undefined) return false;
  if (typeof value !== 'number') {
    throw new ExpressionError(
      expression,
      `"{{${left!}.${right!}}}" is ${JSON.stringify(value)}, which is not numeric: it cannot be compared with "${operator}"`,
    );
  }
  if (typeof literal !== 'number') {
    throw new ExpressionError(
      expression,
      `the literal "${rawLiteral}" is not numeric: it cannot be compared with "${operator}"`,
    );
  }
  if (operator === '>') return value > literal;
  if (operator === '>=') return value >= literal;
  if (operator === '<') return value < literal;
  return value <= literal;
}
