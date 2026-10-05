import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root: string;
const CLI = join(import.meta.dir, '..', '..', 'src', 'cli', 'index.ts');

function writePipeline(name: string, yaml: string) {
  mkdirSync(join(root, 'pipelines', name), { recursive: true });
  writeFileSync(join(root, 'pipelines', name, 'pipeline.yaml'), yaml);
}

async function cli(args: string[], cwd = root): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['bun', CLI, ...args], {
    cwd,
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
  root = mkdtempSync(join(tmpdir(), 'ap-validate-'));
  writeFileSync(join(root, 'pipelines.yaml'), 'channels: {}\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('validate <nombre> con las reglas cableadas', () => {
  test('la sonda de referencias rotas en run: ya no pasa', async () => {
    // Las referencias van entre comillas DOBLES de shell (YAML de comillas
    // simples, que no procesan escapes: lo que se escribe es lo que ve
    // bash), para que R1 no dispare aquí y la única forma de tumbar este
    // test sea que `checkGuardReferences`/`checkStepReferences` sigan
    // cableados de verdad.
    writePipeline(
      'demo',
      `name: demo
description: d
version: 1
params:
  real:
    description: existe
when:
  - shell: 'test -n "{{params.guarda_inexistente}}"'
steps:
  - id: uno
    type: shell
    run: 'echo "{{params.run_inexistente}}" && echo {{params.real}}'
`,
    );
    const { code, out } = await cli(['validate', 'demo']);
    expect(code).not.toBe(0);
    expect(out).toContain('when.0.shell');
    expect(out).toContain('uno.run');
  });

  test('un pipeline correcto sigue en verde', async () => {
    writePipeline(
      'ok',
      `name: ok
description: d
version: 1
steps:
  - id: uno
    type: shell
    run: "true"
`,
    );
    const { code, out } = await cli(['validate', 'ok']);
    expect(code).toBe(0);
    expect(out).toContain('ok');
  });

  test('un prompt que falta sigue siendo ERROR sin --file', async () => {
    writePipeline(
      'conagente',
      `name: conagente
description: d
version: 1
steps:
  - id: uno
    type: agent
    agent: redactor
    prompt: falta.md
`,
    );
    const { code, out } = await cli(['validate', 'conagente']);
    expect(code).not.toBe(0);
    expect(out).toContain('falta.md');
  });

  test('una regla del motor sola basta para tumbar el pipeline (R3)', async () => {
    writePipeline(
      'sinstrict',
      `name: sinstrict
description: d
version: 1
steps:
  - id: uno
    type: shell
    run: |
      echo hola
      echo adios
`,
    );
    const { code, out } = await cli(['validate', 'sinstrict']);
    expect(code).not.toBe(0);
    expect(out).toContain('set -euo pipefail');
  });

  test('R1 llega al comando: referencia declarada, pero entre comillas simples', async () => {
    writePipeline(
      'comillas',
      `name: comillas
description: d
version: 1
params:
  repo:
    description: r
steps:
  - id: uno
    type: shell
    run: "curl -d '{{params.repo}}'"
`,
    );
    const { code, out } = await cli(['validate', 'comillas']);
    expect(code).not.toBe(0);
    expect(out).toContain('no expande');
  });
});

describe('validate --file', () => {
  test('valida un borrador que no vive en pipelines/<nombre>/', async () => {
    const draft = join(root, 'borrador.yaml');
    writeFileSync(
      draft,
      `name: demo
description: d
version: 1
steps:
  - id: uno
    type: shell
    run: "true"
`,
    );
    const { code, out } = await cli(['validate', '--file', draft]);
    expect(code).toBe(0);
    expect(out).toContain('demo');
  });

  test('el name: no tiene que coincidir con ningún directorio', async () => {
    const draft = join(root, 'otro-nombre.yaml');
    writeFileSync(
      draft,
      `name: se-llama-distinto
description: d
version: 1
steps:
  - id: uno
    type: shell
    run: "true"
`,
    );
    expect((await cli(['validate', '--file', draft])).code).toBe(0);
  });

  test('un prompt que falta es AVISO, y dice que no ha mirado sus referencias', async () => {
    const draft = join(root, 'borrador.yaml');
    writeFileSync(
      draft,
      `name: demo
description: d
version: 1
steps:
  - id: uno
    type: agent
    agent: redactor
    prompt: todavia-no.md
`,
    );
    const { code, out } = await cli(['validate', '--file', draft]);
    expect(code).toBe(0);
    expect(out).toContain('aviso');
    expect(out).toContain('todavia-no.md');
    expect(out).toContain('NO se han comprobado');
  });

  test('un error de esquema sigue siendo error', async () => {
    const draft = join(root, 'malo.yaml');
    writeFileSync(
      draft,
      `name: demo
description: d
version: 1
when:
  - throttle: 6d
steps:
  - id: uno
    type: shell
    run: "true"
`,
    );
    const { code, out } = await cli(['validate', '--file', draft]);
    expect(code).not.toBe(0);
    expect(out).toContain('s, m o h');
  });

  test('fuera de cualquier repo no revienta, y avisa de que no ha mirado el canal', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'ap-sin-repo-'));
    try {
      const draft = join(elsewhere, 'borrador.yaml');
      writeFileSync(
        draft,
        `name: demo
description: d
version: 1
triggers:
  - cron: "0 3 * * *"
notify:
  on: [failed]
  stale_after: 72h
  channel: correo
steps:
  - id: uno
    type: shell
    run: "true"
`,
      );
      const { code, out } = await cli(['validate', '--file', draft], elsewhere);
      expect(code).toBe(0);
      expect(out).toContain('aviso');
      expect(out).toContain('correo');
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test('--file junto a un nombre es un error de uso', async () => {
    const draft = join(root, 'borrador.yaml');
    writeFileSync(draft, 'name: demo\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n');
    const { code, out } = await cli(['validate', 'demo', '--file', draft]);
    expect(code).not.toBe(0);
    expect(out).toContain('--file');
  });
});
