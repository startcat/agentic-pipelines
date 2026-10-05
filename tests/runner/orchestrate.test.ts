import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePipeline } from '../../src/schema/pipeline.ts';
import { RunStore } from '../../src/runs/store.ts';
import { interpolate, type InterpolationScope } from '../../src/params/resolve.ts';
import { runPipeline, type RunOptions } from '../../src/runner/orchestrate.ts';

let root: string;
let store: RunStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ap-orch-'));
  store = new RunStore(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (yaml: string, extra: Record<string, unknown> = {}) =>
  runPipeline({
    pipeline: parsePipeline(yaml),
    repoRoot: root,
    store,
    params: {},
    secrets: {},
    ...extra,
  });

describe('runPipeline — camino feliz', () => {
  test('ejecuta los pasos en orden y termina en success', async () => {
    const record = await run(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: echo '{"n":1}'
    outputs: { n: number }
  - id: b
    type: shell
    run: 'echo recibido-{{a.n}}'
`);
    expect(record.status).toBe('success');
    expect(record.steps.a!.outputs).toEqual({ n: 1 });
    expect(record.steps.b!.status).toBe('success');
  });
});

describe('runPipeline — políticas de error', () => {
  test('on_error stop detiene el run y marca failed', async () => {
    const record = await run(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: exit 1
  - id: b
    type: shell
    run: 'true'
`);
    expect(record.status).toBe('failed');
    expect(record.steps.a!.status).toBe('failed');
    expect(record.steps.b).toBeUndefined();
  });

  test('on_error continue sigue con el paso siguiente', async () => {
    const record = await run(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: exit 1
    on_error: continue
  - id: b
    type: shell
    run: 'true'
`);
    expect(record.steps.a!.status).toBe('failed');
    expect(record.steps.b!.status).toBe('success');
    // El único fallo de este run declaró on_error: continue — tolerado
    // explícitamente por el propio pipeline, así que el agregado del run
    // es success. El paso en sí sigue registrado como failed (línea de
    // arriba): el detalle no se pierde, solo cambia el agregado.
    expect(record.status).toBe('success');
  });

  test('un fallo con on_error stop mezclado con uno continue sigue marcando el run failed', async () => {
    const record = await run(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: exit 1
    on_error: continue
  - id: b
    type: shell
    run: exit 1
`);
    expect(record.steps.a!.status).toBe('failed');
    expect(record.steps.b!.status).toBe('failed');
    expect(record.status).toBe('failed');
  });

  test('varios fallos, todos on_error continue, dejan el run en success', async () => {
    const record = await run(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: exit 1
    on_error: continue
  - id: b
    type: shell
    run: exit 1
    on_error: continue
  - id: c
    type: shell
    run: 'true'
`);
    expect(record.steps.a!.status).toBe('failed');
    expect(record.steps.b!.status).toBe('failed');
    expect(record.steps.c!.status).toBe('success');
    expect(record.status).toBe('success');
  });

  test('retry no reintenta un fallo NO transitorio', async () => {
    const record = await run(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: exit 1
    retry: 3
`);
    expect(record.steps.a!.attempts).toBe(1);
  });

  test('retry con on: any reintenta hasta agotar los intentos', async () => {
    const waits: number[] = [];
    const record = await run(
      `
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: exit 1
    retry: { attempts: 2, on: any }
`,
      { sleepFn: async (ms: number) => { waits.push(ms); } },
    );
    expect(record.steps.a!.attempts).toBe(3);
    expect(record.steps.a!.status).toBe('failed');
    // Backoff exponencial: 1s y 2s, sin esperar de verdad en el test.
    expect(waits).toEqual([1000, 2000]);
  });
});

describe('runPipeline — errores de interpolación no abortan el run', () => {
  // `interpolate()` (params/resolve.ts) lanza si una referencia `{{...}}`
  // no se puede resolver, y ni runShellStep ni runAgentStep la capturan: es
  // responsabilidad del orquestador convertir esa excepción en un fallo de
  // paso, no dejar que aborte runPipeline entero con un rechazo sin
  // capturar.
  test('una referencia sin resolver falla solo el paso, runPipeline no rechaza', async () => {
    const record = await run(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: echo {{params.no_declarado}}
`);
    expect(record.status).toBe('failed');
    expect(record.steps.a!.status).toBe('failed');
    expect(record.steps.a!.error).toContain('no_declarado');
  });
});

describe('runPipeline — cascada de saltos', () => {
  test('un when falso salta el paso y sus dependientes', async () => {
    const record = await run(`
name: demo
description: d
version: 1
steps:
  - id: scan
    type: shell
    run: echo '{"count":0}'
    outputs: { count: number }
  - id: draft
    type: shell
    run: echo '{"url":"x"}'
    when: "{{scan.count}} > 0"
    outputs: { url: string }
  - id: notify
    type: shell
    run: echo {{draft.url}}
`);
    expect(record.steps.scan!.status).toBe('success');
    expect(record.steps.draft!.status).toBe('skipped');
    expect(record.steps.notify!.status).toBe('skipped');
    expect(record.steps.notify!.skipReason).toContain('draft');
    expect(record.status).toBe('success');
  });

  test('un paso independiente no se ve afectado por el salto de otro', async () => {
    const record = await run(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: echo '{"n":0}'
    outputs: { n: number }
  - id: b
    type: shell
    run: 'true'
    when: "{{a.n}} > 0"
  - id: c
    type: shell
    run: 'true'
`);
    expect(record.steps.b!.status).toBe('skipped');
    expect(record.steps.c!.status).toBe('success');
  });

  test('un fallo con on_error continue también salta a los dependientes', async () => {
    const record = await run(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: exit 1
    on_error: continue
    outputs: { n: number }
  - id: b
    type: shell
    run: echo {{a.n}}
  - id: c
    type: shell
    run: 'true'
`);
    expect(record.steps.b!.status).toBe('skipped');
    expect(record.steps.c!.status).toBe('success');
  });

  test('la cascada es transitiva: el dependiente de un dependiente también se salta', async () => {
    // a falla -> b se salta en cascada (depende de a) -> c se salta en
    // cascada (depende de b, no de a directamente). c nunca aparece en
    // graph.dependents.get('a'), solo en graph.dependents.get('b'): si el
    // salto no se propagara de verdad nivel a nivel, c se ejecutaría.
    const record = await run(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: exit 1
    on_error: continue
    outputs: { n: number }
  - id: b
    type: shell
    run: echo '{"n":1}'
    inputs: ["a.n"]
    outputs: { n: number }
  - id: c
    type: shell
    run: 'true'
    inputs: ["b.n"]
`);
    expect(record.steps.a!.status).toBe('failed');
    expect(record.steps.b!.status).toBe('skipped');
    expect(record.steps.b!.skipReason).toContain('a');
    expect(record.steps.c!.status).toBe('skipped');
    expect(record.steps.c!.skipReason).toContain('b');
  });
});

describe('runPipeline — reanudación', () => {
  test('resume no re-ejecuta los pasos ya completados', async () => {
    // El paso `a` deja una marca cada vez que se ejecuta. Tras reanudar,
    // el contador debe seguir teniendo una sola marca.
    const counter = join(root, 'contador.txt');
    const yaml = (bCommand: string) => `
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: printf x >> ${counter}; echo '{"n":1}'
    outputs: { n: number }
  - id: b
    type: shell
    run: ${bCommand}
`;

    const first = await run(yaml('exit 1'));
    expect(first.status).toBe('failed');
    expect(await Bun.file(counter).text()).toBe('x');

    // Nota: `bCommand` se inserta como escalar YAML sin comillas. Un
    // `true`/`false` desnudo ahí lo parsearía el YAML como booleano (mismo
    // tipo de defecto señalado para `retry: { ..., on: any }`) y `run:
    // z.string()` lo rechazaría antes de llegar a ejecutarse. `exit 0` no
    // colisiona con ninguna palabra clave de YAML.
    const resumed = await runPipeline({
      pipeline: parsePipeline(yaml('exit 0')),
      repoRoot: root, store, params: {}, secrets: {}, resumeFrom: first,
    });

    expect(resumed.status).toBe('success');
    expect(resumed.steps.a!.outputs).toEqual({ n: 1 });
    expect(await Bun.file(counter).text()).toBe('x');
  });

  test('resume rechaza un run de otra versión del pipeline', async () => {
    const first = await run(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: exit 1
`);
    await expect(
      runPipeline({
        pipeline: parsePipeline(`
name: demo
description: d
version: 2
steps:
  - id: a
    type: shell
    run: 'true'
`),
        repoRoot: root, store, params: {}, secrets: {}, resumeFrom: first,
      }),
    ).rejects.toThrow(/versión/);
  });

  test('resume puede desbloquear pasos que antes se saltaron por cascada', async () => {
    const yaml = (aCommand: string) => `
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: ${aCommand}
    on_error: continue
    outputs: { n: number }
  - id: b
    type: shell
    run: echo '{"n":1}'
    inputs: ["a.n"]
    outputs: { n: number }
  - id: c
    type: shell
    run: 'true'
    inputs: ["b.n"]
`;

    const first = await run(yaml('exit 1'));
    // Único fallo del run: on_error: continue en "a" — tolerado, el
    // agregado es success aunque b/c se saltaran en cascada.
    expect(first.status).toBe('success');
    expect(first.steps.a!.status).toBe('failed');
    expect(first.steps.b!.status).toBe('skipped');
    expect(first.steps.c!.status).toBe('skipped');

    // `aCommand` se inserta como escalar YAML sin comillas: se escribe
    // directamente con comillas simples reales alrededor del JSON (en vez
    // de comillas dobles sin envolver) para que `sh` no se las coma — mismo
    // defecto que shell.test.ts ya documenta para `runShellStep`.
    const resumed = await runPipeline({
      pipeline: parsePipeline(yaml(`echo '{"n":1}'`)),
      repoRoot: root, store, params: {}, secrets: {}, resumeFrom: first,
    });

    expect(resumed.status).toBe('success');
    expect(resumed.steps.a!.status).toBe('success');
    expect(resumed.steps.b!.status).toBe('success');
    expect(resumed.steps.c!.status).toBe('success');
    // El run original no debe quedar mutado por la reanudación. (Y, con el
    // criterio nuevo, nunca fue 'failed' — su único fallo fue tolerado.)
    expect(first.status).toBe('success');
    expect(first.steps.b!.status).toBe('skipped');
  });

  test('resume acumula el coste de un paso previo y uno nuevo, a través de la rama agent (prompt real + agentRunner inyectado)', async () => {
    // Único test de este bloque que ejercita la rama `agent` de `executeOnce`:
    // lee un fichero de prompt real de disco (no se stubea esa lectura) y
    // pasa por un `agentRunner` inyectado — sin red, sin SDK real.
    const pipelineDir = join(root, 'pipelines', 'demo');
    mkdirSync(pipelineDir, { recursive: true });
    writeFileSync(join(pipelineDir, 'a.md'), 'Preséntate.');
    writeFileSync(join(pipelineDir, 'b.md'), 'Resumen sobre {{params.tema}}.');

    const pipeline = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: agent
    agent: worker
    prompt: a.md
  - id: b
    type: agent
    agent: worker
    prompt: b.md
`);

    let bShouldFail = true;
    let capturedPromptText: string | undefined;
    let capturedScope: InterpolationScope | undefined;

    const agentRunner: NonNullable<RunOptions['agentRunner']> = async (step, ctx) => {
      if (step.id === 'a') {
        // Paso previo al resume: siempre tiene éxito, con un coste fijo.
        return { ok: true, outputs: {}, log: '', durationMs: 1, costUsd: 0.5 };
      }
      // Paso 'b': se captura lo que de verdad recibió el runner, para
      // probar que orchestrate.ts leyó el fichero real de disco y montó el
      // scope correcto — no solo que "pasa por la rama agent".
      capturedPromptText = ctx.promptText;
      capturedScope = ctx.scope;
      if (bShouldFail) {
        return { ok: false, error: 'fallo simulado', transient: false, log: '', durationMs: 1 };
      }
      // Paso nuevo, ejecutado solo en la reanudación: coste distinto.
      return { ok: true, outputs: {}, log: '', durationMs: 1, costUsd: 0.25 };
    };

    const first = await runPipeline({
      pipeline, repoRoot: root, store, params: { tema: 'pruebas' }, secrets: {}, agentRunner,
    });
    expect(first.status).toBe('failed');
    expect(first.steps.a!.status).toBe('success');
    expect(first.steps.a!.costUsd).toBe(0.5);
    expect(first.steps.b!.status).toBe('failed');

    bShouldFail = false;
    const resumed = await runPipeline({
      pipeline, repoRoot: root, store, params: { tema: 'pruebas' }, secrets: {},
      resumeFrom: first, agentRunner,
    });

    expect(resumed.status).toBe('success');
    expect(resumed.steps.b!.status).toBe('success');
    // 'a' no se re-ejecuta: su coste es el heredado del run anterior.
    expect(resumed.steps.a!.costUsd).toBe(0.5);
    // 'b' sí se re-ejecuta en esta pasada: coste nuevo.
    expect(resumed.steps.b!.costUsd).toBe(0.25);
    // El coste de un paso previo (nunca re-ejecutado) y el de uno nuevo se
    // suman en el total: ni se resetea el histórico ni se pierde el nuevo.
    expect(resumed.totalCostUsd).toBe(0.75);

    // El texto del prompt es exactamente el contenido leído de disco (sin
    // interpolar: eso es responsabilidad del runner, no de orchestrate.ts),
    // y el scope que recibió el runner permite reconstruirlo interpolado
    // con la misma función que usa runAgentStep — prueba que la lectura del
    // fichero y el scope realmente llegaron bien a la rama agent.
    expect(capturedPromptText).toBe('Resumen sobre {{params.tema}}.');
    expect(interpolate(capturedPromptText!, capturedScope!)).toBe('Resumen sobre pruebas.');
  });
});

// Regresión: `runAgentStep` calculaba `AgentOutcome.denials` correctamente
// pero `runPipeline` nunca lo copiaba al `StepRecord`
// persistido — el `const record: StepRecord = { ... }` de este módulo no lo
// referenciaba, y `StepRecord` ni siquiera declaraba el campo. El resultado:
// una denegación real del hook PreToolUse desaparecía sin dejar rastro
// entre el valor de retorno de `runAgentStep` y `.runs/`, invisible vía
// `pipelines show` — justo lo que tiene que ser visible. Este
// test ejercita el camino completo (agentRunner inyectado -> runPipeline ->
// store.writeStep -> disco) en vez de solo construir un StepRecord a mano,
// para que una futura regresión de este mismo tipo (un campo de
// AgentOutcome que deja de llegar al record persistido) la detecte esta
// suite, no una ejecución real contra un pipeline en producción.
describe('runPipeline — persistencia de denials de un paso agent', () => {
  test('una denegación del hook PreToolUse sobrevive hasta el StepRecord leído de disco', async () => {
    const pipelineDir = join(root, 'pipelines', 'demo');
    mkdirSync(pipelineDir, { recursive: true });
    writeFileSync(join(pipelineDir, 'a.md'), 'Escanea el repo.');

    const pipeline = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: agent
    agent: worker
    prompt: a.md
`);

    const agentRunner: NonNullable<RunOptions['agentRunner']> = async () => ({
      ok: true,
      outputs: {},
      log: '',
      durationMs: 1,
      denials: [
        { toolName: 'Read', toolUseId: 't1', reason: 'fuera de cwd', source: 'both' },
      ],
    });

    const record = await runPipeline({
      pipeline, repoRoot: root, store, params: {}, secrets: {}, agentRunner,
    });

    // 1. El RunRecord que runPipeline devuelve ya lo lleva (store.writeStep
    //    muta run.steps in situ antes de persistir).
    expect(record.steps.a!.denials).toEqual([
      { toolName: 'Read', toolUseId: 't1', reason: 'fuera de cwd', source: 'both' },
    ]);

    // 2. Y, más importante — lo que de verdad se escribió en `.runs/` y es
    //    lo que `pipelines show` acaba leyendo: un StepRecord recién leído
    //    de disco (no el objeto en memoria) también lo conserva.
    const reread = await store.readRun(pipeline.name, record.id);
    expect(reread?.steps.a!.denials).toEqual([
      { toolName: 'Read', toolUseId: 't1', reason: 'fuera de cwd', source: 'both' },
    ]);
  });

  test('un paso shell (sin hook) no lleva denials en su StepRecord', async () => {
    const record = await run(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: echo ok
`);
    expect(record.steps.a!.denials).toBeUndefined();
  });
});

describe('runPipeline — aislamiento de secretos', () => {
  test('los secretos llegan al paso pero no al log del run', async () => {
    const record = await run(
      `
name: demo
description: d
version: 1
requires:
  env: [MY_TOKEN]
steps:
  - id: a
    type: shell
    run: echo "token=$MY_TOKEN"
`,
      { secrets: { MY_TOKEN: 'valor-secretisimo' } },
    );
    expect(record.steps.a!.status).toBe('success');
    const log = await Bun.file(join(root, '.runs', 'demo', record.id, 'a.log')).text();
    expect(log).not.toContain('valor-secretisimo');
    expect(log).toContain('«redactado»');
  });
});

describe('runPipeline — always', () => {
  test('un paso always corre tras un fallo y no afecta el estado del run', async () => {
    const marker = join(root, 'marker.txt');
    const record = await run(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: exit 1
always:
  - id: cleanup
    run: printf hecho > ${marker}
`);
    expect(record.status).toBe('failed');
    expect(record.steps.cleanup!.status).toBe('success');
    expect(await Bun.file(marker).text()).toBe('hecho');
  });

  test('un paso always corre también cuando el run tiene éxito', async () => {
    const record = await run(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: 'true'
always:
  - id: cleanup
    run: 'true'
`);
    expect(record.status).toBe('success');
    expect(record.steps.cleanup!.status).toBe('success');
  });

  test('el fallo de un paso always no cambia el estado del run', async () => {
    const record = await run(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: 'true'
always:
  - id: cleanup
    run: exit 1
`);
    expect(record.status).toBe('success');
    expect(record.steps.cleanup!.status).toBe('failed');
  });

  test('varios pasos always corren todos aunque uno falle', async () => {
    const record = await run(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: 'true'
always:
  - id: cleanup-1
    run: exit 1
  - id: cleanup-2
    run: 'true'
`);
    expect(record.steps['cleanup-1']!.status).toBe('failed');
    expect(record.steps['cleanup-2']!.status).toBe('success');
  });
});
