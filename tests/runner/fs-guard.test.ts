import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureRoots, evaluateToolCall, HARD_DENY_TOOLS, TOOL_FS_PROFILES } from '../../src/runner/fs-guard.ts';

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'fs-guard-'));
  const cwd = join(root, 'allowed');
  const outside = join(root, 'outside');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 'SECRET');
  return { root, cwd, outside };
}

describe('captureRoots', () => {
  test('resuelve cwd y additional_dirs con realpath, sin separador final', () => {
    const { cwd, outside } = sandbox();
    const roots = captureRoots(cwd, [outside]);
    expect(roots.cwdRoot).toBe(realpathSync(cwd));
    expect(roots.readRoots).toEqual([realpathSync(outside)]);
  });

  test('lanza si una raíz no existe — error de configuración, no una sorpresa a mitad de run', () => {
    const { cwd } = sandbox();
    expect(() => captureRoots(cwd, [join(cwd, 'no-existe')])).toThrow();
  });
});

describe('evaluateToolCall — Read/Write/Edit dentro y fuera de cwd', () => {
  test('Read dentro de cwd se permite', () => {
    const { cwd } = sandbox();
    writeFileSync(join(cwd, 'a.txt'), 'x');
    const roots = captureRoots(cwd, []);
    expect(evaluateToolCall('Read', { file_path: join(cwd, 'a.txt') }, roots)).toEqual({ allowed: true });
  });

  test('Read fuera de cwd y sin additional_dirs se deniega', () => {
    const { cwd, outside } = sandbox();
    const roots = captureRoots(cwd, []);
    const result = evaluateToolCall('Read', { file_path: join(outside, 'secret.txt') }, roots);
    expect(result.allowed).toBe(false);
  });

  test('Read fuera de cwd pero dentro de un additional_dirs se permite', () => {
    const { cwd, outside } = sandbox();
    const roots = captureRoots(cwd, [outside]);
    expect(evaluateToolCall('Read', { file_path: join(outside, 'secret.txt') }, roots)).toEqual({ allowed: true });
  });

  test('Write dentro de un additional_dirs (solo lectura) se deniega — mutar ahí nunca vale', () => {
    const { cwd, outside } = sandbox();
    const roots = captureRoots(cwd, [outside]);
    const result = evaluateToolCall('Write', { file_path: join(outside, 'new.txt') }, roots);
    expect(result.allowed).toBe(false);
  });

  test('objetivo inexistente con varios niveles de directorios nuevos bajo cwd se permite (Write crea padres)', () => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    const target = join(cwd, 'deep1', 'deep2', 'deep3', 'hello.txt');
    expect(evaluateToolCall('Write', { file_path: target }, roots)).toEqual({ allowed: true });
  });

  test('symlink dentro de cwd apuntando fuera de toda raíz se deniega', () => {
    const { cwd, outside } = sandbox();
    symlinkSync(outside, join(cwd, 'escape'));
    const roots = captureRoots(cwd, []);
    const result = evaluateToolCall('Read', { file_path: join(cwd, 'escape', 'secret.txt') }, roots);
    expect(result.allowed).toBe(false);
  });

  test('".." inmediatamente después de un symlink se rechaza (no se intenta resolver)', () => {
    const { cwd, outside } = sandbox();
    symlinkSync(outside, join(cwd, 'escape'));
    const roots = captureRoots(cwd, []);
    // "allowed/escape/../outside/secret.txt": normalizar-antes-de-resolver daría
    // "allowed/outside/secret.txt" (dentro de cwd, no existe) y permitiría por error
    // — el motivo del bug de realpath en Bun con symlink+"..".
    // NOTA: se construye con concatenación, no con `join()` — `path.join()` normaliza
    // y colapsaría el ".." antes de que la función bajo prueba llegue a verlo.
    const result = evaluateToolCall(
      'Read',
      { file_path: `${join(cwd, 'escape')}/../outside/secret.txt` },
      roots,
    );
    expect(result.allowed).toBe(false);
    expect(result.allowed === false && result.reason).toContain('".."');
  });

  test('ruta con ".." dentro de cwd (sin symlink de por medio) también se rechaza — la regla es sobre el texto crudo, no sobre si escapa de verdad', () => {
    const { cwd } = sandbox();
    mkdirSync(join(cwd, 'sub'));
    const roots = captureRoots(cwd, []);
    // Igual que arriba: concatenación, no `join()`, para que el ".." sobreviva crudo.
    const result = evaluateToolCall('Read', { file_path: `${join(cwd, 'sub')}/../a.txt` }, roots);
    expect(result.allowed).toBe(false);
  });

  test('falso positivo de prefijo hermano: /root-evil no debe colar contra la raíz /root', () => {
    const { root, cwd } = sandbox();
    const evilSibling = `${cwd}-evil`;
    mkdirSync(evilSibling, { recursive: true });
    writeFileSync(join(evilSibling, 'x.txt'), 'x');
    const roots = captureRoots(cwd, []);
    const result = evaluateToolCall('Read', { file_path: join(evilSibling, 'x.txt') }, roots);
    expect(result.allowed).toBe(false);
    void root;
  });

  test('la propia raíz (sin fichero dentro) se permite para una tool que opera sobre un directorio', () => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    expect(evaluateToolCall('Grep', { pattern: 'x', path: cwd }, roots)).toEqual({ allowed: true });
  });
});

describe('evaluateToolCall — Glob/Grep', () => {
  test('Glob con patrón absoluto y sin "path" se evalúa por el patrón mismo', () => {
    const { cwd, outside } = sandbox();
    const roots = captureRoots(cwd, []);
    const result = evaluateToolCall('Glob', { pattern: join(outside, '*.txt') }, roots);
    expect(result.allowed).toBe(false);
  });

  test('Glob con patrón sin ningún metacarácter, absoluto y fuera de toda raíz, se trata como ruta llana y se deniega', () => {
    const { cwd, outside } = sandbox();
    const roots = captureRoots(cwd, []);
    const result = evaluateToolCall('Glob', { pattern: join(outside, 'secret.txt') }, roots);
    expect(result.allowed).toBe(false);
  });

  test('patrón "/**/..." absoluto: base vacía se interpreta como raíz del filesystem, se deniega', () => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    const result = evaluateToolCall('Glob', { pattern: '/**/etc/passwd' }, roots);
    expect(result.allowed).toBe(false);
  });

  test('patrón "**/..." relativo (sin barra inicial): base vacía se interpreta como cwd, se permite', () => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    const result = evaluateToolCall('Glob', { pattern: '**/*.png' }, roots);
    expect(result.allowed).toBe(true);
  });

  test('Grep con "path" absoluto fuera de cwd se deniega aunque "glob" esté vacío', () => {
    const { cwd, outside } = sandbox();
    const roots = captureRoots(cwd, []);
    const result = evaluateToolCall('Grep', { pattern: 'x', path: outside }, roots);
    expect(result.allowed).toBe(false);
  });
});

describe('evaluateToolCall — tools de escritura de Playwright (path absoluto exigido)', () => {
  test('filename relativo se deniega (la base real es el output-dir del servidor MCP, no cwd)', () => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    const result = evaluateToolCall('browser_take_screenshot', { filename: 'shot.png' }, roots);
    expect(result.allowed).toBe(false);
  });

  test('filename absoluto dentro de cwd se permite', () => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    const result = evaluateToolCall(
      'browser_take_screenshot',
      { filename: join(cwd, 'public', 'screenshots', 'shot.png') },
      roots,
    );
    expect(result.allowed).toBe(true);
  });

  test('filename AUSENTE (campo opcional) no se deniega — se salta, no se pasa undefined al resolutor', () => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    expect(evaluateToolCall('browser_snapshot', {}, roots)).toEqual({ allowed: true });
  });

  test('browser_file_upload con paths[] fuera de cwd se deniega', () => {
    const { cwd, outside } = sandbox();
    const roots = captureRoots(cwd, []);
    const result = evaluateToolCall(
      'browser_file_upload',
      { paths: [join(cwd, 'ok.png'), join(outside, 'secret.txt')] },
      roots,
    );
    expect(result.allowed).toBe(false);
  });

  test('browser_navigate con esquema http se permite, con file:// se deniega', () => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    expect(evaluateToolCall('browser_navigate', { url: 'https://admin.example.com/login' }, roots)).toEqual({
      allowed: true,
    });
    const result = evaluateToolCall('browser_navigate', { url: 'file:///etc/passwd' }, roots);
    expect(result.allowed).toBe(false);
  });
});

describe('evaluateToolCall — tools "none" y bucket de denegación dura', () => {
  test('una tool sin superficie de filesystem se permite siempre', () => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    expect(evaluateToolCall('browser_click', { ref: 'x' }, roots)).toEqual({ allowed: true });
  });

  test.each([...HARD_DENY_TOOLS])('%s está en el bucket de denegación dura y se deniega siempre', (name) => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    expect(evaluateToolCall(name, {}, roots).allowed).toBe(false);
  });

  test('una tool desconocida (ni en la tabla ni en el bucket duro) se deniega', () => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    // Bare, sin prefijo `mcp__` — un nombre genuinamente inexistente en
    // `TOOL_FS_PROFILES`, sin relación con el asunto del test de abajo. Antes
    // este mismo test usaba 'mcp__futuro-servidor__algo_nuevo' como ejemplo,
    // lo que confundía dos motivos de denegación distintos bajo la misma
    // etiqueta "tool desconocida" — ver el test siguiente.
    const result = evaluateToolCall('algo-que-no-existe', {}, roots);
    expect(result.allowed).toBe(false);
  });

  // `evaluateToolCall` en SÍ
  // MISMA nunca interpreta el prefijo `mcp__<servidor>__` — ni para una tool
  // MCP real y concedida (`browser_take_screenshot`, con perfil completo en
  // la tabla) ni para una inventada. Antes de la corrección, esto hacía que
  // TODA llamada MCP real llegara aquí con el nombre cualificado intacto y
  // cayera en "tool desconocida para el motor", denegando las 18+ tools de
  // Playwright que un pipeline real concede — nunca detectado porque el
  // único test que tocaba esta forma de nombre ('mcp__futuro-servidor__algo_nuevo',
  // arriba en versiones anteriores de este fichero) usaba un servidor y una
  // tool genuinamente inexistentes, así que su denegación parecía "tool
  // desconocida, correctamente denegada" sin más — documentando el síntoma
  // del bug como si fuera el comportamiento esperado.
  //
  // El fix real vive un nivel por encima, en `makePreToolUseHook`
  // (`runner/agent.ts`): esa función SÍ conoce qué servidores activó el paso
  // (`step.mcpServers`) y quita el prefijo `mcp__<servidor>__` SOLO para
  // esos servidores, antes de llamar a `evaluateToolCall` — nunca aquí, que
  // deliberadamente no tiene ese contexto (no puede decidir con seguridad
  // qué prefijo pertenece a un servidor legítimo de este paso). Este test
  // fija ese límite de capa como intencional: `evaluateToolCall` denegando un
  // nombre `mcp__...` sin normalizar es correcto, no un bug — la cobertura
  // del caso real (mismo nombre, ya normalizado por el hook, con contexto de
  // servidor) vive en `tests/runner/agent.test.ts`.
  test('evaluateToolCall en sí misma NUNCA interpreta el prefijo mcp__<servidor>__, ni para una tool MCP real y concedida — normalizarlo es responsabilidad del hook, no de esta función', () => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    const result = evaluateToolCall('mcp__playwright__browser_take_screenshot', {}, roots);
    expect(result.allowed).toBe(false);
    expect((result as { reason: string }).reason).toContain('tool desconocida para el motor');
  });

  // Hallado en la primera ejecución real de un pipeline: el SDK invoca
  // `StructuredOutput` como CANAL PRINCIPAL de salida de todo paso con
  // `outputs:` (su propio prompt obliga al modelo a llamarla exactamente una
  // vez al final del turno) — no figura en `step.tools`/`allowedTools` (no
  // es algo que un pipeline "conceda") y no tiene ninguna superficie de
  // filesystem (ver comentario junto a su entrada en `TOOL_FS_PROFILES`). Al
  // no figurar en la tabla, caía en "tool desconocida para el motor" y
  // tumbaba el paso con "el resultado no es JSON válido" — no un caso raro
  // de una tool MCP, sino el mecanismo más usado del motor a una llamada de
  // modelo de romperse en cualquier ejecución.
  test('StructuredOutput (canal principal de salida de outputFormat del SDK) se permite siempre — no tiene superficie de filesystem y no depende de step.tools', () => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    expect(evaluateToolCall('StructuredOutput', { summary: 'x' }, roots)).toEqual({ allowed: true });
  });
});

describe('evaluateToolCall — nunca lanza, siempre denota', () => {
  test('tool_input con forma inesperada (no objeto) deniega en vez de lanzar', () => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    expect(() => evaluateToolCall('Read', 'no-es-un-objeto', roots)).not.toThrow();
    expect(evaluateToolCall('Read', 'no-es-un-objeto', roots).allowed).toBe(false);
  });

  test('tool_input null deniega en vez de lanzar', () => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    expect(evaluateToolCall('Read', null, roots).allowed).toBe(false);
  });

  test('un campo de ruta obligatorio ausente deniega (distinto del caso opcional de arriba)', () => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    expect(evaluateToolCall('Read', {}, roots).allowed).toBe(false);
  });

  test('un campo de ruta con tipo inesperado (número) deniega sin lanzar', () => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    expect(() => evaluateToolCall('Write', { file_path: 12345 }, roots)).not.toThrow();
    expect(evaluateToolCall('Write', { file_path: 12345 }, roots).allowed).toBe(false);
  });
});

describe('TOOL_FS_PROFILES — cobertura completa', () => {
  test('todas las tools nativas del motor tienen perfil', () => {
    for (const name of ['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep']) {
      expect(TOOL_FS_PROFILES[name]).toBeDefined();
    }
  });

  test('las 20 tools de Playwright que concede docs-review tienen perfil o están en el bucket duro', () => {
    const granted = [
      'browser_click', 'browser_close', 'browser_console_messages', 'browser_drag', 'browser_drop',
      'browser_file_upload', 'browser_fill_form', 'browser_find', 'browser_handle_dialog', 'browser_hover',
      'browser_navigate', 'browser_navigate_back', 'browser_network_requests', 'browser_press_key',
      'browser_resize', 'browser_select_option', 'browser_snapshot', 'browser_take_screenshot',
      'browser_type', 'browser_wait_for',
    ];
    for (const name of granted) {
      expect(TOOL_FS_PROFILES[name] !== undefined || HARD_DENY_TOOLS.has(name)).toBe(true);
    }
  });

  test('browser_evaluate y browser_run_code_unsafe están en el bucket duro, no en la tabla', () => {
    expect(HARD_DENY_TOOLS.has('browser_evaluate')).toBe(true);
    expect(HARD_DENY_TOOLS.has('browser_run_code_unsafe')).toBe(true);
    expect(TOOL_FS_PROFILES['browser_evaluate']).toBeUndefined();
  });
});
