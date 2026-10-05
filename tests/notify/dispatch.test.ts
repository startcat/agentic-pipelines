import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePipeline } from '../../src/schema/pipeline.ts';
import { parseRepoConfig } from '../../src/schema/config.ts';
import type { RepoContext } from '../../src/cli/context.ts';
import type { RunRecord } from '../../src/runs/types.ts';
import { dispatchNotify, failureReason } from '../../src/notify/dispatch.ts';

function repoCtx(configYaml: string, dotEnv: Record<string, string> = {}): RepoContext {
  return { root: mkdtempSync(join(tmpdir(), 'ap-notify-')), config: parseRepoConfig(configYaml), dotEnv };
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: '2026-08-17T00-00-00-000Z',
    pipeline: 'demo',
    pipelineVersion: 1,
    status: 'success',
    startedAt: '2026-08-17T00:00:00.000Z',
    params: {},
    steps: {},
    ...overrides,
  };
}

const PIPELINE_WITH_NOTIFY = parsePipeline(`
name: demo
description: d
version: 1
notify:
  on: [success, failed]
  channel: email
steps:
  - id: a
    type: shell
    run: 'true'
`);

const PIPELINE_NO_NOTIFY = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: 'true'
`);

describe('dispatchNotify', () => {
  test('no hace nada si el pipeline no declara notify', async () => {
    let called = false;
    const ctx = repoCtx('channels: {}\n');
    await dispatchNotify(PIPELINE_NO_NOTIFY, run(), ctx, { spawnChannel: async () => { called = true; return { code: 0, log: '' }; } });
    expect(called).toBe(false);
  });

  test('no hace nada si run.status no está en notify.on', async () => {
    let called = false;
    const ctx = repoCtx('channels:\n  email:\n    type: shell\n    run: notify.sh\n');
    await dispatchNotify(PIPELINE_WITH_NOTIFY, run({ status: 'skipped' }), ctx, { spawnChannel: async () => { called = true; return { code: 0, log: '' }; } });
    expect(called).toBe(false);
  });

  test('invoca el canal cuando run.status está en notify.on', async () => {
    let receivedCommand = '';
    const ctx = repoCtx('channels:\n  email:\n    type: shell\n    run: notify.sh\n');
    await dispatchNotify(PIPELINE_WITH_NOTIFY, run({ status: 'success' }), ctx, {
      spawnChannel: async (command) => {
        receivedCommand = command;
        return { code: 0, log: '' };
      },
    });
    expect(receivedCommand).toBe('notify.sh');
  });

  test('pasa nombre, run-id, status y motivo como variables de entorno', async () => {
    let receivedEnv: Record<string, string> = {};
    const ctx = repoCtx('channels:\n  email:\n    type: shell\n    run: notify.sh\n');
    await dispatchNotify(
      PIPELINE_WITH_NOTIFY,
      run({ status: 'failed', skipReason: undefined }),
      ctx,
      { spawnChannel: async (_cmd, env) => { receivedEnv = env; return { code: 0, log: '' }; } },
    );
    expect(receivedEnv.PIPELINES_NOTIFY_NAME).toBe('demo');
    expect(receivedEnv.PIPELINES_NOTIFY_RUN_ID).toBe('2026-08-17T00-00-00-000Z');
    expect(receivedEnv.PIPELINES_NOTIFY_STATUS).toBe('failed');
    expect(receivedEnv.PIPELINES_NOTIFY_REASON).toBe('');
  });

  test('un run skipped con motivo lo pasa en PIPELINES_NOTIFY_REASON', async () => {
    let receivedEnv: Record<string, string> = {};
    const pipeline = parsePipeline(`
name: demo
description: d
version: 1
notify:
  on: [skipped]
  channel: email
steps:
  - id: a
    type: shell
    run: 'true'
`);
    const ctx = repoCtx('channels:\n  email:\n    type: shell\n    run: notify.sh\n');
    await dispatchNotify(
      pipeline,
      run({ status: 'skipped', skipReason: 'throttle: 4h' }),
      ctx,
      { spawnChannel: async (_cmd, env) => { receivedEnv = env; return { code: 0, log: '' }; } },
    );
    expect(receivedEnv.PIPELINES_NOTIFY_REASON).toBe('throttle: 4h');
  });

  test('resuelve los secretos declarados en env: del canal', async () => {
    let receivedEnv: Record<string, string> = {};
    const ctx = repoCtx(
      'channels:\n  email:\n    type: shell\n    run: notify.sh\n    env: [RESEND_API_KEY]\n',
      { RESEND_API_KEY: 're_test_123' },
    );
    await dispatchNotify(
      PIPELINE_WITH_NOTIFY,
      run({ status: 'success' }),
      ctx,
      { spawnChannel: async (_cmd, env) => { receivedEnv = env; return { code: 0, log: '' }; } },
    );
    expect(receivedEnv.RESEND_API_KEY).toBe('re_test_123');
  });

  test('lanza si el canal declarado en notify.channel no existe en pipelines.yaml', async () => {
    const ctx = repoCtx('channels: {}\n');
    await expect(
      dispatchNotify(PIPELINE_WITH_NOTIFY, run({ status: 'success' }), ctx, { spawnChannel: async () => ({ code: 0, log: '' }) }),
    ).rejects.toThrow(/email/);
  });

  test('lanza si el canal sale con código distinto de 0', async () => {
    const ctx = repoCtx('channels:\n  email:\n    type: shell\n    run: notify.sh\n');
    await expect(
      dispatchNotify(PIPELINE_WITH_NOTIFY, run({ status: 'success' }), ctx, { spawnChannel: async () => ({ code: 1, log: '' }) }),
    ).rejects.toThrow(/email/);
  });
});

// `stale_after`: la señal que faltaba. Un `notify.on: [skipped]` a secas es
// ruido — con `throttle: 46h` sobre un cron diario, la mitad de las noches
// salta por diseño. Lo que hay que saber no es "ha saltado", es "lleva
// demasiado sin ejecutarse de verdad", que es lo que pasó desapercibido diez
// noches con docs-review.
const PIPELINE_STALE = parsePipeline(`
name: demo
description: d
version: 1
notify:
  on: [success, failed]
  stale_after: 72h
  channel: email
steps:
  - id: a
    type: shell
    run: 'true'
`);

const CHANNEL_CONFIG = 'channels:\n  email:\n    type: shell\n    run: "true"\n';

describe('dispatchNotify — stale_after', () => {
  test('un run saltado dispara el canal si no hay ningún éxito dentro de la ventana', async () => {
    let called = false;
    const ctx = repoCtx(CHANNEL_CONFIG);
    await dispatchNotify(
      PIPELINE_STALE,
      run({ status: 'skipped', skipReason: 'throttle: 46h' }),
      ctx,
      {
        lastSuccessAt: '2026-08-10T00:00:00.000Z', // 7 días antes del run
        spawnChannel: async () => { called = true; return { code: 0, log: '' }; },
      },
    );
    expect(called).toBe(true);
  });

  test('un run saltado NO dispara el canal si hubo un éxito dentro de la ventana', async () => {
    let called = false;
    const ctx = repoCtx(CHANNEL_CONFIG);
    await dispatchNotify(
      PIPELINE_STALE,
      run({ status: 'skipped', skipReason: 'throttle: 46h' }),
      ctx,
      {
        lastSuccessAt: '2026-08-16T12:00:00.000Z', // 12 h antes del run
        spawnChannel: async () => { called = true; return { code: 0, log: '' }; },
      },
    );
    expect(called).toBe(false);
  });

  test('un run saltado dispara el canal si el pipeline no ha tenido nunca un éxito', async () => {
    let called = false;
    const ctx = repoCtx(CHANNEL_CONFIG);
    await dispatchNotify(
      PIPELINE_STALE,
      run({ status: 'skipped', skipReason: 'already_running' }),
      ctx,
      { spawnChannel: async () => { called = true; return { code: 0, log: '' }; } },
    );
    expect(called).toBe(true);
  });

  test('sin stale_after declarado, un run saltado nunca dispara el canal', async () => {
    let called = false;
    const ctx = repoCtx(CHANNEL_CONFIG);
    await dispatchNotify(
      PIPELINE_WITH_NOTIFY,
      run({ status: 'skipped', skipReason: 'throttle: 46h' }),
      ctx,
      { spawnChannel: async () => { called = true; return { code: 0, log: '' }; } },
    );
    expect(called).toBe(false);
  });

  test('el canal recibe STALE y LAST_SUCCESS para poder redactar el aviso', async () => {
    let received: Record<string, string> = {};
    const ctx = repoCtx(CHANNEL_CONFIG);
    await dispatchNotify(
      PIPELINE_STALE,
      run({ status: 'skipped', skipReason: 'throttle: 46h' }),
      ctx,
      {
        lastSuccessAt: '2026-08-10T00:00:00.000Z',
        spawnChannel: async (_cmd, env) => { received = env; return { code: 0, log: '' }; },
      },
    );
    expect(received.PIPELINES_NOTIFY_STALE).toBe('1');
    expect(received.PIPELINES_NOTIFY_LAST_SUCCESS).toBe('2026-08-10T00:00:00.000Z');
  });

  test('un run correcto normal lleva STALE vacío y su propio éxito como LAST_SUCCESS', async () => {
    let received: Record<string, string> = {};
    const ctx = repoCtx(CHANNEL_CONFIG);
    await dispatchNotify(
      PIPELINE_STALE,
      run({ status: 'success' }),
      ctx,
      {
        lastSuccessAt: '2026-08-17T00:00:00.000Z', // el run mismo
        spawnChannel: async (_cmd, env) => { received = env; return { code: 0, log: '' }; },
      },
    );
    expect(received.PIPELINES_NOTIFY_STALE).toBe('');
    expect(received.PIPELINES_NOTIFY_LAST_SUCCESS).toBe('2026-08-17T00:00:00.000Z');
  });
});

// Hasta ahora, un correo de un run fallido decía "(sense motiu registrat)": el
// motor solo rellenaba REASON para los saltos por guarda, y el canal intentaba
// derivar el motivo llamando a `pipelines show`, que no está instalado como
// binario. El aviso llegaba, pero no decía lo suficiente para actuar sin ir a
// mirar `.runs/` a mano.
describe('dispatchNotify: rastro del canal', () => {
  const CTX_YAML = 'channels:\n  email:\n    type: shell\n    run: ./notify.sh\n    env: [RESEND_API_KEY]\n';

  test('devuelve canal, código, instante y la salida del canal', async () => {
    const ctx = repoCtx(CTX_YAML);
    const result = await dispatchNotify(PIPELINE_WITH_NOTIFY, run(), ctx, {
      spawnChannel: async () => ({ code: 0, log: 'notify-resend: enviat (200): [pipelines] demo OK\n' }),
    });
    expect(result).toMatchObject({
      channel: 'email',
      code: 0,
      log: 'notify-resend: enviat (200): [pipelines] demo OK',
    });
    expect(typeof result?.at).toBe('string');
    expect(Number.isNaN(Date.parse(result!.at))).toBe(false);
  });

  test('devuelve undefined cuando el canal no se invoca', async () => {
    const ctx = repoCtx('channels: {}\n');
    const result = await dispatchNotify(PIPELINE_NO_NOTIFY, run(), ctx, {
      spawnChannel: async () => ({ code: 0, log: 'no debería llegar' }),
    });
    expect(result).toBeUndefined();
  });

  test('redacta los secretos del canal en la salida guardada', async () => {
    const ctx = repoCtx(CTX_YAML, { RESEND_API_KEY: 're_muy_secreta' });
    const result = await dispatchNotify(PIPELINE_WITH_NOTIFY, run(), ctx, {
      spawnChannel: async () => ({ code: 0, log: 'curl -H Bearer re_muy_secreta\n' }),
    });
    expect(result!.log).not.toContain('re_muy_secreta');
    expect(result!.log).toContain('«redactado»');
  });

  test('guarda solo la cola de una salida desmesurada', async () => {
    const ctx = repoCtx(CTX_YAML);
    const result = await dispatchNotify(PIPELINE_WITH_NOTIFY, run(), ctx, {
      spawnChannel: async () => ({ code: 0, log: 'x'.repeat(5000) + 'FINAL' }),
    });
    expect(result!.log.length).toBeLessThanOrEqual(2000);
    expect(result!.log.endsWith('FINAL')).toBe(true);
  });

  test('un canal que sale con error lanza, pero la excepción lleva el rastro', async () => {
    const ctx = repoCtx(CTX_YAML);
    let thrown: unknown;
    try {
      await dispatchNotify(PIPELINE_WITH_NOTIFY, run(), ctx, {
        spawnChannel: async () => ({ code: 1, log: 'notify-resend: FALLIT (422)\n' }),
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('código 1');
    expect((thrown as { notify?: { code: number; log: string } }).notify).toMatchObject({
      code: 1,
      log: 'notify-resend: FALLIT (422)',
    });
  });
});

describe('failureReason', () => {
  const withSteps = (steps: RunRecord['steps']): RunRecord => run({ status: 'failed', steps });

  test('nombra el paso que falló y su error', () => {
    const reason = failureReason(
      withSteps({
        build: { id: 'build', status: 'failed', startedAt: '', durationMs: 0, outputs: {}, effects: [], attempts: 1, error: 'yarn build falló' },
      }),
    );
    expect(reason).toBe('build: yarn build falló');
  });

  test('con varios pasos fallidos los nombra todos', () => {
    const reason = failureReason(
      withSteps({
        build: { id: 'build', status: 'failed', startedAt: '', durationMs: 0, outputs: {}, effects: [], attempts: 1, error: 'a' },
        push: { id: 'push', status: 'failed', startedAt: '', durationMs: 0, outputs: {}, effects: [], attempts: 1, error: 'b' },
      }),
    );
    expect(reason).toBe('build: a; push: b');
  });

  test('ignora los pasos correctos y los saltados', () => {
    const reason = failureReason(
      withSteps({
        ok: { id: 'ok', status: 'success', startedAt: '', durationMs: 0, outputs: {}, effects: [], attempts: 1 },
        saltado: { id: 'saltado', status: 'skipped', startedAt: '', durationMs: 0, outputs: {}, effects: [], attempts: 0 },
        build: { id: 'build', status: 'failed', startedAt: '', durationMs: 0, outputs: {}, effects: [], attempts: 1, error: 'x' },
      }),
    );
    expect(reason).toBe('build: x');
  });

  test('un paso fallido sin mensaje de error se nombra igualmente', () => {
    const reason = failureReason(
      withSteps({
        build: { id: 'build', status: 'failed', startedAt: '', durationMs: 0, outputs: {}, effects: [], attempts: 1 },
      }),
    );
    expect(reason).toBe('build: (sin mensaje de error)');
  });

  // Un error de un paso agent puede ocupar miles de caracteres. Un correo que
  // no se puede leer no informa de nada.
  test('trunca un motivo desmesurado en vez de mandarlo entero', () => {
    const reason = failureReason(
      withSteps({
        redact: { id: 'redact', status: 'failed', startedAt: '', durationMs: 0, outputs: {}, effects: [], attempts: 1, error: 'x'.repeat(2000) },
      }),
    );
    expect(reason.length).toBeLessThanOrEqual(503);
    expect(reason.endsWith('…')).toBe(true);
  });

  // Un run puede acabar `failed` sin ningún paso en `failed` (algo que revienta
  // antes o entre pasos). Devolver cadena vacía deja que el canal caiga a su
  // propio fallback en vez de inventar un motivo.
  test('sin ningún paso fallido devuelve cadena vacía', () => {
    expect(failureReason(withSteps({}))).toBe('');
  });
});

describe('dispatchNotify — motivo de un run fallido', () => {
  test('el canal recibe el paso que falló en REASON', async () => {
    let received: Record<string, string> = {};
    const ctx = repoCtx(CHANNEL_CONFIG);
    await dispatchNotify(
      PIPELINE_WITH_NOTIFY,
      run({
        status: 'failed',
        steps: {
          build: { id: 'build', status: 'failed', startedAt: '', durationMs: 0, outputs: {}, effects: [], attempts: 1, error: 'yarn build falló' },
        },
      }),
      ctx,
      { spawnChannel: async (_cmd, env) => { received = env; return { code: 0, log: '' }; } },
    );
    expect(received.PIPELINES_NOTIFY_REASON).toBe('build: yarn build falló');
  });

  // El motivo de una guarda sigue mandando: un run saltado no tiene pasos
  // fallidos que mirar, y su motivo real es la guarda.
  test('un skipReason existente tiene precedencia sobre los pasos', async () => {
    let received: Record<string, string> = {};
    const ctx = repoCtx(CHANNEL_CONFIG);
    await dispatchNotify(
      parsePipeline(`
name: demo
description: d
version: 1
notify:
  on: [skipped]
  channel: email
steps:
  - id: a
    type: shell
    run: 'true'
`),
      run({ status: 'skipped', skipReason: 'throttle: 46h' }),
      ctx,
      { spawnChannel: async (_cmd, env) => { received = env; return { code: 0, log: '' }; } },
    );
    expect(received.PIPELINES_NOTIFY_REASON).toBe('throttle: 46h');
  });
});
