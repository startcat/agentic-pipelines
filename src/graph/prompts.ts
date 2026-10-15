import { findReferences } from '../params/resolve.ts';
import type { Pipeline } from '../schema/pipeline.ts';

/**
 * Checks that every `{{x.y}}` reference in a prompt resolves against the
 * declared params or the `outputs` of an earlier step — same criterion that
 * `interpolate()` already applies at run time inside `runAgentStep`
 * (`agent.ts`), but before spending the first token.
 *
 * References in prompts do NOT enter the dependency graph (an already
 * accepted decision: rewording a prompt must not reorder the execution
 * plan) — this function only validates, it builds no graph. `prompts`
 * arrives already read from disk (map of step id -> content), because disk
 * access is the responsibility of the caller (the `validate` command, which
 * knows the repo path), not of this pure function.
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
            `${stepId}: the prompt references "{{params.${ref.name}}}", not declared in params`,
          );
        }
        continue;
      }
      if (ref.kind === 'secret') {
        if (!pipeline.requires.env.includes(ref.name)) {
          issues.push(
            `${stepId}: the prompt references "{{secrets.${ref.name}}}", which is not declared in requires.env`,
          );
        }
        continue;
      }
      const source = byId.get(ref.step);
      if (!source) {
        issues.push(`${stepId}: the prompt references nonexistent step "${ref.step}"`);
        continue;
      }
      if (!source.outputs || !(ref.field in source.outputs)) {
        issues.push(
          `${stepId}: the prompt references "${ref.step}.${ref.field}", but "${ref.step}" does not declare that output`,
        );
      }
    }
  }
  return issues;
}

/**
 * Checks that every `{{x.y}}` reference in an `always:` step (its `run`
 * and, if declared, its `cwd`) resolves against the declared params or the
 * `outputs` of a `steps:` step — same criterion as `checkPromptReferences`,
 * applied to the unconditional cleanup steps instead of the prompts. Unlike
 * a prompt, the text is already available in the `Pipeline` itself without
 * reading from disk: the `run:`/`cwd:` of an `always:` are plain strings
 * already parsed from the YAML.
 *
 * `byId` is built ONLY from `pipeline.steps`, never from `pipeline.always`:
 * an `always:` declares no `outputs` (`alwaysStepSchema` has no such field —
 * see `schema/pipeline.ts`), so a reference from an `always:` to ANOTHER
 * `always:` must fail just as if it pointed to a nonexistent step — there
 * is no output that could resolve it.
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
              `always.${step.id}: reference "{{params.${ref.name}}}", not declared in params`,
            );
          }
          continue;
        }
        if (ref.kind === 'secret') {
          issues.push(
            `always.${step.id}: reference "{{secrets.${ref.name}}}" — an always step can never resolve secrets, only an agent step prompt can`,
          );
          continue;
        }
        const source = byId.get(ref.step);
        if (!source) {
          issues.push(`always.${step.id}: reference to nonexistent step "${ref.step}"`);
          continue;
        }
        if (!source.outputs || !(ref.field in source.outputs)) {
          issues.push(
            `always.${step.id}: reference "${ref.step}.${ref.field}", but "${ref.step}" does not declare that output`,
          );
        }
      }
    }
  }
  return issues;
}

/**
 * Checks that every `{{x.y}}` reference in `steps[].cwd`, `steps[].when`,
 * the `run:` of a `shell` step and `steps[].additional_dirs` (agent steps
 * only) resolves against the declared params or the `outputs` of an earlier
 * step — same criterion as `checkAlwaysReferences`.
 *
 * The `run:` came in late: the check covered the `run:` of an
 * `always:` but not that of a normal step, so `validate` gave `✓` on a
 * `{{params.typo}}` that blows up at run time.
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
            issues.push(`${step.id}.${label}: reference "{{params.${ref.name}}}", not declared in params`);
          }
          continue;
        }
        if (ref.kind === 'secret') {
          issues.push(
            `${step.id}.${label}: reference "{{secrets.${ref.name}}}" — ${label} can never resolve secrets, only the prompt of an agent step can`,
          );
          continue;
        }
        const source = byId.get(ref.step);
        if (!source) {
          issues.push(`${step.id}.${label}: reference to nonexistent step "${ref.step}"`);
          continue;
        }
        if (!source.outputs || !(ref.field in source.outputs)) {
          issues.push(
            `${step.id}.${label}: reference "${ref.step}.${ref.field}", but "${ref.step}" does not declare that output`,
          );
        }
      }
    }
  }
  return issues;
}

/**
 * Checks the `{{x.y}}` references of the pipeline-level guards: the
 * `shell:` of a shell guard and the `path:` of a `changed` guard, which are
 * the only two `when:` texts that get interpolated (`guards/evaluate.ts`).
 *
 * The check is STRONGER than a step's, for a run-time reason, not a matter
 * of style: `evaluateGuards` builds the scope as `{ params, steps: {} }`
 * because guards run BEFORE any step exists. So a reference to an output is
 * not "it might not exist": it can never exist, whichever step it points
 * to. As with a `run:` or a `cwd:`, the scope is built without `secrets`.
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
            issues.push(`${label}: reference "{{params.${ref.name}}}", not declared in params`);
          }
          continue;
        }
        if (ref.kind === 'secret') {
          issues.push(
            `${label}: reference "{{secrets.${ref.name}}}" — a guard can never resolve secrets, only the prompt of an agent step can`,
          );
          continue;
        }
        issues.push(
          `${label}: reference "${ref.step}.${ref.field}" — a pipeline-level guard is evaluated BEFORE any step runs, so no output exists yet`,
        );
      }
    }
  });

  return issues;
}

/**
 * Comprueba las referencias `{{x.y}}` de los nombres de `requires.env`. Esos
 * nombres se resuelven en el preflight, antes de que corra ningún paso y sin
 * secrets en el scope (`params/env-names.ts`), así que solo pueden depender
 * de params declarados.
 */
export function checkEnvReferences(pipeline: Pipeline): string[] {
  const issues: string[] = [];

  pipeline.requires.env.forEach((entry, index) => {
    const label = `requires.env.${index}`;
    for (const ref of findReferences(entry)) {
      if (ref.kind === 'param') {
        if (!(ref.name in pipeline.params)) {
          issues.push(`${label}: referencia "{{params.${ref.name}}}", no declarado en params`);
        }
        continue;
      }
      if (ref.kind === 'secret') {
        issues.push(
          `${label}: referencia "{{secrets.${ref.name}}}" — el nombre de un secreto solo puede depender de params`,
        );
        continue;
      }
      issues.push(
        `${label}: referencia "${ref.step}.${ref.field}" — el nombre de un secreto se resuelve antes de que corra ningún paso, solo puede depender de params`,
      );
    }
  });

  return issues;
}
