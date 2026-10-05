import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { parsePipeline } from '../../src/schema/pipeline.ts';
import { hasBlockingFailures, listMcpToolsViaStdio, preflight, type PreflightReport } from '../../src/preflight/check.ts';

let repoRoot: string;
let claudeDir: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'ap-repo-'));
  claudeDir = mkdtempSync(join(tmpdir(), 'ap-claude-'));
  mkdirSync(join(repoRoot, 'agents'), { recursive: true });
});
afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(claudeDir, { recursive: true, force: true });
});

const PIPELINE = parsePipeline(`
name: demo
description: d
version: 1
requires:
  agents: [local-writer, user-writer]
  skills: [docs:update]
  bin: [git]
  env: [MY_TOKEN]
  net: [example.com]
steps:
  - id: a
    type: shell
    run: 'true'
`);

const okProbes = {
  hasBinary: async () => true,
  resolvesHost: async () => true,
  listUserAgents: async () => ['user-writer'],
  listUserSkills: async () => ['docs:update'],
  // Explícito, no por omisión: sin esto el probe real consultaría el llavero
  // de la máquina que corre los tests y el caso "sin credenciales" pasaría o
  // fallaría según quién los ejecute.
  hasKeychainSession: async () => false,
};

describe('preflight', () => {
  test('todo correcto cuando cada dependencia está presente', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# writer');
    const report = await preflight(PIPELINE, {
      repoRoot,
      userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x' },
      dotEnv: { MY_TOKEN: 'secreto-valido' },
      probes: okProbes,
    });
    expect(report.ok).toBe(true);
    expect(report.checks.every((c) => c.ok)).toBe(true);
  });

  test('encuentra un agente en agents/ del repo antes que en el de usuario', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# writer');
    const report = await preflight(PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x' },
      dotEnv: { MY_TOKEN: 's' }, probes: okProbes,
    });
    const check = report.checks.find((c) => c.kind === 'agent' && c.name === 'local-writer');
    expect(check!.ok).toBe(true);
    expect(check!.detail).toContain('repo');
  });

  test('falla nombrando el agente que no encuentra', async () => {
    const report = await preflight(PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x' },
      dotEnv: { MY_TOKEN: 's' }, probes: okProbes,
    });
    expect(report.ok).toBe(false);
    const check = report.checks.find((c) => c.kind === 'agent' && c.name === 'local-writer');
    expect(check!.ok).toBe(false);
  });

  test('falla si falta una variable de entorno declarada', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# w');
    const report = await preflight(PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x' },
      dotEnv: {}, probes: okProbes,
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.kind === 'env')!.ok).toBe(false);
  });

  test('acepta una variable presente en el entorno del proceso aunque no esté en .env', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# w');
    const report = await preflight(PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x', MY_TOKEN: 'del-entorno' },
      dotEnv: {}, probes: okProbes,
    });
    expect(report.checks.find((c) => c.kind === 'env')!.ok).toBe(true);
  });

  test('falla si una variable de entorno declarada está vacía', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# w');
    const report = await preflight(PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x' },
      dotEnv: { MY_TOKEN: '' }, probes: okProbes,
    });
    const check = report.checks.find((c) => c.kind === 'env')!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('corta');
  });

  test('falla si una variable de entorno declarada es solo espacios', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# w');
    const report = await preflight(PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x' },
      dotEnv: { MY_TOKEN: '        ' }, probes: okProbes,
    });
    const check = report.checks.find((c) => c.kind === 'env')!;
    expect(check.ok).toBe(false);
  });

  test('falla si una variable de entorno declarada es más corta que el mínimo', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# w');
    const report = await preflight(PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x' },
      dotEnv: { MY_TOKEN: 'corto12' }, probes: okProbes, // 7 caracteres
    });
    const check = report.checks.find((c) => c.kind === 'env')!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('corta');
  });

  test('acepta una variable de entorno que cumple exactamente el mínimo', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# w');
    const report = await preflight(PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x' },
      dotEnv: { MY_TOKEN: 'exacto12' }, probes: okProbes, // 8 caracteres
    });
    const check = report.checks.find((c) => c.kind === 'env')!;
    expect(check.ok).toBe(true);
  });

  test('nunca expone el valor de un secreto en el informe', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# w');
    const report = await preflight(PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x' },
      dotEnv: { MY_TOKEN: 'valor-secretisimo' }, probes: okProbes,
    });
    expect(JSON.stringify(report)).not.toContain('valor-secretisimo');
  });

  test('falla si no hay credenciales de Claude en el entorno', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# w');
    const report = await preflight(PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: {}, dotEnv: { MY_TOKEN: 's' }, probes: okProbes,
    });
    expect(report.ok).toBe(false);
    const auth = report.checks.find((c) => c.kind === 'auth');
    expect(auth!.ok).toBe(false);
  });

  // Claude Code guarda la credencial en el llavero de macOS, no en un fichero:
  // `~/.claude/.credentials.json` desapareció de esta máquina el 2026-08-29 y
  // el check dejó de ver una sesión que SÍ estaba iniciada, bloqueando
  // cualquier `run` con pasos agent.
  test('acepta una credencial guardada en el llavero, sin fichero ni API key', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# w');
    const report = await preflight(PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: {}, dotEnv: { MY_TOKEN: 's' },
      probes: { ...okProbes, hasKeychainSession: async () => true },
    });
    const auth = report.checks.find((c) => c.kind === 'auth');
    expect(auth!.ok).toBe(true);
    expect(auth!.detail).toContain('llavero');
  });

  test('acepta una sesión de Claude Code como credencial válida', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# w');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, '.credentials.json'), '{}');
    const report = await preflight(PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: {}, dotEnv: { MY_TOKEN: 's' }, probes: okProbes,
    });
    expect(report.checks.find((c) => c.kind === 'auth')!.ok).toBe(true);
  });

  test('falla si un binario declarado no está en PATH', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# w');
    const report = await preflight(PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x' }, dotEnv: { MY_TOKEN: 's' },
      probes: { ...okProbes, hasBinary: async () => false },
    });
    expect(report.checks.find((c) => c.kind === 'bin')!.ok).toBe(false);
  });

  test('falla si un host declarado no resuelve', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# w');
    const report = await preflight(PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x' }, dotEnv: { MY_TOKEN: 's' },
      probes: { ...okProbes, resolvesHost: async () => false },
    });
    expect(report.checks.find((c) => c.kind === 'net')!.ok).toBe(false);
  });

  test('encuentra una skill por su nombre sin cualificar cuando el sondeo solo devuelve la parte final', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# w');
    const report = await preflight(PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x' }, dotEnv: { MY_TOKEN: 's' },
      // El sondeo solo devuelve la parte tras los dos puntos, no
      // 'docs:update' completo: debe caer en la rama de fallback.
      probes: { ...okProbes, listUserSkills: async () => ['update'] },
    });
    const check = report.checks.find((c) => c.kind === 'skill');
    expect(check!.ok).toBe(true);
    expect(check!.detail).toBe('disponible');
  });

  test('usa los sondeos por defecto para listar agentes y skills de usuario cuando no se inyecta ninguno', async () => {
    mkdirSync(join(claudeDir, 'agents'), { recursive: true });
    writeFileSync(join(claudeDir, 'agents', 'user-writer.md'), '# writer');
    mkdirSync(join(claudeDir, 'skills', 'docs-update'), { recursive: true });
    const pipeline = parsePipeline(`
name: demo-default-probes
description: d
version: 1
requires:
  agents: [user-writer]
  skills: [docs-update]
steps:
  - id: a
    type: shell
    run: 'true'
`);
    const report = await preflight(pipeline, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x' }, dotEnv: {},
      // Sin `probes`: se ejercita defaultProbes de verdad (listUserAgents /
      // listUserSkills). No se declaran `bin` ni `net` en este pipeline
      // para no invocar Bun.which ni DNS real en este caso.
    });
    expect(report.checks.find((c) => c.kind === 'agent')!.ok).toBe(true);
    expect(report.checks.find((c) => c.kind === 'skill')!.ok).toBe(true);
  });

  test('los sondeos por defecto no revientan cuando agents/ o skills/ no existen en el directorio de usuario', async () => {
    const pipeline = parsePipeline(`
name: demo-missing-dirs
description: d
version: 1
requires:
  agents: [ghost-agent]
  skills: [ghost-skill]
steps:
  - id: a
    type: shell
    run: 'true'
`);
    // claudeDir es un directorio recién creado por mkdtempSync: no tiene
    // subdirectorios agents/ ni skills/. Los sondeos por defecto deben
    // devolver listas vacías (no lanzar) y el preflight debe fallar
    // nombrando ambas dependencias, no reventar.
    const report = await preflight(pipeline, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x' }, dotEnv: {},
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.kind === 'agent')!.ok).toBe(false);
    expect(report.checks.find((c) => c.kind === 'skill')!.ok).toBe(false);
  });

  test('el sondeo de binarios por defecto usa Bun.which: encuentra el binario que ejecuta el test y falla con uno inexistente', async () => {
    // El binario que con toda seguridad existe y está en PATH en cualquier
    // entorno donde corran estos tests es el propio runtime que los está
    // ejecutando (el proyecto exige Bun >= 1.3.0 para tests). Se evita así
    // asumir un binario concreto de una plataforma (p. ej. 'git' o 'sh').
    const currentBinary = basename(process.execPath);
    const pipeline = parsePipeline(`
name: demo-bun-which
description: d
version: 1
requires:
  bin: [${currentBinary}, zzz-no-existe-bin-xyz]
steps:
  - id: a
    type: shell
    run: 'true'
`);
    const report = await preflight(pipeline, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x' }, dotEnv: {},
    });
    const bins = report.checks.filter((c) => c.kind === 'bin');
    expect(bins.find((c) => c.name === currentBinary)!.ok).toBe(true);
    expect(bins.find((c) => c.name === 'zzz-no-existe-bin-xyz')!.ok).toBe(false);
  });

  test('comprueba el comando de cada servidor MCP declarado, nombrando el servidor', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# w');
    const pipeline = parsePipeline(`
name: demo-mcp
description: d
version: 1
requires:
  agents: [local-writer, user-writer]
  skills: [docs:update]
  bin: [git]
  env: [MY_TOKEN]
  net: [example.com]
mcp_servers:
  playwright:
    command: npx
  broken:
    command: zzz-no-existe-mcp-xyz
steps:
  - id: a
    agent: writer
    prompt: p.md
    mcp_servers: [playwright, broken]
`);
    const report = await preflight(pipeline, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x' },
      dotEnv: { MY_TOKEN: 's' },
      probes: { ...okProbes, hasBinary: async (name) => name !== 'zzz-no-existe-mcp-xyz' },
    });
    const mcp = report.checks.filter((c) => c.kind === 'mcp');
    expect(mcp.find((c) => c.name === 'playwright')!.ok).toBe(true);
    const brokenCheck = mcp.find((c) => c.name === 'broken')!;
    expect(brokenCheck.ok).toBe(false);
    expect(brokenCheck.detail).toContain('zzz-no-existe-mcp-xyz');
    expect(report.ok).toBe(false);
  });
});

const PLAYWRIGHT_PIPELINE = parsePipeline(`
name: demo
description: d
version: 1
mcp_servers:
  pw:
    command: npx
    args: []
    kind: playwright
steps:
  - id: a
    agent: writer
    prompt: p.md
    mcp_servers: [pw]
    tools: [mcp__pw__browser_take_screenshot, mcp__pw__browser_click]
`);

// Campos completos reales de estas dos tools, capturados en vivo el
// 2026-08-18 con `listMcpToolsViaStdio` contra `npx -y @playwright/mcp@latest`
// real — los mismos valores que ahora vive `TOOL_FS_PROFILES[...].knownFields`
// en fs-guard.ts (ver el comentario ahí). Reusarlos aquí
// en vez de inventar datos vuelve estos tests representativos de verdad.
const REAL_BROWSER_TAKE_SCREENSHOT = ['element', 'target', 'type', 'filename', 'fullPage', 'scale'];
const REAL_BROWSER_CLICK = ['element', 'target', 'doubleClick', 'button', 'modifiers'];

describe('preflight — deriva de esquema MCP (doctor)', () => {
  test('coincide con la tabla del motor: sin aviso', async () => {
    const report = await preflight(PLAYWRIGHT_PIPELINE, {
      repoRoot,
      userClaudeDir: claudeDir,
      processEnv: {},
      dotEnv: {},
      probes: {
        hasBinary: async () => true,
        listMcpTools: async () => ({
          browser_take_screenshot: [...REAL_BROWSER_TAKE_SCREENSHOT],
          browser_click: [...REAL_BROWSER_CLICK],
        }),
      },
    });
    const check = report.checks.find((c) => c.kind === 'mcp-schema' && c.name === 'pw');
    expect(check?.ok).toBe(true);
  });

  // Hay que detectar las tres direcciones de deriva: campo nuevo,
  // campo renombrado, campo desaparecido. La comparación vive contra
  // `TOOL_FS_PROFILES[...].knownFields` (el esquema COMPLETO conocido de la
  // tool), no solo contra el campo que el hook vigila — comparar solo contra
  // el campo vigilado no puede detectar nunca un campo nuevo, porque
  // prácticamente cualquier tool real tiene más parámetros que el único
  // campo de ruta rastreado (confirmado en vivo: `browser_take_screenshot`
  // tiene 6 campos reales, la tabla solo vigila `filename`) — de ahí que
  // "sin aviso" de arriba deba usar la lista COMPLETA para no disparar ruido
  // por sí solo.
  test('un campo nuevo que la tabla no conoce en absoluto produce aviso, no bloquea el resto del reporte', async () => {
    const report = await preflight(PLAYWRIGHT_PIPELINE, {
      repoRoot,
      userClaudeDir: claudeDir,
      processEnv: {},
      dotEnv: {},
      probes: {
        hasBinary: async () => true,
        listMcpTools: async () => ({
          browser_take_screenshot: [...REAL_BROWSER_TAKE_SCREENSHOT, 'campo_nuevo'],
          browser_click: [...REAL_BROWSER_CLICK],
        }),
      },
    });
    const check = report.checks.find((c) => c.kind === 'mcp-schema' && c.name === 'pw');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('browser_take_screenshot');
    expect(check?.detail).toContain('campo_nuevo');
  });

  // Señal fuerte: el campo que el HOOK vigila de verdad (`filename`, el
  // único campo de `TOOL_FS_PROFILES.browser_take_screenshot`) desaparece
  // del esquema real. El guard seguiría intentando sanear un campo que ya
  // no existe, sin enterarse de si la tool ganó otro campo de ruta sin
  // vigilar — la mutación más peligrosa de las tres.
  test('el campo que el hook vigila desaparece del servidor real: aviso con la redacción fuerte', async () => {
    const report = await preflight(PLAYWRIGHT_PIPELINE, {
      repoRoot,
      userClaudeDir: claudeDir,
      processEnv: {},
      dotEnv: {},
      probes: {
        hasBinary: async () => true,
        listMcpTools: async () => ({
          browser_take_screenshot: REAL_BROWSER_TAKE_SCREENSHOT.filter((f) => f !== 'filename'),
          browser_click: [...REAL_BROWSER_CLICK],
        }),
      },
    });
    const check = report.checks.find((c) => c.kind === 'mcp-schema' && c.name === 'pw');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('browser_take_screenshot');
    expect(check?.detail).toContain('filename');
    expect(check?.detail).toContain('que la tabla esperaba y ya no están');
  });

  // Señal más débil pero todavía `ok:false`: un campo del esquema COMPLETO
  // conocido (pero no vigilado por el hook, porque `TOOL_FS_PROFILES` solo
  // rastrea `filename` para esta tool) desaparece. No compromete el guard
  // directamente, pero indica que el paquete cambió de forma bajo la tabla
  // — la redacción del aviso debe distinguirse de la señal fuerte de arriba
  // para que un humano leyendo `doctor` pueda priorizar.
  test('un campo conocido pero no vigilado desaparece del servidor real: aviso con redacción distinta a la señal fuerte', async () => {
    const report = await preflight(PLAYWRIGHT_PIPELINE, {
      repoRoot,
      userClaudeDir: claudeDir,
      processEnv: {},
      dotEnv: {},
      probes: {
        hasBinary: async () => true,
        listMcpTools: async () => ({
          browser_take_screenshot: REAL_BROWSER_TAKE_SCREENSHOT.filter((f) => f !== 'scale'),
          browser_click: [...REAL_BROWSER_CLICK],
        }),
      },
    });
    const check = report.checks.find((c) => c.kind === 'mcp-schema' && c.name === 'pw');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('browser_take_screenshot');
    expect(check?.detail).toContain('scale');
    expect(check?.detail).not.toContain('que la tabla esperaba y ya no están');
  });

  // Un campo renombrado no necesita ningún caso especial: se ve, sin más,
  // como la desaparición del nombre viejo (missingGoverned/missingOther) más
  // la aparición del nombre nuevo (extraFields) en la misma tool.
  test('un campo renombrado produce tanto la señal de desaparición como la de campo nuevo, sin caso especial', async () => {
    const report = await preflight(PLAYWRIGHT_PIPELINE, {
      repoRoot,
      userClaudeDir: claudeDir,
      processEnv: {},
      dotEnv: {},
      probes: {
        hasBinary: async () => true,
        listMcpTools: async () => ({
          // 'filename' (vigilado por el hook) renombrado a 'outputPath'.
          browser_take_screenshot: [
            ...REAL_BROWSER_TAKE_SCREENSHOT.filter((f) => f !== 'filename'),
            'outputPath',
          ],
          browser_click: [...REAL_BROWSER_CLICK],
        }),
      },
    });
    const check = report.checks.find((c) => c.kind === 'mcp-schema' && c.name === 'pw');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('filename');
    expect(check?.detail).toContain('outputPath');
  });

  test('un servidor sin kind: no genera ningún chequeo mcp-schema', async () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
mcp_servers:
  x:
    command: npx
    args: []
steps:
  - id: a
    type: shell
    run: 'true'
`);
    const report = await preflight(p, {
      repoRoot,
      userClaudeDir: claudeDir,
      processEnv: {},
      dotEnv: {},
      probes: { hasBinary: async () => true },
    });
    expect(report.checks.some((c) => c.kind === 'mcp-schema')).toBe(false);
  });

  test('si listMcpTools falla (servidor no arranca en esta máquina), el chequeo se marca fallido con el motivo, sin lanzar', async () => {
    const report = await preflight(PLAYWRIGHT_PIPELINE, {
      repoRoot,
      userClaudeDir: claudeDir,
      processEnv: {},
      dotEnv: {},
      probes: {
        hasBinary: async () => true,
        listMcpTools: async () => {
          throw new Error('ECONNRESET');
        },
      },
    });
    const check = report.checks.find((c) => c.kind === 'mcp-schema' && c.name === 'pw');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('ECONNRESET');
  });
});

// `run` y `doctor`
// compartían literalmente `preflight()` y el mismo criterio de gating
// (`!report.ok`), así que un chequeo `mcp-schema` — puramente informativo,
// pensado solo para `doctor` (la deriva de esquema de un servidor MCP) —
// bloqueaba una ejecución real. `hasBlockingFailures` es
// lo que ahora consulta `cli/index.ts`'s `run` en su lugar; `doctor` sigue
// usando `report.ok` sin cambios.
describe('hasBlockingFailures', () => {
  function reportWith(checks: PreflightReport['checks']): PreflightReport {
    return { ok: checks.every((c) => c.ok), checks };
  }

  test('un fallo mcp-schema en solitario NO bloquea — run debe poder proceder', () => {
    const report = reportWith([
      { kind: 'auth', name: 'claude', ok: true, detail: 'ok' },
      { kind: 'mcp-schema', name: 'pw', ok: false, detail: 'deriva de esquema' },
    ]);
    expect(report.ok).toBe(false); // doctor sigue viéndolo como fallo...
    expect(hasBlockingFailures(report)).toBe(false); // ...pero run no debe bloquear por esto solo
  });

  test('un fallo de cualquier otro kind SÍ bloquea, esté o no acompañado de un fallo mcp-schema', () => {
    const soloEnv = reportWith([
      { kind: 'env', name: 'MY_TOKEN', ok: false, detail: 'sin definir' },
    ]);
    expect(hasBlockingFailures(soloEnv)).toBe(true);

    const envYmcpSchema = reportWith([
      { kind: 'env', name: 'MY_TOKEN', ok: false, detail: 'sin definir' },
      { kind: 'mcp-schema', name: 'pw', ok: false, detail: 'deriva de esquema' },
    ]);
    expect(hasBlockingFailures(envYmcpSchema)).toBe(true);
  });

  test('sin ningún fallo, no bloquea', () => {
    const report = reportWith([{ kind: 'auth', name: 'claude', ok: true, detail: 'ok' }]);
    expect(hasBlockingFailures(report)).toBe(false);
  });
});

// `reader.read()` en
// `listMcpToolsViaStdio` esperaba indefinidamente si el servidor MCP nunca
// respondía. `sleep` como "servidor" nunca escribe nada en stdout ni
// termina por su cuenta durante la ventana del test — el único motivo por
// el que este test termina rápido es el timeout nuevo (pasado explícitamente
// muy corto aquí; en producción es MCP_HANDSHAKE_TIMEOUT_MS, 12s).
describe('listMcpToolsViaStdio — timeout del handshake', () => {
  test('un servidor que nunca responde falla con "tiempo agotado" en vez de colgarse — no espera los 12s por defecto', async () => {
    await expect(
      listMcpToolsViaStdio({ command: 'sleep', args: ['30'], env: [] }, {}, 100),
    ).rejects.toThrow(/tiempo agotado/);
  });
});
