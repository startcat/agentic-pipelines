import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root: string;
const CLI = join(import.meta.dir, '..', '..', 'src', 'cli', 'index.ts');

function writePipeline(name: string, yaml: string) {
  mkdirSync(join(root, 'pipelines', name), { recursive: true });
  writeFileSync(join(root, 'pipelines', name, 'pipeline.yaml'), yaml);
}

function latestRunId(pipeline: string): string {
  const entries = readdirSync(join(root, '.runs', pipeline)).sort();
  const last = entries[entries.length - 1];
  if (!last) throw new Error(`no hay runs de "${pipeline}"`);
  return last;
}

async function cli(args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['bun', CLI, ...args], {
    cwd: root,
    env: { ...process.env, ANTHROPIC_API_KEY: 'sk-test' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out: stdout + stderr };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ap-e2e-'));
  writeFileSync(join(root, 'pipelines.yaml'), 'channels: {}\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('localización del repo independiente del directorio de invocación', () => {
  test('--repo apunta a un repo fuera del cwd actual', async () => {
    writePipeline('ok', 'name: ok\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n');
    const elsewhere = mkdtempSync(join(tmpdir(), 'ap-elsewhere-'));
    try {
      const proc = Bun.spawn(['bun', CLI, '--repo', root, 'validate', 'ok'], {
        cwd: elsewhere,
        env: { ...process.env, ANTHROPIC_API_KEY: 'sk-test' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(await proc.exited).toBe(0);
      expect(stdout + stderr).toContain('ok');
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test('PIPELINES_REPO apunta a un repo fuera del cwd actual', async () => {
    writePipeline('ok', 'name: ok\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n');
    const elsewhere = mkdtempSync(join(tmpdir(), 'ap-elsewhere-'));
    try {
      const proc = Bun.spawn(['bun', CLI, 'validate', 'ok'], {
        cwd: elsewhere,
        env: { ...process.env, ANTHROPIC_API_KEY: 'sk-test', PIPELINES_REPO: root },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(await proc.exited).toBe(0);
      expect(stdout + stderr).toContain('ok');
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test('--repo tiene precedencia sobre PIPELINES_REPO', async () => {
    writePipeline('ok', 'name: ok\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n');
    const decoy = mkdtempSync(join(tmpdir(), 'ap-decoy-'));
    writeFileSync(join(decoy, 'pipelines.yaml'), 'channels: {}\n');
    try {
      const proc = Bun.spawn(['bun', CLI, '--repo', root, 'validate', 'ok'], {
        cwd: decoy,
        env: { ...process.env, ANTHROPIC_API_KEY: 'sk-test', PIPELINES_REPO: decoy },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      // Si PIPELINES_REPO (decoy, sin el pipeline "ok") ganara, esto fallaría
      // nombrando los pipelines disponibles de decoy (ninguno).
      expect(await proc.exited).toBe(0);
      expect(stdout + stderr).toContain('ok');
    } finally {
      rmSync(decoy, { recursive: true, force: true });
    }
  });
});

describe('pipelines validate', () => {
  test('sale con 0 en un pipeline correcto', async () => {
    writePipeline('ok', 'name: ok\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n');
    const { code, out } = await cli(['validate', 'ok']);
    expect(code).toBe(0);
    expect(out).toContain('ok');
  });

  test('sale con 1 y explica el problema en un pipeline inválido', async () => {
    writePipeline('malo', 'name: malo\nversion: 1\nsteps: []\n');
    const { code, out } = await cli(['validate', 'malo']);
    expect(code).toBe(1);
    expect(out).toContain('description');
  });

  test('sale con 1 si un prompt referencia un param no declarado', async () => {
    mkdirSync(join(root, 'pipelines', 'con-prompt'), { recursive: true });
    writeFileSync(
      join(root, 'pipelines', 'con-prompt', 'pipeline.yaml'),
      'name: con-prompt\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    agent: w\n    prompt: a.md\n',
    );
    writeFileSync(join(root, 'pipelines', 'con-prompt', 'a.md'), 'Sobre {{params.no_existe}}.');

    const { code, out } = await cli(['validate', 'con-prompt']);
    expect(code).toBe(1);
    expect(out).toContain('a');
    expect(out).toContain('no_existe');
  });

  test('sale con 0 si el prompt solo referencia params/outputs declarados', async () => {
    mkdirSync(join(root, 'pipelines', 'con-prompt-ok'), { recursive: true });
    writeFileSync(
      join(root, 'pipelines', 'con-prompt-ok', 'pipeline.yaml'),
      'name: con-prompt-ok\ndescription: d\nversion: 1\nparams:\n  tema:\n    description: t\nsteps:\n  - id: a\n    agent: w\n    prompt: a.md\n',
    );
    writeFileSync(join(root, 'pipelines', 'con-prompt-ok', 'a.md'), 'Resumen sobre {{params.tema}}.');

    const { code } = await cli(['validate', 'con-prompt-ok']);
    expect(code).toBe(0);
  });

  test('sale con 1 con un mensaje claro si falta el fichero de prompt', async () => {
    mkdirSync(join(root, 'pipelines', 'sin-prompt'), { recursive: true });
    writeFileSync(
      join(root, 'pipelines', 'sin-prompt', 'pipeline.yaml'),
      'name: sin-prompt\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    agent: w\n    prompt: no-existe.md\n',
    );

    const { code, out } = await cli(['validate', 'sin-prompt']);
    expect(code).toBe(1);
    expect(out).toContain('a');
    expect(out).toContain('no-existe.md');
  });

  test('sale con 1 si un paso always referencia un paso inexistente', async () => {
    writePipeline(
      'con-always-malo',
      'name: con-always-malo\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\nalways:\n  - id: cleanup\n    run: "git -C {{fantasma.path}} reset --hard"\n',
    );

    const { code, out } = await cli(['validate', 'con-always-malo']);
    expect(code).toBe(1);
    expect(out).toContain('cleanup');
    expect(out).toContain('fantasma');
  });

  test('sale con 1 si un paso always referencia un param no declarado', async () => {
    writePipeline(
      'con-always-param-malo',
      'name: con-always-param-malo\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\nalways:\n  - id: cleanup\n    run: "echo {{params.no_existe}}"\n',
    );

    const { code, out } = await cli(['validate', 'con-always-param-malo']);
    expect(code).toBe(1);
    expect(out).toContain('cleanup');
    expect(out).toContain('no_existe');
  });

  test('sale con 1 si notify.channel no existe en pipelines.yaml', async () => {
    writePipeline(
      'con-notify-fantasma',
      'name: con-notify-fantasma\ndescription: d\nversion: 1\nnotify:\n  on: [success]\n  channel: ghost\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );

    const { code, out } = await cli(['validate', 'con-notify-fantasma']);
    expect(code).toBe(1);
    expect(out).toContain('ghost');
  });
});

describe('pipelines run', () => {
  test('ejecuta y deja el registro en .runs/', async () => {
    // Una versión anterior usaba `run: 'echo {"n":1}'`: un escalar YAML de
    // comilla simple cuyo contenido pasa TAL CUAL a `sh -c`. Ahí, las
    // comillas dobles sin proteger son sintaxis de shell (se comen a sí
    // mismas) y el stdout real es `{n:1}`, JSON inválido — comprobado
    // reproduciendo el fallo antes de este arreglo. `tests/runner/shell.test.ts`
    // ya documenta y evita este mismo problema
    // envolviendo el JSON en comillas simples adicionales para que sobrevivan
    // al shell; se aplica aquí el mismo patrón.
    writePipeline(
      'demo',
      'name: demo\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "echo \'{\\"n\\":1}\'"\n    outputs: { n: number }\n',
    );
    const { code } = await cli(['run', 'demo']);
    expect(code).toBe(0);
    const { out } = await cli(['status', 'demo']);
    expect(out).toContain('success');
  });

  // `run --force` existe porque verificar el motor en vivo exigía esperar a
  // que la guarda dejara de morder: con `throttle: 46h` sobre un cron diario,
  // una comprobación a mano se saltaba y no había forma de decir "ya lo sé,
  // ejecútalo igual". Que el registro quede marcado es la otra mitad: un run
  // forzado NO demuestra que las guardas habrían dejado pasar, y el historial
  // no debe poder confundirse con uno que pasó por su propio pie.
  test('--force ejecuta pese a una guarda que falla, y marca el run como forzado', async () => {
    writePipeline(
      'demo-force',
      'name: demo-force\ndescription: d\nversion: 1\nwhen:\n  - shell: "false"\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );
    const { code } = await cli(['run', 'demo-force', '--force']);
    expect(code).toBe(0);
    const run = JSON.parse(
      await Bun.file(join(root, '.runs', 'demo-force', latestRunId('demo-force'), 'run.json')).text(),
    );
    expect(run.status).toBe('success');
    expect(run.forced).toBe(true);
  });

  test('un run normal no lleva la marca de forzado', async () => {
    writePipeline(
      'demo-normal',
      'name: demo-normal\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );
    expect((await cli(['run', 'demo-normal'])).code).toBe(0);
    const run = JSON.parse(
      await Bun.file(join(root, '.runs', 'demo-normal', latestRunId('demo-normal'), 'run.json')).text(),
    );
    expect(run.status).toBe('success');
    expect(run.forced).toBeUndefined();
  });

  test('status señala los runs forzados', async () => {
    writePipeline(
      'demo-marca',
      'name: demo-marca\ndescription: d\nversion: 1\nwhen:\n  - shell: "false"\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );
    await cli(['run', 'demo-marca', '--force']);
    const { out } = await cli(['status', 'demo-marca']);
    expect(out).toContain('(guardas omitidas)');
  });

  test('un run saltado sale con código 0 y se marca skipped', async () => {
    writePipeline(
      'saltado',
      'name: saltado\ndescription: d\nversion: 1\nwhen:\n  - shell: "false"\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );
    const { code, out } = await cli(['run', 'saltado']);
    expect(code).toBe(0);
    expect(out).toContain('saltado');
  });

  test('un fallo de paso sale con código 1', async () => {
    writePipeline('falla', 'name: falla\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: exit 1\n');
    const { code } = await cli(['run', 'falla']);
    expect(code).toBe(1);
  });

  test('falla antes de ejecutar si falta un param obligatorio', async () => {
    writePipeline(
      'conparam',
      'name: conparam\ndescription: d\nversion: 1\nparams:\n  ruta:\n    description: r\n    required: true\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );
    const { code, out } = await cli(['run', 'conparam']);
    expect(code).toBe(1);
    expect(out).toContain('ruta');
  });

  test('--set proporciona el param que falta', async () => {
    writePipeline(
      'conparam',
      'name: conparam\ndescription: d\nversion: 1\nparams:\n  ruta:\n    description: r\n    required: true\nsteps:\n  - id: a\n    type: shell\n    run: echo {{params.ruta}}\n',
    );
    const { code } = await cli(['run', 'conparam', '--set', 'ruta=/tmp']);
    expect(code).toBe(0);
  });
});

describe('pipelines doctor', () => {
  test('informa de una dependencia ausente y sale con 1', async () => {
    writePipeline(
      'necesita',
      'name: necesita\ndescription: d\nversion: 1\nrequires:\n  bin: [binario-que-no-existe-xyz]\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );
    const { code, out } = await cli(['doctor', 'necesita']);
    expect(code).toBe(1);
    expect(out).toContain('binario-que-no-existe-xyz');
  });
});

describe('pipelines show', () => {
  test('imprime el run completo en JSON', async () => {
    writePipeline(
      'demo',
      'name: demo\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "echo \'{\\"n\\":1}\'"\n    outputs: { n: number }\n',
    );
    const { code: runCode } = await cli(['run', 'demo']);
    expect(runCode).toBe(0);
    const runId = latestRunId('demo');

    const { code, out } = await cli(['show', 'demo', runId]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.id).toBe(runId);
    expect(parsed.status).toBe('success');
    expect(parsed.steps.a.outputs).toEqual({ n: 1 });
  });

  test('con un tercer argumento imprime solo ese paso', async () => {
    writePipeline(
      'demo',
      'name: demo\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "echo \'{\\"n\\":1}\'"\n    outputs: { n: number }\n',
    );
    await cli(['run', 'demo']);
    const runId = latestRunId('demo');

    const { code, out } = await cli(['show', 'demo', runId, 'a']);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed).toEqual(
      expect.objectContaining({ id: 'a', status: 'success', outputs: { n: 1 } }),
    );
  });

  test('un paso inexistente imprime un objeto vacío, no falla', async () => {
    writePipeline('demo', 'name: demo\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n');
    await cli(['run', 'demo']);
    const runId = latestRunId('demo');

    const { code, out } = await cli(['show', 'demo', runId, 'no-existe']);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({});
  });

  test('un run-id inexistente sale con 1 y un mensaje', async () => {
    writePipeline('demo', 'name: demo\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n');
    const { code, out } = await cli(['show', 'demo', '2020-01-01T00-00-00-000Z']);
    expect(code).toBe(1);
    expect(out).toContain('2020-01-01T00-00-00-000Z');
  });
});

describe('notify: se ejecuta de verdad', () => {
  test('un run success con notify.on: [success] invoca el canal', async () => {
    writeFileSync(
      join(root, 'pipelines.yaml'),
      `channels:\n  marker:\n    type: shell\n    run: "echo $PIPELINES_NOTIFY_STATUS > notify-marker.txt"\n`,
    );
    writePipeline(
      'demo',
      'name: demo\ndescription: d\nversion: 1\nnotify:\n  on: [success]\n  channel: marker\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );
    const { code } = await cli(['run', 'demo']);
    expect(code).toBe(0);
    expect(await Bun.file(join(root, 'notify-marker.txt')).text()).toBe('success\n');
  });

  test('el run.json guarda el rastro del canal: código y salida', async () => {
    writeFileSync(
      join(root, 'pipelines.yaml'),
      `channels:\n  marker:\n    type: shell\n    run: "echo enviat-$PIPELINES_NOTIFY_STATUS; echo detall >&2"\n`,
    );
    writePipeline(
      'demo',
      'name: demo\ndescription: d\nversion: 1\nnotify:\n  on: [success]\n  channel: marker\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );
    const { code } = await cli(['run', 'demo']);
    expect(code).toBe(0);
    const runsDir = join(root, '.runs', 'demo');
    const [runId] = readdirSync(runsDir).filter((d) => !d.startsWith('.'));
    const record = JSON.parse(readFileSync(join(runsDir, runId!, 'run.json'), 'utf8'));
    expect(record.notify).toMatchObject({ channel: 'marker', code: 0 });
    expect(record.notify.log).toContain('enviat-success');
    expect(record.notify.log).toContain('detall');
  });

  test('un canal que falla también deja su rastro en run.json', async () => {
    writeFileSync(
      join(root, 'pipelines.yaml'),
      `channels:\n  roto:\n    type: shell\n    run: "echo motiu-del-canal >&2; exit 3"\n`,
    );
    writePipeline(
      'demo',
      'name: demo\ndescription: d\nversion: 1\nnotify:\n  on: [success]\n  channel: roto\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );
    const { code } = await cli(['run', 'demo']);
    expect(code).toBe(0);
    const runsDir = join(root, '.runs', 'demo');
    const [runId] = readdirSync(runsDir).filter((d) => !d.startsWith('.'));
    const record = JSON.parse(readFileSync(join(runsDir, runId!, 'run.json'), 'utf8'));
    expect(record.notify).toMatchObject({ channel: 'roto', code: 3 });
    expect(record.notify.log).toContain('motiu-del-canal');
  });

  test('un run failed con notify.on: [success] no invoca el canal', async () => {
    writeFileSync(
      join(root, 'pipelines.yaml'),
      `channels:\n  marker:\n    type: shell\n    run: "echo tocado > notify-marker.txt"\n`,
    );
    writePipeline(
      'demo',
      'name: demo\ndescription: d\nversion: 1\nnotify:\n  on: [success]\n  channel: marker\nsteps:\n  - id: a\n    type: shell\n    run: exit 1\n',
    );
    const { code } = await cli(['run', 'demo']);
    expect(code).toBe(1);
    expect(await Bun.file(join(root, 'notify-marker.txt')).exists()).toBe(false);
  });

  test('un fallo del propio canal no cambia el exit code del run', async () => {
    writeFileSync(
      join(root, 'pipelines.yaml'),
      `channels:\n  roto:\n    type: shell\n    run: "exit 1"\n`,
    );
    writePipeline(
      'demo',
      'name: demo\ndescription: d\nversion: 1\nnotify:\n  on: [success]\n  channel: roto\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );
    const { code, out } = await cli(['run', 'demo']);
    expect(code).toBe(0);
    expect(out).toContain('notify falló');
  });
});

describe('validate — referencias de steps[].cwd/additional_dirs/when', () => {
  test('un {{secrets.X}} en additional_dirs hace fallar validate', async () => {
    writeFileSync(join(root, '.env'), 'API_KEY=una-clave-larga-de-verdad\n');
    writePipeline(
      'demo',
      'name: demo\ndescription: d\nversion: 1\nrequires:\n  env: [API_KEY]\nsteps:\n  - id: a\n    agent: writer\n    prompt: p.md\n    additional_dirs: ["{{secrets.API_KEY}}"]\n',
    );
    writeFileSync(join(root, 'pipelines', 'demo', 'p.md'), 'prompt');
    const { code, out } = await cli(['validate', 'demo']);
    expect(code).toBe(1);
    expect(out).toContain('additional_dirs');
  });
});

// Un chequeo `mcp-schema` (deriva de esquema de un servidor MCP) es
// puramente informativo de `doctor` — nunca debió bloquear `run`. Antes de
// este arreglo, `run` y `doctor` compartían literalmente `preflight()` y el
// mismo criterio de gating (`!report.ok`).
//
// El "servidor MCP" real de estos dos tests es un script propio que habla el
// JSON-RPC mínimo que `listMcpToolsViaStdio` necesita, sin depender de
// `npx`/`@playwright/mcp` reales ni de red — determinista y rápido. Su
// `tools/list` devuelve `browser_take_screenshot` SIN el campo `filename`
// (el único que `TOOL_FS_PROFILES` vigila para esa tool), así que el
// chequeo `mcp-schema` falla siempre, de forma predecible.
describe('run vs. doctor — un fallo mcp-schema no bloquea run, pero sí doctor', () => {
  function writeFakeMcpServer(): string {
    const path = join(root, 'fake-mcp-server.js');
    writeFileSync(
      path,
      `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [{
            name: 'browser_take_screenshot',
            // Sin 'filename' a propósito: el único campo que TOOL_FS_PROFILES
            // vigila para esta tool — dispara mcp-schema: ok:false siempre.
            inputSchema: { properties: { element: {}, target: {}, type: {}, fullPage: {}, scale: {} } },
          }],
        },
      }) + '\\n');
    }
  }
});
`,
    );
    return path;
  }

  function writeDriftPipeline(scriptPath: string) {
    writePipeline(
      'demo',
      `name: demo\ndescription: d\nversion: 1\n` +
        // Guarda siempre falsa: si \`run\` llega a evaluarla (en vez de
        // cortar antes en preflight), la observable es un run 'skipped',
        // no una ejecución real del paso agent — así este test no depende
        // de la SDK real ni de red para demostrar que preflight no bloqueó.
        `when:\n  - shell: "false"\n` +
        `mcp_servers:\n  pw:\n    command: bun\n    args: ["${scriptPath}"]\n    kind: playwright\n` +
        `steps:\n  - id: a\n    agent: writer\n    prompt: p.md\n    mcp_servers: [pw]\n    tools: [mcp__pw__browser_take_screenshot]\n`,
    );
  }

  test('run: un fallo mcp-schema en solitario no bloquea — el run llega a evaluarse (se salta por la guarda, no por preflight)', async () => {
    const scriptPath = writeFakeMcpServer();
    writeDriftPipeline(scriptPath);
    const { code, out } = await cli(['run', 'demo']);
    // Antes del arreglo: "Faltan dependencias — no se ejecuta nada.", código 1,
    // NINGÚN run creado — preflight cortaba antes de llegar a la guarda.
    expect(code).toBe(0);
    expect(out).toContain('saltado');
    expect(out).not.toContain('Faltan dependencias');
    // El aviso no bloqueante sigue siendo visible para quien opera el pipeline.
    expect(out).toContain('aviso');
    expect(out).toContain('mcp-schema');
  });

  test('doctor: el mismo fallo mcp-schema SÍ bloquea — comportamiento sin cambios', async () => {
    const scriptPath = writeFakeMcpServer();
    writeDriftPipeline(scriptPath);
    const { code, out } = await cli(['doctor', 'demo']);
    expect(code).toBe(1);
    expect(out).toContain('mcp-schema');
    expect(out).toContain('pw');
    expect(out).toContain('no se ejecutará');
  });
});

// Diez noches seguidas de `skipped` sin que nadie se enterara: `dispatchNotify`
// solo se invocaba en el camino de fin normal, así que el guard-skip y el
// lock-blocked cerraban el run y salían en silencio. Ahora notifican todos los
// caminos, y es el pipeline quien decide con `on:`/`stale_after` si eso genera
// ruido o no.
describe('notify: en los caminos que saltan el run', () => {
  test('un run saltado por guarda invoca el canal si el pipeline está stale', async () => {
    writeFileSync(
      join(root, 'pipelines.yaml'),
      `channels:\n  marker:\n    type: shell\n    run: "echo $PIPELINES_NOTIFY_STATUS/$PIPELINES_NOTIFY_STALE > notify-marker.txt"\n`,
    );
    writePipeline(
      'demo',
      'name: demo\ndescription: d\nversion: 1\nnotify:\n  on: [success, failed]\n  stale_after: 72h\n  channel: marker\nwhen:\n  - shell: "false"\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );

    const { code } = await cli(['run', 'demo']);
    expect(code).toBe(0);
    expect(await Bun.file(join(root, 'notify-marker.txt')).text()).toBe('skipped/1\n');
  });

  test('un run saltado por guarda NO invoca el canal si el pipeline no declara stale_after', async () => {
    writeFileSync(
      join(root, 'pipelines.yaml'),
      `channels:\n  marker:\n    type: shell\n    run: "echo tocado > notify-marker.txt"\n`,
    );
    writePipeline(
      'demo',
      'name: demo\ndescription: d\nversion: 1\nnotify:\n  on: [success, failed]\n  channel: marker\nwhen:\n  - shell: "false"\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );

    await cli(['run', 'demo']);
    expect(await Bun.file(join(root, 'notify-marker.txt')).exists()).toBe(false);
  });

  test('un run correcto apaga el aviso de stale aunque el pipeline lo declare', async () => {
    writeFileSync(
      join(root, 'pipelines.yaml'),
      `channels:\n  marker:\n    type: shell\n    run: "echo $PIPELINES_NOTIFY_STATUS/$PIPELINES_NOTIFY_STALE > notify-marker.txt"\n`,
    );
    writePipeline(
      'demo',
      'name: demo\ndescription: d\nversion: 1\nnotify:\n  on: [success]\n  stale_after: 72h\n  channel: marker\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );

    await cli(['run', 'demo']);
    expect(await Bun.file(join(root, 'notify-marker.txt')).text()).toBe('success/\n');
  });
});
