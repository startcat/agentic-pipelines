import { findReferences } from '../params/resolve.ts';
import type { Pipeline } from '../schema/pipeline.ts';

/** Un tramo de un comando de shell, y si bash expandiría `${…}` dentro. */
export type Segment = { text: string; expands: boolean };

type Heredoc = { delimiter: string; expands: boolean; stripTabs: boolean };

/**
 * Parte un comando de shell en tramos, marcando cada uno según si bash
 * expandiría `${…}` dentro.
 *
 * NO es un parser de bash y no debe llegar a serlo. Cubre cinco contextos
 * donde una referencia del motor puede acabar: comillas simples, comillas
 * dobles, escapes, comentarios, y heredocs con y sin delimitador
 * entrecomillado. Ante cualquier construcción que no entienda, el estado por
 * defecto es "expande" — o sea, no avisar. Un falso negativo aquí cuesta una
 * noche; un falso positivo hace que la regla se silencie y entonces no
 * cuesta una noche, cuesta todas.
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
        // Dentro de comillas dobles la barra invertida sí escapa.
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
        // Un comentario. Sin esto, el apóstrofo de un `# no s'ha de…` abre una
        // cadena que no cierra en toda la línea y deja el RESTO del bloque
        // marcado como "no expande". Los pipelines de este repo están
        // comentados en catalán: al probar la regla contra los tres reales dio
        // 5 falsos positivos, todos por esta causa, y los 5 sobre referencias
        // que en realidad van entre comillas dobles.
        //
        // En `sh`, `#` también abre comentario tras `;`, `&`, `|` o `(` — no
        // solo a principio de línea o tras un espacio. Sin esto, un `echo
        // a;# comentario` con un apóstrofo dentro del comentario (p.ej. un
        // "no s'ha de fer" en catalán) abre una comilla simple que ya no
        // cierra, e invierte el estado de todas las líneas siguientes.
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
        // `<<<` es un here-string, no un heredoc. Se salta ENTERO (i += 3): con
        // un `i += 1` el segundo `<` se volvería a leer como el principio de
        // otro `<<` y "hola" en `cat <<< hola` acabaría de delimitador.
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

  // Guarda de estado terminal. Si al acabar el escaneo queda una comilla sin
  // cerrar, o un heredoc abierto (o uno pendiente de abrir en la última
  // línea), es que el comando no es `sh` válido — o que el escáner se ha
  // perdido y ha reconstruido mal el estado a partir de algo que no entendía
  // (dos heredocs abiertos en la misma línea, por ejemplo). En cualquiera de
  // los dos casos, seguir con el estado que arrastra el bucle produce
  // falsos positivos sobre referencias que en realidad expanden bien. Ningún
  // script correcto pierde cobertura por este bail-out — una comilla simple
  // sin cerrar no es `sh` válido —, y cualquier script que el escáner haya
  // malinterpretado deja de acusar en falso.
  if (quote !== 'none' || heredoc !== undefined || pending !== undefined) {
    return [{ text: command, expands: true }];
  }

  return segments;
}

/**
 * Lee un abridor de heredoc a partir de la posición de `<<`. Devuelve el
 * heredoc y la posición siguiente, o `undefined` si lo que hay no es un
 * abridor reconocible (y entonces el escáner sigue como si fuera texto).
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

/** Texto con el que se nombra una referencia en un mensaje de error. */
function displayRef(ref: ReturnType<typeof findReferences>[number]): string {
  if (ref.kind === 'param') return `params.${ref.name}`;
  if (ref.kind === 'secret') return `secrets.${ref.name}`;
  return `${ref.step}.${ref.field}`;
}

/**
 * Referencias `{{x.y}}` de `command` que caen donde bash NO expande `${…}`.
 * `interpolateForShell` las sustituye por `${__PIPELINES_REF_n}`, así que
 * ahí llegan literales y el paso recibe una variable vacía.
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
 * Un comando de shell partido en tramos por los operadores que separan
 * comandos simples. R2 solo debe mirar el tramo que de verdad invoca
 * `grep`: sin esto, un `\s` en un `printf` de otro tramo daría un falso
 * positivo, y una regla con falsos positivos se acaba silenciando.
 */
function commandSegments(command: string): string[] {
  return command.split(/\n|\|\||&&|[|;]/);
}

/** R2: `\s` no existe en la ERE de POSIX y el grep de macOS no la acepta. */
function checkPosixEre(label: string, command: string): string[] {
  const issues: string[] = [];
  for (const segment of commandSegments(command)) {
    if (!/\bgrep\b/.test(segment)) continue;
    if (!/(^|\s)-[A-Za-z]*E/.test(segment)) continue;
    if (!segment.includes('\\s')) continue;
    issues.push(
      `${label}: "\\s" dentro de un patrón de grep -E. No existe en la ERE de POSIX ` +
        `(es extensión de GNU) y el grep de macOS no la acepta: usa [[:space:]]. ` +
        `Costó diez noches saltando en silencio, del 20 al 29 de agosto de 2026`,
    );
  }
  return issues;
}

/** R3: presencia de `set -euo pipefail` al abrir un `run:` multilínea. */
function checkStrictMode(label: string, run: string): string[] {
  if (!run.trimEnd().includes('\n')) return [];
  const first = run
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#'))
    // Un comentario al final de la propia línea ("set -euo pipefail  #
    // estricto") es código correcto: se descarta antes de comparar. Solo se
    // quita de la primera línea significativa, no del resto del bloque —
    // R3 no comprueba nada más. "set -eu -o pipefail" seguir rechazándose
    // es a propósito: la convención del repo es esa línea exacta.
    ?.replace(/\s+#.*$/, '')
    .trimEnd();
  if (first === 'set -euo pipefail') return [];
  return [
    `${label}: un run: multilínea debe abrir con "set -euo pipefail". Sin él, un ` +
      `comando que falla a mitad deja el paso en éxito y el fallo aparece más tarde ` +
      `y en otro sitio`,
  ];
}

/**
 * R5: una asignación cuyo valor es una sustitución con `grep` y sin `||`
 * dentro de la sustitución. Bajo `set -e` (que R3 exige), `var=$(cmd)` toma
 * el código de salida de la sustitución; con `pipefail`, el de cualquier
 * tramo de la tubería. `grep` sale con 1 cuando no casa — que es
 * exactamente el caso «no hay ERROR: en el texto» que el fallback de la
 * línea siguiente quería tratar — y el paso muere antes de llegar a él.
 *
 * Apareció tres veces en un solo día al migrar un pipeline real:
 * `out=$(q …)`, lo mismo en `qa()`, y `alerts="…$(… | grep … | head -1)"`.
 * Las tres las cazó una revisión, ninguna `validate`. Esta regla es esa
 * revisión, en código.
 *
 * Solo asignaciones al principio de una línea (con `export`/`local`/
 * `readonly` delante o no): `if x=$(grep …)` y `while x=$(…)` están
 * guardados por construcción y no cuentan. Solo `grep`: es el comando
 * cuyo «no encontré nada» sale con 1 por diseño. Un `||` en cualquier
 * punto de la sustitución la da por tratada (`|| true`, `|| echo 0`).
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
          `${label}: la asignación "${name}=" toma su valor de una sustitución con grep y sin "||" ` +
            `dentro. Bajo set -e (y pipefail), grep sale con 1 cuando no casa y mata el paso antes ` +
            `de su propio fallback: añade "|| true" dentro de la sustitución. Apareció tres veces en ` +
            `un solo día al migrar un pipeline real`,
        );
        break;
      }
      from = line.indexOf('$(', from + 2 + body.length);
    }
  }
  return issues;
}

/**
 * El interior de la sustitución `$(` que empieza en `from`, hasta su `)`
 * de cierre contando paréntesis anidados. Si no cierra en la línea, el
 * resto de la línea.
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
 * Las cinco reglas, cerradas y en código. NO hay registro de reglas, ni
 * severidades configurables, ni forma de añadir una sin tocar este
 * fichero — y es a propósito: en cuanto esto admita
 * configuración deja de ser una lista de incidentes y pasa a ser un
 * framework que nadie mantiene. Una regla nueva entra cuando una noche la pague.
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
        `${label}: la referencia "{{${ref}}}" cae donde bash no expande \${…} ` +
          `(comillas simples, o heredoc con delimitador entrecomillado). El motor la ` +
          `sustituye por \${__PIPELINES_REF_n} y pasa el valor por entorno: ahí llega ` +
          `literal y la variable queda vacía`,
      );
    }
    // R2
    issues.push(...checkPosixEre(label, text));
  }

  // R3 — solo sobre `run:`, no sobre las guardas: una guarda es una
  // expresión de una línea evaluada por su código de salida, no un script.
  for (const step of pipeline.steps) {
    if (step.type === 'shell') issues.push(...checkStrictMode(`steps.${step.id}.run`, step.run));
  }
  for (const step of pipeline.always) {
    issues.push(...checkStrictMode(`always.${step.id}.run`, step.run));
  }

  // R5 — como R3, solo sobre `run:`.
  for (const step of pipeline.steps) {
    if (step.type === 'shell') issues.push(...checkGrepSubstitution(`steps.${step.id}.run`, step.run));
  }
  for (const step of pipeline.always) {
    issues.push(...checkGrepSubstitution(`always.${step.id}.run`, step.run));
  }

  // R4
  if (pipeline.triggers.length > 0 && pipeline.notify && !pipeline.notify.staleAfter) {
    issues.push(
      `notify: un pipeline con triggers: debe declarar notify.stale_after. Sin él, un ` +
        `pipeline frenado por una guarda no se lo dice a nadie: no hay ningún error que ` +
        `notificar, solo ausencia`,
    );
  }

  return issues;
}
