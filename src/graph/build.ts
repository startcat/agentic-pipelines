import { findReferences, type Reference } from '../params/resolve.ts';
import type { Pipeline, Step } from '../schema/pipeline.ts';

export class GraphError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Grafo de pasos inválido:\n  - ${issues.join('\n  - ')}`);
    this.name = 'GraphError';
    this.issues = issues;
  }
}

export type Graph = {
  /** Orden topológico estable: respeta el orden declarado entre independientes. */
  order: string[];
  /** id de paso -> ids de los que depende. */
  dependencies: Map<string, Set<string>>;
  /** id de paso -> ids que dependen de él. Usado para la cascada de saltos. */
  dependents: Map<string, Set<string>>;
};

/**
 * Todos los textos de un paso donde puede haber referencias `{{x.y}}`.
 *
 * `additionalDirs` (solo pasos `agent`) faltaba aquí: `checkStepReferences`
 * (`graph/prompts.ts`) SÍ valida `{{steps.x.field}}` dentro de
 * `additional_dirs` y lo acepta como referencia válida, pero sin esta línea
 * el grafo nunca creaba la arista de dependencia correspondiente — un paso
 * que interpola la salida de otro en su `additional_dirs` podía ejecutarse
 * ANTES que el paso referenciado (el orden topológico no sabía que dependía
 * de él), y `interpolate()` (`runAgentStep`, `agent.ts`) lanzaría en tiempo
 * de ejecución un "Referencia sin resolver" en vez de que el grafo ordenara
 * los pasos correctamente. Mismo mecanismo que ya cubre `cwd` arriba: ambos
 * campos se interpolan contra el mismo `scope` en `runAgentStep`.
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
 * Referencias a pasos de un paso: las de `inputs` más las interpoladas.
 * Un `inputs` malformado (sin punto, o con más de uno) no lanza: se añade a
 * `issues` como un problema más, para que se acumule junto con el resto de
 * defectos del grafo en vez de eclipsarlos.
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
        `${step.id}: input "${input}" debe tener la forma <paso>.<campo>`,
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
 * Construye el grafo de dependencias entre pasos y su orden de ejecución.
 * Valida que toda referencia apunte a un paso existente y a un campo que ese
 * paso declara en `outputs`. El paso referenciado puede aparecer en
 * cualquier posición del YAML (antes o después del que lo referencia): no se
 * exige orden de declaración, solo ausencia de ciclos — el orden real de
 * ejecución lo decide `topoOrder`.
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
        issues.push(`${step.id}: referencia al paso inexistente "${ref.step}"`);
        continue;
      }
      if (!source.outputs || !(ref.field in source.outputs)) {
        issues.push(
          `${step.id}: el paso "${ref.step}" no declara el output "${ref.field}" (referencia ${ref.step}.${ref.field})`,
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
 * Orden topológico estable por selección: en cada vuelta toma el primer paso
 * (en orden declarado) cuyas dependencias ya estén colocadas. Así dos pasos
 * independientes conservan el orden del YAML, que es lo que el autor espera.
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
 * Construye el `GraphError` cuando `topoOrder` se atasca. `remaining` puede
 * mezclar varios grupos que no deben confundirse: uno o más ciclos (cada
 * componente fuertemente conexa cuenta como uno, sea un ciclo simple o
 * varios que comparten vértice), y los pasos que solo quedan bloqueados por
 * depender (directa o transitivamente) de alguno de ellos. Cada ciclo se
 * reporta por separado y solo lo que de verdad queda fuera de todos ellos se
 * etiqueta como bloqueado.
 */
function cycleError(
  remaining: string[],
  dependencies: Map<string, Set<string>>,
): GraphError {
  const cycles = findCycles(remaining, dependencies);
  const cycleNodes = new Set(cycles.flat());
  const blocked = remaining.filter((id) => !cycleNodes.has(id));

  const issues = cycles.map(
    (cycle) => `ciclo de dependencias entre los pasos: ${cycle.join(', ')}`,
  );
  if (blocked.length > 0) {
    const [label, pronoun] =
      cycles.length === 1 ? ['el ciclo anterior', 'él'] : ['los ciclos anteriores', 'ellos'];
    issues.push(
      `pasos bloqueados por ${label}, no forman parte de ${pronoun}: ${blocked.join(', ')}`,
    );
  }
  return new GraphError(issues);
}

/**
 * Encuentra todos los ciclos dentro de `remaining` mediante el algoritmo de
 * Tarjan de componentes fuertemente conexas (SCC), restringido a las
 * aristas entre nodos de `remaining` (las que apuntan fuera ya están
 * resueltas por `topoOrder` y no pueden formar parte de un ciclo aquí).
 *
 * Por qué SCC y no "buscar un ciclo simple y repetir": dos ciclos simples
 * que comparten un vértice (p. ej. a↔b y b↔c) no son dos ciclos separables,
 * son una única componente fuertemente conexa — a, b y c son mutuamente
 * alcanzables entre sí. Intentar pelarlos como ciclos independientes deja
 * uno de los nodos mal etiquetado como "bloqueado" cuando en realidad sigue
 * siendo cíclico, solo que por el ciclo que no se reportó. Tarjan evita el
 * problema de raíz: cada SCC de tamaño ≥ 2 es, por definición, un ciclo
 * (todos sus miembros son mutuamente alcanzables), y una SCC de un único
 * nodo solo es cíclica si ese nodo depende de sí mismo (auto-referencia).
 * Todo lo que quede fuera de cualquier SCC cíclica es, por construcción,
 * genuinamente acíclico: solo puede estar bloqueado por depender de un
 * ciclo, nunca ser parte de uno no detectado.
 *
 * El resultado es determinista: los miembros de cada ciclo se listan en el
 * orden declarado del YAML (el de `remaining`), y los ciclos entre sí se
 * ordenan por la posición declarada de su primer miembro — no se depende
 * del orden de descubrimiento de Tarjan, que es un accidente del recorrido.
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
        // No hay riesgo de vaciar la pila antes de encontrar `v`: se
        // empujó al entrar en esta llamada y nada lo retira hasta que su
        // propia SCC se cierra, justo aquí.
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
