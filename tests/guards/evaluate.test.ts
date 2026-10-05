import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePipeline } from '../../src/schema/pipeline.ts';
import { RunStore } from '../../src/runs/store.ts';
import { evaluateGuards, parseDuration } from '../../src/guards/evaluate.ts';

let root: string;
let store: RunStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ap-guards-'));
  store = new RunStore(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const withGuards = (guards: string) =>
  parsePipeline(`
name: demo
description: d
version: 1
when:
${guards}
steps:
  - id: a
    type: shell
    run: 'true'
`);

describe('parseDuration', () => {
  test('convierte segundos, minutos y horas a milisegundos', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('4h')).toBe(14_400_000);
  });
});

describe('evaluateGuards — throttle', () => {
  test('pasa cuando nunca hubo un run correcto', async () => {
    const result = await evaluateGuards(withGuards('  - throttle: 4h'), {
      store, params: {}, now: new Date(),
    });
    expect(result.pass).toBe(true);
  });

  test('bloquea si el último run correcto es más reciente que la ventana', async () => {
    const run = await store.createRun('demo', 1, {}, new Date('2026-08-05T10:00:00Z'));
    await store.finishRun(run, 'success');
    const result = await evaluateGuards(withGuards('  - throttle: 4h'), {
      store, params: {}, now: new Date('2026-08-05T12:00:00Z'),
    });
    expect(result.pass).toBe(false);
    if (!result.pass) expect(result.reason).toContain('throttle');
  });

  test('pasa si el último run correcto es más antiguo que la ventana', async () => {
    const run = await store.createRun('demo', 1, {}, new Date('2026-08-05T02:00:00Z'));
    await store.finishRun(run, 'success');
    const result = await evaluateGuards(withGuards('  - throttle: 4h'), {
      store, params: {}, now: new Date('2026-08-05T12:00:00Z'),
    });
    expect(result.pass).toBe(true);
  });

  test('un run FALLIDO no consume la ventana', async () => {
    const run = await store.createRun('demo', 1, {}, new Date('2026-08-05T11:00:00Z'));
    await store.finishRun(run, 'failed');
    const result = await evaluateGuards(withGuards('  - throttle: 4h'), {
      store, params: {}, now: new Date('2026-08-05T12:00:00Z'),
    });
    expect(result.pass).toBe(true);
  });

  test('con since: last_attempt un run fallido SÍ consume la ventana', async () => {
    const run = await store.createRun('demo', 1, {}, new Date('2026-08-05T11:00:00Z'));
    await store.finishRun(run, 'failed');
    const result = await evaluateGuards(
      withGuards('  - throttle: { every: 4h, since: last_attempt }'),
      { store, params: {}, now: new Date('2026-08-05T12:00:00Z') },
    );
    expect(result.pass).toBe(false);
  });
});

describe('evaluateGuards — shell', () => {
  test('pasa con exit code 0', async () => {
    // NOTA: entrecomillado a propósito. `shell: true` sin comillas es un booleano
    // YAML, no la cadena "true", y el schema exige
    // `shell: z.string()` — sin comillas, parsePipeline lanzaría antes de llegar
    // a evaluateGuards (las mismas comillas ya se usan más abajo, en el bloque
    // "combinación").
    const result = await evaluateGuards(withGuards('  - shell: "true"'), {
      store, params: {}, now: new Date(), runShell: async () => 0,
    });
    expect(result.pass).toBe(true);
  });

  test('bloquea con exit code distinto de 0', async () => {
    const result = await evaluateGuards(withGuards('  - shell: "false"'), {
      store, params: {}, now: new Date(), runShell: async () => 1,
    });
    expect(result.pass).toBe(false);
  });

  test('interpola params en el comando vía variable de entorno', async () => {
    let receivedCommand = '';
    let receivedEnv: Record<string, string> = {};
    await evaluateGuards(withGuards('  - shell: test -d {{params.root}}'), {
      store, params: { root: '/srv' }, now: new Date(),
      runShell: async (cmd, env) => { receivedCommand = cmd; receivedEnv = env; return 0; },
    });
    expect(receivedCommand).toBe('test -d ${__PIPELINES_REF_0}');
    expect(receivedEnv.__PIPELINES_REF_0).toBe('/srv');
  });

  test('un valor de param con metacaracteres de shell no se ejecuta (indirección por entorno)', async () => {
    let receivedCommand = '';
    const result = await evaluateGuards(withGuards('  - shell: "echo {{params.texto}}"'), {
      store, params: { texto: '$(touch pwned.txt)' }, now: new Date(),
      runShell: async (cmd) => { receivedCommand = cmd; return 0; },
    });
    expect(result.pass).toBe(true);
    expect(receivedCommand).not.toContain('touch');
  });

  test('el motivo de fallo usa el texto declarado del guard, no el valor interpolado', async () => {
    const result = await evaluateGuards(
      withGuards('  - shell: test -d {{params.secret}}'),
      {
        store, params: { secret: 'super-secreto' }, now: new Date(),
        runShell: async () => 1,
      },
    );
    expect(result.pass).toBe(false);
    if (!result.pass) {
      expect(result.reason).toContain('{{params.secret}}');
      expect(result.reason).not.toContain('super-secreto');
    }
  });

  // A diferencia de todos los tests anteriores de este describe, aquí NO se
  // inyecta un `runShell` de prueba: sin esa opción, `evaluateGuards` cae al
  // `defaultRunShell` real (`src/guards/evaluate.ts`), que hace
  // `Bun.spawn(['sh', '-c', command], { env: { ...composeEnv({}), ...env } })`
  // de verdad. Ningún otro test de este fichero ejercita esa plomería real —
  // todos estaban el punto de entrada con un `runShell` de prueba. El valor
  // del param contiene `$(...)` (metacaracteres de shell): si el motor
  // cayera a sustitución de texto crudo en vez de indirección por entorno,
  // `sh` evaluaría `$(echo BBB)` ANTES de que `grep` viera nada y el patrón
  // fijo (`-F`) dejaría de encontrar el literal — el guard fallaría en vez
  // de pasar. Mismo patrón que el test de inyección de
  // `tests/runner/shell.test.ts` (paso `shell`), aplicado aquí al camino de
  // producción real de la guarda `shell:`.
  test('sin stub de runShell, el defaultRunShell real pasa el valor por env, no por sustitución de texto (integración)', async () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
when:
  - shell: "echo {{params.texto}} | grep -qF 'AAA$(echo BBB)CCC'"
steps:
  - id: a
    type: shell
    run: 'true'
`);
    const result = await evaluateGuards(p, {
      store,
      params: { texto: 'AAA$(echo BBB)CCC' },
      now: new Date(),
      // Sin `runShell`: se ejercita el `defaultRunShell` real de producción.
    });
    expect(result.pass).toBe(true);
  });
});

describe('evaluateGuards — between', () => {
  test('pasa dentro de la ventana horaria', async () => {
    const result = await evaluateGuards(withGuards('  - between: "07:00-23:00"'), {
      store, params: {}, now: new Date('2026-08-05T12:00:00'),
    });
    expect(result.pass).toBe(true);
  });

  test('bloquea fuera de la ventana horaria', async () => {
    const result = await evaluateGuards(withGuards('  - between: "07:00-23:00"'), {
      store, params: {}, now: new Date('2026-08-05T03:00:00'),
    });
    expect(result.pass).toBe(false);
  });

  test('admite ventanas que cruzan medianoche', async () => {
    const result = await evaluateGuards(withGuards('  - between: "22:00-06:00"'), {
      store, params: {}, now: new Date('2026-08-05T02:00:00'),
    });
    expect(result.pass).toBe(true);
  });
});

describe('evaluateGuards — changed', () => {
  test('pasa cuando hay cambios desde el último run correcto', async () => {
    const run = await store.createRun('demo', 1, {}, new Date('2026-08-05T02:00:00Z'));
    await store.finishRun(run, 'success');
    const result = await evaluateGuards(
      withGuards('  - changed: { path: "{{params.root}}" }'),
      {
        store, params: { root: '/srv/docs' }, now: new Date(),
        gitChangedSince: async () => true,
      },
    );
    expect(result.pass).toBe(true);
  });

  test('bloquea cuando no hay cambios', async () => {
    const run = await store.createRun('demo', 1, {}, new Date('2026-08-05T02:00:00Z'));
    await store.finishRun(run, 'success');
    const result = await evaluateGuards(
      withGuards('  - changed: { path: "{{params.root}}" }'),
      {
        store, params: { root: '/srv/docs' }, now: new Date(),
        gitChangedSince: async () => false,
      },
    );
    expect(result.pass).toBe(false);
  });

  test('pasa cuando nunca hubo un run correcto con el que comparar', async () => {
    const result = await evaluateGuards(
      withGuards('  - changed: { path: "/srv" }'),
      { store, params: {}, now: new Date(), gitChangedSince: async () => false },
    );
    expect(result.pass).toBe(true);
  });

  test('el motivo de fallo usa el texto declarado del guard, no el valor interpolado', async () => {
    const run = await store.createRun('demo', 1, {}, new Date('2026-08-05T02:00:00Z'));
    await store.finishRun(run, 'success');
    const result = await evaluateGuards(
      withGuards('  - changed: { path: "{{params.secret}}" }'),
      {
        store, params: { secret: 'super-secreto' }, now: new Date(),
        gitChangedSince: async () => false,
      },
    );
    expect(result.pass).toBe(false);
    if (!result.pass) {
      expect(result.reason).toContain('{{params.secret}}');
      expect(result.reason).not.toContain('super-secreto');
    }
  });
});

describe('evaluateGuards — combinación', () => {
  test('todas las guardas deben cumplirse', async () => {
    const result = await evaluateGuards(
      withGuards('  - throttle: 4h\n  - shell: "false"'),
      { store, params: {}, now: new Date(), runShell: async () => 1 },
    );
    expect(result.pass).toBe(false);
  });

  test('un pipeline sin guardas siempre pasa', async () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: 'true'
`);
    expect((await evaluateGuards(p, { store, params: {}, now: new Date() })).pass).toBe(true);
  });
});

// Las guardas corren por el mismo `sh -c` que un paso `run:`, así que
// arrastraban el mismo defecto de locale heredado — y de hecho fue una
// guarda, no un paso, la que saltó un pipeline diez noches seguidas en
// producción. Estos dos tests ejercitan el `defaultRunShell` REAL (sin
// inyectar `runShell`), que es donde vive el arreglo.
describe('evaluateGuards — entorno del subproceso (integración)', () => {
  let previous: { lang?: string; lcAll?: string };

  beforeEach(() => {
    previous = { lang: process.env.LANG, lcAll: process.env.LC_ALL };
  });
  afterEach(() => {
    if (previous.lang === undefined) delete process.env.LANG;
    else process.env.LANG = previous.lang;
    if (previous.lcAll === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = previous.lcAll;
  });

  test('una guarda casa `.` contra un carácter multibyte sin locale en el proceso', async () => {
    delete process.env.LANG;
    delete process.env.LC_ALL;
    const result = await evaluateGuards(
      withGuards(`  - shell: "printf 'Última revisió\\\\n' | grep -qE '^.ltima revisi.$'"`),
      { store, params: {}, now: new Date() },
    );
    expect(result.pass).toBe(true);
  });

  test('una guarda no ve una variable del proceso ajena a la base mínima', async () => {
    process.env.AP_VARIABLE_DE_PRUEBA = 'no-deberia-pasar';
    const result = await evaluateGuards(withGuards('  - shell: "test -n \\"$AP_VARIABLE_DE_PRUEBA\\""'), {
      store,
      params: {},
      now: new Date(),
    });
    delete process.env.AP_VARIABLE_DE_PRUEBA;
    expect(result.pass).toBe(false);
  });
});
