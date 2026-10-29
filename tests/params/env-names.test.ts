import { describe, expect, test } from 'bun:test';
import { resolvedEnvNames, resolveEnvNames } from '../../src/params/env-names.ts';

describe('resolveEnvNames', () => {
  test('a literal name passes as is', () => {
    expect(resolveEnvNames(['MY_TOKEN'], {})).toEqual([
      { declared: 'MY_TOKEN', ok: true, name: 'MY_TOKEN' },
    ]);
  });

  test('a literal name is not validated as a variable, so as not to break what already exists', () => {
    expect(resolveEnvNames(['raro-pero-literal'], {})).toEqual([
      { declared: 'raro-pero-literal', ok: true, name: 'raro-pero-literal' },
    ]);
  });

  test('a template is resolved with the params', () => {
    expect(
      resolveEnvNames(['QA_{{params.app}}_{{params.stage}}_USER'], { app: 'myapp', stage: 'pro' }),
    ).toEqual([
      { declared: 'QA_{{params.app}}_{{params.stage}}_USER', ok: true, name: 'QA_myapp_pro_USER' },
    ]);
  });

  test('a template with params with no value is not resolved and says which are missing', () => {
    expect(resolveEnvNames(['QA_{{params.app}}_{{params.stage}}_USER'], { app: 'myapp' })).toEqual([
      {
        declared: 'QA_{{params.app}}_{{params.stage}}_USER',
        ok: false,
        reason: 'missing-params',
        missing: ['stage'],
      },
    ]);
  });

  test('a resolved name that is not a valid variable is rejected', () => {
    expect(resolveEnvNames(['QA_{{params.app}}_USER'], { app: 'my-app' })).toEqual([
      { declared: 'QA_{{params.app}}_USER', ok: false, reason: 'invalid-name', name: 'QA_my-app_USER' },
    ]);
  });

  test('a reference that is not to params is rejected without throwing', () => {
    expect(resolveEnvNames(['X_{{secrets.OTHER}}', 'Y_{{step.field}}'], {})).toEqual([
      { declared: 'X_{{secrets.OTHER}}', ok: false, reason: 'bad-reference', refs: ['secrets.OTHER'] },
      { declared: 'Y_{{step.field}}', ok: false, reason: 'bad-reference', refs: ['step.field'] },
    ]);
  });
});

describe('resolvedEnvNames', () => {
  test('returns only the resolved, valid names', () => {
    expect(
      resolvedEnvNames(['MY_TOKEN', 'QA_{{params.app}}_USER', 'QA_{{params.missing}}_X'], { app: 'myapp' }),
    ).toEqual(['MY_TOKEN', 'QA_myapp_USER']);
  });

  test('does not repeat a name that comes from two entries', () => {
    expect(resolvedEnvNames(['QA_myapp_USER', 'QA_{{params.app}}_USER'], { app: 'myapp' })).toEqual([
      'QA_myapp_USER',
    ]);
  });
});
