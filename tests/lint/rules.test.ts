import { describe, expect, test } from 'bun:test';
import { splitByExpansion, unexpandedReferences, lintPipeline } from '../../src/lint/rules.ts';
import { parsePipeline } from '../../src/schema/pipeline.ts';

describe('splitByExpansion', () => {
  test('without quotes, everything expands', () => {
    expect(splitByExpansion('echo {{params.x}}')).toEqual([
      { text: 'echo {{params.x}}', expands: true },
    ]);
  });

  test('marks the inside of single quotes', () => {
    const segments = splitByExpansion(`echo 'hello' outside`);
    expect(segments.filter((s) => !s.expands).map((s) => s.text)).toEqual(['hello']);
  });

  test('the inside of double quotes expands', () => {
    expect(splitByExpansion(`echo "hello"`).every((s) => s.expands)).toBe(true);
  });

  test('single quotes inside double quotes open nothing', () => {
    expect(splitByExpansion(`echo "it's fine"`).every((s) => s.expands)).toBe(true);
  });

  test('an escaped single quote outside quotes opens nothing', () => {
    expect(splitByExpansion(`echo \\' {{params.x}}`).every((s) => s.expands)).toBe(true);
  });

  test('the body of a quoted heredoc does not expand', () => {
    const segments = splitByExpansion("cat <<'EOF'\nbody\nEOF\nend");
    expect(segments.filter((s) => !s.expands).map((s) => s.text)).toEqual(['body']);
  });

  test('the body of an unquoted heredoc does expand', () => {
    expect(splitByExpansion('cat <<EOF\nbody\nEOF\n').every((s) => s.expands)).toBe(true);
  });

  test('a quoted <<- heredoc with a tab-indented delimiter closes just the same', () => {
    const segments = splitByExpansion("cat <<-'EOF'\n\tbody\n\tEOF\nend");
    expect(segments.filter((s) => !s.expands).map((s) => s.text)).toEqual(['\tbody']);
  });

  test('a <<< here-string is not a heredoc', () => {
    expect(splitByExpansion('cat <<< hello').every((s) => s.expands)).toBe(true);
  });

  test('the apostrophe in a comment does not open a string', () => {
    const segments = splitByExpansion("# aquest pas no s'ha de saltar\necho {{params.x}}");
    expect(segments.every((s) => s.expands)).toBe(true);
  });

  test('a hash stuck to a word is not a comment', () => {
    const segments = splitByExpansion(`echo abc#def '{{params.x}}'`);
    expect(segments.filter((s) => !s.expands).map((s) => s.text)).toEqual(['{{params.x}}']);
  });
});

describe('unexpandedReferences', () => {
  test('catches the reference inside single quotes', () => {
    expect(unexpandedReferences(`curl -d '{"repo":"{{params.repo}}"}'`)).toEqual(['params.repo']);
  });

  test('does not catch the reference inside double quotes', () => {
    expect(unexpandedReferences(`grep -qE "pattern" "{{params.docs_repo}}/x.md"`)).toEqual([]);
  });

  test('does not catch an unquoted reference', () => {
    expect(unexpandedReferences('echo {{params.x}}')).toEqual([]);
  });

  test('catches the reference inside a quoted heredoc', () => {
    expect(unexpandedReferences("python3 <<'PY'\nprint('{{params.x}}')\nPY\n")).toEqual(['params.x']);
  });

  test('names a step reference and a secret reference correctly', () => {
    expect(unexpandedReferences(`echo '{{fetch.head}} {{secrets.TOKEN}}'`)).toEqual([
      'fetch.head',
      'secrets.TOKEN',
    ]);
  });

  test('the REAL docs-review guard does not fire (YAML quotes, not shell quotes)', () => {
    const parsed =
      'grep -qE "^\\| Slug \\(ca\\)[[:space:]]+\\| Estat[[:space:]]+\\| Captures[[:space:]]+\\|[^|]*ltima revisi[^|]*\\|" "{{params.docs_repo}}/scripts/auto-review-status.md"';
    expect(unexpandedReferences(parsed)).toEqual([]);
  });

  // A
  // `;#` was not recognized as a comment and a `#` followed by a Catalan
  // apostrophe left `quote` at 'single' forever, flipping the state of
  // everything that came after.
  test('a comment after ";" does not leave a quote open forever (before: false positive on params.y, false negative on params.x)', () => {
    const command = "echo a;# no s'ha de fer\necho '{{params.x}}' && echo {{params.y}}";
    // Before fix (b), the scanner did not recognize "#" after ";" as a
    // comment: the apostrophe in "s'ha" opened a single quote that did not
    // close on the whole of line 1, and that state leaked into line 2. The
    // result was exactly the opposite of the correct one: `params.y` (which
    // expands fine) came out as a finding, and `params.x` (which really is
    // inside shell single quotes) did not. With the fix, line 1 is
    // recognized as a comment in full and line 2 is analyzed cleanly: the
    // real defect is caught and the made-up one disappears.
    expect(unexpandedReferences(command)).toEqual(['params.x']);
  });

  test('two heredocs opened on the same line trigger the terminal-state guard (before: false positive)', () => {
    // The scanner only remembers one "pending" heredoc per line
    // (`pending = pending ?? opener.heredoc`), so the second `<<'B'` is
    // lost. That leaves the real body of B as loose text, with an apostrophe
    // ("dos s'ha") that opens a single quote that never closes. Before the
    // bail-out, that corrupt state was carried to the end and marked the
    // `echo "{{params.x}}"` line (inside DOUBLE quotes, which expands
    // perfectly) as if it did not expand: a false positive. With the
    // terminal-state guard, a scan that ends with an unclosed quote is
    // discarded entirely and nothing is reported for this command.
    const command = "cat <<'A' <<'B'\none\nA\ndos s'ha\nB\necho \"{{params.x}}\"";
    expect(unexpandedReferences(command)).toEqual([]);
  });
});

const BASE = `name: demo
description: d
version: 1
`;

describe('R1 inside lintPipeline', () => {
  test('catches a reference inside single quotes in a run:', () => {
    const issues = lintPipeline(parsePipeline(`${BASE}params:
  repo:
    description: r
steps:
  - id: one
    type: shell
    run: "curl -d '{{params.repo}}'"
`));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('steps.one.run');
    expect(issues[0]).toContain('params.repo');
  });

  test('catches a reference inside single quotes in an always:', () => {
    const issues = lintPipeline(parsePipeline(`${BASE}params:
  repo:
    description: r
steps:
  - id: one
    type: shell
    run: "true"
always:
  - id: cleanup
    run: "echo '{{params.repo}}'"
`));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('always.cleanup.run');
  });
});

describe('R2: \\s in a grep -E', () => {
  test('fires', () => {
    const issues = lintPipeline(parsePipeline(`${BASE}when:
  - shell: 'grep -qE "a\\s+b" file'
steps:
  - id: one
    type: shell
    run: "true"
`));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('when.0.shell');
    expect(issues[0]).toContain('[[:space:]]');
  });

  test('does not fire with [[:space:]]', () => {
    expect(lintPipeline(parsePipeline(`${BASE}when:
  - shell: 'grep -qE "a[[:space:]]+b" file'
steps:
  - id: one
    type: shell
    run: "true"
`))).toEqual([]);
  });

  test('does not fire if the \\s is in ANOTHER segment of the command', () => {
    expect(lintPipeline(parsePipeline(`${BASE}steps:
  - id: one
    type: shell
    run: |
      set -euo pipefail
      printf 'a\\sb' | grep -qE "ab"
`))).toEqual([]);
  });
});

describe('R3: set -euo pipefail', () => {
  test('fires on a multi-line run: that does not open with it', () => {
    const issues = lintPipeline(parsePipeline(`${BASE}steps:
  - id: one
    type: shell
    run: |
      echo hello
      echo bye
`));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('steps.one.run');
    expect(issues[0]).toContain('set -euo pipefail');
  });

  test('does not fire if it comes after a comment', () => {
    expect(lintPipeline(parsePipeline(`${BASE}steps:
  - id: one
    type: shell
    run: |
      # explanation
      set -euo pipefail
      echo hello
`))).toEqual([]);
  });

  test('a one-line run: is exempt', () => {
    expect(lintPipeline(parsePipeline(`${BASE}steps:
  - id: one
    type: shell
    run: "rm -rf /tmp/x"
`))).toEqual([]);
  });

  // "set -euo pipefail  # strict" is
  // correct code and R3 rejected it because it compared against the whole
  // line, comment included.
  test('does not fire with a comment at the end of the line itself', () => {
    expect(lintPipeline(parsePipeline(`${BASE}steps:
  - id: one
    type: shell
    run: |
      set -euo pipefail  # strict
      echo hello
`))).toEqual([]);
  });

  test('"set -eu -o pipefail" is still rejected even with a comment', () => {
    const issues = lintPipeline(parsePipeline(`${BASE}steps:
  - id: one
    type: shell
    run: |
      set -eu -o pipefail  # equivalent, but not the convention
      echo hello
`));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('set -euo pipefail');
  });
});

describe('R4: stale_after', () => {
  test('fires with triggers and notify but without stale_after', () => {
    const issues = lintPipeline(parsePipeline(`${BASE}triggers:
  - cron: "0 3 * * *"
notify:
  on: [failed]
  channel: mail
steps:
  - id: one
    type: shell
    run: "true"
`));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('notify');
    expect(issues[0]).toContain('stale_after');
  });

  test('does not fire without triggers', () => {
    expect(lintPipeline(parsePipeline(`${BASE}notify:
  on: [failed]
  channel: mail
steps:
  - id: one
    type: shell
    run: "true"
`))).toEqual([]);
  });

  test('does not fire with stale_after declared', () => {
    expect(lintPipeline(parsePipeline(`${BASE}triggers:
  - cron: "0 3 * * *"
notify:
  on: [failed]
  stale_after: 72h
  channel: mail
steps:
  - id: one
    type: shell
    run: "true"
`))).toEqual([]);
  });
});

describe('R5: an assignment with $(… grep …) without || inside', () => {
  const step = (run: string) => `${BASE}steps:
  - id: one
    type: shell
    run: |
      set -euo pipefail
${run.split('\n').map((l) => `      ${l}`).join('\n')}
`;

  test('fires: out=$(… | grep … | head -1) without || dies under pipefail when grep does not match', () => {
    const issues = lintPipeline(parsePipeline(step(`out=$(printf '%s' "$x" | grep -iE 'ERROR:' | head -1)
echo "$out"`)));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('steps.one.run');
    expect(issues[0]).toContain('grep');
    expect(issues[0]).toContain('|| true');
  });

  test('also fires inside double quotes and with export/local', () => {
    const issues = lintPipeline(parsePipeline(step(`export alerts="🔴 res: $(printf '%s' "$out" | grep -iE 'ERROR:' | head -1)"
local n=$(grep -c PRES "$f")`)));
    expect(issues).toHaveLength(2);
  });

  test('does not fire with || true inside the substitution', () => {
    expect(lintPipeline(parsePipeline(step(`out=$(printf '%s' "$x" | grep -iE 'ERROR:' | head -1 || true)
n=$(grep -c PRES "$f" || echo 0)`)))).toEqual([]);
  });

  test('does not fire if the assignment is guarded by if/while', () => {
    expect(lintPipeline(parsePipeline(step(`if out=$(grep x "$f"); then echo yes; fi
while l=$(grep y "$f"); do break; done`)))).toEqual([]);
  });

  test('does not fire without grep, nor in comments, nor with grep outside a substitution', () => {
    expect(lintPipeline(parsePipeline(step(`out=$(printf '%s' "$x" | head -1)
# alerts=$(grep this is a comment)
grep -q pattern "$f" || true
n=$(sed -n 's/x//p' "$f")`)))).toEqual([]);
  });

  test('follows the right parenthesis with nested substitutions', () => {
    const issues = lintPipeline(parsePipeline(step(`v=$(tok "N=" "$(q "select 1")")
w=$(tok "N=" "$(printf '%s' "$x" | grep -c y)")`)));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('w=');
  });
});
