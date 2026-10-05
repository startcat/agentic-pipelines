import { describe, expect, test } from 'bun:test';
import { parsePipeline } from '../../src/schema/pipeline.ts';
import { buildGraph, GraphError } from '../../src/graph/build.ts';

describe('buildGraph', () => {
  test('deriva dependencias del campo inputs', () => {
    const g = buildGraph(
      parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: scan
    type: shell
    run: 'true'
    outputs: { pages: 'string[]' }
  - id: draft
    type: shell
    run: 'true'
    inputs: [scan.pages]
`),
    );
    expect(g.dependencies.get('draft')).toEqual(new Set(['scan']));
    expect(g.dependents.get('scan')).toEqual(new Set(['draft']));
    expect(g.order).toEqual(['scan', 'draft']);
  });

  test('deriva dependencias de referencias en run, when y cwd', () => {
    const g = buildGraph(
      parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: scan
    type: shell
    run: 'true'
    outputs: { pr_url: string, count: number }
  - id: notify
    type: shell
    run: echo {{scan.pr_url}}
    when: "{{scan.count}} > 0"
`),
    );
    expect(g.dependencies.get('notify')).toEqual(new Set(['scan']));
  });

  // `checkStepReferences` (graph/prompts.ts) SÍ valida y acepta un
  // `{{steps.x.field}}` dentro de `additional_dirs`, pero sin esta arista el
  // grafo no sabía que el paso dependía de él — `additional_dirs: [scan.dir]`
  // pasaba `pipelines validate` sin aviso y podía ejecutarse ANTES que
  // "scan", produciendo un "Referencia sin resolver" en tiempo de ejecución
  // (`interpolate()`, `runAgentStep`) en vez de que el grafo ordenara los
  // pasos correctamente.
  test('deriva dependencias de una referencia en additional_dirs de un paso agent', () => {
    const g = buildGraph(
      parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: scan
    agent: writer
    prompt: p.md
    outputs: { dir: string }
  - id: review
    agent: writer
    prompt: p.md
    additional_dirs: ["{{scan.dir}}"]
`),
    );
    expect(g.dependencies.get('review')).toEqual(new Set(['scan']));
    expect(g.dependents.get('scan')).toEqual(new Set(['review']));
    expect(g.order).toEqual(['scan', 'review']);
  });

  test('ignora las referencias a params al construir el grafo', () => {
    const g = buildGraph(
      parsePipeline(`
name: demo
description: d
version: 1
params:
  root: { description: r, default: /tmp }
steps:
  - id: a
    type: shell
    run: ls {{params.root}}
`),
    );
    expect(g.dependencies.get('a')).toEqual(new Set());
  });

  test('mantiene el orden declarado entre pasos independientes', () => {
    const g = buildGraph(
      parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: 'true'
  - id: b
    type: shell
    run: 'true'
  - id: c
    type: shell
    run: 'true'
`),
    );
    expect(g.order).toEqual(['a', 'b', 'c']);
  });

  test('detecta un ciclo y nombra los pasos implicados', () => {
    try {
      buildGraph(
        parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: echo {{b.x}}
    outputs: { x: string }
  - id: b
    type: shell
    run: echo {{a.x}}
    outputs: { x: string }
`),
      );
      throw new Error('debería haber lanzado');
    } catch (err) {
      expect(err).toBeInstanceOf(GraphError);
      const text = (err as GraphError).issues.join(' ');
      expect(text).toContain('a');
      expect(text).toContain('b');
    }
  });

  test('rechaza una referencia a un paso inexistente', () => {
    expect(() =>
      buildGraph(
        parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: echo {{fantasma.x}}
`),
      ),
    ).toThrow(/fantasma/);
  });

  test('rechaza una referencia a un campo que el paso origen no declara', () => {
    expect(() =>
      buildGraph(
        parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: scan
    type: shell
    run: 'true'
    outputs: { pages: 'string[]' }
  - id: b
    type: shell
    run: echo {{scan.nope}}
`),
      ),
    ).toThrow(/scan\.nope/);
  });

  test('en un ciclo, no acusa a un paso meramente bloqueado de formar parte de él', () => {
    try {
      buildGraph(
        parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: echo {{b.x}}
    outputs: { x: string }
  - id: b
    type: shell
    run: echo {{a.x}}
    outputs: { x: string }
  - id: c
    type: shell
    run: 'true'
    inputs: [a.x]
`),
      );
      throw new Error('debería haber lanzado');
    } catch (err) {
      expect(err).toBeInstanceOf(GraphError);
      const issues = (err as GraphError).issues;

      const cycleIssue = issues.find((i) => i.startsWith('ciclo de dependencias'));
      expect(cycleIssue).toBeDefined();
      const cycleMembers = cycleIssue!
        .replace('ciclo de dependencias entre los pasos: ', '')
        .split(', ');
      expect(cycleMembers.sort()).toEqual(['a', 'b']);

      const blockedIssue = issues.find((i) => i.startsWith('pasos bloqueados'));
      expect(blockedIssue).toBeDefined();
      expect(blockedIssue).toContain('c');
    }
  });

  test('acumula un input malformado junto a una referencia a un paso inexistente', () => {
    try {
      buildGraph(
        parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: echo {{fantasma.x}}
  - id: b
    type: shell
    run: 'true'
    inputs: [huerfano]
`),
      );
      throw new Error('debería haber lanzado');
    } catch (err) {
      expect(err).toBeInstanceOf(GraphError);
      const issues = (err as GraphError).issues;
      expect(issues.some((i) => i.includes('fantasma'))).toBe(true);
      expect(issues.some((i) => i.includes('huerfano'))).toBe(true);
      expect(issues.length).toBe(2);
    }
  });

  test('reporta dos ciclos independientes por separado, sin fusionarlos ni etiquetarlos como bloqueo', () => {
    try {
      buildGraph(
        parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: echo {{b.x}}
    outputs: { x: string }
  - id: b
    type: shell
    run: echo {{a.x}}
    outputs: { x: string }
  - id: d
    type: shell
    run: echo {{e.x}}
    outputs: { x: string }
  - id: e
    type: shell
    run: echo {{d.x}}
    outputs: { x: string }
`),
      );
      throw new Error('debería haber lanzado');
    } catch (err) {
      expect(err).toBeInstanceOf(GraphError);
      const issues = (err as GraphError).issues;

      const cycleIssues = issues.filter((i) => i.startsWith('ciclo de dependencias'));
      expect(cycleIssues).toHaveLength(2);

      const cycleMembers = cycleIssues.map((i) =>
        i.replace('ciclo de dependencias entre los pasos: ', '').split(', ').sort(),
      );
      expect(cycleMembers).toContainEqual(['a', 'b']);
      expect(cycleMembers).toContainEqual(['d', 'e']);

      // Ningún paso queda etiquetado como "bloqueado": los cuatro son parte
      // de un ciclo (el suyo), ninguno depende meramente de otro.
      expect(issues.some((i) => i.startsWith('pasos bloqueados'))).toBe(false);
    }
  });

  test('funde en un solo ciclo dos ciclos simples que comparten vértice', () => {
    try {
      buildGraph(
        parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: echo {{b.x}}
    outputs: { x: string }
  - id: b
    type: shell
    run: echo {{a.x}} {{c.x}}
    outputs: { x: string }
  - id: c
    type: shell
    run: echo {{b.x}}
    outputs: { x: string }
`),
      );
      throw new Error('debería haber lanzado');
    } catch (err) {
      expect(err).toBeInstanceOf(GraphError);
      const issues = (err as GraphError).issues;

      // a↔b y b↔c comparten el vértice b: son una única componente
      // fuertemente conexa, no dos ciclos separables. Debe reportarse como
      // un solo ciclo con los tres miembros, no como un ciclo a↔b más c
      // "bloqueado" (c sí es cíclico, solo que por el ciclo b↔c).
      const cycleIssues = issues.filter((i) => i.startsWith('ciclo de dependencias'));
      expect(cycleIssues).toHaveLength(1);
      const cycleMembers = cycleIssues[0]!
        .replace('ciclo de dependencias entre los pasos: ', '')
        .split(', ');
      expect(cycleMembers.sort()).toEqual(['a', 'b', 'c']);

      expect(issues.some((i) => i.startsWith('pasos bloqueados'))).toBe(false);
    }
  });

  test('rechaza un input con más de un punto en vez de truncarlo en silencio', () => {
    try {
      buildGraph(
        parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: scan
    type: shell
    run: 'true'
    outputs: { pages: 'string[]' }
  - id: b
    type: shell
    run: 'true'
    inputs: [scan.pages.deep]
`),
      );
      throw new Error('debería haber lanzado');
    } catch (err) {
      expect(err).toBeInstanceOf(GraphError);
      const issues = (err as GraphError).issues;
      expect(issues.some((i) => i.includes('scan.pages.deep'))).toBe(true);
    }
  });
});
