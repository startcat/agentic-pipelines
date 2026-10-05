import type { InterpolationScope } from '../params/resolve.ts';

export class ExpressionError extends Error {
  constructor(expression: string, reason: string) {
    super(
      `Expresión "when" no admitida: ${expression}\n  ${reason}\n` +
        `  Formas admitidas: "{{paso.campo}}" o "{{paso.campo}} <op> <literal>" con op en == != > >= < <=`,
    );
    this.name = 'ExpressionError';
  }
}

const BARE_RE = /^\s*\{\{\s*([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)\s*\}\}\s*$/;

/**
 * Cierto si `expression` es justo una referencia pelada (`{{x.y}}`, sin
 * comparación). Se exporta para `install/params.ts`: una referencia pelada
 * ausente se salta con certeza (`isTruthy(undefined)` es falso), pero una
 * dentro de una comparación (`{{x.y}} != "..."`) puede acabar en cualquiera
 * de los dos resultados según el operador — distinguir ambas formas es lo
 * que evita que el aviso de "sin valor" afirme algo que no siempre es cierto.
 */
export function isBareReference(expression: string): boolean {
  return BARE_RE.test(expression);
}

const COMPARISON_RE =
  /^\s*\{\{\s*([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)\s*\}\}\s*(==|!=|>=|<=|>|<)\s*(.+?)\s*$/;

/** Parsea un literal: número, booleano, o cadena con o sin comillas. */
function parseLiteral(raw: string): string | number | boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  const quoted = /^(["'])(.*)\1$/.exec(raw);
  return quoted ? quoted[2]! : raw;
}

/**
 * Devuelve el valor de una referencia, o undefined si no existe.
 *
 * `resolveParams` normaliza todo param a string (la interpolación y el env
 * del proceso hijo lo necesitan así), así que un param declarado
 * `dry_run: false` o `retries: 0` en el pipeline.yaml llega aquí como la
 * cadena "false" o "0". Se reutiliza el mismo `parseLiteral` que ya se
 * aplica al literal del otro lado de una comparación para reconstruir su
 * tipo real, de modo que ambos lados de una comparación queden simétricos.
 *
 * Las salidas de pasos en `scope.steps` vienen de registros de ejecución en
 * JSON y ya tienen el tipo correcto (número, booleano, lista) — coaccionarlas
 * corrompería datos reales, así que solo se aplica a `params`.
 */
function lookup(scope: InterpolationScope, left: string, right: string): unknown {
  if (left === 'params') {
    const raw = scope.params[right];
    return raw === undefined ? undefined : parseLiteral(raw);
  }
  return scope.steps[left]?.[right];
}

/** Verdad al estilo de las plantillas: vacío, cero, false y null son falsos. */
function isTruthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (value === 0) return false;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Evalúa un `when`. Deliberadamente pobre: dos formas y nada más.
 * Una referencia ausente es falsa, no un error — un paso cuyo predecesor se
 * saltó debe saltarse también, no reventar.
 */
export function evaluateWhen(expression: string, scope: InterpolationScope): boolean {
  const bare = BARE_RE.exec(expression);
  if (bare) return isTruthy(lookup(scope, bare[1]!, bare[2]!));

  const comparison = COMPARISON_RE.exec(expression);
  if (!comparison) {
    throw new ExpressionError(expression, 'no encaja en ninguna forma admitida');
  }

  const [, left, right, operator, rawLiteral] = comparison;
  if (rawLiteral!.includes('{{')) {
    throw new ExpressionError(expression, 'no se pueden comparar dos referencias entre sí');
  }

  const value = lookup(scope, left!, right!);
  const literal = parseLiteral(rawLiteral!);

  if (operator === '==') return value === literal;
  if (operator === '!=') return value !== literal;

  // Comparaciones de orden: un campo ausente es falso (así un paso cuyo
  // predecesor se saltó se salta también, sin reventar), pero un valor
  // presente que no es numérico es un error de configuración — falla alto,
  // igual que interpolate() con una referencia sin resolver.
  if (value === undefined) return false;
  if (typeof value !== 'number') {
    throw new ExpressionError(
      expression,
      `"{{${left!}.${right!}}}" vale ${JSON.stringify(value)}, que no es numérico: no se puede comparar con "${operator}"`,
    );
  }
  if (typeof literal !== 'number') {
    throw new ExpressionError(
      expression,
      `el literal "${rawLiteral}" no es numérico: no se puede comparar con "${operator}"`,
    );
  }
  if (operator === '>') return value > literal;
  if (operator === '>=') return value >= literal;
  if (operator === '<') return value < literal;
  return value <= literal;
}
