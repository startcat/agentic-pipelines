import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRepoContext } from '../../src/cli/context.ts';
import { escapeHtml } from '../../src/web/render.ts';
import { createServer } from '../../src/web/server.ts';

let root: string;
const CLI = join(import.meta.dir, '..', '..', 'src', 'cli', 'index.ts');

function writePipeline(name: string, yaml: string) {
  mkdirSync(join(root, 'pipelines', name), { recursive: true });
  writeFileSync(join(root, 'pipelines', name, 'pipeline.yaml'), yaml);
}

function latestRunId(pipeline: string): string {
  const entries = readdirSync(join(root, '.runs', pipeline)).sort();
  const last = entries[entries.length - 1];
  if (!last) throw new Error(`no runs of "${pipeline}"`);
  return last;
}

async function cli(args: string[]): Promise<{ code: number; out: string; stdout: string }> {
  const proc = Bun.spawn(['bun', CLI, ...args], {
    cwd: root,
    env: { ...process.env, ANTHROPIC_API_KEY: 'sk-test' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out: stdout + stderr, stdout };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ap-e2e-'));
  writeFileSync(join(root, 'pipelines.yaml'), 'channels: {}\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('repo location independent of the invocation directory', () => {
  test('--repo points to a repo outside the current cwd', async () => {
    writePipeline('ok', 'name: ok\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n');
    const elsewhere = mkdtempSync(join(tmpdir(), 'ap-elsewhere-'));
    try {
      const proc = Bun.spawn(['bun', CLI, '--repo', root, 'validate', 'ok'], {
        cwd: elsewhere,
        env: { ...process.env, ANTHROPIC_API_KEY: 'sk-test' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(await proc.exited).toBe(0);
      expect(stdout + stderr).toContain('ok');
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test('PIPELINES_REPO points to a repo outside the current cwd', async () => {
    writePipeline('ok', 'name: ok\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n');
    const elsewhere = mkdtempSync(join(tmpdir(), 'ap-elsewhere-'));
    try {
      const proc = Bun.spawn(['bun', CLI, 'validate', 'ok'], {
        cwd: elsewhere,
        env: { ...process.env, ANTHROPIC_API_KEY: 'sk-test', PIPELINES_REPO: root },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(await proc.exited).toBe(0);
      expect(stdout + stderr).toContain('ok');
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test('--repo takes precedence over PIPELINES_REPO', async () => {
    writePipeline('ok', 'name: ok\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n');
    const decoy = mkdtempSync(join(tmpdir(), 'ap-decoy-'));
    writeFileSync(join(decoy, 'pipelines.yaml'), 'channels: {}\n');
    try {
      const proc = Bun.spawn(['bun', CLI, '--repo', root, 'validate', 'ok'], {
        cwd: decoy,
        env: { ...process.env, ANTHROPIC_API_KEY: 'sk-test', PIPELINES_REPO: decoy },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      // If PIPELINES_REPO (decoy, without the pipeline "ok") won, this would
      // fail naming the available pipelines of decoy (none).
      expect(await proc.exited).toBe(0);
      expect(stdout + stderr).toContain('ok');
    } finally {
      rmSync(decoy, { recursive: true, force: true });
    }
  });
});

describe('pipelines validate', () => {
  test('exits 0 on a correct pipeline', async () => {
    writePipeline('ok', 'name: ok\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n');
    const { code, out } = await cli(['validate', 'ok']);
    expect(code).toBe(0);
    expect(out).toContain('ok');
  });

  test('exits 1 and explains the problem on an invalid pipeline', async () => {
    writePipeline('bad', 'name: bad\nversion: 1\nsteps: []\n');
    const { code, out } = await cli(['validate', 'bad']);
    expect(code).toBe(1);
    expect(out).toContain('description');
  });

  test('exits 1 if requires.env uses an undeclared param', async () => {
    writePipeline(
      'tpl',
      'name: tpl\ndescription: d\nversion: 1\nrequires:\n  env: ["QA_{{params.app}}_TOKEN"]\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );
    const { code, out } = await cli(['validate', 'tpl']);
    expect(code).toBe(1);
    expect(out).toContain('requires.env.0: references "{{params.app}}", not declared in params');
  });

  test('exits 1 if a prompt references an undeclared param', async () => {
    mkdirSync(join(root, 'pipelines', 'with-prompt'), { recursive: true });
    writeFileSync(
      join(root, 'pipelines', 'with-prompt', 'pipeline.yaml'),
      'name: with-prompt\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    agent: w\n    prompt: a.md\n',
    );
    writeFileSync(join(root, 'pipelines', 'with-prompt', 'a.md'), 'About {{params.not_declared}}.');

    const { code, out } = await cli(['validate', 'with-prompt']);
    expect(code).toBe(1);
    expect(out).toContain('a');
    expect(out).toContain('not_declared');
  });

  test('exits 0 if the prompt only references declared params/outputs', async () => {
    mkdirSync(join(root, 'pipelines', 'with-prompt-ok'), { recursive: true });
    writeFileSync(
      join(root, 'pipelines', 'with-prompt-ok', 'pipeline.yaml'),
      'name: with-prompt-ok\ndescription: d\nversion: 1\nparams:\n  topic:\n    description: t\nsteps:\n  - id: a\n    agent: w\n    prompt: a.md\n',
    );
    writeFileSync(join(root, 'pipelines', 'with-prompt-ok', 'a.md'), 'Summary about {{params.topic}}.');

    const { code } = await cli(['validate', 'with-prompt-ok']);
    expect(code).toBe(0);
  });

  test('exits 1 with a clear message if the prompt file is missing', async () => {
    mkdirSync(join(root, 'pipelines', 'no-prompt'), { recursive: true });
    writeFileSync(
      join(root, 'pipelines', 'no-prompt', 'pipeline.yaml'),
      'name: no-prompt\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    agent: w\n    prompt: missing.md\n',
    );

    const { code, out } = await cli(['validate', 'no-prompt']);
    expect(code).toBe(1);
    expect(out).toContain('a');
    expect(out).toContain('missing.md');
  });

  test('exits 1 if an always step references a nonexistent step', async () => {
    writePipeline(
      'with-always-bad',
      'name: with-always-bad\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\nalways:\n  - id: cleanup\n    run: "git -C {{ghost-step.path}} reset --hard"\n',
    );

    const { code, out } = await cli(['validate', 'with-always-bad']);
    expect(code).toBe(1);
    expect(out).toContain('cleanup');
    expect(out).toContain('ghost-step');
  });

  test('exits 1 if an always step references an undeclared param', async () => {
    writePipeline(
      'with-always-bad-param',
      'name: with-always-bad-param\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\nalways:\n  - id: cleanup\n    run: "echo {{params.not_declared}}"\n',
    );

    const { code, out } = await cli(['validate', 'with-always-bad-param']);
    expect(code).toBe(1);
    expect(out).toContain('cleanup');
    expect(out).toContain('not_declared');
  });

  test('exits 1 if notify.channel does not exist in pipelines.yaml', async () => {
    writePipeline(
      'with-notify-ghost',
      'name: with-notify-ghost\ndescription: d\nversion: 1\nnotify:\n  on: [success]\n  channel: ghost\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );

    const { code, out } = await cli(['validate', 'with-notify-ghost']);
    expect(code).toBe(1);
    expect(out).toContain('ghost');
  });
});

describe('pipelines run', () => {
  test('runs and leaves the record in .runs/', async () => {
    // An earlier version used `run: 'echo {"n":1}'`: a single-quoted YAML
    // scalar whose content goes AS IS to `sh -c`. There, unprotected double
    // quotes are shell syntax (they eat themselves) and the real stdout is
    // `{n:1}`, invalid JSON — checked by reproducing the failure before this
    // fix. `tests/runner/shell.test.ts` already documents and avoids this same
    // problem by wrapping the JSON in additional single quotes so they survive
    // the shell; the same pattern is applied here.
    writePipeline(
      'demo',
      'name: demo\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "echo \'{\\"n\\":1}\'"\n    outputs: { n: number }\n',
    );
    const { code } = await cli(['run', 'demo']);
    expect(code).toBe(0);
    const { out } = await cli(['status', 'demo']);
    expect(out).toContain('success');
  });

  // `run --force` exists because verifying the engine live required waiting
  // for the guard to stop biting: with `throttle: 46h` on a daily cron, a
  // manual check got skipped and there was no way to say "I know, run it
  // anyway". Having the record marked is the other half: a forced run does NOT
  // prove that the guards would have let it through, and the history must not
  // be mistakable for one that passed on its own.
  test('--force runs despite a failing guard, and marks the run as forced', async () => {
    writePipeline(
      'demo-force',
      'name: demo-force\ndescription: d\nversion: 1\nwhen:\n  - shell: "false"\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );
    const { code } = await cli(['run', 'demo-force', '--force']);
    expect(code).toBe(0);
    const run = JSON.parse(
      await Bun.file(join(root, '.runs', 'demo-force', latestRunId('demo-force'), 'run.json')).text(),
    );
    expect(run.status).toBe('success');
    expect(run.forced).toBe(true);
  });

  test('a normal run does not carry the forced mark', async () => {
    writePipeline(
      'demo-normal',
      'name: demo-normal\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );
    expect((await cli(['run', 'demo-normal'])).code).toBe(0);
    const run = JSON.parse(
      await Bun.file(join(root, '.runs', 'demo-normal', latestRunId('demo-normal'), 'run.json')).text(),
    );
    expect(run.status).toBe('success');
    expect(run.forced).toBeUndefined();
  });

  test('status flags forced runs', async () => {
    writePipeline(
      'demo-mark',
      'name: demo-mark\ndescription: d\nversion: 1\nwhen:\n  - shell: "false"\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );
    await cli(['run', 'demo-mark', '--force']);
    const { out } = await cli(['status', 'demo-mark']);
    expect(out).toContain('(guards skipped)');
  });

  test('a skipped run exits with code 0 and is marked skipped', async () => {
    writePipeline(
      'skipped',
      'name: skipped\ndescription: d\nversion: 1\nwhen:\n  - shell: "false"\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );
    const { code, out } = await cli(['run', 'skipped']);
    expect(code).toBe(0);
    expect(out).toContain('skipped');
  });

  test('a step failure exits with code 1', async () => {
    writePipeline('fails', 'name: fails\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: exit 1\n');
    const { code } = await cli(['run', 'fails']);
    expect(code).toBe(1);
  });

  test('fails before running if a required param is missing', async () => {
    writePipeline(
      'withparam',
      'name: withparam\ndescription: d\nversion: 1\nparams:\n  path:\n    description: r\n    required: true\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );
    const { code, out } = await cli(['run', 'withparam']);
    expect(code).toBe(1);
    expect(out).toContain('path');
  });

  test('--set provides the missing param', async () => {
    writePipeline(
      'withparam',
      'name: withparam\ndescription: d\nversion: 1\nparams:\n  path:\n    description: r\n    required: true\nsteps:\n  - id: a\n    type: shell\n    run: echo {{params.path}}\n',
    );
    const { code } = await cli(['run', 'withparam', '--set', 'path=/tmp']);
    expect(code).toBe(0);
  });
});

describe('pipelines doctor', () => {
  test('reports a missing dependency and exits 1', async () => {
    writePipeline(
      'needs',
      'name: needs\ndescription: d\nversion: 1\nrequires:\n  bin: [nonexistent-binary-xyz]\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );
    const { code, out } = await cli(['doctor', 'needs']);
    expect(code).toBe(1);
    expect(out).toContain('nonexistent-binary-xyz');
  });
});

describe('pipelines show', () => {
  test('prints the whole run as JSON', async () => {
    writePipeline(
      'demo',
      'name: demo\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "echo \'{\\"n\\":1}\'"\n    outputs: { n: number }\n',
    );
    const { code: runCode } = await cli(['run', 'demo']);
    expect(runCode).toBe(0);
    const runId = latestRunId('demo');

    const { code, out } = await cli(['show', 'demo', runId]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.id).toBe(runId);
    expect(parsed.status).toBe('success');
    expect(parsed.steps.a.outputs).toEqual({ n: 1 });
  });

  test('with a third argument it prints only that step', async () => {
    writePipeline(
      'demo',
      'name: demo\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "echo \'{\\"n\\":1}\'"\n    outputs: { n: number }\n',
    );
    await cli(['run', 'demo']);
    const runId = latestRunId('demo');

    const { code, out } = await cli(['show', 'demo', runId, 'a']);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed).toEqual(
      expect.objectContaining({ id: 'a', status: 'success', outputs: { n: 1 } }),
    );
  });

  test('a nonexistent step prints an empty object, it does not fail', async () => {
    writePipeline('demo', 'name: demo\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n');
    await cli(['run', 'demo']);
    const runId = latestRunId('demo');

    const { code, out } = await cli(['show', 'demo', runId, 'nonexistent']);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({});
  });

  test('a nonexistent run-id exits with 1 and a message', async () => {
    writePipeline('demo', 'name: demo\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n');
    const { code, out } = await cli(['show', 'demo', '2020-01-01T00-00-00-000Z']);
    expect(code).toBe(1);
    expect(out).toContain('2020-01-01T00-00-00-000Z');
  });
});

describe('notify: it really runs', () => {
  test('a success run with notify.on: [success] invokes the channel', async () => {
    writeFileSync(
      join(root, 'pipelines.yaml'),
      `channels:\n  marker:\n    type: shell\n    run: "echo $PIPELINES_NOTIFY_STATUS > notify-marker.txt"\n`,
    );
    writePipeline(
      'demo',
      'name: demo\ndescription: d\nversion: 1\nnotify:\n  on: [success]\n  channel: marker\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );
    const { code } = await cli(['run', 'demo']);
    expect(code).toBe(0);
    expect(await Bun.file(join(root, 'notify-marker.txt')).text()).toBe('success\n');
  });

  test('run.json keeps the trace of the channel: code and output', async () => {
    writeFileSync(
      join(root, 'pipelines.yaml'),
      `channels:\n  marker:\n    type: shell\n    run: "echo sent-$PIPELINES_NOTIFY_STATUS; echo detail >&2"\n`,
    );
    writePipeline(
      'demo',
      'name: demo\ndescription: d\nversion: 1\nnotify:\n  on: [success]\n  channel: marker\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );
    const { code } = await cli(['run', 'demo']);
    expect(code).toBe(0);
    const runsDir = join(root, '.runs', 'demo');
    const [runId] = readdirSync(runsDir).filter((d) => !d.startsWith('.'));
    const record = JSON.parse(readFileSync(join(runsDir, runId!, 'run.json'), 'utf8'));
    expect(record.notify).toMatchObject({ channel: 'marker', code: 0 });
    expect(record.notify.log).toContain('sent-success');
    expect(record.notify.log).toContain('detail');
  });

  test('a failing channel also leaves its trace in run.json', async () => {
    writeFileSync(
      join(root, 'pipelines.yaml'),
      `channels:\n  broken:\n    type: shell\n    run: "echo channel-reason >&2; exit 3"\n`,
    );
    writePipeline(
      'demo',
      'name: demo\ndescription: d\nversion: 1\nnotify:\n  on: [success]\n  channel: broken\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );
    const { code } = await cli(['run', 'demo']);
    expect(code).toBe(0);
    const runsDir = join(root, '.runs', 'demo');
    const [runId] = readdirSync(runsDir).filter((d) => !d.startsWith('.'));
    const record = JSON.parse(readFileSync(join(runsDir, runId!, 'run.json'), 'utf8'));
    expect(record.notify).toMatchObject({ channel: 'broken', code: 3 });
    expect(record.notify.log).toContain('channel-reason');
  });

  test('a failed run with notify.on: [success] does not invoke the channel', async () => {
    writeFileSync(
      join(root, 'pipelines.yaml'),
      `channels:\n  marker:\n    type: shell\n    run: "echo touched > notify-marker.txt"\n`,
    );
    writePipeline(
      'demo',
      'name: demo\ndescription: d\nversion: 1\nnotify:\n  on: [success]\n  channel: marker\nsteps:\n  - id: a\n    type: shell\n    run: exit 1\n',
    );
    const { code } = await cli(['run', 'demo']);
    expect(code).toBe(1);
    expect(await Bun.file(join(root, 'notify-marker.txt')).exists()).toBe(false);
  });

  test('a failure of the channel itself does not change the exit code of the run', async () => {
    writeFileSync(
      join(root, 'pipelines.yaml'),
      `channels:\n  broken:\n    type: shell\n    run: "exit 1"\n`,
    );
    writePipeline(
      'demo',
      'name: demo\ndescription: d\nversion: 1\nnotify:\n  on: [success]\n  channel: broken\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );
    const { code, out } = await cli(['run', 'demo']);
    expect(code).toBe(0);
    expect(out).toContain('notify failed');
  });
});

describe('validate — references in steps[].cwd/additional_dirs/when', () => {
  test('a {{secrets.X}} in additional_dirs makes validate fail', async () => {
    writeFileSync(join(root, '.env'), 'API_KEY=a-really-long-key\n');
    writePipeline(
      'demo',
      'name: demo\ndescription: d\nversion: 1\nrequires:\n  env: [API_KEY]\nsteps:\n  - id: a\n    agent: writer\n    prompt: p.md\n    additional_dirs: ["{{secrets.API_KEY}}"]\n',
    );
    writeFileSync(join(root, 'pipelines', 'demo', 'p.md'), 'prompt');
    const { code, out } = await cli(['validate', 'demo']);
    expect(code).toBe(1);
    expect(out).toContain('additional_dirs');
  });
});

// An `mcp-schema` check (schema drift of an MCP server) is purely
// informational for `doctor` — it should never have blocked `run`. Before
// this fix, `run` and `doctor` literally shared `preflight()` and the same
// gating criterion (`!report.ok`).
//
// The real "MCP server" of these two tests is a script of our own that speaks
// the minimal JSON-RPC that `listMcpToolsViaStdio` needs, without depending
// on real `npx`/`@playwright/mcp` or on the network — deterministic and fast.
// Its `tools/list` returns `browser_take_screenshot` WITHOUT the `filename`
// field (the only one `TOOL_FS_PROFILES` watches for that tool), so the
// `mcp-schema` check always fails, predictably.
describe('run vs. doctor — an mcp-schema failure does not block run, but does block doctor', () => {
  function writeFakeMcpServer(): string {
    const path = join(root, 'fake-mcp-server.js');
    writeFileSync(
      path,
      `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [{
            name: 'browser_take_screenshot',
            // No 'filename' on purpose: the only field TOOL_FS_PROFILES watches
            // for this tool — it always triggers mcp-schema: ok:false.
            inputSchema: { properties: { element: {}, target: {}, type: {}, fullPage: {}, scale: {} } },
          }],
        },
      }) + '\\n');
    }
  }
});
`,
    );
    return path;
  }

  function writeDriftPipeline(scriptPath: string) {
    writePipeline(
      'demo',
      `name: demo\ndescription: d\nversion: 1\n` +
        // Always-false guard: if \`run\` gets to evaluate it (instead of
        // cutting short in preflight), the observable is a 'skipped' run,
        // not a real execution of the agent step — so this test depends on
        // neither the real SDK nor the network to show that preflight did not
        // block.
        `when:\n  - shell: "false"\n` +
        `mcp_servers:\n  pw:\n    command: bun\n    args: ["${scriptPath}"]\n    kind: playwright\n` +
        `steps:\n  - id: a\n    agent: writer\n    prompt: p.md\n    mcp_servers: [pw]\n    tools: [mcp__pw__browser_take_screenshot]\n`,
    );
  }

  test('run: an mcp-schema failure on its own does not block — the run does get evaluated (skipped by the guard, not by preflight)', async () => {
    const scriptPath = writeFakeMcpServer();
    writeDriftPipeline(scriptPath);
    const { code, out } = await cli(['run', 'demo']);
    // Before the fix: "Missing dependencies — nothing will run.", code 1,
    // NO run created — preflight cut short before reaching the guard.
    expect(code).toBe(0);
    expect(out).toContain('skipped');
    expect(out).not.toContain('Missing dependencies');
    // The non-blocking warning is still visible to whoever operates the pipeline.
    expect(out).toContain('warning');
    expect(out).toContain('mcp-schema');
  });

  test('doctor: the same mcp-schema failure DOES block — unchanged behavior', async () => {
    const scriptPath = writeFakeMcpServer();
    writeDriftPipeline(scriptPath);
    const { code, out } = await cli(['doctor', 'demo']);
    expect(code).toBe(1);
    expect(out).toContain('mcp-schema');
    expect(out).toContain('pw');
    expect(out).toContain('it will not run');
  });
});

// Ten nights in a row of `skipped` without anyone finding out: `dispatchNotify`
// was only invoked on the normal-end path, so guard-skip and lock-blocked
// closed the run and left silently. Now every path notifies, and it is the
// pipeline that decides with `on:`/`stale_after` whether that makes noise or
// not.
describe('notify: on the paths that skip the run', () => {
  test('a run skipped by a guard invokes the channel if the pipeline is stale', async () => {
    writeFileSync(
      join(root, 'pipelines.yaml'),
      `channels:\n  marker:\n    type: shell\n    run: "echo $PIPELINES_NOTIFY_STATUS/$PIPELINES_NOTIFY_STALE > notify-marker.txt"\n`,
    );
    writePipeline(
      'demo',
      'name: demo\ndescription: d\nversion: 1\nnotify:\n  on: [success, failed]\n  stale_after: 72h\n  channel: marker\nwhen:\n  - shell: "false"\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );

    const { code } = await cli(['run', 'demo']);
    expect(code).toBe(0);
    expect(await Bun.file(join(root, 'notify-marker.txt')).text()).toBe('skipped/1\n');
  });

  test('a run skipped by a guard does NOT invoke the channel if the pipeline does not declare stale_after', async () => {
    writeFileSync(
      join(root, 'pipelines.yaml'),
      `channels:\n  marker:\n    type: shell\n    run: "echo touched > notify-marker.txt"\n`,
    );
    writePipeline(
      'demo',
      'name: demo\ndescription: d\nversion: 1\nnotify:\n  on: [success, failed]\n  channel: marker\nwhen:\n  - shell: "false"\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );

    await cli(['run', 'demo']);
    expect(await Bun.file(join(root, 'notify-marker.txt')).exists()).toBe(false);
  });

  test('a successful run turns off the stale warning even if the pipeline declares it', async () => {
    writeFileSync(
      join(root, 'pipelines.yaml'),
      `channels:\n  marker:\n    type: shell\n    run: "echo $PIPELINES_NOTIFY_STATUS/$PIPELINES_NOTIFY_STALE > notify-marker.txt"\n`,
    );
    writePipeline(
      'demo',
      'name: demo\ndescription: d\nversion: 1\nnotify:\n  on: [success]\n  stale_after: 72h\n  channel: marker\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );

    await cli(['run', 'demo']);
    expect(await Bun.file(join(root, 'notify-marker.txt')).text()).toBe('success/\n');
  });
});

describe('doctor — platform checks do not block', () => {
  test('with linger red (systemd forced), doctor exits with code 0 and shows it', async () => {
    writePipeline('ok', 'name: ok\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n');
    const bin = (name: string, body: string) => {
      const p = join(root, name);
      writeFileSync(p, `#!/bin/sh\n${body}\n`);
      chmodSync(p, 0o755);
      return p;
    };
    const proc = Bun.spawn(['bun', CLI, 'doctor', 'ok'], {
      cwd: root,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: 'sk-test',
        PIPELINES_SCHEDULER: 'systemd',
        PIPELINES_SYSTEMCTL_BIN: bin('sc', 'echo running'),
        PIPELINES_LOGINCTL_BIN: bin('lc', 'echo no'),
        PIPELINES_TIMEDATECTL_BIN: bin('td', 'echo Europe/Madrid'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(await proc.exited).toBe(0);
    const out = stdout + stderr;
    expect(out).toContain('linger');
    expect(out).toContain('sudo loginctl enable-linger');
    // With a red platform check, "All set" would be a lie.
    expect(out).not.toContain('All set');
    expect(out).toContain('Ready to run; to install, still missing: linger.');
  });

  test('with no scheduler for the platform, doctor does not throw and skips the platform checks', async () => {
    writePipeline('ok', 'name: ok\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n');
    const proc = Bun.spawn(['bun', CLI, 'doctor', 'ok'], {
      cwd: root,
      // An unknown value makes `schedulerFor()` throw, just as on FreeBSD.
      env: { ...process.env, ANTHROPIC_API_KEY: 'sk-test', PIPELINES_SCHEDULER: 'freebsd' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(await proc.exited).toBe(0);
    const out = stdout + stderr;
    expect(out).toContain('All set.');
    expect(out).not.toContain('platform');
  });
});

describe('requires.env with templates, end to end', () => {
  const TPL =
    'name: tpl\ndescription: d\nversion: 1\n' +
    'params:\n  app:\n    description: a\n    required: true\n' +
    'requires:\n  env: ["QA_{{params.app}}_TOKEN"]\n' +
    'steps:\n  - id: use\n    type: shell\n    run: |\n      set -euo pipefail\n      test -n "$QA_demo_TOKEN"\n      echo "value=$QA_demo_TOKEN" >&2\n';

  test('run resolves the name, passes the secret to the step and redacts it in the log', async () => {
    writePipeline('tpl', TPL);
    writeFileSync(join(root, '.env'), 'QA_demo_TOKEN=a-very-long-secret\n');
    const { code } = await cli(['run', 'tpl', '--set', 'app=demo']);
    expect(code).toBe(0);
    const log = readFileSync(join(root, '.runs', 'tpl', latestRunId('tpl'), 'use.log'), 'utf8');
    expect(log).not.toContain('a-very-long-secret');
    expect(log).toContain('[redacted]');
  });

  test('doctor without --set points out the missing param and exits 1', async () => {
    writePipeline('tpl', TPL);
    const { code, out } = await cli(['doctor', 'tpl']);
    expect(code).toBe(1);
    expect(out).toContain('depends on params with no value: app (pass them with --set)');
  });

  test('doctor with --set checks the resolved name', async () => {
    writePipeline('tpl', TPL);
    writeFileSync(join(root, '.env'), 'QA_demo_TOKEN=a-very-long-secret\n');
    const { code, out } = await cli(['doctor', 'tpl', '--set', 'app=demo']);
    expect(out).toContain('QA_demo_TOKEN');
    expect(code).toBe(0);
  });

  test('resume resolves the names with the params of the original run', async () => {
    const TPL_FAILS =
      'name: tpl\ndescription: d\nversion: 1\n' +
      'params:\n  app:\n    description: a\n    required: true\n' +
      'requires:\n  env: ["QA_{{params.app}}_TOKEN"]\n' +
      'steps:\n  - id: use\n    type: shell\n    run: |\n      set -euo pipefail\n      test -n "$QA_demo_TOKEN"\n      exit 1\n';
    writePipeline('tpl', TPL_FAILS);
    writeFileSync(join(root, '.env'), 'QA_demo_TOKEN=a-very-long-secret\n');
    const first = await cli(['run', 'tpl', '--set', 'app=demo']);
    expect(first.code).toBe(1);
    writePipeline('tpl', TPL);
    // Local params different from the original run's: if resume resolved
    // with these (QA_other_TOKEN, missing from the .env), the step would fail.
    writeFileSync(join(root, '.params.local.json'), JSON.stringify({ tpl: { app: 'other' } }));
    const { code } = await cli(['resume', 'tpl', latestRunId('tpl')]);
    expect(code).toBe(0);
  });
});

describe('status --json', () => {
  const OK_YAML = 'name: ok\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n';

  test('prints the overview as JSON on stdout, exit 0', async () => {
    writePipeline('ok', OK_YAML);
    const { code, stdout } = await cli(['status', '--json']);
    expect(code).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.repo).toBe(realpathSync(root));
    expect(json.pipelines.map((p: { name: string }) => p.name)).toEqual(['ok']);
    expect(json.costs.month.runs).toBe(0);
  });

  test('a folder with no pipeline.yaml is an entry with an error, still exit 0', async () => {
    writePipeline('ok', OK_YAML);
    mkdirSync(join(root, 'pipelines', 'half'), { recursive: true });
    const { code, stdout } = await cli(['status', '--json']);
    expect(code).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.pipelines).toContainEqual({ name: 'half', error: 'the folder has no pipeline.yaml' });
    expect(json.pipelines.find((p: { name: string }) => p.name === 'ok')).toHaveProperty('verdict');
  });

  test('with a name, only that pipeline', async () => {
    writePipeline('ok', OK_YAML);
    writePipeline('other', OK_YAML.replace('name: ok', 'name: other'));
    const { code, stdout } = await cli(['status', 'ok', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).pipelines.length).toBe(1);
  });

  test('an unknown name fails with exit 1 (the text output prints it with no runs)', async () => {
    writePipeline('ok', OK_YAML);
    const { code, out } = await cli(['status', 'nope', '--json']);
    expect(code).toBe(1);
    expect(out).toContain('does not exist');
  });

  test('without --json the text output is unchanged', async () => {
    writePipeline('ok', OK_YAML);
    const { code, stdout } = await cli(['status']);
    expect(code).toBe(0);
    expect(stdout).toBe('\nok\n  (no runs)\n');
  });

  test('the verdict is the one the dashboard draws', async () => {
    writePipeline('ok', OK_YAML);
    const { stdout } = await cli(['status', '--json']);
    const line: string = JSON.parse(stdout).pipelines[0].verdict.line;
    const server = createServer(await loadRepoContext(root), { port: 0 });
    try {
      const html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text();
      expect(html).toContain(escapeHtml(line));
    } finally {
      server.stop(true);
    }
  });
});
