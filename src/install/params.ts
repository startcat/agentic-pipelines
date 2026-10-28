import { isBareReference } from '../expr/evaluate.ts';
import { findReferences } from '../params/resolve.ts';
import type { Pipeline } from '../schema/pipeline.ts';

export type UnsetParamImpact = {
  param: string;
  /**
   * Steps whose `when:` is exactly a bare reference to that param
   * (`{{params.x}}`, no comparison): `evaluateWhen` treats a missing
   * reference as `undefined`, which is falsy, so these steps are skipped
   * FOR CERTAIN when the param has no value.
   */
  skippedSteps: string[];
  /**
   * Steps whose `when:` references that param INSIDE a comparison
   * (`{{params.x}} != "..."`, etc.): the result depends on the operator and
   * the literal — with `!=` the step RUNS, it is not skipped —, so no outcome
   * is asserted, only that the step depends on the param.
   */
  uncertainSteps: string[];
};

/**
 * Declared params that end up without a value, with the steps that will be
 * skipped (for certain) or that merely depend on it (uncertain) because of it.
 * It is not an error — an optional param without a value is legitimate —, but
 * it is what `install` prints when it finishes.
 *
 * Born from the second incident of 2026-08-29: the plist did not pass
 * `deploy_dispatch_url`, the `deploy` step was skipped cleanly every night,
 * and the effect (the published site frozen while commits kept arriving)
 * produced no error anywhere. An `install` that had said it out loud would
 * have been enough.
 *
 * The distinction between `skippedSteps` and `uncertainSteps` comes from the
 * final review: with `when: '{{params.dry_run}} != "yes"'` and `dry_run`
 * without a value, the comparison gives `true` and the step RUNS, so claiming
 * "it will be skipped" there would be lying — exactly the kind of false
 * warning this command exists to avoid.
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
