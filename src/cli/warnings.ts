import type { RunRecord } from '../runs/types.ts';

/**
 * The exact reason that `deny()` produces in `fs-guard.ts` when a tool has no
 * entry in `TOOL_FS_PROFILES` and is not in `HARD_DENY_TOOLS`. Isolated as a
 * constant because `unknownToolWarnings` uses it as a prefix, not as free
 * text — a wording change in `fs-guard.ts` must break here instead of
 * silently going undetected.
 */
export const UNKNOWN_TOOL_DENY_PREFIX = 'unknown tool for the engine';

/**
 * The same reason as written before the translation to English. Runs stored
 * in `run.json` by the previous version carry it, so it must keep being
 * recognized.
 */
const LEGACY_UNKNOWN_TOOL_DENY_PREFIX = 'tool desconocida para el motor';

/**
 * Detects "unknown tool" denials in an ALREADY FINISHED run, even if it
 * ended in success — the very incident that motivated this
 * (`StructuredOutput`, 2026-08-18) brought a step down, but the same symptom
 * in ANOTHER internal SDK tool (`TodoWrite`, `AskUserQuestion`, `TaskOutput`,
 * `Skill`, `Workflow`/`SendMessage` — see the review of this fix) might not
 * bring the step down if the model never ends up needing it, and stay buried
 * in `run.json` until someone looks for it by hand. Deduplicated by
 * (step, tool): the same run can deny the same tool twice (the model
 * retries) without that deserving two identical warnings.
 *
 * Lives in its own module (not in `cli/index.ts`) because `index.ts` runs
 * `program.parseAsync(process.argv)` on load — importing it directly from a
 * test would fire the real CLI against the test runner's argv.
 */
export function unknownToolWarnings(record: RunRecord): string[] {
  const seen = new Set<string>();
  const warnings: string[] = [];
  for (const [stepId, step] of Object.entries(record.steps)) {
    for (const denial of step.denials ?? []) {
      if (
        !denial.reason?.startsWith(UNKNOWN_TOOL_DENY_PREFIX) &&
        !denial.reason?.startsWith(LEGACY_UNKNOWN_TOOL_DENY_PREFIX)
      ) {
        continue;
      }
      const key = `${stepId}:${denial.toolName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      warnings.push(
        `warning: step "${stepId}" invoked "${denial.toolName}", which the engine does not govern (denied) — if it is legitimate, add its profile to TOOL_FS_PROFILES in fs-guard.ts`,
      );
    }
  }
  return warnings;
}
