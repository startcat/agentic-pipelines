import { describe, expect, test } from 'bun:test';
import { evaluateWhen, ExpressionError } from '../../src/expr/evaluate.ts';
import { parsePipeline } from '../../src/schema/pipeline.ts';
import { resolveParams, type InterpolationScope } from '../../src/params/resolve.ts';

const scope = {
  params: { mode: 'full' },
  steps: {
    scan: { stale_count: 7, pages: ['a'], empty_list: [], name: 'docs', flag: false, zero: 0, nothing: null },
    draft: { pr_url: 'https://x/1' },
  },
};

describe('evaluateWhen — referencia sola', () => {
  test('una cadena no vacía es cierta', () => {
    expect(evaluateWhen('{{draft.pr_url}}', scope)).toBe(true);
  });
  test('un número distinto de cero es cierto', () => {
    expect(evaluateWhen('{{scan.stale_count}}', scope)).toBe(true);
  });
  test('cero es falso', () => {
    expect(evaluateWhen('{{scan.zero}}', scope)).toBe(false);
  });
  test('false es falso', () => {
    expect(evaluateWhen('{{scan.flag}}', scope)).toBe(false);
  });
  test('null es falso', () => {
    expect(evaluateWhen('{{scan.nothing}}', scope)).toBe(false);
  });
  test('una lista vacía es falsa', () => {
    expect(evaluateWhen('{{scan.empty_list}}', scope)).toBe(false);
  });
  test('una lista con elementos es cierta', () => {
    expect(evaluateWhen('{{scan.pages}}', scope)).toBe(true);
  });
  test('un campo que no existe es falso, no un error', () => {
    expect(evaluateWhen('{{scan.no_existe}}', scope)).toBe(false);
  });
  test('acepta referencias a params', () => {
    expect(evaluateWhen('{{params.mode}}', scope)).toBe(true);
  });
});

describe('evaluateWhen — comparación', () => {
  test('compara números', () => {
    expect(evaluateWhen('{{scan.stale_count}} > 0', scope)).toBe(true);
    expect(evaluateWhen('{{scan.stale_count}} > 10', scope)).toBe(false);
    expect(evaluateWhen('{{scan.stale_count}} >= 7', scope)).toBe(true);
    expect(evaluateWhen('{{scan.stale_count}} < 10', scope)).toBe(true);
    expect(evaluateWhen('{{scan.stale_count}} <= 6', scope)).toBe(false);
  });
  test('compara cadenas con == y !=', () => {
    expect(evaluateWhen('{{scan.name}} == "docs"', scope)).toBe(true);
    expect(evaluateWhen("{{scan.name}} != 'docs'", scope)).toBe(false);
  });
  test('compara con literales booleanos', () => {
    expect(evaluateWhen('{{scan.flag}} == false', scope)).toBe(true);
  });
  test('una comparación de orden sobre un campo ausente es falsa', () => {
    expect(evaluateWhen('{{scan.no_existe}} > 0', scope)).toBe(false);
  });
});

describe('evaluateWhen — formas rechazadas', () => {
  test('rechaza operadores lógicos', () => {
    expect(() => evaluateWhen('{{scan.stale_count}} > 0 && {{draft.pr_url}}', scope)).toThrow(
      ExpressionError,
    );
  });
  test('rechaza aritmética', () => {
    expect(() => evaluateWhen('{{scan.stale_count}} + 1 > 0', scope)).toThrow(ExpressionError);
  });
  test('rechaza comparar dos referencias entre sí', () => {
    expect(() => evaluateWhen('{{scan.stale_count}} > {{scan.zero}}', scope)).toThrow(
      ExpressionError,
    );
  });
  test('rechaza texto que no contiene ninguna referencia', () => {
    expect(() => evaluateWhen('1 > 0', scope)).toThrow(ExpressionError);
  });
});

describe('evaluateWhen — coerción de params', () => {
  // `resolveParams` normaliza todo param a string, así que este bloque lo
  // ejercita de verdad en vez de simular la forma con un scope escrito a
  // mano — así queda pinneado el camino real de stringificación.
  const paramPipeline = parsePipeline(`
name: demo
description: d
version: 1
params:
  dry_run:
    description: Si es un simulacro
    default: false
  retries:
    description: Reintentos
    default: 0
  max:
    description: Máximo
    default: 3
  mode:
    description: Modo de ejecución
    default: full
steps:
  - id: a
    type: shell
    run: 'true'
`);
  const paramScope: InterpolationScope = {
    params: resolveParams(paramPipeline, {}),
    steps: {},
  };

  test('resolveParams entrega los params como string', () => {
    expect(paramScope.params).toEqual({
      dry_run: 'false',
      retries: '0',
      max: '3',
      mode: 'full',
    });
  });

  test('un param de origen booleano es falso, no la cadena "false"', () => {
    expect(evaluateWhen('{{params.dry_run}}', paramScope)).toBe(false);
    expect(evaluateWhen('{{params.dry_run}} == false', paramScope)).toBe(true);
  });

  test('un param de origen numérico es falso en cero y compara numéricamente', () => {
    expect(evaluateWhen('{{params.retries}}', paramScope)).toBe(false);
    expect(evaluateWhen('{{params.max}} > 1', paramScope)).toBe(true);
    expect(evaluateWhen('{{params.retries}} == 0', paramScope)).toBe(true);
  });

  test('un param de origen cadena se comporta igual que antes (sin regresión)', () => {
    expect(evaluateWhen('{{params.mode}}', paramScope)).toBe(true);
  });
});

describe('evaluateWhen — orden: ausente vs. no numérico', () => {
  test('un campo ausente en una comparación de orden sigue siendo falso', () => {
    expect(evaluateWhen('{{scan.no_existe}} > 0', scope)).toBe(false);
  });

  test('un campo presente pero no numérico en una comparación de orden revienta, nombrando el valor', () => {
    expect(() => evaluateWhen('{{scan.name}} > 0', scope)).toThrow(ExpressionError);
    expect(() => evaluateWhen('{{scan.name}} > 0', scope)).toThrow(/scan\.name.*"docs"/);
  });

  test('un literal no numérico en una comparación de orden también revienta', () => {
    expect(() => evaluateWhen('{{scan.stale_count}} > "siete"', scope)).toThrow(ExpressionError);
  });
});

describe('evaluateWhen — las salidas de pasos no se coaccionan', () => {
  test('una salida de paso que es la cadena "0" sigue siendo verdadera', () => {
    const stepScope: InterpolationScope = { params: {}, steps: { x: { count: '0' } } };
    expect(evaluateWhen('{{x.count}}', stepScope)).toBe(true);
  });
});
