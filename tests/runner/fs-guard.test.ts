import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureRoots, evaluateToolCall, HARD_DENY_TOOLS, TOOL_FS_PROFILES } from '../../src/runner/fs-guard.ts';

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'fs-guard-'));
  const cwd = join(root, 'allowed');
  const outside = join(root, 'outside');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 'SECRET');
  return { root, cwd, outside };
}

describe('captureRoots', () => {
  test('resolves cwd and additional_dirs with realpath, no trailing separator', () => {
    const { cwd, outside } = sandbox();
    const roots = captureRoots(cwd, [outside]);
    expect(roots.cwdRoot).toBe(realpathSync(cwd));
    expect(roots.readRoots).toEqual([realpathSync(outside)]);
  });

  test('throws if a root does not exist — a configuration error, not a surprise mid-run', () => {
    const { cwd } = sandbox();
    expect(() => captureRoots(cwd, [join(cwd, 'does-not-exist')])).toThrow();
  });
});

describe('evaluateToolCall — Read/Write/Edit inside and outside cwd', () => {
  test('Read inside cwd is allowed', () => {
    const { cwd } = sandbox();
    writeFileSync(join(cwd, 'a.txt'), 'x');
    const roots = captureRoots(cwd, []);
    expect(evaluateToolCall('Read', { file_path: join(cwd, 'a.txt') }, roots)).toEqual({ allowed: true });
  });

  test('Read outside cwd and without additional_dirs is denied', () => {
    const { cwd, outside } = sandbox();
    const roots = captureRoots(cwd, []);
    const result = evaluateToolCall('Read', { file_path: join(outside, 'secret.txt') }, roots);
    expect(result.allowed).toBe(false);
  });

  test('Read outside cwd but inside an additional_dirs is allowed', () => {
    const { cwd, outside } = sandbox();
    const roots = captureRoots(cwd, [outside]);
    expect(evaluateToolCall('Read', { file_path: join(outside, 'secret.txt') }, roots)).toEqual({ allowed: true });
  });

  test('Write inside an additional_dirs (read-only) is denied — mutating there is never valid', () => {
    const { cwd, outside } = sandbox();
    const roots = captureRoots(cwd, [outside]);
    const result = evaluateToolCall('Write', { file_path: join(outside, 'new.txt') }, roots);
    expect(result.allowed).toBe(false);
  });

  test('a nonexistent target with several levels of new directories under cwd is allowed (Write creates parents)', () => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    const target = join(cwd, 'deep1', 'deep2', 'deep3', 'hello.txt');
    expect(evaluateToolCall('Write', { file_path: target }, roots)).toEqual({ allowed: true });
  });

  test('a symlink inside cwd pointing outside every root is denied', () => {
    const { cwd, outside } = sandbox();
    symlinkSync(outside, join(cwd, 'escape'));
    const roots = captureRoots(cwd, []);
    const result = evaluateToolCall('Read', { file_path: join(cwd, 'escape', 'secret.txt') }, roots);
    expect(result.allowed).toBe(false);
  });

  test('".." right after a symlink is rejected (no attempt to resolve it)', () => {
    const { cwd, outside } = sandbox();
    symlinkSync(outside, join(cwd, 'escape'));
    const roots = captureRoots(cwd, []);
    // "allowed/escape/../outside/secret.txt": normalizing before resolving would give
    // "allowed/outside/secret.txt" (inside cwd, does not exist) and wrongly allow it
    // — the reason for the realpath bug in Bun with symlink+"..".
    // NOTE: built with concatenation, not `join()` — `path.join()` normalizes
    // and would collapse the ".." before the function under test gets to see it.
    const result = evaluateToolCall(
      'Read',
      { file_path: `${join(cwd, 'escape')}/../outside/secret.txt` },
      roots,
    );
    expect(result.allowed).toBe(false);
    expect(result.allowed === false && result.reason).toContain('".."');
  });

  test('a path with ".." inside cwd (no symlink in between) is also rejected — the rule is about the raw text, not about whether it really escapes', () => {
    const { cwd } = sandbox();
    mkdirSync(join(cwd, 'sub'));
    const roots = captureRoots(cwd, []);
    // Same as above: concatenation, not `join()`, so the ".." survives raw.
    const result = evaluateToolCall('Read', { file_path: `${join(cwd, 'sub')}/../a.txt` }, roots);
    expect(result.allowed).toBe(false);
  });

  test('sibling-prefix false positive: /root-evil must not pass against the /root root', () => {
    const { root, cwd } = sandbox();
    const evilSibling = `${cwd}-evil`;
    mkdirSync(evilSibling, { recursive: true });
    writeFileSync(join(evilSibling, 'x.txt'), 'x');
    const roots = captureRoots(cwd, []);
    const result = evaluateToolCall('Read', { file_path: join(evilSibling, 'x.txt') }, roots);
    expect(result.allowed).toBe(false);
    void root;
  });

  test('the root itself (no file inside) is allowed for a tool that operates on a directory', () => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    expect(evaluateToolCall('Grep', { pattern: 'x', path: cwd }, roots)).toEqual({ allowed: true });
  });
});

describe('evaluateToolCall — Glob/Grep', () => {
  test('Glob with an absolute pattern and no "path" is evaluated by the pattern itself', () => {
    const { cwd, outside } = sandbox();
    const roots = captureRoots(cwd, []);
    const result = evaluateToolCall('Glob', { pattern: join(outside, '*.txt') }, roots);
    expect(result.allowed).toBe(false);
  });

  test('Glob with a pattern with no metacharacter, absolute and outside every root, is treated as a plain path and denied', () => {
    const { cwd, outside } = sandbox();
    const roots = captureRoots(cwd, []);
    const result = evaluateToolCall('Glob', { pattern: join(outside, 'secret.txt') }, roots);
    expect(result.allowed).toBe(false);
  });

  test('absolute "/**/..." pattern: empty base is interpreted as the filesystem root, denied', () => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    const result = evaluateToolCall('Glob', { pattern: '/**/etc/passwd' }, roots);
    expect(result.allowed).toBe(false);
  });

  test('relative "**/..." pattern (no leading slash): empty base is interpreted as cwd, allowed', () => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    const result = evaluateToolCall('Glob', { pattern: '**/*.png' }, roots);
    expect(result.allowed).toBe(true);
  });

  test('Grep with an absolute "path" outside cwd is denied even if "glob" is empty', () => {
    const { cwd, outside } = sandbox();
    const roots = captureRoots(cwd, []);
    const result = evaluateToolCall('Grep', { pattern: 'x', path: outside }, roots);
    expect(result.allowed).toBe(false);
  });
});

describe('evaluateToolCall — Playwright write tools (absolute path required)', () => {
  test('a relative filename is denied (the real base is the MCP server output dir, not cwd)', () => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    const result = evaluateToolCall('browser_take_screenshot', { filename: 'shot.png' }, roots);
    expect(result.allowed).toBe(false);
  });

  test('an absolute filename inside cwd is allowed', () => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    const result = evaluateToolCall(
      'browser_take_screenshot',
      { filename: join(cwd, 'public', 'screenshots', 'shot.png') },
      roots,
    );
    expect(result.allowed).toBe(true);
  });

  test('a MISSING filename (optional field) is not denied — it is skipped, undefined is not passed to the resolver', () => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    expect(evaluateToolCall('browser_snapshot', {}, roots)).toEqual({ allowed: true });
  });

  test('browser_file_upload with paths[] outside cwd is denied', () => {
    const { cwd, outside } = sandbox();
    const roots = captureRoots(cwd, []);
    const result = evaluateToolCall(
      'browser_file_upload',
      { paths: [join(cwd, 'ok.png'), join(outside, 'secret.txt')] },
      roots,
    );
    expect(result.allowed).toBe(false);
  });

  test('browser_navigate with an http scheme is allowed, with file:// it is denied', () => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    expect(evaluateToolCall('browser_navigate', { url: 'https://admin.example.com/login' }, roots)).toEqual({
      allowed: true,
    });
    const result = evaluateToolCall('browser_navigate', { url: 'file:///etc/passwd' }, roots);
    expect(result.allowed).toBe(false);
  });
});

describe('evaluateToolCall — "none" tools and the hard-deny bucket', () => {
  test('a tool with no filesystem surface is always allowed', () => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    expect(evaluateToolCall('browser_click', { ref: 'x' }, roots)).toEqual({ allowed: true });
  });

  test.each([...HARD_DENY_TOOLS])('%s is in the hard-deny bucket and is always denied', (name) => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    expect(evaluateToolCall(name, {}, roots).allowed).toBe(false);
  });

  test('an unknown tool (neither in the table nor in the hard bucket) is denied', () => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    // Bare, no `mcp__` prefix — a name that genuinely does not exist in
    // `TOOL_FS_PROFILES`, unrelated to the subject of the test below. This
    // same test used to use 'mcp__futuro-servidor__algo_nuevo' as its example,
    // which mixed up two different denial reasons under the same "unknown
    // tool" label — see the next test.
    const result = evaluateToolCall('something-that-does-not-exist', {}, roots);
    expect(result.allowed).toBe(false);
  });

  // `evaluateToolCall` ITSELF never interprets the `mcp__<server>__` prefix —
  // neither for a real, granted MCP tool (`browser_take_screenshot`, with a
  // full profile in the table) nor for an invented one. Before the fix, this
  // meant that EVERY real MCP call arrived here with the qualified name intact
  // and fell into "unknown tool for the engine", denying the 18+ Playwright
  // tools a real pipeline grants — never detected because the only test
  // touching this name shape ('mcp__futuro-servidor__algo_nuevo', above in
  // earlier versions of this file) used a genuinely nonexistent server and
  // tool, so its denial looked like "unknown tool, correctly denied" and
  // nothing more — documenting the symptom of the bug as if it were the
  // expected behavior.
  //
  // The real fix lives one level up, in `makePreToolUseHook`
  // (`runner/agent.ts`): that function DOES know which servers the step
  // enabled (`step.mcpServers`) and strips the `mcp__<server>__` prefix ONLY
  // for those servers, before calling `evaluateToolCall` — never here, which
  // deliberately lacks that context (it cannot safely decide which prefix
  // belongs to a legitimate server of this step). This test pins that layer
  // boundary as intentional: `evaluateToolCall` denying an unnormalized
  // `mcp__...` name is correct, not a bug — coverage of the real case (same
  // name, already normalized by the hook, with server context) lives in
  // `tests/runner/agent.test.ts`.
  test('evaluateToolCall itself NEVER interprets the mcp__<server>__ prefix, not even for a real, granted MCP tool — normalizing it is the hook\'s job, not this function\'s', () => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    const result = evaluateToolCall('mcp__playwright__browser_take_screenshot', {}, roots);
    expect(result.allowed).toBe(false);
    expect((result as { reason: string }).reason).toContain('unknown tool for the engine');
  });

  // Found in the first real run of a pipeline: the SDK invokes
  // `StructuredOutput` as the MAIN output CHANNEL of every step with
  // `outputs:` (its own prompt forces the model to call it exactly once at
  // the end of the turn) — it is not in `step.tools`/`allowedTools` (it is not
  // something a pipeline "grants") and it has no filesystem surface (see the
  // comment next to its entry in `TOOL_FS_PROFILES`). Not being in the table,
  // it fell into "unknown tool for the engine" and brought the step down with
  // "the result is not valid JSON" — not a rare case of an MCP tool, but the
  // engine's most-used mechanism one model call away from breaking on every
  // run.
  test('StructuredOutput (the SDK outputFormat main output channel) is always allowed — it has no filesystem surface and does not depend on step.tools', () => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    expect(evaluateToolCall('StructuredOutput', { summary: 'x' }, roots)).toEqual({ allowed: true });
  });
});

describe('evaluateToolCall — never throws, always denies', () => {
  test('tool_input with an unexpected shape (not an object) denies instead of throwing', () => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    expect(() => evaluateToolCall('Read', 'not-an-object', roots)).not.toThrow();
    expect(evaluateToolCall('Read', 'not-an-object', roots).allowed).toBe(false);
  });

  test('null tool_input denies instead of throwing', () => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    expect(evaluateToolCall('Read', null, roots).allowed).toBe(false);
  });

  test('a missing required path field denies (unlike the optional case above)', () => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    expect(evaluateToolCall('Read', {}, roots).allowed).toBe(false);
  });

  test('a path field with an unexpected type (number) denies without throwing', () => {
    const { cwd } = sandbox();
    const roots = captureRoots(cwd, []);
    expect(() => evaluateToolCall('Write', { file_path: 12345 }, roots)).not.toThrow();
    expect(evaluateToolCall('Write', { file_path: 12345 }, roots).allowed).toBe(false);
  });
});

describe('TOOL_FS_PROFILES — full coverage', () => {
  test('all native tools of the engine have a profile', () => {
    for (const name of ['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep']) {
      expect(TOOL_FS_PROFILES[name]).toBeDefined();
    }
  });

  test('the 20 Playwright tools that docs-review grants have a profile or are in the hard bucket', () => {
    const granted = [
      'browser_click', 'browser_close', 'browser_console_messages', 'browser_drag', 'browser_drop',
      'browser_file_upload', 'browser_fill_form', 'browser_find', 'browser_handle_dialog', 'browser_hover',
      'browser_navigate', 'browser_navigate_back', 'browser_network_requests', 'browser_press_key',
      'browser_resize', 'browser_select_option', 'browser_snapshot', 'browser_take_screenshot',
      'browser_type', 'browser_wait_for',
    ];
    for (const name of granted) {
      expect(TOOL_FS_PROFILES[name] !== undefined || HARD_DENY_TOOLS.has(name)).toBe(true);
    }
  });

  test('browser_evaluate and browser_run_code_unsafe are in the hard bucket, not in the table', () => {
    expect(HARD_DENY_TOOLS.has('browser_evaluate')).toBe(true);
    expect(HARD_DENY_TOOLS.has('browser_run_code_unsafe')).toBe(true);
    expect(TOOL_FS_PROFILES['browser_evaluate']).toBeUndefined();
  });
});
