/**
 * Groups consecutive skips that share a guard. PURE module.
 *
 * Why it exists: ten skipped nights were drawn as ten paragraphs with the same
 * two-hundred-character grep. The FACT is "eight nights, same guard"; repeating
 * it eight times doesn't inform, it hides.
 */
import type { RunRecord } from '../runs/types.ts';

/**
 * The STABLE part of the reason: the reason minus its trailing parenthesis.
 *
 * `throttle: 46h (last run 2211 min ago)` and `(… 771 min ago)` are the same
 * fact with two different figures, and grouping by the whole reason would keep
 * them apart. The `$` anchors at the end ON PURPOSE: a `shell` guard carries
 * parentheses INSIDE the command (`\(ca\)`) that must not be touched.
 */
export function guardOf(skipReason: string | undefined): string {
  if (skipReason === undefined) return '';
  return skipReason.replace(/\s*\([^)]*\)\s*$/, '');
}

export type Segment =
  | { kind: 'run'; run: RunRecord }
  | { kind: 'skips'; runs: RunRecord[]; guard: string };

/** Minimum consecutive skips to collapse them. With a single one the block would
 *  take more room than the row it replaces. */
const MINIMUM = 2;

export function groupHistory(runs: readonly RunRecord[]): Segment[] {
  const segments: Segment[] = [];
  let i = 0;

  while (i < runs.length) {
    const current = runs[i]!;
    if (current.status !== 'skipped') {
      segments.push({ kind: 'run', run: current });
      i += 1;
      continue;
    }

    // A streak extends while the next run is a skip WITH THE SAME guard. A run
    // that did work in between cuts it: two skips separated by a good night are
    // not eight nights in a row, and saying so would be lying.
    const guard = guardOf(current.skipReason);
    let end = i + 1;
    while (end < runs.length) {
      const next = runs[end]!;
      if (next.status !== 'skipped' || guardOf(next.skipReason) !== guard) break;
      end += 1;
    }

    const streak = runs.slice(i, end);
    if (streak.length >= MINIMUM) segments.push({ kind: 'skips', runs: streak, guard });
    else for (const r of streak) segments.push({ kind: 'run', run: r });
    i = end;
  }

  return segments;
}
