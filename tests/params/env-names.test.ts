import { describe, expect, test } from 'bun:test';
import { resolvedEnvNames, resolveEnvNames } from '../../src/params/env-names.ts';

describe('resolveEnvNames', () => {
  test('un nombre literal pasa tal cual', () => {
    expect(resolveEnvNames(['MY_TOKEN'], {})).toEqual([
      { declared: 'MY_TOKEN', ok: true, name: 'MY_TOKEN' },
    ]);
  });

  test('un nombre literal no se valida como variable, para no romper lo que ya existe', () => {
    expect(resolveEnvNames(['raro-pero-literal'], {})).toEqual([
      { declared: 'raro-pero-literal', ok: true, name: 'raro-pero-literal' },
    ]);
  });

  test('una plantilla se resuelve con los params', () => {
    expect(
      resolveEnvNames(['QA_{{params.app}}_{{params.entorno}}_USUARIO'], { app: 'myapp', entorno: 'pro' }),
    ).toEqual([
      { declared: 'QA_{{params.app}}_{{params.entorno}}_USUARIO', ok: true, name: 'QA_myapp_pro_USUARIO' },
    ]);
  });

  test('una plantilla con params sin valor no se resuelve y dice cuáles faltan', () => {
    expect(resolveEnvNames(['QA_{{params.app}}_{{params.entorno}}_USUARIO'], { app: 'myapp' })).toEqual([
      {
        declared: 'QA_{{params.app}}_{{params.entorno}}_USUARIO',
        ok: false,
        reason: 'missing-params',
        missing: ['entorno'],
      },
    ]);
  });

  test('un nombre resuelto que no es variable válida se rechaza', () => {
    expect(resolveEnvNames(['QA_{{params.app}}_USUARIO'], { app: 'my-app' })).toEqual([
      { declared: 'QA_{{params.app}}_USUARIO', ok: false, reason: 'invalid-name', name: 'QA_my-app_USUARIO' },
    ]);
  });

  test('una referencia que no es a params se rechaza sin lanzar', () => {
    expect(resolveEnvNames(['X_{{secrets.OTRO}}', 'Y_{{paso.campo}}'], {})).toEqual([
      { declared: 'X_{{secrets.OTRO}}', ok: false, reason: 'bad-reference', refs: ['secrets.OTRO'] },
      { declared: 'Y_{{paso.campo}}', ok: false, reason: 'bad-reference', refs: ['paso.campo'] },
    ]);
  });
});

describe('resolvedEnvNames', () => {
  test('devuelve solo los nombres resueltos y válidos', () => {
    expect(
      resolvedEnvNames(['MY_TOKEN', 'QA_{{params.app}}_USUARIO', 'QA_{{params.falta}}_X'], { app: 'myapp' }),
    ).toEqual(['MY_TOKEN', 'QA_myapp_USUARIO']);
  });

  test('no repite un nombre que llega por dos entradas', () => {
    expect(resolvedEnvNames(['QA_myapp_USUARIO', 'QA_{{params.app}}_USUARIO'], { app: 'myapp' })).toEqual([
      'QA_myapp_USUARIO',
    ]);
  });
});
