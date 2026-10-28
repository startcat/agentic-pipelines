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

describe('evaluateWhen — bare reference', () => {
  test('a non-empty string is truthy', () => {
    expect(evaluateWhen('{{draft.pr_url}}', scope)).toBe(true);
  });
  test('a non-zero number is truthy', () => {
    expect(evaluateWhen('{{scan.stale_count}}', scope)).toBe(true);
  });
  test('zero is falsy', () => {
    expect(evaluateWhen('{{scan.zero}}', scope)).toBe(false);
  });
  test('false is falsy', () => {
    expect(evaluateWhen('{{scan.flag}}', scope)).toBe(false);
  });
  test('null is falsy', () => {
    expect(evaluateWhen('{{scan.nothing}}', scope)).toBe(false);
  });
  test('an empty list is falsy', () => {
    expect(evaluateWhen('{{scan.empty_list}}', scope)).toBe(false);
  });
  test('a list with elements is truthy', () => {
    expect(evaluateWhen('{{scan.pages}}', scope)).toBe(true);
  });
  test('a field that does not exist is falsy, not an error', () => {
    expect(evaluateWhen('{{scan.does_not_exist}}', scope)).toBe(false);
  });
  test('accepts references to params', () => {
    expect(evaluateWhen('{{params.mode}}', scope)).toBe(true);
  });
});

describe('evaluateWhen — comparison', () => {
  test('compares numbers', () => {
    expect(evaluateWhen('{{scan.stale_count}} > 0', scope)).toBe(true);
    expect(evaluateWhen('{{scan.stale_count}} > 10', scope)).toBe(false);
    expect(evaluateWhen('{{scan.stale_count}} >= 7', scope)).toBe(true);
    expect(evaluateWhen('{{scan.stale_count}} < 10', scope)).toBe(true);
    expect(evaluateWhen('{{scan.stale_count}} <= 6', scope)).toBe(false);
  });
  test('compares strings with == and !=', () => {
    expect(evaluateWhen('{{scan.name}} == "docs"', scope)).toBe(true);
    expect(evaluateWhen("{{scan.name}} != 'docs'", scope)).toBe(false);
  });
  test('compares with boolean literals', () => {
    expect(evaluateWhen('{{scan.flag}} == false', scope)).toBe(true);
  });
  test('an ordering comparison on an absent field is falsy', () => {
    expect(evaluateWhen('{{scan.does_not_exist}} > 0', scope)).toBe(false);
  });
});

describe('evaluateWhen — rejected forms', () => {
  test('rejects logical operators', () => {
    expect(() => evaluateWhen('{{scan.stale_count}} > 0 && {{draft.pr_url}}', scope)).toThrow(
      ExpressionError,
    );
  });
  test('rejects arithmetic', () => {
    expect(() => evaluateWhen('{{scan.stale_count}} + 1 > 0', scope)).toThrow(ExpressionError);
  });
  test('rejects comparing two references with each other', () => {
    expect(() => evaluateWhen('{{scan.stale_count}} > {{scan.zero}}', scope)).toThrow(
      ExpressionError,
    );
  });
  test('rejects text that contains no reference', () => {
    expect(() => evaluateWhen('1 > 0', scope)).toThrow(ExpressionError);
  });
});

describe('evaluateWhen — params coercion', () => {
  // `resolveParams` normalizes every param to a string, so this block
  // exercises it for real instead of simulating the shape with a
  // hand-written scope — that way the real stringification path is pinned.
  const paramPipeline = parsePipeline(`
name: demo
description: d
version: 1
params:
  dry_run:
    description: Whether it is a dry run
    default: false
  retries:
    description: Retries
    default: 0
  max:
    description: Maximum
    default: 3
  mode:
    description: Run mode
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

  test('resolveParams delivers params as strings', () => {
    expect(paramScope.params).toEqual({
      dry_run: 'false',
      retries: '0',
      max: '3',
      mode: 'full',
    });
  });

  test('a param of boolean origin is falsy, not the string "false"', () => {
    expect(evaluateWhen('{{params.dry_run}}', paramScope)).toBe(false);
    expect(evaluateWhen('{{params.dry_run}} == false', paramScope)).toBe(true);
  });

  test('a param of numeric origin is falsy at zero and compares numerically', () => {
    expect(evaluateWhen('{{params.retries}}', paramScope)).toBe(false);
    expect(evaluateWhen('{{params.max}} > 1', paramScope)).toBe(true);
    expect(evaluateWhen('{{params.retries}} == 0', paramScope)).toBe(true);
  });

  test('a param of string origin behaves as before (no regression)', () => {
    expect(evaluateWhen('{{params.mode}}', paramScope)).toBe(true);
  });
});

describe('evaluateWhen — ordering: absent vs. non-numeric', () => {
  test('an absent field in an ordering comparison is still falsy', () => {
    expect(evaluateWhen('{{scan.does_not_exist}} > 0', scope)).toBe(false);
  });

  test('a present but non-numeric field in an ordering comparison blows up, naming the value', () => {
    expect(() => evaluateWhen('{{scan.name}} > 0', scope)).toThrow(ExpressionError);
    expect(() => evaluateWhen('{{scan.name}} > 0', scope)).toThrow(/scan\.name.*"docs"/);
  });

  test('a non-numeric literal in an ordering comparison also blows up', () => {
    expect(() => evaluateWhen('{{scan.stale_count}} > "seven"', scope)).toThrow(ExpressionError);
  });
});

describe('evaluateWhen — step outputs are not coerced', () => {
  test('a step output that is the string "0" is still truthy', () => {
    const stepScope: InterpolationScope = { params: {}, steps: { x: { count: '0' } } };
    expect(evaluateWhen('{{x.count}}', stepScope)).toBe(true);
  });
});
