import { findReferences, interpolate } from './resolve.ts';

/**
 * An environment variable name that `sh` can read as `$NAME`. Only required
 * of names that come out of a template: a literal name already declared today
 * is kept as is, so as not to break any existing pipeline.
 */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type EnvNameResolution =
  | { declared: string; ok: true; name: string }
  | { declared: string; ok: false; reason: 'missing-params'; missing: string[] }
  | { declared: string; ok: false; reason: 'invalid-name'; name: string }
  | { declared: string; ok: false; reason: 'bad-reference'; refs: string[] };

/**
 * Resolves the `{{params.*}}` templates in `requires.env` against the run's
 * params. That way a generic pipeline (parametrized by app and environment)
 * declares secrets whose name depends on those params, and the engine still
 * checks them in `doctor`, passes them to `shell` steps and redacts them in
 * the logs like any other secret.
 *
 * Never throws: each entry returns its result, and the caller decides (the
 * preflight turns it into a red check; `run` only reads the resolved ones).
 * `validate` already rejects references that are not to params, but this
 * function does not assume it has run.
 */
export function resolveEnvNames(declared: string[], params: Record<string, string>): EnvNameResolution[] {
  return declared.map((entry): EnvNameResolution => {
    const refs = findReferences(entry);
    if (refs.length === 0) return { declared: entry, ok: true, name: entry };

    const bad = refs.flatMap((ref) =>
      ref.kind === 'param' ? [] : [ref.kind === 'secret' ? `secrets.${ref.name}` : `${ref.step}.${ref.field}`],
    );
    if (bad.length > 0) return { declared: entry, ok: false, reason: 'bad-reference', refs: bad };

    const missing = refs.flatMap((ref) => (ref.kind === 'param' && !(ref.name in params) ? [ref.name] : []));
    if (missing.length > 0) return { declared: entry, ok: false, reason: 'missing-params', missing };

    const name = interpolate(entry, { params, steps: {} });
    if (!ENV_NAME_RE.test(name)) return { declared: entry, ok: false, reason: 'invalid-name', name };
    return { declared: entry, ok: true, name };
  });
}

/** The resolved, valid names, without repeats: the ones read from the `.env` for a run. */
export function resolvedEnvNames(declared: string[], params: Record<string, string>): string[] {
  const names = resolveEnvNames(declared, params).flatMap((r) => (r.ok ? [r.name] : []));
  return [...new Set(names)];
}
