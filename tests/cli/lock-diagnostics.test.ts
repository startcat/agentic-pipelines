import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, readLock, releaseLock } from '../../src/guards/lock.ts';
import { RunStore } from '../../src/runs/store.ts';

// Cobertura de los dos diagnósticos de lock de la CLI (lock ocupado y lock
// dañado) y de dos garantías más: que `resume` también tome el lock, y
// que el propio proceso libere el lock al ser interrumpido.

let root: string;
const CLI = join(import.meta.dir, '..', '..', 'src', 'cli', 'index.ts');

function writePipeline(name: string, yaml: string): void {
  mkdirSync(join(root, 'pipelines', name), { recursive: true });
  writeFileSync(join(root, 'pipelines', name, 'pipeline.yaml'), yaml);
}

// Anotado con los mismos literales pasados a `Bun.spawn` más abajo: sin
// instanciar sus parámetros genéricos, `stdout`/`stderr` quedarían tipados
// como `number | ReadableStream | undefined` en vez de `ReadableStream`
// (mismo problema ya documentado en `src/runner/shell.ts`).
function spawnCli(args: string[]): Bun.Subprocess<'ignore', 'pipe', 'pipe'> {
  return Bun.spawn(['bun', CLI, ...args], {
    cwd: root,
    env: { ...process.env, ANTHROPIC_API_KEY: 'sk-test' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

async function cli(args: string[]): Promise<{ code: number; out: string }> {
  const proc = spawnCli(args);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out: stdout + stderr };
}

/** Espera hasta que `predicate` sea verdadero, sin una espera fija. */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error('timeout esperando la condición');
}

function latestRunId(pipeline: string): string {
  const entries = readdirSync(join(root, '.runs', pipeline)).sort();
  const last = entries[entries.length - 1];
  if (!last) throw new Error(`no hay runs de "${pipeline}"`);
  return last;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ap-lock-diag-'));
  writeFileSync(join(root, 'pipelines.yaml'), 'channels: {}\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('mensaje de lock ya sostenido', () => {
  test('nombra la ruta relativa del lock, el pid y desde cuándo', async () => {
    writePipeline(
      'ocupado',
      'name: ocupado\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );

    // El propio proceso de test sostiene el lock: su pid está vivo durante
    // toda la prueba, así que `acquireLock` del subproceso CLI lo verá como
    // una ejecución legítima en curso, no como un lock huérfano.
    const handle = await acquireLock(root, 'ocupado');
    expect(handle).toBeDefined();

    try {
      const { code, out } = await cli(['run', 'ocupado']);
      expect(code).toBe(3); // EXIT_ALREADY_RUNNING
      expect(out).toContain('ocupado');
      expect(out).toContain(join('.runs', '.locks', 'ocupado.lock'));
      expect(out).toContain(String(process.pid));
      expect(out).toContain('desde');
      // Nunca una ruta absoluta de esta máquina (restricción de portabilidad).
      expect(out).not.toContain(root);
    } finally {
      await releaseLock(handle!);
    }
  });

  test('registra el intento bloqueado como skipped(already_running) en .runs/', async () => {
    writePipeline(
      'ocupado2',
      'name: ocupado2\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );
    const handle = await acquireLock(root, 'ocupado2');
    expect(handle).toBeDefined();
    try {
      const { code } = await cli(['run', 'ocupado2']);
      expect(code).toBe(3); // EXIT_ALREADY_RUNNING — no cambia
    } finally {
      await releaseLock(handle!);
    }

    const runs = await new RunStore(root).listRuns('ocupado2');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('skipped');
    expect(runs[0]!.skipReason).toBe('already_running');
  });
});

describe('lock dañado, distinto de "ya en curso"', () => {
  test('se informa como problema del propio fichero, con un código de salida distinto', async () => {
    writePipeline(
      'roto',
      'name: roto\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );
    mkdirSync(join(root, '.runs', '.locks'), { recursive: true });
    writeFileSync(join(root, '.runs', '.locks', 'roto.lock'), 'esto no es JSON válido');

    const { code, out } = await cli(['run', 'roto']);

    expect(code).toBe(2); // EXIT_LOCK_ERROR — distinto de EXIT_ALREADY_RUNNING (3)
    expect(out).not.toContain('ya hay una ejecución en curso');
    expect(out.toLowerCase()).toContain('lock');
  });
});

describe('resume toma el lock', () => {
  test('un resume rechaza arrancar si otra ejecución sostiene el lock del mismo pipeline', async () => {
    writePipeline(
      'resumible',
      'name: resumible\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: exit 1\n',
    );
    const { code: runCode } = await cli(['run', 'resumible']);
    expect(runCode).toBe(1);
    const runId = latestRunId('resumible');

    const handle = await acquireLock(root, 'resumible');
    expect(handle).toBeDefined();
    try {
      const { code, out } = await cli(['resume', 'resumible', runId]);
      expect(code).toBe(3); // EXIT_ALREADY_RUNNING
      expect(out).toContain('en curso');

      const runs = await new RunStore(root).listRuns('resumible');
      // El primer run (falló de verdad) más el intento de resume bloqueado.
      expect(runs).toHaveLength(2);
      const blocked = runs.find((r) => r.skipReason === 'already_running');
      expect(blocked?.status).toBe('skipped');
    } finally {
      await releaseLock(handle!);
    }
  });

  test('el registro de un resume bloqueado usa la versión del pipeline del run que se retoma, no la recién cargada', async () => {
    writePipeline(
      'versionado',
      'name: versionado\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: exit 1\n',
    );
    const { code: runCode } = await cli(['run', 'versionado']);
    expect(runCode).toBe(1);
    const runId = latestRunId('versionado');
    const original = await new RunStore(root).readRun('versionado', runId);
    expect(original?.pipelineVersion).toBe(1);

    // El pipeline.yaml cambia de versión ENTRE el run original y el intento
    // de resume: el registro del intento bloqueado debe seguir anclado a la
    // versión del run que se está retomando (1), no a la recién cargada (2).
    writePipeline(
      'versionado',
      'name: versionado\ndescription: d\nversion: 2\nsteps:\n  - id: a\n    type: shell\n    run: exit 1\n',
    );

    const handle = await acquireLock(root, 'versionado');
    expect(handle).toBeDefined();
    try {
      const { code } = await cli(['resume', 'versionado', runId]);
      expect(code).toBe(3); // EXIT_ALREADY_RUNNING
    } finally {
      await releaseLock(handle!);
    }

    const runs = await new RunStore(root).listRuns('versionado');
    const blocked = runs.find((r) => r.skipReason === 'already_running');
    expect(blocked?.pipelineVersion).toBe(1);
  });

  test('un resume normal (sin conflicto) reintenta el paso fallido y puede tener éxito', async () => {
    // La puerta usa un fichero marcador dentro del propio directorio del
    // pipeline (cwd por defecto de un paso shell): ausente la primera vez
    // (falla y lo crea), presente la segunda (tiene éxito). Así se simula
    // un fallo transitorio real que un operador arregla antes de reanudar,
    // sin depender de reintentos automáticos del propio pipeline.
    writePipeline(
      'reanudable',
      'name: reanudable\ndescription: d\nversion: 1\nsteps:\n  - id: puerta\n    type: shell\n    run: test -f .flag && echo \'{"ok":true}\' || (touch .flag; exit 1)\n    outputs: { ok: boolean }\n',
    );

    const { code: firstCode } = await cli(['run', 'reanudable']);
    expect(firstCode).toBe(1);
    const runId = latestRunId('reanudable');

    const { code: resumeCode, out } = await cli(['resume', 'reanudable', runId]);
    expect(resumeCode).toBe(0);
    expect(out).toContain('success');

    // El lock quedó liberado tras el resume: una ejecución normal posterior
    // no debería toparse con "ya en curso".
    expect(await readLock(root, 'reanudable')).toBeUndefined();
  });
});

describe('interrupción del proceso (verificación: ¿se libera el lock en todo camino de salida?)', () => {
  test('SIGINT libera el lock antes de que el proceso termine', async () => {
    writePipeline(
      'lento',
      'name: lento\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: sleep 5\n',
    );

    const proc = spawnCli(['run', 'lento']);
    await waitFor(async () => (await readLock(root, 'lento')) !== undefined);

    proc.kill('SIGINT');
    const code = await proc.exited;

    expect(code).toBe(130);
    expect(await readLock(root, 'lento')).toBeUndefined();
  });
});
