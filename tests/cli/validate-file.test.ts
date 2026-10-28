import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root: string;
const CLI = join(import.meta.dir, '..', '..', 'src', 'cli', 'index.ts');

function writePipeline(name: string, yaml: string) {
  mkdirSync(join(root, 'pipelines', name), { recursive: true });
  writeFileSync(join(root, 'pipelines', name, 'pipeline.yaml'), yaml);
}

async function cli(args: string[], cwd = root): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['bun', CLI, ...args], {
    cwd,
    env: { ...process.env, ANTHROPIC_API_KEY: 'sk-test' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out: stdout + stderr };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ap-validate-'));
  writeFileSync(join(root, 'pipelines.yaml'), 'channels: {}\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('validate <name> with the rules wired in', () => {
  test('the broken-references probe in run: no longer passes', async () => {
    // The references go inside shell DOUBLE quotes (single-quoted YAML, which
    // does not process escapes: what is written is what bash sees), so that R1
    // does not fire here and the only way to bring this test down is for
    // `checkGuardReferences`/`checkStepReferences` to still be genuinely
    // wired in.
    writePipeline(
      'demo',
      `name: demo
description: d
version: 1
params:
  real:
    description: exists
when:
  - shell: 'test -n "{{params.missing_guard}}"'
steps:
  - id: uno
    type: shell
    run: 'echo "{{params.missing_run}}" && echo {{params.real}}'
`,
    );
    const { code, out } = await cli(['validate', 'demo']);
    expect(code).not.toBe(0);
    expect(out).toContain('when.0.shell');
    expect(out).toContain('uno.run');
  });

  test('a correct pipeline stays green', async () => {
    writePipeline(
      'ok',
      `name: ok
description: d
version: 1
steps:
  - id: uno
    type: shell
    run: "true"
`,
    );
    const { code, out } = await cli(['validate', 'ok']);
    expect(code).toBe(0);
    expect(out).toContain('ok');
  });

  test('a missing prompt is still an ERROR without --file', async () => {
    writePipeline(
      'withagent',
      `name: withagent
description: d
version: 1
steps:
  - id: uno
    type: agent
    agent: writer
    prompt: missing.md
`,
    );
    const { code, out } = await cli(['validate', 'withagent']);
    expect(code).not.toBe(0);
    expect(out).toContain('missing.md');
  });

  test('a single engine rule is enough to bring the pipeline down (R3)', async () => {
    writePipeline(
      'nostrict',
      `name: nostrict
description: d
version: 1
steps:
  - id: uno
    type: shell
    run: |
      echo hello
      echo goodbye
`,
    );
    const { code, out } = await cli(['validate', 'nostrict']);
    expect(code).not.toBe(0);
    expect(out).toContain('set -euo pipefail');
  });

  test('R1 reaches the command: declared reference, but inside single quotes', async () => {
    writePipeline(
      'quotes',
      `name: quotes
description: d
version: 1
params:
  repo:
    description: r
steps:
  - id: uno
    type: shell
    run: "curl -d '{{params.repo}}'"
`,
    );
    const { code, out } = await cli(['validate', 'quotes']);
    expect(code).not.toBe(0);
    expect(out).toContain('does not expand');
  });
});

describe('validate --file', () => {
  test('validates a draft that does not live in pipelines/<name>/', async () => {
    const draft = join(root, 'draft.yaml');
    writeFileSync(
      draft,
      `name: demo
description: d
version: 1
steps:
  - id: uno
    type: shell
    run: "true"
`,
    );
    const { code, out } = await cli(['validate', '--file', draft]);
    expect(code).toBe(0);
    expect(out).toContain('demo');
  });

  test('the name: does not have to match any directory', async () => {
    const draft = join(root, 'other-name.yaml');
    writeFileSync(
      draft,
      `name: named-differently
description: d
version: 1
steps:
  - id: uno
    type: shell
    run: "true"
`,
    );
    expect((await cli(['validate', '--file', draft])).code).toBe(0);
  });

  test('a missing prompt is a WARNING, and says it did not check its references', async () => {
    const draft = join(root, 'draft.yaml');
    writeFileSync(
      draft,
      `name: demo
description: d
version: 1
steps:
  - id: uno
    type: agent
    agent: writer
    prompt: not-yet.md
`,
    );
    const { code, out } = await cli(['validate', '--file', draft]);
    expect(code).toBe(0);
    expect(out).toContain('warning');
    expect(out).toContain('not-yet.md');
    expect(out).toContain('NOT been checked');
  });

  test('a schema error is still an error', async () => {
    const draft = join(root, 'bad.yaml');
    writeFileSync(
      draft,
      `name: demo
description: d
version: 1
when:
  - throttle: 6d
steps:
  - id: uno
    type: shell
    run: "true"
`,
    );
    const { code, out } = await cli(['validate', '--file', draft]);
    expect(code).not.toBe(0);
    expect(out).toContain('s, m or h');
  });

  test('outside any repo it does not blow up, and warns that it did not check the channel', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'ap-no-repo-'));
    try {
      const draft = join(elsewhere, 'draft.yaml');
      writeFileSync(
        draft,
        `name: demo
description: d
version: 1
triggers:
  - cron: "0 3 * * *"
notify:
  on: [failed]
  stale_after: 72h
  channel: mail
steps:
  - id: uno
    type: shell
    run: "true"
`,
      );
      const { code, out } = await cli(['validate', '--file', draft], elsewhere);
      expect(code).toBe(0);
      expect(out).toContain('warning');
      expect(out).toContain('mail');
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test('--file together with a name is a usage error', async () => {
    const draft = join(root, 'draft.yaml');
    writeFileSync(draft, 'name: demo\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n');
    const { code, out } = await cli(['validate', 'demo', '--file', draft]);
    expect(code).not.toBe(0);
    expect(out).toContain('--file');
  });
});
