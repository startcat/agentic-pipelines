import { describe, expect, test } from 'bun:test';
import { splitByExpansion, unexpandedReferences, lintPipeline } from '../../src/lint/rules.ts';
import { parsePipeline } from '../../src/schema/pipeline.ts';

describe('splitByExpansion', () => {
  test('sin comillas, todo expande', () => {
    expect(splitByExpansion('echo {{params.x}}')).toEqual([
      { text: 'echo {{params.x}}', expands: true },
    ]);
  });

  test('marca el interior de unas comillas simples', () => {
    const segments = splitByExpansion(`echo 'hola' fuera`);
    expect(segments.filter((s) => !s.expands).map((s) => s.text)).toEqual(['hola']);
  });

  test('el interior de comillas dobles expande', () => {
    expect(splitByExpansion(`echo "hola"`).every((s) => s.expands)).toBe(true);
  });

  test('unas comillas simples dentro de comillas dobles no abren nada', () => {
    expect(splitByExpansion(`echo "no's abre"`).every((s) => s.expands)).toBe(true);
  });

  test('una comilla simple escapada fuera de comillas no abre nada', () => {
    expect(splitByExpansion(`echo \\' {{params.x}}`).every((s) => s.expands)).toBe(true);
  });

  test('el cuerpo de un heredoc entrecomillado no expande', () => {
    const segments = splitByExpansion("cat <<'EOF'\ncuerpo\nEOF\nfin");
    expect(segments.filter((s) => !s.expands).map((s) => s.text)).toEqual(['cuerpo']);
  });

  test('el cuerpo de un heredoc sin entrecomillar sí expande', () => {
    expect(splitByExpansion('cat <<EOF\ncuerpo\nEOF\n').every((s) => s.expands)).toBe(true);
  });

  test('un heredoc <<- entrecomillado con delimitador indentado por tabuladores cierra igual', () => {
    const segments = splitByExpansion("cat <<-'EOF'\n\tcuerpo\n\tEOF\nfin");
    expect(segments.filter((s) => !s.expands).map((s) => s.text)).toEqual(['\tcuerpo']);
  });

  test('un here-string <<< no es un heredoc', () => {
    expect(splitByExpansion('cat <<< hola').every((s) => s.expands)).toBe(true);
  });

  test('el apóstrofo de un comentario no abre una cadena', () => {
    const segments = splitByExpansion("# aquest pas no s'ha de saltar\necho {{params.x}}");
    expect(segments.every((s) => s.expands)).toBe(true);
  });

  test('una almohadilla pegada a una palabra no es un comentario', () => {
    const segments = splitByExpansion(`echo abc#def '{{params.x}}'`);
    expect(segments.filter((s) => !s.expands).map((s) => s.text)).toEqual(['{{params.x}}']);
  });
});

describe('unexpandedReferences', () => {
  test('caza la referencia dentro de comillas simples', () => {
    expect(unexpandedReferences(`curl -d '{"repo":"{{params.repo}}"}'`)).toEqual(['params.repo']);
  });

  test('no caza la referencia dentro de comillas dobles', () => {
    expect(unexpandedReferences(`grep -qE "patron" "{{params.docs_repo}}/x.md"`)).toEqual([]);
  });

  test('no caza una referencia sin comillas', () => {
    expect(unexpandedReferences('echo {{params.x}}')).toEqual([]);
  });

  test('caza la referencia dentro de un heredoc entrecomillado', () => {
    expect(unexpandedReferences("python3 <<'PY'\nprint('{{params.x}}')\nPY\n")).toEqual(['params.x']);
  });

  test('nombra bien una referencia a un paso y a un secreto', () => {
    expect(unexpandedReferences(`echo '{{fetch.head}} {{secrets.TOKEN}}'`)).toEqual([
      'fetch.head',
      'secrets.TOKEN',
    ]);
  });

  test('la guarda REAL de docs-review no dispara (comillas de YAML, no de shell)', () => {
    const parsed =
      'grep -qE "^\\| Slug \\(ca\\)[[:space:]]+\\| Estat[[:space:]]+\\| Captures[[:space:]]+\\|[^|]*ltima revisi[^|]*\\|" "{{params.docs_repo}}/scripts/auto-review-status.md"';
    expect(unexpandedReferences(parsed)).toEqual([]);
  });

  // Un
  // `;#` no se reconocía como comentario y un `#` con un apóstrofo catalán
  // detrás dejaba `quote` en 'single' para siempre, invirtiendo el estado de
  // todo lo que venía después.
  test('un comentario tras ";" no deja una comilla abierta para siempre (antes: falso positivo en params.y, falso negativo en params.x)', () => {
    const command = "echo a;# no s'ha de fer\necho '{{params.x}}' && echo {{params.y}}";
    // Antes del fix (b), el escáner no reconocía "#" tras ";" como
    // comentario: el apóstrofo de "s'ha" abría una comilla simple que no
    // cerraba en toda la línea 1, y ese estado se colaba en la línea 2. El
    // resultado era exactamente al revés de lo correcto: `params.y` (que
    // expande bien) salía como hallazgo, y `params.x` (que de verdad está
    // entre comillas simples de shell) no salía. Con el fix, la línea 1 se
    // reconoce entera como comentario y la línea 2 se analiza limpia: el
    // defecto real se caza y el inventado desaparece.
    expect(unexpandedReferences(command)).toEqual(['params.x']);
  });

  test('dos heredocs abiertos en la misma línea activan la guarda de estado terminal (antes: falso positivo)', () => {
    // El escáner solo recuerda un heredoc "pending" por línea
    // (`pending = pending ?? opener.heredoc`), así que el segundo `<<'B'`
    // se pierde. Eso deja el cuerpo real de B como texto suelto, con un
    // apóstrofo ("dos s'ha") que abre una comilla simple que ya no cierra.
    // Antes del bail-out, ese estado corrupto se arrastraba hasta el final
    // y marcaba la línea de `echo "{{params.x}}"` (entre comillas DOBLES,
    // que expande perfectamente) como si no expandiera: falso positivo. Con
    // la guarda de estado terminal, un escaneo que acaba con una comilla sin
    // cerrar se descarta entero y no se informa de nada para este comando.
    const command = "cat <<'A' <<'B'\nuno\nA\ndos s'ha\nB\necho \"{{params.x}}\"";
    expect(unexpandedReferences(command)).toEqual([]);
  });
});

const BASE = `name: demo
description: d
version: 1
`;

describe('R1 dentro de lintPipeline', () => {
  test('caza una referencia entre comillas simples en un run:', () => {
    const issues = lintPipeline(parsePipeline(`${BASE}params:
  repo:
    description: r
steps:
  - id: uno
    type: shell
    run: "curl -d '{{params.repo}}'"
`));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('steps.uno.run');
    expect(issues[0]).toContain('params.repo');
  });

  test('caza una referencia entre comillas simples en un always:', () => {
    const issues = lintPipeline(parsePipeline(`${BASE}params:
  repo:
    description: r
steps:
  - id: uno
    type: shell
    run: "true"
always:
  - id: limpia
    run: "echo '{{params.repo}}'"
`));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('always.limpia.run');
  });
});

describe('R2: \\s en un grep -E', () => {
  test('dispara', () => {
    const issues = lintPipeline(parsePipeline(`${BASE}when:
  - shell: 'grep -qE "a\\s+b" fichero'
steps:
  - id: uno
    type: shell
    run: "true"
`));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('when.0.shell');
    expect(issues[0]).toContain('[[:space:]]');
  });

  test('no dispara con [[:space:]]', () => {
    expect(lintPipeline(parsePipeline(`${BASE}when:
  - shell: 'grep -qE "a[[:space:]]+b" fichero'
steps:
  - id: uno
    type: shell
    run: "true"
`))).toEqual([]);
  });

  test('no dispara si el \\s está en OTRO tramo del comando', () => {
    expect(lintPipeline(parsePipeline(`${BASE}steps:
  - id: uno
    type: shell
    run: |
      set -euo pipefail
      printf 'a\\sb' | grep -qE "ab"
`))).toEqual([]);
  });
});

describe('R3: set -euo pipefail', () => {
  test('dispara en un run: multilínea que no lo abre', () => {
    const issues = lintPipeline(parsePipeline(`${BASE}steps:
  - id: uno
    type: shell
    run: |
      echo hola
      echo adios
`));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('steps.uno.run');
    expect(issues[0]).toContain('set -euo pipefail');
  });

  test('no dispara si va tras un comentario', () => {
    expect(lintPipeline(parsePipeline(`${BASE}steps:
  - id: uno
    type: shell
    run: |
      # explicación
      set -euo pipefail
      echo hola
`))).toEqual([]);
  });

  test('un run: de una línea está exento', () => {
    expect(lintPipeline(parsePipeline(`${BASE}steps:
  - id: uno
    type: shell
    run: "rm -rf /tmp/x"
`))).toEqual([]);
  });

  // "set -euo pipefail  # estricto" es
  // código correcto y R3 lo rechazaba por comparar contra la línea entera,
  // comentario incluido.
  test('no dispara con un comentario al final de la propia línea', () => {
    expect(lintPipeline(parsePipeline(`${BASE}steps:
  - id: uno
    type: shell
    run: |
      set -euo pipefail  # estricto
      echo hola
`))).toEqual([]);
  });

  test('"set -eu -o pipefail" sigue rechazándose aunque lleve comentario', () => {
    const issues = lintPipeline(parsePipeline(`${BASE}steps:
  - id: uno
    type: shell
    run: |
      set -eu -o pipefail  # equivalente, pero no es la convención
      echo hola
`));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('set -euo pipefail');
  });
});

describe('R4: stale_after', () => {
  test('dispara con triggers y notify pero sin stale_after', () => {
    const issues = lintPipeline(parsePipeline(`${BASE}triggers:
  - cron: "0 3 * * *"
notify:
  on: [failed]
  channel: correo
steps:
  - id: uno
    type: shell
    run: "true"
`));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('notify');
    expect(issues[0]).toContain('stale_after');
  });

  test('no dispara sin triggers', () => {
    expect(lintPipeline(parsePipeline(`${BASE}notify:
  on: [failed]
  channel: correo
steps:
  - id: uno
    type: shell
    run: "true"
`))).toEqual([]);
  });

  test('no dispara con stale_after declarado', () => {
    expect(lintPipeline(parsePipeline(`${BASE}triggers:
  - cron: "0 3 * * *"
notify:
  on: [failed]
  stale_after: 72h
  channel: correo
steps:
  - id: uno
    type: shell
    run: "true"
`))).toEqual([]);
  });
});

describe('R5: una asignación con $(… grep …) sin || dentro', () => {
  const step = (run: string) => `${BASE}steps:
  - id: uno
    type: shell
    run: |
      set -euo pipefail
${run.split('\n').map((l) => `      ${l}`).join('\n')}
`;

  test('dispara: out=$(… | grep … | head -1) sin || muere bajo pipefail cuando grep no casa', () => {
    const issues = lintPipeline(parsePipeline(step(`out=$(printf '%s' "$x" | grep -iE 'ERROR:' | head -1)
echo "$out"`)));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('steps.uno.run');
    expect(issues[0]).toContain('grep');
    expect(issues[0]).toContain('|| true');
  });

  test('dispara también dentro de comillas dobles y con export/local', () => {
    const issues = lintPipeline(parsePipeline(step(`export alerts="🔴 res: $(printf '%s' "$out" | grep -iE 'ERROR:' | head -1)"
local n=$(grep -c PRES "$f")`)));
    expect(issues).toHaveLength(2);
  });

  test('no dispara con || true dentro de la sustitución', () => {
    expect(lintPipeline(parsePipeline(step(`out=$(printf '%s' "$x" | grep -iE 'ERROR:' | head -1 || true)
n=$(grep -c PRES "$f" || echo 0)`)))).toEqual([]);
  });

  test('no dispara si la asignación está guardada por if/while', () => {
    expect(lintPipeline(parsePipeline(step(`if out=$(grep x "$f"); then echo si; fi
while l=$(grep y "$f"); do break; done`)))).toEqual([]);
  });

  test('no dispara sin grep, ni en comentarios, ni con grep fuera de una sustitución', () => {
    expect(lintPipeline(parsePipeline(step(`out=$(printf '%s' "$x" | head -1)
# alerts=$(grep esto es un comentario)
grep -q patron "$f" || true
n=$(sed -n 's/x//p' "$f")`)))).toEqual([]);
  });

  test('sigue el paréntesis correcto con sustituciones anidadas', () => {
    const issues = lintPipeline(parsePipeline(step(`v=$(tok "N=" "$(q "select 1")")
w=$(tok "N=" "$(printf '%s' "$x" | grep -c y)")`)));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('w=');
  });
});
