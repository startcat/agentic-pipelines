import { describe, expect, test } from 'bun:test';
import { parsePipeline } from '../../src/schema/pipeline.ts';
import { buildGraph, GraphError } from '../../src/graph/build.ts';

describe('buildGraph', () => {
  test('derives dependencies from the inputs field', () => {
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

  test('derives dependencies from references in run, when and cwd', () => {
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

  // `checkStepReferences` (graph/prompts.ts) DOES validate and accept a
  // `{{steps.x.field}}` inside `additional_dirs`, but without this edge the
  // graph did not know the step depended on it — `additional_dirs:
  // [scan.dir]` passed `pipelines validate` with no warning and could run
  // BEFORE "scan", producing an "Unresolved reference" at run time
  // (`interpolate()`, `runAgentStep`) instead of the graph ordering the
  // steps correctly.
  test('derives dependencies from a reference in additional_dirs of an agent step', () => {
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

  test('ignores references to params when building the graph', () => {
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

  test('keeps the declared order among independent steps', () => {
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

  test('detects a cycle and names the steps involved', () => {
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
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GraphError);
      const text = (err as GraphError).issues.join(' ');
      expect(text).toContain('a');
      expect(text).toContain('b');
    }
  });

  test('rejects a reference to a nonexistent step', () => {
    expect(() =>
      buildGraph(
        parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: echo {{ghost.x}}
`),
      ),
    ).toThrow(/ghost/);
  });

  test('rejects a reference to a field the source step does not declare', () => {
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

  test('in a cycle, does not accuse a merely blocked step of being part of it', () => {
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
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GraphError);
      const issues = (err as GraphError).issues;

      const cycleIssue = issues.find((i) => i.startsWith('dependency cycle'));
      expect(cycleIssue).toBeDefined();
      const cycleMembers = cycleIssue!
        .replace('dependency cycle between the steps: ', '')
        .split(', ');
      expect(cycleMembers.sort()).toEqual(['a', 'b']);

      const blockedIssue = issues.find((i) => i.startsWith('steps blocked'));
      expect(blockedIssue).toBeDefined();
      expect(blockedIssue).toContain('c');
    }
  });

  test('accumulates a malformed input alongside a reference to a nonexistent step', () => {
    try {
      buildGraph(
        parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: echo {{ghost.x}}
  - id: b
    type: shell
    run: 'true'
    inputs: [orphan]
`),
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GraphError);
      const issues = (err as GraphError).issues;
      expect(issues.some((i) => i.includes('ghost'))).toBe(true);
      expect(issues.some((i) => i.includes('orphan'))).toBe(true);
      expect(issues.length).toBe(2);
    }
  });

  test('reports two independent cycles separately, without merging them or labeling them as blocked', () => {
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
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GraphError);
      const issues = (err as GraphError).issues;

      const cycleIssues = issues.filter((i) => i.startsWith('dependency cycle'));
      expect(cycleIssues).toHaveLength(2);

      const cycleMembers = cycleIssues.map((i) =>
        i.replace('dependency cycle between the steps: ', '').split(', ').sort(),
      );
      expect(cycleMembers).toContainEqual(['a', 'b']);
      expect(cycleMembers).toContainEqual(['d', 'e']);

      // No step is labeled "blocked": all four are part of a cycle (their
      // own), none merely depends on another.
      expect(issues.some((i) => i.startsWith('steps blocked'))).toBe(false);
    }
  });

  test('merges into a single cycle two simple cycles that share a vertex', () => {
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
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GraphError);
      const issues = (err as GraphError).issues;

      // a↔b and b↔c share vertex b: they are a single strongly connected
      // component, not two separable cycles. It must be reported as a
      // single cycle with the three members, not as an a↔b cycle plus a
      // "blocked" c (c is cyclic, just through the b↔c cycle).
      const cycleIssues = issues.filter((i) => i.startsWith('dependency cycle'));
      expect(cycleIssues).toHaveLength(1);
      const cycleMembers = cycleIssues[0]!
        .replace('dependency cycle between the steps: ', '')
        .split(', ');
      expect(cycleMembers.sort()).toEqual(['a', 'b', 'c']);

      expect(issues.some((i) => i.startsWith('steps blocked'))).toBe(false);
    }
  });

  test('rejects an input with more than one dot instead of truncating it silently', () => {
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
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GraphError);
      const issues = (err as GraphError).issues;
      expect(issues.some((i) => i.includes('scan.pages.deep'))).toBe(true);
    }
  });
});
