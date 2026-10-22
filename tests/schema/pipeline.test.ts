import { describe, expect, test } from 'bun:test';
import { parsePipeline, PipelineParseError, type AgentStep } from '../../src/schema/pipeline.ts';

const MINIMAL = `
name: demo
description: A minimal pipeline
version: 1
steps:
  - id: hello
    type: shell
    run: echo hello
`;

describe('parsePipeline', () => {
  test('accepts a minimal pipeline and applies the defaults', () => {
    const p = parsePipeline(MINIMAL);
    expect(p.name).toBe('demo');
    expect(p.version).toBe(1);
    expect(p.steps).toHaveLength(1);
    const step = p.steps[0]!;
    expect(step.type).toBe('shell');
    expect(step.onError).toBe('stop');
    expect(step.retry).toEqual({ attempts: 0, on: 'transient' });
    expect(step.timeout).toBe('15m');
  });

  test('the default type of a step is agent', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    agent: writer
    prompt: steps/a.md
`);
    expect(p.steps[0]!.type).toBe('agent');
  });

  test('accepts an optional max_cost_usd in an agent step', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    agent: writer
    prompt: p.md
    max_cost_usd: 2.5
`);
    const step = p.steps[0]! as AgentStep;
    expect(step.maxCostUsd).toBe(2.5);
  });

  test('max_cost_usd is undefined if not declared', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    agent: writer
    prompt: p.md
`);
    const step = p.steps[0]! as AgentStep;
    expect(step.maxCostUsd).toBeUndefined();
  });

  test('rejects a negative or zero max_cost_usd', () => {
    expect(() =>
      parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    agent: writer
    prompt: p.md
    max_cost_usd: 0
`),
    ).toThrow(PipelineParseError);
  });

  test('the pipeline defaults propagate to the steps that do not declare them', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
defaults:
  on_error: continue
  retry: 2
  timeout: 5m
steps:
  - id: a
    type: shell
    run: 'true'
  - id: b
    type: shell
    run: 'true'
    on_error: stop
`);
    expect(p.steps[0]!.onError).toBe('continue');
    expect(p.steps[0]!.retry).toEqual({ attempts: 2, on: 'transient' });
    expect(p.steps[0]!.timeout).toBe('5m');
    expect(p.steps[1]!.onError).toBe('stop');
  });

  test('rejects an agent step without prompt naming the field', () => {
    try {
      parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    agent: writer
`);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineParseError);
      const issues = (err as PipelineParseError).issues;
      expect(issues.some((i) => i.includes('steps.0.prompt'))).toBe(true);
      expect(issues.some((i) => i === 'steps.0: Invalid input')).toBe(false);
    }
  });

  test('rejects a shell step without run naming the field', () => {
    try {
      parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
`);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineParseError);
      const issues = (err as PipelineParseError).issues;
      expect(issues.some((i) => i.includes('steps.0.run'))).toBe(true);
      expect(issues.some((i) => i === 'steps.0: Invalid input')).toBe(false);
    }
  });

  test('rejects duplicate step ids naming the id', () => {
    try {
      parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: 'true'
  - id: a
    type: shell
    run: 'true'
`);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineParseError);
      expect((err as PipelineParseError).issues.join(' ')).toContain('a');
    }
  });

  test('rejects syntactically invalid YAML', () => {
    expect(() => parsePipeline('name: [unclosed')).toThrow(PipelineParseError);
  });

  // The format uses `on_error` in all its examples; before this fix the
  // schema accepted `onError` and Zod silently dropped the `on_error` key
  // (and any other typo), without warning. `.strict()` turns that into an
  // error that names the key.
  test('the YAML key is on_error, as the format documents it, and it does take effect', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: exit 1
    on_error: continue
`);
    expect(p.steps[0]!.onError).toBe('continue');
  });

  test('rejects a typo in a step field naming the unknown key', () => {
    try {
      parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: 'true'
    outpus: { n: number }
`);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineParseError);
      const issues = (err as PipelineParseError).issues;
      expect(issues.some((i) => i.includes('outpus'))).toBe(true);
    }
  });

  test('rejects a typo in defaults naming the unknown key', () => {
    try {
      parsePipeline(`
name: demo
description: d
version: 1
defaults:
  retires: 2
steps:
  - id: a
    type: shell
    run: 'true'
`);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineParseError);
      const issues = (err as PipelineParseError).issues;
      expect(issues.some((i) => i.includes('retires'))).toBe(true);
    }
  });

  test('rejects an unknown key at pipeline level naming it', () => {
    try {
      parsePipeline(`
name: demo
description: d
version: 1
paramas:
  x: 1
steps:
  - id: a
    type: shell
    run: 'true'
`);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineParseError);
      const issues = (err as PipelineParseError).issues;
      expect(issues.some((i) => i.includes('paramas'))).toBe(true);
    }
  });

  test('accepts notify.on with failed (not failure) and exposes it as is', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
notify:
  on: [failed, success]
  channel: telegram
steps:
  - id: a
    type: shell
    run: 'true'
`);
    expect(p.notify).toEqual({ on: ['failed', 'success'], channel: 'telegram' });
  });

  test('rejects the old name failure in notify.on', () => {
    expect(() =>
      parsePipeline(`
name: demo
description: d
version: 1
notify:
  on: [failure]
  channel: telegram
steps:
  - id: a
    type: shell
    run: 'true'
`),
    ).toThrow(PipelineParseError);
  });
});

describe('mcp_servers', () => {
  const declaredYaml = (server: string, tools = '[Read, mcp__my-device__screenshot]') => `
name: demo
description: d
version: 1
mcp_servers:
  my-device:
${server}
steps:
  - id: a
    agent: writer
    prompt: p.md
    mcp_servers: [my-device]
    tools: ${tools}
`;
  const issuesOf = (yaml: string): string[] => {
    try {
      parsePipeline(yaml);
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineParseError);
      return (err as PipelineParseError).issues;
    }
    throw new Error('should have thrown');
  };

  test('kind: declared with allow exposes exactly the listed tools', () => {
    const p = parsePipeline(
      declaredYaml(
        '    command: qa\n    args: [mcp]\n    kind: declared\n    allow: [screenshot, tap]',
        '[Read, mcp__my-device__screenshot]',
      ),
    );
    expect(p.mcpServers["my-device"]!.allow).toEqual(['screenshot', 'tap']);
  });

  test('a tool of a declared server that is not in allow is rejected', () => {
    const issues = issuesOf(
      declaredYaml(
        '    command: qa\n    kind: declared\n    allow: [screenshot]',
        '[mcp__my-device__erase]',
      ),
    );
    expect(issues.join('\n')).toContain('steps.0.tools.0');
    expect(issues.join('\n')).toContain('"erase" is not in the allow of server "my-device"');
  });

  test('kind: declared without allow is rejected', () => {
    const text = issuesOf(declaredYaml('    command: qa\n    kind: declared', '[Read]')).join('\n');
    expect(text).toContain('mcp_servers.my-device');
    expect(text).toContain('allow');
  });

  test('allow on a server without kind: declared is rejected', () => {
    for (const kindLine of ['    kind: playwright\n', '']) {
      const text = issuesOf(
        declaredYaml(`    command: qa\n${kindLine}    allow: [screenshot]`, '[Read]'),
      ).join('\n');
      expect(text).toContain('mcp_servers.my-device');
      expect(text).toContain('allow');
    }
  });

  test('allow containing a HARD_DENY_TOOLS tool is rejected', () => {
    const text = issuesOf(
      declaredYaml('    command: qa\n    kind: declared\n    allow: [browser_evaluate]', '[Read]'),
    ).join('\n');
    expect(text).toContain('mcp_servers.my-device.allow.0');
    expect(text).toContain('browser_evaluate');
  });

  test('an empty allow is rejected', () => {
    const text = issuesOf(
      declaredYaml('    command: qa\n    kind: declared\n    allow: []', '[Read]'),
    ).join('\n');
    expect(text).toContain('mcp_servers.my-device.allow');
  });

  test('resolves the pipeline registry and the names enabled by a step', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
mcp_servers:
  playwright:
    command: npx
    args: ["-y", "@playwright/mcp@latest", "--headless"]
    env: [PLAYWRIGHT_TOKEN]
steps:
  - id: a
    agent: writer
    prompt: p.md
    mcp_servers: [playwright]
`);
    expect(p.mcpServers).toEqual({
      playwright: {
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest', '--headless'],
        env: ['PLAYWRIGHT_TOKEN'],
      },
    });
    const step = p.steps[0]!;
    expect(step.type).toBe('agent');
    expect((step as { mcpServers: string[] }).mcpServers).toEqual(['playwright']);
  });

  test('a step without mcp_servers ends up with an empty list', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    agent: writer
    prompt: p.md
`);
    expect((p.steps[0] as { mcpServers: string[] }).mcpServers).toEqual([]);
  });

  test('args and env of a server default to empty lists', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
mcp_servers:
  bare:
    command: some-mcp-server
steps:
  - id: a
    type: shell
    run: 'true'
`);
    expect(p.mcpServers.bare).toEqual({ command: 'some-mcp-server', args: [], env: [] });
  });

  test('rejects a step that references an undeclared MCP server, naming the step and the index', () => {
    try {
      parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    agent: writer
    prompt: p.md
    mcp_servers: [playwright]
`);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineParseError);
      const issues = (err as PipelineParseError).issues;
      expect(issues).toEqual([
        'steps.0.mcp_servers.0: MCP server "playwright" not declared in mcp_servers',
      ]);
    }
  });

  test('rejects an mcp__ tool in tools without the server enabled in mcp_servers', () => {
    try {
      parsePipeline(`
name: demo
description: d
version: 1
mcp_servers:
  playwright:
    command: npx
    kind: playwright
steps:
  - id: a
    agent: writer
    prompt: p.md
    tools: [Read, mcp__playwright__browser_navigate]
`);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineParseError);
      const issues = (err as PipelineParseError).issues;
      expect(issues).toEqual([
        'steps.0.tools.1: the tool "mcp__playwright__browser_navigate" requires enabling its server in mcp_servers',
      ]);
    }
  });

  test('accepts an mcp__ tool when its server is enabled in mcp_servers', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
mcp_servers:
  playwright:
    command: npx
    kind: playwright
steps:
  - id: a
    agent: writer
    prompt: p.md
    mcp_servers: [playwright]
    tools: [Read, mcp__playwright__browser_navigate]
`);
    expect((p.steps[0] as { tools: string[] }).tools).toContain('mcp__playwright__browser_navigate');
  });

  test('rejects an MCP server name that is not kebab-case', () => {
    try {
      parsePipeline(`
name: demo
description: d
version: 1
mcp_servers:
  "Play Wright":
    command: npx
steps:
  - id: a
    type: shell
    run: 'true'
`);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineParseError);
      const issues = (err as PipelineParseError).issues;
      expect(issues.some((i) => i.includes('mcp_servers') && i.includes('kebab-case'))).toBe(true);
    }
  });

  test('rejects an unknown key inside an MCP server naming it', () => {
    try {
      parsePipeline(`
name: demo
description: d
version: 1
mcp_servers:
  playwright:
    comand: npx
steps:
  - id: a
    type: shell
    run: 'true'
`);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineParseError);
      const issues = (err as PipelineParseError).issues;
      expect(issues.some((i) => i.includes('comand'))).toBe(true);
    }
  });

  test('an mcp_servers server can declare kind: playwright, and an mcp__<server>__<suffix> tool known for that kind is accepted with whatever server name the author picks', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
mcp_servers:
  pw:
    command: npx
    args: ["-y", "@playwright/mcp@latest"]
    kind: playwright
steps:
  - id: a
    agent: writer
    prompt: p.md
    mcp_servers: [pw]
    tools: [mcp__pw__browser_click, mcp__pw__browser_take_screenshot]
`);
    expect(p.mcpServers.pw!.kind).toBe('playwright');
  });

  test('an mcp__<server>__<suffix> tool whose server does not declare kind: is rejected', () => {
    expect(() =>
      parsePipeline(`
name: demo
description: d
version: 1
mcp_servers:
  pw:
    command: npx
    args: ["-y", "@playwright/mcp@latest"]
steps:
  - id: a
    agent: writer
    prompt: p.md
    mcp_servers: [pw]
    tools: [mcp__pw__browser_click]
`),
    ).toThrow(/kind/);
  });

  test('an mcp__<server>__<suffix> suffix that kind: playwright does not recognize is rejected', () => {
    expect(() =>
      parsePipeline(`
name: demo
description: d
version: 1
mcp_servers:
  pw:
    command: npx
    args: []
    kind: playwright
steps:
  - id: a
    agent: writer
    prompt: p.md
    mcp_servers: [pw]
    tools: [mcp__pw__this_tool_does_not_exist]
`),
    ).toThrow(/this_tool_does_not_exist/);
  });

  test('mcp__<server>__browser_evaluate is rejected with a specific reason, even if the server declares kind: playwright', () => {
    expect(() =>
      parsePipeline(`
name: demo
description: d
version: 1
mcp_servers:
  pw:
    command: npx
    args: []
    kind: playwright
steps:
  - id: a
    agent: writer
    prompt: p.md
    mcp_servers: [pw]
    tools: [mcp__pw__browser_evaluate]
`),
    ).toThrow(/arbitrary code/);
  });
});

describe('tools: governance — deny-by-default', () => {
  test('a native tool unknown to the engine is rejected with the tool name', () => {
    expect(() =>
      parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    agent: writer
    prompt: p.md
    tools: [TotallyMadeUpTool]
`),
    ).toThrow(/TotallyMadeUpTool/);
  });

  test('Bash in tools: of an agent step is rejected, suggesting type: shell', () => {
    expect(() =>
      parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    agent: writer
    prompt: p.md
    tools: [Bash]
`),
    ).toThrow(/type: shell/);
  });

  test('the known native tools (Read/Write/Edit/NotebookEdit/Glob/Grep) are never rejected by name', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    agent: writer
    prompt: p.md
    tools: [Read, Write, Edit, NotebookEdit, Glob, Grep]
`);
    expect((p.steps[0] as AgentStep).tools).toEqual(['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep']);
  });
});

describe('when guards — specific messages', () => {
  function parseWhen(guard: string): PipelineParseError {
    try {
      parsePipeline(`
name: demo
description: d
version: 1
when:
  - ${guard}
steps:
  - id: a
    type: shell
    run: 'true'
`);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineParseError);
      return err as PipelineParseError;
    }
  }

  test('a malformed throttle.every names the field throttle.every', () => {
    const err = parseWhen('throttle: { every: "3 hours" }');
    expect(err.issues.some((i) => i.includes('when.0') && i.includes('every'))).toBe(true);
  });

  test('a badly formatted between names the field between', () => {
    const err = parseWhen('between: "tomorrow"');
    expect(err.issues.some((i) => i.includes('when.0') && i.includes('between'))).toBe(true);
  });

  test('a changed without path names the field changed.path', () => {
    const err = parseWhen('changed: {}');
    expect(err.issues.some((i) => i.includes('when.0') && i.includes('path'))).toBe(true);
  });

  test('a guard with no recognized key says so explicitly', () => {
    const err = parseWhen('foo: bar');
    expect(err.issues.some((i) => i.includes('when.0') && i.includes('throttle'))).toBe(true);
  });

  test('a guard with two keys of different type says so explicitly', () => {
    const err = parseWhen('{ throttle: 4h, shell: "true" }');
    expect(err.issues.some((i) => i.includes('when.0'))).toBe(true);
  });

  test('a valid shell still parses successfully (no regression)', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
when:
  - shell: "true"
steps:
  - id: a
    type: shell
    run: 'true'
`);
    expect(p.when).toEqual([{ shell: 'true' }]);
  });

  // The four guard branches (and the nested throttle/changed objects) are
  // `.strict()`: an unknown key is no longer dropped silently (behavior
  // confirmed BEFORE this fix: `sinc` instead of `since` parsed without
  // error and the guard anchored on the wrong default). Same `.strict()`
  // convention already established in the rest of the file.
  test('a typo inside throttle (object branch) is rejected, not dropped silently', () => {
    const err = parseWhen('throttle: { every: "4h", sinc: last_attempt }');
    expect(err.issues.some((i) => i.includes('when.0'))).toBe(true);
  });

  test('a typo inside changed is rejected, not dropped silently', () => {
    const err = parseWhen('changed: { path: /x, sinc: last_attempt }');
    expect(err.issues.some((i) => i.includes('when.0'))).toBe(true);
  });

  test('an extra key at shell level is rejected', () => {
    const err = parseWhen('{ shell: "true", extra: 1 }');
    expect(err.issues.some((i) => i.includes('when.0'))).toBe(true);
  });

  test('an extra key at between level is rejected', () => {
    const err = parseWhen('{ between: "07:00-23:00", extra: 1 }');
    expect(err.issues.some((i) => i.includes('when.0'))).toBe(true);
  });

  test('throttle as a simple duration (string branch, not object) still parses successfully', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
when:
  - throttle: 4h
steps:
  - id: a
    type: shell
    run: 'true'
`);
    expect(p.when).toEqual([{ throttle: '4h' }]);
  });

  test('throttle with a correct since (no typo) still parses successfully', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
when:
  - throttle: { every: 4h, since: last_attempt }
steps:
  - id: a
    type: shell
    run: 'true'
`);
    expect(p.when).toEqual([{ throttle: { every: '4h', since: 'last_attempt' } }]);
  });

  test('changed with a correct since (no typo) still parses successfully', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
when:
  - changed: { path: /x, since: last_attempt }
steps:
  - id: a
    type: shell
    run: 'true'
`);
    expect(p.when).toEqual([{ changed: { path: '/x', since: 'last_attempt' } }]);
  });
});

describe('always — unconditional cleanup', () => {
  test('accepts an always block and exposes it as shell steps', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: 'true'
always:
  - id: cleanup
    run: git reset --hard
    cwd: /tmp
`);
    expect(p.always).toHaveLength(1);
    expect(p.always[0]).toMatchObject({
      id: 'cleanup', type: 'shell', run: 'git reset --hard', cwd: '/tmp',
    });
  });

  test('without always declared, the list is empty', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: 'true'
`);
    expect(p.always).toEqual([]);
  });

  test('an always id duplicated with one in steps is rejected', () => {
    expect(() =>
      parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: 'true'
always:
  - id: a
    run: 'true'
`),
    ).toThrow(PipelineParseError);
  });

  test('two always entries with the same id (no collision with steps) are rejected', () => {
    try {
      parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: 'true'
always:
  - id: cleanup
    run: 'true'
  - id: cleanup
    run: 'echo again'
`);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineParseError);
      expect(
        (err as PipelineParseError).issues.some(
          (i) => i.includes('always') && i.includes('cleanup'),
        ),
      ).toBe(true);
    }
  });

  test('rejects an unknown key inside always naming it', () => {
    try {
      parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: 'true'
always:
  - id: cleanup
    run: 'true'
    when: "true"
`);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineParseError);
      expect((err as PipelineParseError).issues.some((i) => i.includes('when'))).toBe(true);
    }
  });
});

describe('notify.stale_after', () => {
  const withNotify = (notify: string) =>
    parsePipeline(`
name: demo
description: d
version: 1
notify:
${notify}
steps:
  - id: a
    type: shell
    run: 'true'
`);

  test('accepts a valid duration', () => {
    const p = withNotify('  on: [success]\n  stale_after: 72h\n  channel: c');
    expect(p.notify?.staleAfter).toBe('72h');
  });

  test('is optional', () => {
    const p = withNotify('  on: [success]\n  channel: c');
    expect(p.notify?.staleAfter).toBeUndefined();
  });

  test('rejects a malformed duration', () => {
    expect(() => withNotify('  on: [success]\n  stale_after: 3 days\n  channel: c')).toThrow(/stale_after/);
  });

  // Without `.strict()`, a misspelled `stale_after` would be ignored
  // silently — exactly the class of silent failure this field exists to
  // avoid.
  test('rejects an unknown key inside notify', () => {
    expect(() => withNotify('  on: [success]\n  stale_afer: 72h\n  channel: c')).toThrow();
  });
});
