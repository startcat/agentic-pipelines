import { DECLARED_DENY_PREFIX } from '../runner/fs-guard.ts';
import type { RunRecord } from '../runs/types.ts';

/**
 * El motivo exacto que `deny()` produce en `fs-guard.ts` cuando una tool no
 * tiene entrada en `TOOL_FS_PROFILES` ni está en `HARD_DENY_TOOLS`. Aislado
 * como constante porque `unknownToolWarnings` lo usa como prefijo, no como
 * texto libre — un cambio de redacción en `fs-guard.ts` debe romper aquí en
 * vez de dejar de detectarse en silencio.
 */
export const UNKNOWN_TOOL_DENY_PREFIX = 'tool desconocida para el motor';

/**
 * Detecta denegaciones por "tool desconocida" en un run YA TERMINADO,
 * incluso si terminó en éxito — el propio incidente que motivó esto
 * (`StructuredOutput`, 2026-08-18) tumbó un paso, pero el mismo síntoma en
 * OTRA tool interna del SDK (`TodoWrite`, `AskUserQuestion`, `TaskOutput`,
 * `Skill`, `Workflow`/`SendMessage` — ver revisión de este fix) podría no
 * tumbar el paso si el modelo no llega a necesitarla, y quedar enterrada en
 * `run.json` hasta que alguien la busque a mano. Deduplicada por
 * (paso, tool): el mismo run puede denegar la misma tool dos veces (el
 * modelo reintenta) sin que eso merezca dos avisos idénticos.
 *
 * It also warns about denials from a `kind: declared` server (reason starting
 * with `DECLARED_DENY_PREFIX`): the tool is not in its `allow` or the step does
 * not grant it in `tools:`, and the hook (via `declaredAllow`) denies it.
 *
 * Vive en su propio módulo (no en `cli/index.ts`) porque `index.ts` ejecuta
 * `program.parseAsync(process.argv)` al cargarse — importarlo directamente
 * desde un test dispararía el CLI real contra el argv del test runner.
 */
export function unknownToolWarnings(record: RunRecord): string[] {
  const seen = new Set<string>();
  const warnings: string[] = [];
  for (const [stepId, step] of Object.entries(record.steps)) {
    for (const denial of step.denials ?? []) {
      const declared = denial.reason?.startsWith(DECLARED_DENY_PREFIX) ?? false;
      if (!declared && !denial.reason?.startsWith(UNKNOWN_TOOL_DENY_PREFIX)) continue;
      const key = `${stepId}:${denial.toolName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (declared) {
        warnings.push(
          `aviso: paso "${stepId}" invocó "${denial.toolName}", que no está en el allow de su servidor declared (denegada) — si es legítima, añádela a allow del servidor y a tools: del paso`,
        );
        continue;
      }
      warnings.push(
        `aviso: paso "${stepId}" invocó "${denial.toolName}", que el motor no gobierna (denegada) — si es legítima, añade su perfil a TOOL_FS_PROFILES en fs-guard.ts`,
      );
    }
  }
  return warnings;
}
