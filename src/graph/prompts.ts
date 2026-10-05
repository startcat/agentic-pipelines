import { findReferences } from '../params/resolve.ts';
import type { Pipeline } from '../schema/pipeline.ts';

/**
 * Comprueba que cada referencia `{{x.y}}` de un prompt resuelve contra los
 * params declarados o los `outputs` de un paso anterior — mismo criterio
 * que `interpolate()` ya aplica en tiempo real dentro de `runAgentStep`
 * (`agent.ts`), pero antes de gastar el primer token.
 *
 * Las referencias en prompts NO entran al grafo de dependencias (decisión
 * ya aceptada: un cambio de redacción de un prompt no debe reordenar el
 * plan de ejecución) — esta función solo valida, no construye ningún
 * grafo. `prompts` llega ya leído de disco (mapa id de paso -> contenido),
 * porque el propio acceso a disco es responsabilidad de quien la llama
 * (el comando `validate`, que conoce la ruta del repo), no de esta función
 * pura.
 */
export function checkPromptReferences(
  pipeline: Pipeline,
  prompts: Record<string, string>,
): string[] {
  const issues: string[] = [];
  const byId = new Map(pipeline.steps.map((s) => [s.id, s]));

  for (const [stepId, text] of Object.entries(prompts)) {
    for (const ref of findReferences(text)) {
      if (ref.kind === 'param') {
        if (!(ref.name in pipeline.params)) {
          issues.push(
            `${stepId}: el prompt referencia "{{params.${ref.name}}}", no declarado en params`,
          );
        }
        continue;
      }
      if (ref.kind === 'secret') {
        if (!pipeline.requires.env.includes(ref.name)) {
          issues.push(
            `${stepId}: el prompt referencia "{{secrets.${ref.name}}}", no declarado en requires.env`,
          );
        }
        continue;
      }
      const source = byId.get(ref.step);
      if (!source) {
        issues.push(`${stepId}: el prompt referencia al paso inexistente "${ref.step}"`);
        continue;
      }
      if (!source.outputs || !(ref.field in source.outputs)) {
        issues.push(
          `${stepId}: el prompt referencia "${ref.step}.${ref.field}", pero "${ref.step}" no declara ese output`,
        );
      }
    }
  }
  return issues;
}

/**
 * Comprueba que cada referencia `{{x.y}}` de un paso `always:` (su `run` y,
 * si lo declara, su `cwd`) resuelve contra los params declarados o los
 * `outputs` de un paso de `steps:` — mismo criterio que
 * `checkPromptReferences`, aplicado a los pasos de limpieza incondicional
 * en vez de a los prompts. A diferencia de un prompt, el texto ya está
 * disponible en el propio `Pipeline` sin lectura de disco: `run:`/`cwd:` de
 * un `always:` son cadenas planas ya parseadas del YAML.
 *
 * `byId` se construye SOLO a partir de `pipeline.steps`, nunca de
 * `pipeline.always`: un `always:` no declara `outputs` (`alwaysStepSchema`
 * no tiene ese campo — ver `schema/pipeline.ts`), así que una referencia de
 * un `always:` a OTRO `always:` debe fallar igual que si apuntara a un
 * paso inexistente — no hay ningún output que pueda resolverla.
 */
export function checkAlwaysReferences(pipeline: Pipeline): string[] {
  const issues: string[] = [];
  const byId = new Map(pipeline.steps.map((s) => [s.id, s]));

  for (const step of pipeline.always) {
    const texts = step.cwd ? [step.run, step.cwd] : [step.run];
    for (const text of texts) {
      for (const ref of findReferences(text)) {
        if (ref.kind === 'param') {
          if (!(ref.name in pipeline.params)) {
            issues.push(
              `always.${step.id}: referencia "{{params.${ref.name}}}", no declarado en params`,
            );
          }
          continue;
        }
        if (ref.kind === 'secret') {
          issues.push(
            `always.${step.id}: referencia "{{secrets.${ref.name}}}" — un paso always nunca puede resolver secrets, solo un prompt de paso agent`,
          );
          continue;
        }
        const source = byId.get(ref.step);
        if (!source) {
          issues.push(`always.${step.id}: referencia al paso inexistente "${ref.step}"`);
          continue;
        }
        if (!source.outputs || !(ref.field in source.outputs)) {
          issues.push(
            `always.${step.id}: referencia "${ref.step}.${ref.field}", pero "${ref.step}" no declara ese output`,
          );
        }
      }
    }
  }
  return issues;
}

/**
 * Comprueba que cada referencia `{{x.y}}` de `steps[].cwd`, `steps[].when`,
 * el `run:` de un paso `shell` y `steps[].additional_dirs` (solo en pasos
 * agent) resuelve contra los params declarados o los `outputs` de un paso
 * anterior — mismo criterio que `checkAlwaysReferences`.
 *
 * El `run:` entró tarde (2026-09-01): la comprobación cubría el `run:` de un
 * `always:` pero no el de un paso normal, así que `validate` daba `✓` sobre
 * un `{{params.typo}}` que revienta en ejecución.
 */
export function checkStepReferences(pipeline: Pipeline): string[] {
  const issues: string[] = [];
  const byId = new Map(pipeline.steps.map((s) => [s.id, s]));

  for (const step of pipeline.steps) {
    const texts: { label: string; text: string }[] = [];
    if (step.cwd) texts.push({ label: 'cwd', text: step.cwd });
    if (step.when) texts.push({ label: 'when', text: step.when });
    if (step.type === 'shell') texts.push({ label: 'run', text: step.run });
    if (step.type === 'agent') {
      step.additionalDirs.forEach((dir, i) => texts.push({ label: `additional_dirs.${i}`, text: dir }));
    }

    for (const { label, text } of texts) {
      for (const ref of findReferences(text)) {
        if (ref.kind === 'param') {
          if (!(ref.name in pipeline.params)) {
            issues.push(`${step.id}.${label}: referencia "{{params.${ref.name}}}", no declarado en params`);
          }
          continue;
        }
        if (ref.kind === 'secret') {
          issues.push(
            `${step.id}.${label}: referencia "{{secrets.${ref.name}}}" — ${label} nunca puede resolver secrets, solo el prompt de un paso agent`,
          );
          continue;
        }
        const source = byId.get(ref.step);
        if (!source) {
          issues.push(`${step.id}.${label}: referencia al paso inexistente "${ref.step}"`);
          continue;
        }
        if (!source.outputs || !(ref.field in source.outputs)) {
          issues.push(
            `${step.id}.${label}: referencia "${ref.step}.${ref.field}", pero "${ref.step}" no declara ese output`,
          );
        }
      }
    }
  }
  return issues;
}

/**
 * Comprueba las referencias `{{x.y}}` de las guardas de nivel pipeline: el
 * `shell:` de una guarda shell y el `path:` de una guarda `changed`, que son
 * los dos únicos textos de `when:` que se interpolan (`guards/evaluate.ts`).
 *
 * La comprobación es MÁS FUERTE que la de un paso, y por una razón de
 * ejecución, no de estilo: `evaluateGuards` construye el scope como
 * `{ params, steps: {} }` porque las guardas corren ANTES de que exista
 * ningún paso. Así que una referencia a un output no es "puede que no
 * exista": no puede existir nunca, apunte al paso que apunte. Igual que en
 * un `run:` o un `cwd:`, el scope se construye sin `secrets`.
 */
export function checkGuardReferences(pipeline: Pipeline): string[] {
  const issues: string[] = [];

  pipeline.when.forEach((guard, index) => {
    const texts: { label: string; text: string }[] = [];
    if ('shell' in guard) texts.push({ label: `when.${index}.shell`, text: guard.shell });
    if ('changed' in guard) {
      texts.push({ label: `when.${index}.changed.path`, text: guard.changed.path });
    }

    for (const { label, text } of texts) {
      for (const ref of findReferences(text)) {
        if (ref.kind === 'param') {
          if (!(ref.name in pipeline.params)) {
            issues.push(`${label}: referencia "{{params.${ref.name}}}", no declarado en params`);
          }
          continue;
        }
        if (ref.kind === 'secret') {
          issues.push(
            `${label}: referencia "{{secrets.${ref.name}}}" — una guarda nunca puede resolver secrets, solo el prompt de un paso agent`,
          );
          continue;
        }
        issues.push(
          `${label}: referencia "${ref.step}.${ref.field}" — una guarda de nivel pipeline se evalúa ANTES de que corra ningún paso, así que ningún output existe todavía`,
        );
      }
    }
  });

  return issues;
}
