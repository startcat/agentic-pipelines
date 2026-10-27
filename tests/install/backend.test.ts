import { describe, expect, test } from 'bun:test';
import { schedulerFor } from '../../src/install/backend.ts';

describe('schedulerFor', () => {
  test('en macOS elige launchd', () => {
    expect(schedulerFor('darwin', {}).kind).toBe('launchd');
  });

  test('en Linux elige systemd', () => {
    expect(schedulerFor('linux', {}).kind).toBe('systemd');
  });

  test('en cualquier otra plataforma lanza un error que dice cuáles sirven', () => {
    expect(() => schedulerFor('win32', {})).toThrow(
      'Programar pipelines solo está soportado en macOS (launchd) y Linux (systemd); esta máquina es win32.',
    );
  });

  // El seam de los tests: forzar el backend sin depender de la máquina.
  test('PIPELINES_SCHEDULER manda sobre la plataforma', () => {
    expect(schedulerFor('darwin', { PIPELINES_SCHEDULER: 'systemd' }).kind).toBe('systemd');
    expect(schedulerFor('linux', { PIPELINES_SCHEDULER: 'launchd' }).kind).toBe('launchd');
  });

  test('un PIPELINES_SCHEDULER desconocido es un error, no un valor por defecto', () => {
    expect(() => schedulerFor('darwin', { PIPELINES_SCHEDULER: 'cron' })).toThrow('PIPELINES_SCHEDULER');
  });
});
