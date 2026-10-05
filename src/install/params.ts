import { isBareReference } from '../expr/evaluate.ts';
import { findReferences } from '../params/resolve.ts';
import type { Pipeline } from '../schema/pipeline.ts';

export type UnsetParamImpact = {
  param: string;
  /**
   * Pasos cuyo `when:` es justo una referencia pelada a ese param
   * (`{{params.x}}`, sin comparación): `evaluateWhen` trata una referencia
   * ausente como `undefined`, que es falso, así que estos pasos se saltan
   * CON CERTEZA cuando el param no tiene valor.
   */
  skippedSteps: string[];
  /**
   * Pasos cuyo `when:` referencia ese param DENTRO de una comparación
   * (`{{params.x}} != "..."`, etc.): el resultado depende del operador y del
   * literal — con `!=` el paso se EJECUTA, no se salta —, así que no se
   * afirma un desenlace, solo que el paso depende del param.
   */
  uncertainSteps: string[];
};

/**
 * Params declarados que se quedan sin valor, con los pasos que se saltarán
 * (con certeza) o que simplemente dependen de él (sin certeza) por ello. No
 * es un error — un param opcional sin valor es legítimo —, pero es lo que
 * `install` imprime al terminar.
 *
 * Nace del segundo incidente del 2026-08-29: el plist no pasaba
 * `deploy_dispatch_url`, el paso `deploy` se saltaba limpiamente cada noche, y
 * el efecto (el sitio publicado congelado mientras los commits seguían
 * llegando) no producía error en ninguna parte. Un `install` que lo hubiera
 * dicho en voz alta habría bastado.
 *
 * La distinción entre `skippedSteps` y `uncertainSteps` nace de la revisión
 * final: con `when: '{{params.dry_run}} != "yes"'` y `dry_run` sin valor, la
 * comparación da `true` y el paso SE EJECUTA, así que afirmar "se saltará"
 * ahí sería mentir — justo el tipo de aviso falso que este comando existe
 * para evitar.
 */
export function unsetParamImpacts(
  pipeline: Pipeline,
  resolved: Record<string, string>,
): UnsetParamImpact[] {
  const impacts: UnsetParamImpact[] = [];

  for (const name of Object.keys(pipeline.params)) {
    if (resolved[name] !== undefined) continue;

    const skippedSteps: string[] = [];
    const uncertainSteps: string[] = [];
    for (const step of pipeline.steps) {
      if (step.when === undefined) continue;
      const references = findReferences(step.when);
      if (!references.some((ref) => ref.kind === 'param' && ref.name === name)) continue;
      if (isBareReference(step.when)) {
        skippedSteps.push(step.id);
      } else {
        uncertainSteps.push(step.id);
      }
    }
    impacts.push({ param: name, skippedSteps, uncertainSteps });
  }
  return impacts;
}
