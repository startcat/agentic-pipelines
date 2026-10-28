import { describe, expect, test } from 'bun:test';
import { schedulerFor } from '../../src/install/backend.ts';

describe('schedulerFor', () => {
  test('on macOS it picks launchd', () => {
    expect(schedulerFor('darwin', {}).kind).toBe('launchd');
  });

  test('on Linux it picks systemd', () => {
    expect(schedulerFor('linux', {}).kind).toBe('systemd');
  });

  test('on any other platform it throws an error that says which ones work', () => {
    expect(() => schedulerFor('win32', {})).toThrow(
      'Scheduling pipelines is only supported on macOS (launchd) and Linux (systemd); this machine is win32.',
    );
  });

  // The tests' seam: force the backend without depending on the machine.
  test('PIPELINES_SCHEDULER wins over the platform', () => {
    expect(schedulerFor('darwin', { PIPELINES_SCHEDULER: 'systemd' }).kind).toBe('systemd');
    expect(schedulerFor('linux', { PIPELINES_SCHEDULER: 'launchd' }).kind).toBe('launchd');
  });

  test('an unknown PIPELINES_SCHEDULER is an error, not a default value', () => {
    expect(() => schedulerFor('darwin', { PIPELINES_SCHEDULER: 'cron' })).toThrow('PIPELINES_SCHEDULER');
  });
});
