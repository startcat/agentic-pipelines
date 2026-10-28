import { findReferences, type Reference } from '../params/resolve.ts';
import type { Pipeline, Step } from '../schema/pipeline.ts';

export class GraphError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid step graph:\n  - ${issues.join('\n  - ')}`);
    this.name = 'GraphError';
    this.issues = issues;
  }
}

export type Graph = {
  /** Stable topological order: respects the declared order among independent steps. */
  order: string[];
  /** step id -> ids it depends on. */
  dependencies: Map<string, Set<string>>;
  /** step id -> ids that depend on it. Used for the skip cascade. */
  dependents: Map<string, Set<string>>;
};

/**
 * All the texts of a step where `{{x.y}}` references can appear.
 *
 * `additionalDirs` (`agent` steps only) was missing here: `checkStepReferences`
 * (`graph/prompts.ts`) DOES validate `{{steps.x.field}}` inside
 * `additional_dirs` and accepts it as a valid reference, but without this
 * line the graph never created the matching dependency edge — a step that
 * interpolates another's output in its `additional_dirs` could run BEFORE
 * the referenced step (the topological order did not know it depended on
 * it), and `interpolate()` (`runAgentStep`, `agent.ts`) would throw an
 * "Unresolved reference" at run time instead of the graph ordering the
 * steps correctly. Same mechanism that already covers `cwd` above: both
 * fields are interpolated against the same `scope` in `runAgentStep`.
 */
function interpolatableTexts(step: Step): string[] {
  const texts: string[] = [];
  if (step.cwd) texts.push(step.cwd);
  if (step.when) texts.push(step.when);
  if (step.type === 'shell') texts.push(step.run);
  if (step.type === 'agent') texts.push(...step.additionalDirs);
  return texts;
}

/**
 * Step references of a step: those of `inputs` plus the interpolated ones.
 * A malformed `inputs` (no dot, or more than one) does not throw: it is
 * added to `issues` as one more problem, so it accumulates with the rest of
 * the graph's defects instead of overshadowing them.
 */
function stepReferences(
  step: Step,
  issues: string[],
): { step: string; field: string }[] {
  const refs: { step: string; field: string }[] = [];

  for (const input of step.inputs) {
    const parts = input.split('.');
    const [from, field] = parts;
    if (parts.length !== 2 || !from || !field) {
      issues.push(
        `${step.id}: input "${input}" must have the form <step>.<field>`,
      );
      continue;
    }
    refs.push({ step: from, field });
  }

  for (const text of interpolatableTexts(step)) {
    for (const ref of findReferences(text) as Reference[]) {
      if (ref.kind === 'step') refs.push({ step: ref.step, field: ref.field });
    }
  }

  return refs;
}

/**
 * Builds the dependency graph between steps and their execution order.
 * Validates that every reference points to an existing step and to a field
 * that step declares in `outputs`. The referenced step may appear at any
 * position in the YAML (before or after the one referencing it): no
 * declaration order is required, only the absence of cycles — the real
 * execution order is decided by `topoOrder`.
 */
export function buildGraph(pipeline: Pipeline): Graph {
  const issues: string[] = [];
  const byId = new Map(pipeline.steps.map((s) => [s.id, s]));
  const dependencies = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();

  for (const step of pipeline.steps) {
    dependencies.set(step.id, new Set());
    dependents.set(step.id, new Set());
  }

  for (const step of pipeline.steps) {
    for (const ref of stepReferences(step, issues)) {
      const source = byId.get(ref.step);
      if (!source) {
        issues.push(`${step.id}: reference to nonexistent step "${ref.step}"`);
        continue;
      }
      if (!source.outputs || !(ref.field in source.outputs)) {
        issues.push(
          `${step.id}: step "${ref.step}" does not declare the output "${ref.field}" (reference ${ref.step}.${ref.field})`,
        );
        continue;
      }
      dependencies.get(step.id)!.add(ref.step);
      dependents.get(ref.step)!.add(step.id);
    }
  }

  if (issues.length > 0) throw new GraphError(issues);

  const order = topoOrder(pipeline, dependencies);
  return { order, dependencies, dependents };
}

/**
 * Stable topological order by selection: on each iteration it takes the first
 * step (in declared order) whose dependencies are already placed. That way
 * two independent steps keep the YAML order, which is what the author
 * expects.
 */
function topoOrder(
  pipeline: Pipeline,
  dependencies: Map<string, Set<string>>,
): string[] {
  const placed = new Set<string>();
  const order: string[] = [];
  const remaining = pipeline.steps.map((s) => s.id);

  while (remaining.length > 0) {
    const index = remaining.findIndex((id) =>
      [...dependencies.get(id)!].every((dep) => placed.has(dep)),
    );
    if (index === -1) {
      throw cycleError(remaining, dependencies);
    }
    const [id] = remaining.splice(index, 1);
    placed.add(id!);
    order.push(id!);
  }

  return order;
}

/**
 * Builds the `GraphError` when `topoOrder` gets stuck. `remaining` can mix
 * several groups that must not be confused: one or more cycles (each
 * strongly connected component counts as one, whether a simple cycle or
 * several sharing a vertex), and the steps that are only blocked because
 * they depend (directly or transitively) on one of them. Each cycle is
 * reported separately and only what really falls outside all of them is
 * labeled as blocked.
 */
function cycleError(
  remaining: string[],
  dependencies: Map<string, Set<string>>,
): GraphError {
  const cycles = findCycles(remaining, dependencies);
  const cycleNodes = new Set(cycles.flat());
  const blocked = remaining.filter((id) => !cycleNodes.has(id));

  const issues = cycles.map(
    (cycle) => `dependency cycle between the steps: ${cycle.join(', ')}`,
  );
  if (blocked.length > 0) {
    const [label, pronoun] =
      cycles.length === 1 ? ['the cycle above', 'it'] : ['the cycles above', 'them'];
    issues.push(
      `steps blocked by ${label}, not part of ${pronoun}: ${blocked.join(', ')}`,
    );
  }
  return new GraphError(issues);
}

/**
 * Finds all the cycles within `remaining` using Tarjan's algorithm for
 * strongly connected components (SCC), restricted to the edges between
 * nodes of `remaining` (those pointing outside are already resolved by
 * `topoOrder` and cannot be part of a cycle here).
 *
 * Why SCC and not "find a simple cycle and repeat": two simple cycles that
 * share a vertex (e.g. a↔b and b↔c) are not two separable cycles, they are
 * a single strongly connected component — a, b and c are mutually
 * reachable. Trying to peel them off as independent cycles leaves one of
 * the nodes wrongly labeled "blocked" when it is actually still cyclic,
 * just through the cycle that was not reported. Tarjan avoids the problem
 * at the root: every SCC of size ≥ 2 is, by definition, a cycle (all its
 * members are mutually reachable), and a single-node SCC is only cyclic if
 * that node depends on itself (self-reference). Everything left outside any
 * cyclic SCC is, by construction, genuinely acyclic: it can only be blocked
 * by depending on a cycle, never be part of an undetected one.
 *
 * The result is deterministic: the members of each cycle are listed in the
 * YAML's declared order (that of `remaining`), and the cycles are ordered
 * among themselves by the declared position of their first member — it
 * does not depend on Tarjan's discovery order, which is an accident of the
 * traversal.
 */
function findCycles(
  remaining: string[],
  dependencies: Map<string, Set<string>>,
): string[][] {
  const nodeSet = new Set(remaining);
  const position = new Map(remaining.map((id, i) => [id, i]));

  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  function strongConnect(v: string): void {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);

    for (const w of dependencies.get(v) ?? []) {
      if (!nodeSet.has(w)) continue;
      if (!index.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }

    if (lowlink.get(v) === index.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        // There is no risk of emptying the stack before finding `v`: it
        // was pushed on entering this call and nothing removes it until its
        // own SCC closes, right here.
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      components.push(component);
    }
  }

  for (const id of remaining) {
    if (!index.has(id)) strongConnect(id);
  }

  return components
    .filter(
      (component) =>
        component.length > 1 || (dependencies.get(component[0]!)?.has(component[0]!) ?? false),
    )
    .map((component) => [...component].sort((a, b) => position.get(a)! - position.get(b)!))
    .sort((a, b) => position.get(a[0]!)! - position.get(b[0]!)!);
}
