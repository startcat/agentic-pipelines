import { describe, expect, test } from 'bun:test';
import { parsePipeline, PipelineParseError, type AgentStep } from '../../src/schema/pipeline.ts';

const MINIMAL = `
name: demo
description: Un pipeline mínimo
version: 1
steps:
  - id: hello
    type: shell
    run: echo hola
`;

describe('parsePipeline', () => {
  test('acepta un pipeline mínimo y aplica los valores por defecto', () => {
    const p = parsePipeline(MINIMAL);
    expect(p.name).toBe('demo');
    expect(p.version).toBe(1);
    expect(p.steps).toHaveLength(1);
    const step = p.steps[0]!;
    expect(step.type).toBe('shell');
    expect(step.onError).toBe('stop');
    expect(step.retry).toEqual({ attempts: 0, on: 'transient' });
    expect(step.timeout).toBe('15m');
  });

  test('el tipo por defecto de un paso es agent', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    agent: writer
    prompt: steps/a.md
`);
    expect(p.steps[0]!.type).toBe('agent');
  });

  test('acepta max_cost_usd opcional en un paso agent', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    agent: writer
    prompt: p.md
    max_cost_usd: 2.5
`);
    const step = p.steps[0]! as AgentStep;
    expect(step.maxCostUsd).toBe(2.5);
  });

  test('max_cost_usd es undefined si no se declara', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    agent: writer
    prompt: p.md
`);
    const step = p.steps[0]! as AgentStep;
    expect(step.maxCostUsd).toBeUndefined();
  });

  test('rechaza un max_cost_usd negativo o cero', () => {
    expect(() =>
      parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    agent: writer
    prompt: p.md
    max_cost_usd: 0
`),
    ).toThrow(PipelineParseError);
  });

  test('los defaults del pipeline se propagan a los pasos que no los declaran', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
defaults:
  on_error: continue
  retry: 2
  timeout: 5m
steps:
  - id: a
    type: shell
    run: 'true'
  - id: b
    type: shell
    run: 'true'
    on_error: stop
`);
    expect(p.steps[0]!.onError).toBe('continue');
    expect(p.steps[0]!.retry).toEqual({ attempts: 2, on: 'transient' });
    expect(p.steps[0]!.timeout).toBe('5m');
    expect(p.steps[1]!.onError).toBe('stop');
  });

  test('rechaza un paso agent sin prompt nombrando el campo', () => {
    try {
      parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    agent: writer
`);
      throw new Error('debería haber lanzado');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineParseError);
      const issues = (err as PipelineParseError).issues;
      expect(issues.some((i) => i.includes('steps.0.prompt'))).toBe(true);
      expect(issues.some((i) => i === 'steps.0: Invalid input')).toBe(false);
    }
  });

  test('rechaza un paso shell sin run nombrando el campo', () => {
    try {
      parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
`);
      throw new Error('debería haber lanzado');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineParseError);
      const issues = (err as PipelineParseError).issues;
      expect(issues.some((i) => i.includes('steps.0.run'))).toBe(true);
      expect(issues.some((i) => i === 'steps.0: Invalid input')).toBe(false);
    }
  });

  test('rechaza ids de paso duplicados nombrando el id', () => {
    try {
      parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: 'true'
  - id: a
    type: shell
    run: 'true'
`);
      throw new Error('debería haber lanzado');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineParseError);
      expect((err as PipelineParseError).issues.join(' ')).toContain('a');
    }
  });

  test('rechaza YAML sintácticamente inválido', () => {
    expect(() => parsePipeline('name: [sin cerrar')).toThrow(PipelineParseError);
  });

  // El formato usa `on_error` en todos sus ejemplos; antes de este arreglo
  // el esquema aceptaba `onError` y Zod descartaba en silencio la clave
  // `on_error` (y cualquier otro typo), sin avisar. `.strict()` convierte eso en
  // un error que nombra la clave.
  test('la clave YAML es on_error, tal como la documenta el formato, y sí tiene efecto', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: exit 1
    on_error: continue
`);
    expect(p.steps[0]!.onError).toBe('continue');
  });

  test('rechaza un typo en un campo de paso nombrando la clave desconocida', () => {
    try {
      parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: 'true'
    outpus: { n: number }
`);
      throw new Error('debería haber lanzado');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineParseError);
      const issues = (err as PipelineParseError).issues;
      expect(issues.some((i) => i.includes('outpus'))).toBe(true);
    }
  });

  test('rechaza un typo en defaults nombrando la clave desconocida', () => {
    try {
      parsePipeline(`
name: demo
description: d
version: 1
defaults:
  retires: 2
steps:
  - id: a
    type: shell
    run: 'true'
`);
      throw new Error('debería haber lanzado');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineParseError);
      const issues = (err as PipelineParseError).issues;
      expect(issues.some((i) => i.includes('retires'))).toBe(true);
    }
  });

  test('rechaza una clave desconocida a nivel de pipeline nombrándola', () => {
    try {
      parsePipeline(`
name: demo
description: d
version: 1
paramas:
  x: 1
steps:
  - id: a
    type: shell
    run: 'true'
`);
      throw new Error('debería haber lanzado');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineParseError);
      const issues = (err as PipelineParseError).issues;
      expect(issues.some((i) => i.includes('paramas'))).toBe(true);
    }
  });

  test('acepta notify.on con failed (no failure) y lo expone tal cual', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
notify:
  on: [failed, success]
  channel: telegram
steps:
  - id: a
    type: shell
    run: 'true'
`);
    expect(p.notify).toEqual({ on: ['failed', 'success'], channel: 'telegram' });
  });

  test('rechaza el nombre antiguo failure en notify.on', () => {
    expect(() =>
      parsePipeline(`
name: demo
description: d
version: 1
notify:
  on: [failure]
  channel: telegram
steps:
  - id: a
    type: shell
    run: 'true'
`),
    ).toThrow(PipelineParseError);
  });
});

describe('mcp_servers', () => {
  test('resuelve el registro del pipeline y los nombres activados por un paso', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
mcp_servers:
  playwright:
    command: npx
    args: ["-y", "@playwright/mcp@latest", "--headless"]
    env: [PLAYWRIGHT_TOKEN]
steps:
  - id: a
    agent: writer
    prompt: p.md
    mcp_servers: [playwright]
`);
    expect(p.mcpServers).toEqual({
      playwright: {
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest', '--headless'],
        env: ['PLAYWRIGHT_TOKEN'],
      },
    });
    const step = p.steps[0]!;
    expect(step.type).toBe('agent');
    expect((step as { mcpServers: string[] }).mcpServers).toEqual(['playwright']);
  });

  test('un paso sin mcp_servers queda con una lista vacía', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    agent: writer
    prompt: p.md
`);
    expect((p.steps[0] as { mcpServers: string[] }).mcpServers).toEqual([]);
  });

  test('args y env de un servidor por defecto son listas vacías', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
mcp_servers:
  bare:
    command: some-mcp-server
steps:
  - id: a
    type: shell
    run: 'true'
`);
    expect(p.mcpServers.bare).toEqual({ command: 'some-mcp-server', args: [], env: [] });
  });

  test('rechaza un paso que referencia un servidor MCP no declarado, nombrando el paso y el índice', () => {
    try {
      parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    agent: writer
    prompt: p.md
    mcp_servers: [playwright]
`);
      throw new Error('debería haber lanzado');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineParseError);
      const issues = (err as PipelineParseError).issues;
      expect(issues).toEqual([
        'steps.0.mcp_servers.0: servidor MCP "playwright" no declarado en mcp_servers',
      ]);
    }
  });

  test('rechaza una tool mcp__ en tools sin el servidor activado en mcp_servers', () => {
    try {
      parsePipeline(`
name: demo
description: d
version: 1
mcp_servers:
  playwright:
    command: npx
    kind: playwright
steps:
  - id: a
    agent: writer
    prompt: p.md
    tools: [Read, mcp__playwright__browser_navigate]
`);
      throw new Error('debería haber lanzado');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineParseError);
      const issues = (err as PipelineParseError).issues;
      expect(issues).toEqual([
        'steps.0.tools.1: la herramienta "mcp__playwright__browser_navigate" requiere activar su servidor en mcp_servers',
      ]);
    }
  });

  test('acepta una tool mcp__ cuando su servidor está activado en mcp_servers', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
mcp_servers:
  playwright:
    command: npx
    kind: playwright
steps:
  - id: a
    agent: writer
    prompt: p.md
    mcp_servers: [playwright]
    tools: [Read, mcp__playwright__browser_navigate]
`);
    expect((p.steps[0] as { tools: string[] }).tools).toContain('mcp__playwright__browser_navigate');
  });

  test('rechaza un nombre de servidor MCP que no es kebab-case', () => {
    try {
      parsePipeline(`
name: demo
description: d
version: 1
mcp_servers:
  "Play Wright":
    command: npx
steps:
  - id: a
    type: shell
    run: 'true'
`);
      throw new Error('debería haber lanzado');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineParseError);
      const issues = (err as PipelineParseError).issues;
      expect(issues.some((i) => i.includes('mcp_servers') && i.includes('kebab-case'))).toBe(true);
    }
  });

  test('rechaza una clave desconocida dentro de un servidor MCP nombrándola', () => {
    try {
      parsePipeline(`
name: demo
description: d
version: 1
mcp_servers:
  playwright:
    comand: npx
steps:
  - id: a
    type: shell
    run: 'true'
`);
      throw new Error('debería haber lanzado');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineParseError);
      const issues = (err as PipelineParseError).issues;
      expect(issues.some((i) => i.includes('comand'))).toBe(true);
    }
  });

  test('un servidor mcp_servers puede declarar kind: playwright, y una tool mcp__<servidor>__<sufijo> conocida para ese kind se acepta con el nombre de servidor que elija el autor', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
mcp_servers:
  pw:
    command: npx
    args: ["-y", "@playwright/mcp@latest"]
    kind: playwright
steps:
  - id: a
    agent: writer
    prompt: p.md
    mcp_servers: [pw]
    tools: [mcp__pw__browser_click, mcp__pw__browser_take_screenshot]
`);
    expect(p.mcpServers.pw!.kind).toBe('playwright');
  });

  test('una tool mcp__<servidor>__<sufijo> cuyo servidor no declara kind: se rechaza', () => {
    expect(() =>
      parsePipeline(`
name: demo
description: d
version: 1
mcp_servers:
  pw:
    command: npx
    args: ["-y", "@playwright/mcp@latest"]
steps:
  - id: a
    agent: writer
    prompt: p.md
    mcp_servers: [pw]
    tools: [mcp__pw__browser_click]
`),
    ).toThrow(/kind/);
  });

  test('un sufijo mcp__<servidor>__<sufijo> que kind: playwright no reconoce se rechaza', () => {
    expect(() =>
      parsePipeline(`
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
    tools: [mcp__pw__no_existe_esta_tool]
`),
    ).toThrow(/no_existe_esta_tool/);
  });

  test('mcp__<servidor>__browser_evaluate se rechaza con un motivo específico, aunque el servidor declare kind: playwright', () => {
    expect(() =>
      parsePipeline(`
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
    tools: [mcp__pw__browser_evaluate]
`),
    ).toThrow(/código.*arbitrario/);
  });
});

describe('gobierno de tools: — deny-by-default', () => {
  test('una tool nativa desconocida para el motor se rechaza con el nombre de la tool', () => {
    expect(() =>
      parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    agent: writer
    prompt: p.md
    tools: [TotallyMadeUpTool]
`),
    ).toThrow(/TotallyMadeUpTool/);
  });

  test('Bash en tools: de un paso agent se rechaza, sugiriendo type: shell', () => {
    expect(() =>
      parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    agent: writer
    prompt: p.md
    tools: [Bash]
`),
    ).toThrow(/type: shell/);
  });

  test('las tools nativas conocidas (Read/Write/Edit/NotebookEdit/Glob/Grep) nunca se rechazan por nombre', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    agent: writer
    prompt: p.md
    tools: [Read, Write, Edit, NotebookEdit, Glob, Grep]
`);
    expect((p.steps[0] as AgentStep).tools).toEqual(['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep']);
  });
});

describe('guardas de when — mensajes específicos', () => {
  function parseWhen(guard: string): PipelineParseError {
    try {
      parsePipeline(`
name: demo
description: d
version: 1
when:
  - ${guard}
steps:
  - id: a
    type: shell
    run: 'true'
`);
      throw new Error('debería haber lanzado');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineParseError);
      return err as PipelineParseError;
    }
  }

  test('un throttle.every mal formado nombra el campo throttle.every', () => {
    const err = parseWhen('throttle: { every: "3 horas" }');
    expect(err.issues.some((i) => i.includes('when.0') && i.includes('every'))).toBe(true);
  });

  test('un between fuera de formato nombra el campo between', () => {
    const err = parseWhen('between: "mañana"');
    expect(err.issues.some((i) => i.includes('when.0') && i.includes('between'))).toBe(true);
  });

  test('un changed sin path nombra el campo changed.path', () => {
    const err = parseWhen('changed: {}');
    expect(err.issues.some((i) => i.includes('when.0') && i.includes('path'))).toBe(true);
  });

  test('una guarda sin ninguna clave reconocida lo dice explícitamente', () => {
    const err = parseWhen('foo: bar');
    expect(err.issues.some((i) => i.includes('when.0') && i.includes('throttle'))).toBe(true);
  });

  test('una guarda con dos claves de tipo distinto lo dice explícitamente', () => {
    const err = parseWhen('{ throttle: 4h, shell: "true" }');
    expect(err.issues.some((i) => i.includes('when.0'))).toBe(true);
  });

  test('un shell válido sigue parseando con éxito (sin regresión)', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
when:
  - shell: "true"
steps:
  - id: a
    type: shell
    run: 'true'
`);
    expect(p.when).toEqual([{ shell: 'true' }]);
  });

  // Las cuatro ramas de guarda (y los objetos anidados de throttle/changed)
  // son `.strict()`: una clave desconocida ya no se descarta en silencio
  // (comportamiento confirmado ANTES de este arreglo: `sinc` en vez de
  // `since` parseaba sin error y la guarda anclaba en el default
  // equivocado). Misma convención `.strict()` ya establecida en el resto del
  // fichero.
  test('un typo dentro de throttle (rama objeto) se rechaza, no se descarta en silencio', () => {
    const err = parseWhen('throttle: { every: "4h", sinc: last_attempt }');
    expect(err.issues.some((i) => i.includes('when.0'))).toBe(true);
  });

  test('un typo dentro de changed se rechaza, no se descarta en silencio', () => {
    const err = parseWhen('changed: { path: /x, sinc: last_attempt }');
    expect(err.issues.some((i) => i.includes('when.0'))).toBe(true);
  });

  test('una clave extra a nivel de shell se rechaza', () => {
    const err = parseWhen('{ shell: "true", extra: 1 }');
    expect(err.issues.some((i) => i.includes('when.0'))).toBe(true);
  });

  test('una clave extra a nivel de between se rechaza', () => {
    const err = parseWhen('{ between: "07:00-23:00", extra: 1 }');
    expect(err.issues.some((i) => i.includes('when.0'))).toBe(true);
  });

  test('throttle como duración simple (rama string, no objeto) sigue parseando con éxito', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
when:
  - throttle: 4h
steps:
  - id: a
    type: shell
    run: 'true'
`);
    expect(p.when).toEqual([{ throttle: '4h' }]);
  });

  test('throttle con since correcto (sin typo) sigue parseando con éxito', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
when:
  - throttle: { every: 4h, since: last_attempt }
steps:
  - id: a
    type: shell
    run: 'true'
`);
    expect(p.when).toEqual([{ throttle: { every: '4h', since: 'last_attempt' } }]);
  });

  test('changed con since correcto (sin typo) sigue parseando con éxito', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
when:
  - changed: { path: /x, since: last_attempt }
steps:
  - id: a
    type: shell
    run: 'true'
`);
    expect(p.when).toEqual([{ changed: { path: '/x', since: 'last_attempt' } }]);
  });
});

describe('always — limpieza incondicional', () => {
  test('acepta un bloque always y lo expone como pasos shell', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: 'true'
always:
  - id: cleanup
    run: git reset --hard
    cwd: /tmp
`);
    expect(p.always).toHaveLength(1);
    expect(p.always[0]).toMatchObject({
      id: 'cleanup', type: 'shell', run: 'git reset --hard', cwd: '/tmp',
    });
  });

  test('sin always declarado, la lista está vacía', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: 'true'
`);
    expect(p.always).toEqual([]);
  });

  test('un id de always duplicado con uno de steps se rechaza', () => {
    expect(() =>
      parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: 'true'
always:
  - id: a
    run: 'true'
`),
    ).toThrow(PipelineParseError);
  });

  test('dos entradas de always con el mismo id (sin colisión con steps) se rechazan', () => {
    try {
      parsePipeline(`
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
  - id: cleanup
    run: 'echo again'
`);
      throw new Error('debería haber lanzado');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineParseError);
      expect(
        (err as PipelineParseError).issues.some(
          (i) => i.includes('always') && i.includes('cleanup'),
        ),
      ).toBe(true);
    }
  });

  test('rechaza una clave desconocida dentro de always nombrándola', () => {
    try {
      parsePipeline(`
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
    when: "true"
`);
      throw new Error('debería haber lanzado');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineParseError);
      expect((err as PipelineParseError).issues.some((i) => i.includes('when'))).toBe(true);
    }
  });
});

describe('notify.stale_after', () => {
  const withNotify = (notify: string) =>
    parsePipeline(`
name: demo
description: d
version: 1
notify:
${notify}
steps:
  - id: a
    type: shell
    run: 'true'
`);

  test('acepta una duración válida', () => {
    const p = withNotify('  on: [success]\n  stale_after: 72h\n  channel: c');
    expect(p.notify?.staleAfter).toBe('72h');
  });

  test('es opcional', () => {
    const p = withNotify('  on: [success]\n  channel: c');
    expect(p.notify?.staleAfter).toBeUndefined();
  });

  test('rechaza una duración mal formada', () => {
    expect(() => withNotify('  on: [success]\n  stale_after: 3 dias\n  channel: c')).toThrow(/stale_after/);
  });

  // Sin `.strict()`, un `stale_after` mal escrito se ignoraría en silencio —
  // justo la clase de fallo mudo que este campo existe para evitar.
  test('rechaza una clave desconocida dentro de notify', () => {
    expect(() => withNotify('  on: [success]\n  stale_afer: 72h\n  channel: c')).toThrow();
  });
});
