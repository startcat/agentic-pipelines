import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path';

/**
 * Filesystem surface profile of a tool. `kind: 'none'` for tools with no
 * path or URL field (most of the Playwright ones: click, type, wait...).
 * `kind: 'url'` for `browser_navigate` — it is not a file path, but
 * `file://` is a local read the other two kinds do not model.
 * `kind: 'path'`/`'multi-path'` for everything that does touch
 * the filesystem; each field declares whether its value must be treated as a
 * glob pattern (cut at the first metacharacter before resolving)
 * or as a plain path, and whether it is required: a missing required field
 * (or one of an unexpected type) denies the whole call — silent absence is
 * only allowed in optional fields such as the `filename` of the Playwright
 * tools.
 */
export type PathField = { name: string; glob: boolean; required: boolean };

/**
 * `knownFields` — unlike `field`/`fields` (the field(s) the hook actually
 * watches), this is the COMPLETE set of the tool's real parameters, verified
 * against a real `tools/list` (Playwright) or `sdk-tools.d.ts` (native
 * tools) — never from memory, same criterion as the rest of this table. Only
 * `doctor` uses it (`preflight/check.ts`) to detect FULL schema
 * drift (a new, renamed or removed field) against the real package; the
 * `evaluateToolCall` hook still looks only at `field`/`fields`, never at
 * `knownFields` — two consumers with two different needs of the same table.
 */
export type ToolFsProfile =
  | { kind: 'none'; knownFields: string[] }
  | { kind: 'url'; field: string; schemes: string[]; knownFields: string[] }
  | { kind: 'path'; mutates: boolean; field: string; required: boolean; knownFields: string[] }
  | { kind: 'multi-path'; mutates: boolean; fields: PathField[]; knownFields: string[] };

/**
 * Prefix of the reason the hook gives when it denies a tool of a `declared`
 * server that is not in its `allow`. `unknownToolWarnings` reads it as a
 * prefix, so rewording it must break there rather than pass silently.
 */
export const DECLARED_DENY_PREFIX = 'tool not allowed by the declared server';

export type FsRoots = { cwdRoot: string; readRoots: string[] };

export type PathCheckResult = { allowed: true } | { allowed: false; reason: string };

function allow(): PathCheckResult {
  return { allowed: true };
}

function deny(reason: string): PathCheckResult {
  return { allowed: false, reason };
}

/**
 * Profile table, built against the real `sdk-tools.d.ts` (native tools) and
 * a real `tools/list` from `@playwright/mcp` (MCP) — never from memory. No
 * `MultiEdit`: it does not exist in this SDK version.
 *
 * `knownFields` of the 6 native entries: read directly from
 * `node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts`
 * (`FileReadInput`/`FileWriteInput`/`FileEditInput`/`NotebookEditInput`/
 * `GlobInput`/`GrepInput`) on 2026-08-18. `knownFields` of the 20 Playwright
 * entries: captured live the same day with `listMcpToolsViaStdio` against a
 * real `npx -y @playwright/mcp@latest` — not
 * copied from the package documentation, which may not reflect the version
 * actually published.
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
   * NOT listed in `sdk-tools.d.ts` (unlike the 6 native entries above)
   * because it is not a capability a step grants via `step.tools`/
   * `allowedTools` (`agent.ts`, `options.allowedTools = step.tools`): it is
   * the channel through which the SDK RETURNS the result when `outputFormat`
   * is active (`step.outputs`, whatever the step's tool list) — its own
   * internal prompt forces the model to call it exactly once at the end of
   * each turn; it is not a one-off correction mechanism, it is the main
   * output channel of every step with `outputs:`. Confirmed by reading the
   * real definition in the SDK's native binary
   * (`node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`):
   * `isMcp: false`, `call()` is total — it just returns `{ data:
   * "Structured output provided successfully", structured_output: e,
   * endsTurn: true }`, with no fs, network or subprocess. Before this entry,
   * the table denied it with "unknown tool for the engine", bringing the
   * step down with "the result is not valid JSON" — the only reason this
   * took until the first real run of a pipeline to show up is
   * that the engine had been surviving on the SDK's own text-JSON fallback
   * when this tool was not available — not that the failure is a rare case:
   * every step with `outputs:` calls it under normal conditions.
   * `kind: 'none'`: it does not touch the filesystem in any form.
   * `knownFields: []` because its fields are the step's own `outputs:` schema
   * (the SDK exposes its `inputSchema` as `passthrough()`), not a fixed
   * contract — there is nothing static to compare in a schema drift.
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
  // `paths` is OPTIONAL in both — verified against the real schema of
  // `@playwright/mcp@0.0.79`: `browser_file_upload` without `paths` cancels
  // the file chooser instead of failing, and `browser_drop` can be invoked
  // with `data` alone (no `paths` at all). It used to be marked
  // `required: true`, which denied a legitimate call without that field as
  // "required field missing" (see `extractPathCandidates`) — the same kind of
  // fail-closed the table pursues in general, but applied to a field the real
  // package does not require.
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
 * Tools with no path field a hook could meaningfully bound (`Bash`/`REPL`
 * run free text), or that mutate the `cwd` itself at runtime
 * (`EnterWorktree`/`ExitWorktree` — they would undermine the root captured
 * in `captureRoots` if allowed), or that run arbitrary code
 * (`browser_evaluate`/`browser_run_code_unsafe`). No opt-in: verified
 * against real pipelines that none of them needs these, and a door nobody
 * uses is only attack surface.
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

/** Resolves `cwd`/`additionalDirs` ONCE per step, before the hook's first invocation. */
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
 * Literal base of a glob pattern: everything before the first segment with a
 * metacharacter. A pattern with no metacharacter at all is treated as a plain
 * path (the loop finds nothing to cut and returns the whole pattern). A
 * pattern whose first segment ALREADY has a metacharacter (`/**\/x` or
 * `**\/x`) yields an empty base, ambiguous between "the whole root" and "the
 * entire cwd" — it is disambiguated by whether the original pattern was
 * absolute.
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
 * Resolves a plain path (already free of ".." — the caller checks that
 * first) against `cwdRoot`, with `realpath`. If the target does not exist yet
 * (a `Write` creating new files/directories), it walks up to the nearest
 * existing ancestor, resolves it, and re-appends the tail — safe because the
 * tail can no longer contain "..".
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
        if (parent === dir) throw new Error(`no existing ancestor of "${raw}"`);
        tail.push(basename(dir));
        dir = parent;
      }
    }
  }
}

type PathCandidate = { raw: string; glob: boolean };

/**
 * Result of extracting the path candidates from `toolInput` according to the
 * profile. `ok: false` when a field marked `required: true` is missing or has
 * an unexpected type — the whole call is denied instead of being treated as
 * "no paths to check" (bug found in the first pass of this file: `Read`
 * without `file_path` fell into 0 candidates and was allowed by default,
 * exactly the opposite of "fail closed"). An optional field that is missing
 * or of an unexpected type is simply skipped: most Playwright path fields are
 * optional (`filename?`), and passing `undefined`/a number to the resolver
 * would throw.
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
      return { ok: false, reason: `"${f.name}" is required and is missing or has an unexpected type` };
    }
  }
  return { ok: true, candidates: out };
}

/**
 * Decides whether a call to `toolName` with `toolInput` may run given
 * `roots`. NEVER throws — any internal exception becomes an explicit DENY:
 * the sandbox never fails open.
 */
export function evaluateToolCall(toolName: string, toolInput: unknown, roots: FsRoots): PathCheckResult {
  try {
    if (HARD_DENY_TOOLS.has(toolName)) {
      return deny(
        `"${toolName}" is not allowed in an agent step — if you need to run commands, use a type: shell step`,
      );
    }
    const profile = TOOL_FS_PROFILES[toolName];
    if (!profile) return deny(`unknown tool for the engine: "${toolName}"`);
    if (profile.kind === 'none') return allow();

    if (profile.kind === 'url') {
      const input = toolInput !== null && typeof toolInput === 'object' ? (toolInput as Record<string, unknown>) : {};
      const value = input[profile.field];
      if (typeof value !== 'string') return allow(); // field missing: nothing to validate
      if (!profile.schemes.some((s) => value.startsWith(`${s}://`))) {
        return deny(`scheme not allowed in ${profile.field}: "${value}"`);
      }
      return allow();
    }

    const extracted = extractPathCandidates(profile, toolInput);
    if (!extracted.ok) return deny(extracted.reason);

    for (const { raw, glob } of extracted.candidates) {
      if (containsDotDotSegment(raw)) return deny(`path with ".." rejected: "${raw}"`);
      if (profile.mutates && !isAbsolute(raw)) {
        return deny(`"${raw}" must be an absolute path for this tool — its relative base is not cwd`);
      }
      const base = glob ? globBase(raw) : raw;
      const resolved = resolvePlainPath(base, roots.cwdRoot);
      const allowedRoot = profile.mutates
        ? (isUnder(resolved, roots.cwdRoot) ? roots.cwdRoot : null)
        : (isUnder(resolved, roots.cwdRoot) ? roots.cwdRoot : roots.readRoots.find((r) => isUnder(resolved, r)));
      if (!allowedRoot) {
        return deny(
          `"${raw}" resolves outside every allowed root ` +
            `(write: ${roots.cwdRoot}${
              profile.mutates ? '' : `; read: ${[roots.cwdRoot, ...roots.readRoots].join(', ')}`
            })`,
        );
      }
    }
    return allow();
  } catch (err) {
    return deny(`internal error validating the path — denied by default (${(err as Error).message})`);
  }
}
