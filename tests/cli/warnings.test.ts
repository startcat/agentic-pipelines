import { describe, expect, test } from 'bun:test';
import { unknownToolWarnings } from '../../src/cli/warnings.ts';
import type { RunRecord, StepRecord } from '../../src/runs/types.ts';

function step(overrides: Partial<StepRecord> = {}): StepRecord {
  return {
    id: 'x',
    status: 'success',
    startedAt: '2026-08-18T00:00:00.000Z',
    durationMs: 1,
    outputs: {},
    effects: [],
    attempts: 1,
    ...overrides,
  };
}

function run(steps: Record<string, StepRecord>): RunRecord {
  return {
    id: 'r1',
    pipeline: 'p',
    pipelineVersion: 1,
    status: 'success',
    startedAt: '2026-08-18T00:00:00.000Z',
    params: {},
    steps,
  };
}

describe('unknownToolWarnings', () => {
  test('un run sin denegaciones no produce avisos', () => {
    expect(unknownToolWarnings(run({ a: step() }))).toEqual([]);
  });

  test('una denegación por otro motivo (fuera de cwd) no produce aviso — no es "tool desconocida"', () => {
    const withDenial = step({
      denials: [{ toolName: 'Read', toolUseId: 't1', reason: 'ruta fuera de las raíces permitidas', source: 'both' }],
    });
    expect(unknownToolWarnings(run({ a: withDenial }))).toEqual([]);
  });

  test('una denegación por "tool desconocida para el motor" produce un aviso, incluso si el paso terminó en éxito', () => {
    const withDenial = step({
      status: 'success',
      denials: [
        { toolName: 'StructuredOutput', toolUseId: 't1', reason: 'tool desconocida para el motor: "StructuredOutput"', source: 'both' },
      ],
    });
    const warnings = unknownToolWarnings(run({ spelling: withDenial }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('spelling');
    expect(warnings[0]).toContain('StructuredOutput');
  });

  test('la misma tool denegada dos veces en el mismo paso produce un solo aviso (deduplicado)', () => {
    const withDenial = step({
      denials: [
        { toolName: 'StructuredOutput', toolUseId: 't1', reason: 'tool desconocida para el motor: "StructuredOutput"', source: 'both' },
        { toolName: 'StructuredOutput', toolUseId: 't2', reason: 'tool desconocida para el motor: "StructuredOutput"', source: 'both' },
      ],
    });
    expect(unknownToolWarnings(run({ spelling: withDenial }))).toHaveLength(1);
  });

  test('la misma tool denegada en dos pasos distintos produce un aviso por paso', () => {
    const denial = { toolName: 'StructuredOutput', toolUseId: 't1', reason: 'tool desconocida para el motor: "StructuredOutput"', source: 'both' as const };
    const warnings = unknownToolWarnings(run({ a: step({ denials: [denial] }), b: step({ denials: [{ ...denial, toolUseId: 't2' }] }) }));
    expect(warnings).toHaveLength(2);
  });

  test('un denial sin reason (solo sdk-result) no produce aviso — no hay texto que comparar', () => {
    const withDenial = step({
      denials: [{ toolName: 'algo', toolUseId: 't1', source: 'sdk-result' }],
    });
    expect(unknownToolWarnings(run({ a: withDenial }))).toEqual([]);
  });
});
