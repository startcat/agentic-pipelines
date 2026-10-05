import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path';

/**
 * Perfil de superficie de filesystem de una tool. `kind: 'none'` para
 * tools sin ningún campo de ruta ni URL (la mayoría de las de Playwright:
 * clic, tipeo, espera...). `kind: 'url'` para `browser_navigate` — no es
 * una ruta de fichero, pero `file://` es una lectura local no modelada por
 * los otros dos tipos. `kind: 'path'`/`'multi-path'`
 * para todo lo que sí toca el filesystem; cada campo declara si su valor
 * debe tratarse como patrón glob (se corta en el primer metacarácter antes
 * de resolver) o como ruta llana, y si es obligatorio: un campo
 * obligatorio ausente (o de tipo inesperado) deniega la llamada entera —
 * ausencia silenciosa solo se permite en campos opcionales como el
 * `filename` de las tools de Playwright.
 */
export type PathField = { name: string; glob: boolean; required: boolean };

/**
 * `knownFields` — a diferencia de `field`/`fields` (el/los campo(s) que el
 * hook realmente vigila), esto es el conjunto COMPLETO de parámetros reales
 * de la tool, verificado contra una `tools/list` real (Playwright) o
 * `sdk-tools.d.ts` (nativas) — nunca de memoria, mismo criterio que el resto
 * de esta tabla. Solo lo usa `doctor` (`preflight/check.ts`) para
 * detectar deriva de esquema COMPLETA (campo nuevo, renombrado o
 * desaparecido) frente al paquete real; el hook de `evaluateToolCall` sigue
 * mirando únicamente `field`/`fields`, nunca `knownFields` — dos consumidores
 * con dos necesidades distintas de la misma tabla.
 */
export type ToolFsProfile =
  | { kind: 'none'; knownFields: string[] }
  | { kind: 'url'; field: string; schemes: string[]; knownFields: string[] }
  | { kind: 'path'; mutates: boolean; field: string; required: boolean; knownFields: string[] }
  | { kind: 'multi-path'; mutates: boolean; fields: PathField[]; knownFields: string[] };

export type FsRoots = { cwdRoot: string; readRoots: string[] };

export type PathCheckResult = { allowed: true } | { allowed: false; reason: string };

function allow(): PathCheckResult {
  return { allowed: true };
}

function deny(reason: string): PathCheckResult {
  return { allowed: false, reason };
}

/**
 * Tabla de perfiles, construida contra `sdk-tools.d.ts` real (nativas) y
 * una `tools/list` real de `@playwright/mcp` (MCP) — nunca de memoria. Sin `MultiEdit`: no existe en esta versión del SDK.
 *
 * `knownFields` de las 6 entradas nativas: leído directamente de
 * `node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts`
 * (`FileReadInput`/`FileWriteInput`/`FileEditInput`/`NotebookEditInput`/
 * `GlobInput`/`GrepInput`) el 2026-08-18. `knownFields` de las 20 entradas de
 * Playwright: capturado en vivo ese mismo día con `listMcpToolsViaStdio`
 * contra `npx -y @playwright/mcp@latest` real — no
 * copiado de la documentación del paquete, que puede no reflejar la versión
 * publicada de verdad.
 */
export const TOOL_FS_PROFILES: Record<string, ToolFsProfile> = {
  Read: {
    kind: 'path',
    mutates: false,
    field: 'file_path',
    required: true,
    knownFields: ['file_path', 'offset', 'limit', 'pages'],
  },
  Write: {
    kind: 'path',
    mutates: true,
    field: 'file_path',
    required: true,
    knownFields: ['file_path', 'content'],
  },
  Edit: {
    kind: 'path',
    mutates: true,
    field: 'file_path',
    required: true,
    knownFields: ['file_path', 'old_string', 'new_string', 'replace_all'],
  },
  NotebookEdit: {
    kind: 'path',
    mutates: true,
    field: 'notebook_path',
    required: true,
    knownFields: ['notebook_path', 'cell_id', 'new_source', 'cell_type', 'edit_mode'],
  },
  Glob: {
    kind: 'multi-path',
    mutates: false,
    fields: [
      { name: 'pattern', glob: true, required: true },
      { name: 'path', glob: false, required: false },
    ],
    knownFields: ['pattern', 'path'],
  },
  Grep: {
    kind: 'multi-path',
    mutates: false,
    fields: [
      { name: 'path', glob: false, required: false },
      { name: 'glob', glob: true, required: false },
    ],
    knownFields: [
      'pattern', 'path', 'glob', 'output_mode', '-B', '-A', '-C', 'context',
      '-n', '-i', '-o', 'type', 'head_limit', 'offset', 'multiline',
    ],
  },
  /**
   * NO figura en `sdk-tools.d.ts` (a diferencia de las 6 entradas nativas de
   * arriba) porque no es una capability que un paso conceda vía
   * `step.tools`/`allowedTools` (`agent.ts`, `options.allowedTools =
   * step.tools`): es el canal por el que el SDK DEVUELVE el resultado
   * cuando `outputFormat` está activo (`step.outputs`, cualquiera que sea la
   * lista de tools del paso) — su propio prompt interno obliga al modelo a
   * llamarla exactamente una vez al final de cada turno; no es un mecanismo
   * de corrección puntual, es el canal principal de salida de todo paso con
   * `outputs:`. Confirmado leyendo la definición real en el binario nativo
   * del SDK (`node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`):
   * `isMcp: false`, `call()` es total — se limita a devolver `{ data:
   * "Structured output provided successfully", structured_output: e,
   * endsTurn: true }`, sin fs ni red ni subproceso. Antes de esta entrada, la
   * tabla la denegaba con "tool desconocida para el motor", tumbando el
   * paso con "el resultado no es JSON válido" — la única razón por la que
   * esto tardó hasta la primera ejecución real de un pipeline en
   * manifestarse es
   * que el motor venía sobreviviendo con el fallback de texto-JSON de la
   * propia SDK cuando esta tool no estaba disponible — no que el fallo sea
   * un caso raro: cualquier paso con `outputs:` la invoca en condiciones
   * normales. `kind: 'none'`: no toca el filesystem bajo ninguna forma.
   * `knownFields: []` porque sus campos son el esquema de `outputs:` del
   * propio paso (el SDK expone su `inputSchema` como `passthrough()`), no un
   * contrato fijo — no hay nada estático que comparar en una deriva de
   * esquema.
   */
  StructuredOutput: { kind: 'none', knownFields: [] },
  browser_take_screenshot: {
    kind: 'path',
    mutates: true,
    field: 'filename',
    required: false,
    knownFields: ['element', 'target', 'type', 'filename', 'fullPage', 'scale'],
  },
  browser_snapshot: {
    kind: 'path',
    mutates: true,
    field: 'filename',
    required: false,
    knownFields: ['target', 'filename', 'depth', 'boxes'],
  },
  browser_console_messages: {
    kind: 'path',
    mutates: true,
    field: 'filename',
    required: false,
    knownFields: ['level', 'all', 'filename'],
  },
  browser_network_requests: {
    kind: 'path',
    mutates: true,
    field: 'filename',
    required: false,
    knownFields: ['static', 'filter', 'filename'],
  },
  // `paths` es OPCIONAL en ambas — verificado contra el esquema real de
  // `@playwright/mcp@0.0.79`: `browser_file_upload` sin `paths` cancela el selector de
  // fichero en vez de fallar, y `browser_drop` puede invocarse solo con
  // `data` (sin `paths` en absoluto). Antes marcado `required: true`, lo que
  // denegaba por "obligatorio ausente" (ver `extractPathCandidates`) una
  // llamada legítima sin ese campo — el mismo tipo de fallo-cerrado que la
  // tabla persigue en general, pero aplicado sobre un campo que el paquete
  // real no exige.
  browser_file_upload: {
    kind: 'multi-path',
    mutates: false,
    fields: [{ name: 'paths', glob: false, required: false }],
    knownFields: ['paths'],
  },
  browser_drop: {
    kind: 'multi-path',
    mutates: false,
    fields: [{ name: 'paths', glob: false, required: false }],
    knownFields: ['element', 'target', 'paths', 'data'],
  },
  browser_navigate: {
    kind: 'url',
    field: 'url',
    schemes: ['http', 'https'],
    knownFields: ['url'],
  },
  browser_click: {
    kind: 'none',
    knownFields: ['element', 'target', 'doubleClick', 'button', 'modifiers'],
  },
  browser_close: { kind: 'none', knownFields: [] },
  browser_drag: {
    kind: 'none',
    knownFields: ['startElement', 'startTarget', 'endElement', 'endTarget'],
  },
  browser_fill_form: { kind: 'none', knownFields: ['fields'] },
  browser_find: { kind: 'none', knownFields: ['text', 'regex'] },
  browser_handle_dialog: { kind: 'none', knownFields: ['accept', 'promptText'] },
  browser_hover: { kind: 'none', knownFields: ['element', 'target'] },
  browser_navigate_back: { kind: 'none', knownFields: [] },
  browser_press_key: { kind: 'none', knownFields: ['key'] },
  browser_resize: { kind: 'none', knownFields: ['width', 'height'] },
  browser_select_option: { kind: 'none', knownFields: ['element', 'target', 'values'] },
  browser_type: { kind: 'none', knownFields: ['element', 'target', 'text', 'submit', 'slowly'] },
  browser_wait_for: { kind: 'none', knownFields: ['time', 'text', 'textGone'] },
};

/**
 * Sin campo de ruta que un hook pueda acotar con sentido (`Bash`/`REPL`
 * ejecutan texto libre), o mutan el propio `cwd` en tiempo de ejecución
 * (`EnterWorktree`/`ExitWorktree` — socavarían la raíz capturada en
 * `captureRoots` si se permitieran), o ejecutan código arbitrario
 * (`browser_evaluate`/`browser_run_code_unsafe`). Sin opt-in: verificado
 * contra los pipelines reales que ninguno las necesita, y una puerta que
 * nadie usa solo es superficie de ataque.
 */
export const HARD_DENY_TOOLS: ReadonlySet<string> = new Set([
  'Bash',
  'REPL',
  'Workflow',
  'Agent',
  'EnterWorktree',
  'ExitWorktree',
  'browser_evaluate',
  'browser_run_code_unsafe',
]);

function trimTrailingSep(path: string): string {
  return path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
}

/** Resuelve `cwd`/`additionalDirs` UNA VEZ por paso, antes de la primera invocación del hook. */
export function captureRoots(cwd: string, additionalDirs: string[]): FsRoots {
  return {
    cwdRoot: trimTrailingSep(realpathSync(cwd)),
    readRoots: additionalDirs.map((d) => trimTrailingSep(realpathSync(d))),
  };
}

function isUnder(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

function containsDotDotSegment(raw: string): boolean {
  return raw.split(/[/\\]/).includes('..');
}

const GLOB_MAGIC = /[*?[{]/;

/**
 * Base literal de un patrón glob: todo lo anterior al primer segmento con
 * metacarácter. Un patrón sin ningún metacarácter se trata como ruta llana
 * (el bucle no encuentra nada que cortar y devuelve el patrón entero). Un
 * patrón cuyo primer segmento YA tiene metacarácter (`/**\/x` o `**\/x`)
 * produce una base vacía, ambigua entre "toda la raíz" y "cwd entero" — se
 * desambigua por si el patrón original era absoluto.
 */
function globBase(pattern: string): string {
  const segments = pattern.split('/');
  const magicIndex = segments.findIndex((s) => GLOB_MAGIC.test(s));
  if (magicIndex === -1) return pattern;
  const baseSegments = segments.slice(0, magicIndex);
  const joined = baseSegments.join('/');
  if (joined.length === 0) return isAbsolute(pattern) ? '/' : '.';
  return joined;
}

/**
 * Resuelve una ruta llana (ya libre de ".." — el llamante lo comprueba
 * antes) contra `cwdRoot`, con `realpath`. Si el objetivo no existe todavía
 * (un `Write` creando ficheros/directorios nuevos), sube al ancestro
 * existente más cercano, lo resuelve, y reañade la cola — segura porque ya
 * no puede contener "..".
 */
function resolvePlainPath(raw: string, cwdRoot: string): string {
  const joined = isAbsolute(raw) ? raw : join(cwdRoot, raw);
  const normalized = normalize(joined);
  try {
    return realpathSync(normalized);
  } catch {
    let dir = dirname(normalized);
    const tail: string[] = [basename(normalized)];
    for (;;) {
      try {
        const realDir = realpathSync(dir);
        return join(realDir, ...tail.reverse());
      } catch {
        const parent = dirname(dir);
        if (parent === dir) throw new Error(`ningún ancestro existente de "${raw}"`);
        tail.push(basename(dir));
        dir = parent;
      }
    }
  }
}

type PathCandidate = { raw: string; glob: boolean };

/**
 * Resultado de extraer los candidatos de ruta de `toolInput` según el
 * perfil. `ok: false` cuando un campo marcado `required: true` está
 * ausente o tiene un tipo inesperado — se deniega la llamada entera en vez
 * de tratarla como "sin rutas que comprobar" (bug encontrado en la primera
 * pasada de este fichero: `Read` sin `file_path` caía en 0 candidatos y se
 * permitía por defecto, exactamente lo contrario de "fail closed"). Un
 * campo opcional ausente o de tipo inesperado simplemente se salta: la
 * mayoría de los campos de ruta de Playwright son opcionales (`filename?`),
 * y pasar `undefined`/un número al resolutor lanzaría.
 */
function extractPathCandidates(
  profile: Extract<ToolFsProfile, { kind: 'path' } | { kind: 'multi-path' }>,
  toolInput: unknown,
): { ok: true; candidates: PathCandidate[] } | { ok: false; reason: string } {
  const input = toolInput !== null && typeof toolInput === 'object' ? (toolInput as Record<string, unknown>) : {};
  const fields: PathField[] =
    profile.kind === 'path' ? [{ name: profile.field, glob: false, required: profile.required }] : profile.fields;
  const out: PathCandidate[] = [];
  for (const f of fields) {
    const value = input[f.name];
    let matched = false;
    if (typeof value === 'string' && value.length > 0) {
      out.push({ raw: value, glob: f.glob });
      matched = true;
    } else if (Array.isArray(value)) {
      for (const v of value) {
        if (typeof v === 'string' && v.length > 0) {
          out.push({ raw: v, glob: f.glob });
          matched = true;
        }
      }
    }
    if (!matched && f.required) {
      return { ok: false, reason: `"${f.name}" es obligatorio y está ausente o tiene un tipo inesperado` };
    }
  }
  return { ok: true, candidates: out };
}

/**
 * Decide si una llamada a `toolName` con `toolInput` puede ejecutarse dadas
 * `roots`. NUNCA lanza — cualquier excepción interna se convierte en un
 * DENY explícito: el sandbox nunca falla abierto.
 */
export function evaluateToolCall(toolName: string, toolInput: unknown, roots: FsRoots): PathCheckResult {
  try {
    if (HARD_DENY_TOOLS.has(toolName)) {
      return deny(
        `"${toolName}" no está permitida en un paso agent — si necesitas ejecutar comandos, usa un paso type: shell`,
      );
    }
    const profile = TOOL_FS_PROFILES[toolName];
    if (!profile) return deny(`tool desconocida para el motor: "${toolName}"`);
    if (profile.kind === 'none') return allow();

    if (profile.kind === 'url') {
      const input = toolInput !== null && typeof toolInput === 'object' ? (toolInput as Record<string, unknown>) : {};
      const value = input[profile.field];
      if (typeof value !== 'string') return allow(); // campo ausente: nada que validar
      if (!profile.schemes.some((s) => value.startsWith(`${s}://`))) {
        return deny(`esquema no permitido en ${profile.field}: "${value}"`);
      }
      return allow();
    }

    const extracted = extractPathCandidates(profile, toolInput);
    if (!extracted.ok) return deny(extracted.reason);

    for (const { raw, glob } of extracted.candidates) {
      if (containsDotDotSegment(raw)) return deny(`ruta con ".." rechazada: "${raw}"`);
      if (profile.mutates && !isAbsolute(raw)) {
        return deny(`"${raw}" debe ser una ruta absoluta para esta tool — su base relativa no es cwd`);
      }
      const base = glob ? globBase(raw) : raw;
      const resolved = resolvePlainPath(base, roots.cwdRoot);
      const allowedRoot = profile.mutates
        ? (isUnder(resolved, roots.cwdRoot) ? roots.cwdRoot : null)
        : (isUnder(resolved, roots.cwdRoot) ? roots.cwdRoot : roots.readRoots.find((r) => isUnder(resolved, r)));
      if (!allowedRoot) {
        return deny(
          `"${raw}" resuelve fuera de toda raíz permitida ` +
            `(escritura: ${roots.cwdRoot}${
              profile.mutates ? '' : `; lectura: ${[roots.cwdRoot, ...roots.readRoots].join(', ')}`
            })`,
        );
      }
    }
    return allow();
  } catch (err) {
    return deny(`error interno validando la ruta — se deniega por defecto (${(err as Error).message})`);
  }
}
