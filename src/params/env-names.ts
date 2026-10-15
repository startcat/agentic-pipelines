import { findReferences, interpolate } from './resolve.ts';

/**
 * Nombre de variable de entorno que `sh` puede leer como `$NOMBRE`. Solo se
 * exige a los nombres que salen de una plantilla: un nombre literal ya
 * declarado hoy se respeta tal cual, para no romper ningún pipeline existente.
 */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type EnvNameResolution =
  | { declared: string; ok: true; name: string }
  | { declared: string; ok: false; reason: 'missing-params'; missing: string[] }
  | { declared: string; ok: false; reason: 'invalid-name'; name: string }
  | { declared: string; ok: false; reason: 'bad-reference'; refs: string[] };

/**
 * Resuelve las plantillas `{{params.*}}` de `requires.env` contra los params
 * del run. Así un pipeline genérico (parametrizado por app y entorno) declara
 * secretos cuyo nombre depende de esos params, y el motor los sigue
 * comprobando en `doctor`, pasando a los pasos `shell` y redactando en los
 * logs como cualquier otro secreto.
 *
 * Nunca lanza: cada entrada devuelve su resultado, y quien la llama decide
 * (el preflight lo convierte en un check en rojo; `run` solo lee las
 * resueltas). `validate` ya rechaza las referencias que no son a params,
 * pero esta función no da por hecho que se haya ejecutado.
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

/** Los nombres resueltos y válidos, sin repetir: los que se leen del `.env` para un run. */
export function resolvedEnvNames(declared: string[], params: Record<string, string>): string[] {
  const names = resolveEnvNames(declared, params).flatMap((r) => (r.ok ? [r.name] : []));
  return [...new Set(names)];
}
