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
  test('a run with no denials produces no warnings', () => {
    expect(unknownToolWarnings(run({ a: step() }))).toEqual([]);
  });

  test('a denial for another reason (outside cwd) produces no warning — it is not "unknown tool"', () => {
    const withDenial = step({
      denials: [{ toolName: 'Read', toolUseId: 't1', reason: 'path outside the allowed roots', source: 'both' }],
    });
    expect(unknownToolWarnings(run({ a: withDenial }))).toEqual([]);
  });

  test('a denial for "unknown tool for the engine" produces a warning, even if the step ended in success', () => {
    const withDenial = step({
      status: 'success',
      denials: [
        { toolName: 'StructuredOutput', toolUseId: 't1', reason: 'unknown tool for the engine: "StructuredOutput"', source: 'both' },
      ],
    });
    const warnings = unknownToolWarnings(run({ spelling: withDenial }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('spelling');
    expect(warnings[0]).toContain('StructuredOutput');
  });

  test('the same tool denied twice in the same step produces a single warning (deduplicated)', () => {
    const withDenial = step({
      denials: [
        { toolName: 'StructuredOutput', toolUseId: 't1', reason: 'unknown tool for the engine: "StructuredOutput"', source: 'both' },
        { toolName: 'StructuredOutput', toolUseId: 't2', reason: 'unknown tool for the engine: "StructuredOutput"', source: 'both' },
      ],
    });
    expect(unknownToolWarnings(run({ spelling: withDenial }))).toHaveLength(1);
  });

  test('the same tool denied in two different steps produces one warning per step', () => {
    const denial = { toolName: 'StructuredOutput', toolUseId: 't1', reason: 'unknown tool for the engine: "StructuredOutput"', source: 'both' as const };
    const warnings = unknownToolWarnings(run({ a: step({ denials: [denial] }), b: step({ denials: [{ ...denial, toolUseId: 't2' }] }) }));
    expect(warnings).toHaveLength(2);
  });

  test('a denial with no reason (sdk-result only) produces no warning — there is no text to compare', () => {
    const withDenial = step({
      denials: [{ toolName: 'something', toolUseId: 't1', source: 'sdk-result' }],
    });
    expect(unknownToolWarnings(run({ a: withDenial }))).toEqual([]);
  });

  test('a denial written before the translation (Spanish reason) is still recognized', () => {
    const withDenial = step({
      denials: [
        { toolName: 'StructuredOutput', toolUseId: 't1', reason: 'tool desconocida para el motor: "StructuredOutput"', source: 'both' },
      ],
    });
    expect(unknownToolWarnings(run({ spelling: withDenial }))).toHaveLength(1);
  });
});
