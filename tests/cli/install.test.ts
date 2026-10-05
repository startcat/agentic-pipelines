import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

let root: string;
let fakeHome: string;
let launchctlLog: string;
const CLI = join(import.meta.dir, '..', '..', 'src', 'cli', 'index.ts');

function writePipeline(name: string, yaml: string) {
  mkdirSync(join(root, 'pipelines', name), { recursive: true });
  writeFileSync(join(root, 'pipelines', name, 'pipeline.yaml'), yaml);
}

/**
 * `launchctl` de mentira: registra sus argumentos en un fichero y sale 0. La
 * suite NUNCA carga un job de verdad en el launchd de la máquina.
 */
function writeFakeLaunchctl(): string {
  const path = join(fakeHome, 'fake-launchctl');
  writeFileSync(path, `#!/bin/sh\necho "$@" >> ${launchctlLog}\nexit 0\n`);
  chmodSync(path, 0o755);
  return path;
}

/**
 * `launchctl` de mentira cuyo `bootstrap` falla a propósito, con un mensaje
 * en stderr: antes `stdout`/`stderr` se descartaban
 * (`stdio: 'ignore'`), así que un `bootstrap` fallido no dejaba ningún
 * diagnóstico. `bootout` (llamado antes, dentro de `install`) sigue saliendo
 * 0 con normalidad.
 */
function writeFailingLaunchctl(stderrMessage: string, exitCode: number): string {
  const path = join(fakeHome, 'fake-launchctl-failing');
  writeFileSync(
    path,
    `#!/bin/sh\necho "$@" >> ${launchctlLog}\n` +
      `if [ "$1" = "bootstrap" ]; then echo "${stderrMessage}" >&2; exit ${exitCode}; fi\n` +
      `exit 0\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

async function cli(
  args: string[],
  opts: { launchctlBin?: string } = {},
): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['bun', CLI, ...args], {
    cwd: root,
    env: {
      ...process.env,
      HOME: fakeHome,
      ANTHROPIC_API_KEY: 'sk-test',
      PIPELINES_LAUNCHCTL_BIN: opts.launchctlBin ?? writeFakeLaunchctl(),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out: stdout + stderr };
}

/** Valor del `EnvironmentVariables/PATH` de un plist ya escrito, para las aserciones sobre él. */
function pathFromPlist(xml: string): string {
  const match = /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/.exec(xml);
  if (!match) throw new Error('el plist no lleva ninguna clave PATH');
  return match[1]!;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ap-install-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'ap-home-'));
  mkdirSync(join(fakeHome, 'Library', 'LaunchAgents'), { recursive: true });
  mkdirSync(join(fakeHome, 'Library', 'Logs'), { recursive: true });
  launchctlLog = join(fakeHome, 'launchctl.log');
  writeFileSync(join(root, 'pipelines.yaml'), 'channels: {}\n');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

const DEMO = `name: demo
description: d
version: 1
params:
  docs_repo:
    description: ruta
    required: true
  deploy_url:
    description: url opcional
requires:
  bin: [git]
triggers:
  - cron: "0 3 * * *"
steps:
  - id: build
    type: shell
    run: 'true'
  - id: deploy
    type: shell
    when: "{{params.deploy_url}}"
    run: 'true'
`;

describe('pipelines install', () => {
  test('escribe el plist y los params, y carga el job', async () => {
    writePipeline('demo', DEMO);
    const { code, out } = await cli(['install', 'demo', '--set', 'docs_repo=/repos/docs']);
    expect(code).toBe(0);

    const plist = await Bun.file(
      join(fakeHome, 'Library', 'LaunchAgents', 'cat.start.pipelines.demo.plist'),
    ).text();
    expect(plist).toContain('<string>cat.start.pipelines.demo</string>');
    expect(plist).toContain('<key>Hour</key>');

    const params = await Bun.file(join(root, '.params.local.json')).json();
    expect(params.demo.docs_repo).toBe('/repos/docs');

    const launchctl = await Bun.file(launchctlLog).text();
    expect(launchctl).toContain('bootstrap');
    expect(out).toContain('cat.start.pipelines.demo');
  });

  // Regla fija: ningún valor de param en el plist. Si esto se rompe,
  // el plist vuelve a llevar información viva y puede desviarse del repo.
  test('el plist no lleva ningún valor de parámetro', async () => {
    writePipeline('demo', DEMO);
    await cli(['install', 'demo', '--set', 'docs_repo=/repos/docs']);
    const plist = await Bun.file(
      join(fakeHome, 'Library', 'LaunchAgents', 'cat.start.pipelines.demo.plist'),
    ).text();
    expect(plist).not.toContain('/repos/docs');
  });

  test('avisa de los params opcionales sin valor y del paso que se saltará', async () => {
    writePipeline('demo', DEMO);
    const { out } = await cli(['install', 'demo', '--set', 'docs_repo=/repos/docs']);
    expect(out).toContain('deploy_url');
    expect(out).toContain('deploy');
  });

  test('falla nombrando el param obligatorio que falta, sin escribir nada', async () => {
    writePipeline('demo', DEMO);
    const { code, out } = await cli(['install', 'demo']);
    expect(code).not.toBe(0);
    expect(out).toContain('docs_repo');
    expect(
      await Bun.file(join(fakeHome, 'Library', 'LaunchAgents', 'cat.start.pipelines.demo.plist')).exists(),
    ).toBe(false);
  });

  test('falla si el pipeline no declara triggers', async () => {
    writePipeline(
      'sin-trigger',
      'name: sin-trigger\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );
    const { code, out } = await cli(['install', 'sin-trigger']);
    expect(code).not.toBe(0);
    expect(out).toContain('triggers');
  });

  test('preserva las entradas de otros pipelines en .params.local.json', async () => {
    writePipeline('demo', DEMO);
    writeFileSync(join(root, '.params.local.json'), JSON.stringify({ otro: { x: '1' } }));
    await cli(['install', 'demo', '--set', 'docs_repo=/repos/docs']);
    const params = await Bun.file(join(root, '.params.local.json')).json();
    expect(params.otro.x).toBe('1');
    expect(params.demo.docs_repo).toBe('/repos/docs');
  });

  test('avisa de un job ajeno que menciona la misma ruta y no instala sin --force', async () => {
    writePipeline('demo', DEMO);
    writeFileSync(
      join(fakeHome, 'Library', 'LaunchAgents', 'com.otro.backup.plist'),
      '<plist><dict><string>/repos/docs</string></dict></plist>',
    );
    const { code, out } = await cli(['install', 'demo', '--set', 'docs_repo=/repos/docs']);
    expect(code).not.toBe(0);
    expect(out).toContain('com.otro.backup');
    expect(out).toContain('--force');
  });

  test('con --force instala igualmente pese al job ajeno', async () => {
    writePipeline('demo', DEMO);
    writeFileSync(
      join(fakeHome, 'Library', 'LaunchAgents', 'com.otro.backup.plist'),
      '<plist><dict><string>/repos/docs</string></dict></plist>',
    );
    const { code } = await cli(['install', 'demo', '--set', 'docs_repo=/repos/docs', '--force']);
    expect(code).toBe(0);
  });

  // Reemplazar un job con la MISMA
  // etiqueta debe seguir ocurriendo sin --force, pero avisando de que es un
  // reemplazo y no una instalación nueva.
  test('la segunda instalación avisa de que reemplaza el job existente', async () => {
    writePipeline('demo', DEMO);
    const first = await cli(['install', 'demo', '--set', 'docs_repo=/repos/docs']);
    expect(first.code).toBe(0);
    expect(first.out).not.toContain('reemplazado');

    const second = await cli(['install', 'demo', '--set', 'docs_repo=/repos/docs']);
    expect(second.code).toBe(0);
    expect(second.out).toContain('reemplazado');
    expect(second.out).toContain('cat.start.pipelines.demo');
  });

  // Un PATH calculado solo desde
  // `requires.bin` puede no incluir `/bin`, y en macOS `sh` SOLO vive ahí —
  // sin él, el job instalado moriría en el primer paso `shell` o guarda
  // `shell:`. Aserción sobre el plist REALMENTE escrito, no sobre `computePath`
  // en aislado.
  test('el PATH del plist instalado incluye /bin, así puede lanzar "sh"', async () => {
    writePipeline('demo', DEMO);
    await cli(['install', 'demo', '--set', 'docs_repo=/repos/docs']);
    const plist = await Bun.file(
      join(fakeHome, 'Library', 'LaunchAgents', 'cat.start.pipelines.demo.plist'),
    ).text();
    expect(pathFromPlist(plist).split(':')).toContain('/bin');
  });

  // El único test anterior de "sin LANG/LC_ALL" llamaba a
  // `renderPlist` con un spec que nunca los llevaba — no podía fallar nunca.
  // La garantía real vive en cómo `install` construye `environmentVariables`
  // (solo PATH y HOME), así que la aserción tiene que ir sobre el plist que
  // el comando escribe de verdad.
  test('el plist realmente instalado no declara LANG ni LC_ALL', async () => {
    writePipeline('demo', DEMO);
    await cli(['install', 'demo', '--set', 'docs_repo=/repos/docs']);
    const plist = await Bun.file(
      join(fakeHome, 'Library', 'LaunchAgents', 'cat.start.pipelines.demo.plist'),
    ).text();
    expect(plist).not.toContain('LANG');
    expect(plist).not.toContain('LC_ALL');
  });

  // `computePath` ignoraba `mcp_servers[].command`, y hasta
  // ahora funcionaba por casualidad cuando ese comando compartía directorio
  // con algún `requires.bin` vecino. Aquí `requires.bin` solo declara "git"
  // (que vive en /usr/bin, y además ya cubierto por el suelo de sistema), y
  // el servidor MCP usa "node" (que en esta máquina vive en un directorio de
  // nvm bien distinto) para demostrar que su directorio entra en el PATH por
  // sí mismo.
  test('el PATH del plist incluye el directorio del "command" de un servidor MCP', async () => {
    const nodeBin = Bun.which('node');
    if (!nodeBin) {
      // Entorno sin "node" en el PATH: no hay nada que demostrar aquí.
      return;
    }
    const nodeDir = dirname(nodeBin);

    writePipeline(
      'demo-mcp',
      `name: demo-mcp
description: d
version: 1
params: {}
requires:
  bin: [git]
mcp_servers:
  fs:
    command: node
    args: []
triggers:
  - cron: "0 3 * * *"
steps:
  - id: build
    type: shell
    run: 'true'
`,
    );
    const { code } = await cli(['install', 'demo-mcp']);
    expect(code).toBe(0);
    const plist = await Bun.file(
      join(fakeHome, 'Library', 'LaunchAgents', 'cat.start.pipelines.demo-mcp.plist'),
    ).text();
    expect(pathFromPlist(plist).split(':')).toContain(nodeDir);
  });

  // Con `--force`, la salida antes era indistinguible de una instalación
  // limpia — ni el doctor en rojo ni los jobs ajenos se imprimían.
  // "--force lo salta, AVISANDO".
  test('con --force avisa igualmente del doctor en rojo y de los jobs ajenos detectados', async () => {
    // El check en rojo es de tipo "env" (una var de `requires.env` sin
    // definir), no "bin": un binario de `requires.bin` que no resuelve hace
    // que `computePath` LANCE (necesita esa ruta para construir el PATH del
    // job), y eso taparía la comprobación de esta prueba con un error
    // distinto en vez de con el aviso de "--force" que se quiere comprobar.
    writePipeline(
      'demo-rojo',
      `name: demo-rojo
description: d
version: 1
params:
  docs_repo:
    description: ruta
    required: true
requires:
  bin: [git]
  env: [SECRETO_AUSENTE_XYZ]
triggers:
  - cron: "0 3 * * *"
steps:
  - id: build
    type: shell
    run: 'true'
`,
    );
    writeFileSync(
      join(fakeHome, 'Library', 'LaunchAgents', 'com.otro.backup.plist'),
      '<plist><dict><string>/repos/docs</string></dict></plist>',
    );
    const { code, out } = await cli([
      'install',
      'demo-rojo',
      '--set',
      'docs_repo=/repos/docs',
      '--force',
    ]);
    expect(code).toBe(0);
    expect(out).toContain('SECRETO_AUSENTE_XYZ');
    expect(out).toContain('com.otro.backup');
    expect(out).toContain('--force');
  });

  // Sin `mkdir(..., { recursive:
  // true })`, una máquina limpia sin `~/Library/LaunchAgents` todavía sale
  // con un ENOENT crudo en vez de crear el directorio.
  test('crea ~/Library/LaunchAgents si todavía no existe', async () => {
    rmSync(join(fakeHome, 'Library', 'LaunchAgents'), { recursive: true, force: true });
    writePipeline('demo', DEMO);
    const { code } = await cli(['install', 'demo', '--set', 'docs_repo=/repos/docs']);
    expect(code).toBe(0);
    expect(
      await Bun.file(join(fakeHome, 'Library', 'LaunchAgents', 'cat.start.pipelines.demo.plist')).exists(),
    ).toBe(true);
  });

  // Antes `stdout`/`stderr` de `launchctl` se descartaban
  // (`stdio: 'ignore'`), así que un `bootstrap` fallido no dejaba ningún
  // diagnóstico — justo el caso en que más hace falta.
  test('si "launchctl bootstrap" falla, la salida incluye su stderr', async () => {
    writePipeline('demo', DEMO);
    const failing = writeFailingLaunchctl('Load failed: 5: Input/output error', 5);
    const { code, out } = await cli(
      ['install', 'demo', '--set', 'docs_repo=/repos/docs'],
      { launchctlBin: failing },
    );
    expect(code).not.toBe(0);
    expect(out).toContain('5');
    expect(out).toContain('Load failed: 5: Input/output error');
  });
});

// `--dry-run` nace de una revisión: el paso que compara el plist generado
// contra el que ya corre es lo que habría cazado el fallo del PATH sin `/bin`,
// y era una entrada de checklist que se ejecuta a mano una vez — de hecho no
// llegó a ejecutarse hasta que la revisión lo señaló. Como flag, es repetible.
describe('pipelines install --dry-run', () => {
  test('imprime el plist que escribiría y no escribe ningún fichero', async () => {
    writePipeline('demo', DEMO);
    const { code, out } = await cli(['install', 'demo', '--dry-run', '--set', 'docs_repo=/repos/docs']);
    expect(code).toBe(0);
    expect(out).toContain('<key>Label</key>');
    expect(out).toContain('cat.start.pipelines.demo');
    expect(
      await Bun.file(join(fakeHome, 'Library', 'LaunchAgents', 'cat.start.pipelines.demo.plist')).exists(),
    ).toBe(false);
  });

  // Un "ensayo" que deja un efecto persistente deja de ser un ensayo.
  test('no escribe .params.local.json aunque reciba --set', async () => {
    writePipeline('demo', DEMO);
    await cli(['install', 'demo', '--dry-run', '--set', 'docs_repo=/repos/docs']);
    expect(await Bun.file(join(root, '.params.local.json')).exists()).toBe(false);
  });

  test('no invoca launchctl', async () => {
    writePipeline('demo', DEMO);
    await cli(['install', 'demo', '--dry-run', '--set', 'docs_repo=/repos/docs']);
    expect(await Bun.file(launchctlLog).exists()).toBe(false);
  });

  test('sigue fallando si falta un param obligatorio, para que sirva en un script', async () => {
    writePipeline('demo', DEMO);
    const { code, out } = await cli(['install', 'demo', '--dry-run']);
    expect(code).not.toBe(0);
    expect(out).toContain('docs_repo');
  });

  test('avisa igual de los params opcionales sin valor', async () => {
    writePipeline('demo', DEMO);
    const { out } = await cli(['install', 'demo', '--dry-run', '--set', 'docs_repo=/repos/docs']);
    expect(out).toContain('deploy_url');
  });
});

describe('pipelines uninstall', () => {
  test('descarga el job y borra el plist', async () => {
    writePipeline('demo', DEMO);
    await cli(['install', 'demo', '--set', 'docs_repo=/repos/docs']);
    const plistPath = join(fakeHome, 'Library', 'LaunchAgents', 'cat.start.pipelines.demo.plist');
    expect(await Bun.file(plistPath).exists()).toBe(true);

    const { code, out } = await cli(['uninstall', 'demo']);
    expect(code).toBe(0);
    expect(await Bun.file(plistPath).exists()).toBe(false);
    expect(await Bun.file(launchctlLog).text()).toContain('bootout');
    expect(out).toContain('.params.local.json');
  });

  // Idempotente: repetir un uninstall no es un error. Un `uninstall` que
  // falla la segunda vez empuja a la gente a comprobar estado a mano.
  test('sobre un pipeline que no está instalado informa y sale 0', async () => {
    writePipeline('demo', DEMO);
    const { code, out } = await cli(['uninstall', 'demo']);
    expect(code).toBe(0);
    expect(out).toContain('no está instalado');
  });

  // Si el plist se borra a mano pero el job sigue cargado,
  // `uninstall` debe descargarlo igualmente — no basta con mirar si el
  // fichero existe y salir sin más. `bootout` debe llamarse SIEMPRE.
  test('llama a bootout aunque el plist se haya borrado a mano', async () => {
    writePipeline('demo', DEMO);
    await cli(['install', 'demo', '--set', 'docs_repo=/repos/docs']);
    const plistPath = join(fakeHome, 'Library', 'LaunchAgents', 'cat.start.pipelines.demo.plist');
    rmSync(plistPath); // borrado a mano: el job puede seguir cargado en launchd

    const bootoutsBefore = (await Bun.file(launchctlLog).text())
      .split('\n')
      .filter((line) => line.startsWith('bootout')).length;

    const { code, out } = await cli(['uninstall', 'demo']);
    expect(code).toBe(0);
    expect(out).toContain('no está instalado');

    const bootoutsAfter = (await Bun.file(launchctlLog).text())
      .split('\n')
      .filter((line) => line.startsWith('bootout')).length;
    expect(bootoutsAfter).toBeGreaterThan(bootoutsBefore);
  });
});
