import { findReferences } from '../params/resolve.ts';
import type { Pipeline } from '../schema/pipeline.ts';

/** A segment of a shell command, and whether bash would expand `${…}` inside it. */
export type Segment = { text: string; expands: boolean };

type Heredoc = { delimiter: string; expands: boolean; stripTabs: boolean };

/**
 * Splits a shell command into segments, marking each one by whether bash
 * would expand `${…}` inside it.
 *
 * It is NOT a bash parser and must not become one. It covers five contexts
 * where an engine reference can end up: single quotes, double quotes,
 * escapes, comments, and heredocs with and without a quoted delimiter. For
 * any construct it does not understand, the default state is "expands" —
 * that is, do not warn. A false negative here costs one night; a false
 * positive gets the rule silenced, and then it costs not one night but all
 * of them.
 */
export function splitByExpansion(command: string): Segment[] {
  const segments: Segment[] = [];
  const push = (text: string, expands: boolean) => {
    if (text.length > 0) segments.push({ text, expands });
  };

  const lines = command.split('\n');
  let quote: 'none' | 'single' | 'double' = 'none';
  let heredoc: Heredoc | undefined;
  let pending: Heredoc | undefined;

  for (const line of lines) {
    if (heredoc) {
      const closing = heredoc.stripTabs ? line.replace(/^\t+/, '') : line;
      if (closing === heredoc.delimiter) {
        heredoc = undefined;
      } else {
        push(line, heredoc.expands);
      }
      continue;
    }

    let start = 0;
    let i = 0;
    while (i < line.length) {
      const c = line[i]!;
      if (quote === 'single') {
        if (c === "'") {
          push(line.slice(start, i), false);
          quote = 'none';
          start = i + 1;
        }
        i += 1;
        continue;
      }
      if (quote === 'double') {
        // Inside double quotes the backslash does escape.
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === '"') {
          quote = 'none';
        }
        i += 1;
        continue;
      }
      // quote === 'none'
      if (
        c === '#' &&
        (i === 0 || /\s/.test(line[i - 1]!) || ';&|('.includes(line[i - 1]!))
      ) {
        // A comment. Without this, the apostrophe in a `# no s'ha de…` opens
        // a string that never closes on the whole line and leaves the REST of
        // the block marked as "does not expand". The pipelines in this repo
        // are commented in Catalan: when the rule was tried against the three
        // real ones it gave 5 false positives, all from this cause, and all 5
        // on references that are actually inside double quotes.
        //
        // In `sh`, `#` also opens a comment after `;`, `&`, `|` or `(` — not
        // only at the start of a line or after a space. Without this, an `echo
        // a;# comment` with an apostrophe inside the comment (e.g. a Catalan
        // "no s'ha de fer") opens a single quote that never closes, and
        // flips the state of every following line.
        push(line.slice(start, i), true);
        start = line.length;
        break;
      }
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === "'") {
        push(line.slice(start, i), true);
        quote = 'single';
        start = i + 1;
        i += 1;
        continue;
      }
      if (c === '"') {
        quote = 'double';
        i += 1;
        continue;
      }
      if (c === '<' && line[i + 1] === '<') {
        // `<<<` is a here-string, not a heredoc. It is skipped WHOLE (i += 3):
        // with `i += 1` the second `<` would be read again as the start of
        // another `<<` and "hello" in `cat <<< hello` would end up as the
        // delimiter.
        if (line[i + 2] === '<') {
          i += 3;
          continue;
        }
        const opener = parseHeredocOpener(line, i);
        if (opener) {
          pending = pending ?? opener.heredoc;
          i = opener.next;
          continue;
        }
      }
      i += 1;
    }
    push(line.slice(start), quote !== 'single');
    if (pending) {
      heredoc = pending;
      pending = undefined;
    }
  }

  // Terminal-state guard. If the scan ends with an unclosed quote, or an
  // open heredoc (or one waiting to open on the last line), either the
  // command is not valid `sh` or the scanner got lost and rebuilt the state
  // wrongly from something it did not understand (two heredocs opened on the
  // same line, for example). In both cases, carrying on with the state the
  // loop has accumulated produces false positives on references that
  // actually expand fine. No correct script loses coverage through this
  // bail-out — an unclosed single quote is not valid `sh` — and any script
  // the scanner misread is no longer falsely flagged.
  if (quote !== 'none' || heredoc !== undefined || pending !== undefined) {
    return [{ text: command, expands: true }];
  }

  return segments;
}

/**
 * Reads a heredoc opener starting at the position of `<<`. Returns the
 * heredoc and the next position, or `undefined` if what is there is not a
 * recognizable opener (and then the scanner goes on as if it were text).
 */
function parseHeredocOpener(
  line: string,
  at: number,
): { heredoc: Heredoc; next: number } | undefined {
  let i = at + 2;
  const stripTabs = line[i] === '-';
  if (stripTabs) i += 1;
  while (line[i] === ' ' || line[i] === '\t') i += 1;

  const quoteChar = line[i];
  if (quoteChar === "'" || quoteChar === '"') {
    const end = line.indexOf(quoteChar, i + 1);
    if (end === -1) return undefined;
    return {
      heredoc: { delimiter: line.slice(i + 1, end), expands: false, stripTabs },
      next: end + 1,
    };
  }

  const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(line.slice(i));
  if (!match) return undefined;
  return {
    heredoc: { delimiter: match[0], expands: true, stripTabs },
    next: i + match[0].length,
  };
}

/** Text used to name a reference in an error message. */
function displayRef(ref: ReturnType<typeof findReferences>[number]): string {
  if (ref.kind === 'param') return `params.${ref.name}`;
  if (ref.kind === 'secret') return `secrets.${ref.name}`;
  return `${ref.step}.${ref.field}`;
}

/**
 * `{{x.y}}` references in `command` that fall where bash does NOT expand
 * `${…}`. `interpolateForShell` replaces them with `${__PIPELINES_REF_n}`,
 * so they arrive there literally and the step gets an empty variable.
 */
export function unexpandedReferences(command: string): string[] {
  const found: string[] = [];
  for (const segment of splitByExpansion(command)) {
    if (segment.expands) continue;
    for (const ref of findReferences(segment.text)) found.push(displayRef(ref));
  }
  return found;
}

/**
 * A shell command split into segments by the operators that separate
 * simple commands. R2 must only look at the segment that actually invokes
 * `grep`: without this, a `\s` in a `printf` in another segment would give
 * a false positive, and a rule with false positives ends up silenced.
 */
function commandSegments(command: string): string[] {
  return command.split(/\n|\|\||&&|[|;]/);
}

/** R2: `\s` does not exist in POSIX ERE and macOS grep does not accept it. */
function checkPosixEre(label: string, command: string): string[] {
  const issues: string[] = [];
  for (const segment of commandSegments(command)) {
    if (!/\bgrep\b/.test(segment)) continue;
    if (!/(^|\s)-[A-Za-z]*E/.test(segment)) continue;
    if (!segment.includes('\\s')) continue;
    issues.push(
      `${label}: "\\s" inside a grep -E pattern. It does not exist in POSIX ERE ` +
        `(it is a GNU extension) and macOS grep does not accept it: use [[:space:]]. ` +
        `It cost ten nights of silent skipping, from August 20 to 29, 2026`,
    );
  }
  return issues;
}

/** R3: presence of `set -euo pipefail` at the top of a multi-line `run:`. */
function checkStrictMode(label: string, run: string): string[] {
  if (!run.trimEnd().includes('\n')) return [];
  const first = run
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#'))
    // A comment at the end of the line itself ("set -euo pipefail  #
    // strict") is correct code: it is dropped before comparing. It is only
    // stripped from the first significant line, not from the rest of the
    // block — R3 checks nothing else. "set -eu -o pipefail" still being
    // rejected is on purpose: the repo convention is that exact line.
    ?.replace(/\s+#.*$/, '')
    .trimEnd();
  if (first === 'set -euo pipefail') return [];
  return [
    `${label}: a multi-line run: must open with "set -euo pipefail". Without it, a ` +
      `command that fails midway leaves the step successful, and the failure shows up later ` +
      `and somewhere else`,
  ];
}

/**
 * R5: an assignment whose value is a substitution with `grep` and no `||`
 * inside the substitution. Under `set -e` (which R3 requires), `var=$(cmd)`
 * takes the exit code of the substitution; with `pipefail`, that of any
 * command in the pipe. `grep` exits with 1 when it does not match —
 * which is exactly the "there is no ERROR: in the text" case that the
 * fallback on the next line meant to handle — and the step dies before
 * reaching it.
 *
 * It appeared three times in a single day while migrating a real pipeline:
 * `out=$(q …)`, the same in `qa()`, and
 * `alerts="…$(… | grep … | head -1)"`. A review caught all three, `validate`
 * caught none. This rule is that review, in code.
 *
 * Only assignments at the start of a line (with `export`/`local`/
 * `readonly` in front or not): `if x=$(grep …)` and `while x=$(…)` are
 * guarded by construction and do not count. Only `grep`: it is the command
 * whose "found nothing" exits with 1 by design. A `||` anywhere in the
 * substitution counts it as handled (`|| true`, `|| echo 0`).
 */
function checkGrepSubstitution(label: string, run: string): string[] {
  const issues: string[] = [];
  const assignment = /^\s*(?:export\s+|local\s+|readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)=/;
  for (const line of run.split('\n')) {
    if (line.trim().startsWith('#')) continue;
    const match = assignment.exec(line);
    if (!match) continue;
    const name = match[1]!;
    let from = line.indexOf('$(', match[0].length);
    while (from !== -1) {
      const body = substitutionBody(line, from);
      if (/\bgrep\b/.test(body) && !body.includes('||')) {
        issues.push(
          `${label}: the assignment "${name}=" takes its value from a substitution with grep and no "||" ` +
            `inside. Under set -e (and pipefail), grep exits with 1 when it does not match and kills the step before ` +
            `its own fallback: add "|| true" inside the substitution. It appeared three times in ` +
            `a single day while migrating a real pipeline`,
        );
        break;
      }
      from = line.indexOf('$(', from + 2 + body.length);
    }
  }
  return issues;
}

/**
 * The inside of the `$(` substitution that starts at `from`, up to its
 * closing `)` counting nested parentheses. If it does not close on the
 * line, the rest of the line.
 */
function substitutionBody(line: string, from: number): string {
  let depth = 0;
  for (let i = from + 1; i < line.length; i += 1) {
    const c = line[i];
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return line.slice(from + 2, i);
    }
  }
  return line.slice(from + 2);
}

/**
 * The five rules, closed and in code. There is NO rule registry, no
 * configurable severities, and no way to add one without touching this
 * file — and that is on purpose: as soon as this accepts configuration it
 * stops being a list of incidents and becomes a framework nobody maintains.
 * A new rule goes in only once a night has paid for it.
 */
export function lintPipeline(pipeline: Pipeline): string[] {
  const issues: string[] = [];

  const shellTexts: { label: string; text: string }[] = [];
  pipeline.when.forEach((guard, index) => {
    if ('shell' in guard) shellTexts.push({ label: `when.${index}.shell`, text: guard.shell });
  });
  for (const step of pipeline.steps) {
    if (step.type === 'shell') shellTexts.push({ label: `steps.${step.id}.run`, text: step.run });
  }
  for (const step of pipeline.always) {
    shellTexts.push({ label: `always.${step.id}.run`, text: step.run });
  }

  for (const { label, text } of shellTexts) {
    // R1
    for (const ref of unexpandedReferences(text)) {
      issues.push(
        `${label}: the reference "{{${ref}}}" falls where bash does not expand \${…} ` +
          `(single quotes, or a heredoc with a quoted delimiter). The engine replaces it ` +
          `with \${__PIPELINES_REF_n} and passes the value through the environment: it arrives there ` +
          `literally and the variable ends up empty`,
      );
    }
    // R2
    issues.push(...checkPosixEre(label, text));
  }

  // R3 — only on `run:`, not on guards: a guard is a one-line
  // expression evaluated by its exit code, not a script.
  for (const step of pipeline.steps) {
    if (step.type === 'shell') issues.push(...checkStrictMode(`steps.${step.id}.run`, step.run));
  }
  for (const step of pipeline.always) {
    issues.push(...checkStrictMode(`always.${step.id}.run`, step.run));
  }

  // R5 — like R3, only on `run:`.
  for (const step of pipeline.steps) {
    if (step.type === 'shell') issues.push(...checkGrepSubstitution(`steps.${step.id}.run`, step.run));
  }
  for (const step of pipeline.always) {
    issues.push(...checkGrepSubstitution(`always.${step.id}.run`, step.run));
  }

  // R4
  if (pipeline.triggers.length > 0 && pipeline.notify && !pipeline.notify.staleAfter) {
    issues.push(
      `notify: a pipeline with triggers: must declare notify.stale_after. Without it, a ` +
        `pipeline held back by a guard tells nobody: there is no error to ` +
        `notify, only absence`,
    );
  }

  return issues;
}
