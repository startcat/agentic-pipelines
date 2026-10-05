import { describe, expect, test } from 'bun:test';
import { parseRepoConfig } from '../../src/schema/config.ts';

// config.ts recibió el renombrado de clave (onError -> on_error) pero nunca
// el `.strict()` que ya tenía su hermano `pipeline.ts`, así que `pipelines.yaml` seguía
// tragándose en silencio el mismo typo que on_error existe para atrapar.
describe('parseRepoConfig', () => {
  test('acepta on_error y lo expone como onError', () => {
    const config = parseRepoConfig('defaults:\n  on_error: continue\n');
    expect(config.defaults.onError).toBe('continue');
  });

  test('rechaza el typo camelCase onError nombrando la clave', () => {
    expect(() => parseRepoConfig('defaults:\n  onError: continue\n')).toThrow(/onError/);
  });

  test('rechaza una clave desconocida a nivel de pipeline nombrándola', () => {
    expect(() => parseRepoConfig('claveInventada: 1\n')).toThrow(/claveInventada/);
  });

  test('rechaza una clave desconocida en defaults nombrándola', () => {
    expect(() => parseRepoConfig('defaults:\n  retires: 2\n')).toThrow(/retires/);
  });

  test('acepta defaults.notify.on con failed y lo expone tal cual', () => {
    const config = parseRepoConfig('defaults:\n  notify:\n    on: [failed, success]\n    channel: telegram\n');
    expect(config.defaults.notify).toEqual({ on: ['failed', 'success'], channel: 'telegram' });
  });

  // cli/context.ts depende de esto: loadRepoContext acepta un
  // pipelines.yaml vacío (touch pipelines.yaml basta) porque todo campo de
  // este esquema tiene un valor por defecto.
  test('un config vacío parsea con éxito', () => {
    const config = parseRepoConfig('');
    expect(config).toEqual({ channels: {}, defaults: {} });
  });

  test('un canal acepta env: opcional y expone los nombres declarados', () => {
    const config = parseRepoConfig(
      'channels:\n  email:\n    type: shell\n    run: scripts/notify.sh\n    env: [RESEND_API_KEY]\n',
    );
    expect(config.channels['email']).toEqual({
      type: 'shell',
      run: 'scripts/notify.sh',
      env: ['RESEND_API_KEY'],
    });
  });

  test('un canal sin env: declarado expone una lista vacía', () => {
    const config = parseRepoConfig('channels:\n  telegram:\n    type: shell\n    run: relay.sh\n');
    expect(config.channels['telegram']!.env).toEqual([]);
  });

  test('rechaza una clave desconocida dentro de un canal nombrándola', () => {
    expect(() =>
      parseRepoConfig('channels:\n  x:\n    type: shell\n    run: r.sh\n    secretos: [A]\n'),
    ).toThrow(/secretos/);
  });
});
