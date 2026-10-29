import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePipeline } from '../../src/schema/pipeline.ts';
import { RunStore } from '../../src/runs/store.ts';
import { interpolate, type InterpolationScope } from '../../src/params/resolve.ts';
import { runAgentStep } from '../../src/runner/agent.ts';
import { runPipeline, type RunOptions } from '../../src/runner/orchestrate.ts';

let root: string;
let store: RunStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ap-orch-'));
  store = new RunStore(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (yaml: string, extra: Record<string, unknown> = {}) =>
  runPipeline({
    pipeline: parsePipeline(yaml),
    repoRoot: root,
    store,
    params: {},
    secrets: {},
    ...extra,
  });

describe('runPipeline — happy path', () => {
  test('runs the steps in order and ends in success', async () => {
    const record = await run(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: echo '{"n":1}'
    outputs: { n: number }
  - id: b
    type: shell
    run: 'echo received-{{a.n}}'
`);
    expect(record.status).toBe('success');
    expect(record.steps.a!.outputs).toEqual({ n: 1 });
    expect(record.steps.b!.status).toBe('success');
  });
});

describe('runPipeline — error policies', () => {
  test('on_error stop halts the run and marks it failed', async () => {
    const record = await run(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: exit 1
  - id: b
    type: shell
    run: 'true'
`);
    expect(record.status).toBe('failed');
    expect(record.steps.a!.status).toBe('failed');
    expect(record.steps.b).toBeUndefined();
  });

  test('on_error continue goes on to the next step', async () => {
    const record = await run(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: exit 1
    on_error: continue
  - id: b
    type: shell
    run: 'true'
`);
    expect(record.steps.a!.status).toBe('failed');
    expect(record.steps.b!.status).toBe('success');
    // The only failure in this run declared on_error: continue — explicitly
    // tolerated by the pipeline itself, so the run's aggregate is success.
    // The step itself is still recorded as failed (line above): the detail is
    // not lost, only the aggregate changes.
    expect(record.status).toBe('success');
  });

  test('a failure with on_error stop mixed with a continue one still marks the run failed', async () => {
    const record = await run(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: exit 1
    on_error: continue
  - id: b
    type: shell
    run: exit 1
`);
    expect(record.steps.a!.status).toBe('failed');
    expect(record.steps.b!.status).toBe('failed');
    expect(record.status).toBe('failed');
  });

  test('several failures, all on_error continue, leave the run in success', async () => {
    const record = await run(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: exit 1
    on_error: continue
  - id: b
    type: shell
    run: exit 1
    on_error: continue
  - id: c
    type: shell
    run: 'true'
`);
    expect(record.steps.a!.status).toBe('failed');
    expect(record.steps.b!.status).toBe('failed');
    expect(record.steps.c!.status).toBe('success');
    expect(record.status).toBe('success');
  });

  test('retry does not retry a NON-transient failure', async () => {
    const record = await run(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: exit 1
    retry: 3
`);
    expect(record.steps.a!.attempts).toBe(1);
  });

  test('retry with on: any retries until attempts run out', async () => {
    const waits: number[] = [];
    const record = await run(
      `
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: exit 1
    retry: { attempts: 2, on: any }
`,
      { sleepFn: async (ms: number) => { waits.push(ms); } },
    );
    expect(record.steps.a!.attempts).toBe(3);
    expect(record.steps.a!.status).toBe('failed');
    // Exponential backoff: 1s and 2s, without really waiting in the test.
    expect(waits).toEqual([1000, 2000]);
  });
});

describe('runPipeline — interpolation errors do not abort the run', () => {
  // `interpolate()` (params/resolve.ts) throws if a `{{...}}` reference
  // cannot be resolved, and neither runShellStep nor runAgentStep catch it:
  // it is the orchestrator's responsibility to turn that exception into a
  // step failure, not to let it abort the whole runPipeline with an uncaught
  // rejection.
  test('an unresolved reference fails only the step, runPipeline does not reject', async () => {
    const record = await run(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: echo {{params.undeclared}}
`);
    expect(record.status).toBe('failed');
    expect(record.steps.a!.status).toBe('failed');
    expect(record.steps.a!.error).toContain('undeclared');
  });
});

describe('runPipeline — skip cascade', () => {
  test('a false when skips the step and its dependents', async () => {
    const record = await run(`
name: demo
description: d
version: 1
steps:
  - id: scan
    type: shell
    run: echo '{"count":0}'
    outputs: { count: number }
  - id: draft
    type: shell
    run: echo '{"url":"x"}'
    when: "{{scan.count}} > 0"
    outputs: { url: string }
  - id: notify
    type: shell
    run: echo {{draft.url}}
`);
    expect(record.steps.scan!.status).toBe('success');
    expect(record.steps.draft!.status).toBe('skipped');
    expect(record.steps.notify!.status).toBe('skipped');
    expect(record.steps.notify!.skipReason).toContain('draft');
    expect(record.status).toBe('success');
  });

  test('an independent step is not affected by the skip of another step', async () => {
    const record = await run(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: echo '{"n":0}'
    outputs: { n: number }
  - id: b
    type: shell
    run: 'true'
    when: "{{a.n}} > 0"
  - id: c
    type: shell
    run: 'true'
`);
    expect(record.steps.b!.status).toBe('skipped');
    expect(record.steps.c!.status).toBe('success');
  });

  test('a failure with on_error continue also skips the dependents', async () => {
    const record = await run(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: exit 1
    on_error: continue
    outputs: { n: number }
  - id: b
    type: shell
    run: echo {{a.n}}
  - id: c
    type: shell
    run: 'true'
`);
    expect(record.steps.b!.status).toBe('skipped');
    expect(record.steps.c!.status).toBe('success');
  });

  test('the cascade is transitive: the dependent of a dependent is skipped too', async () => {
    // a fails -> b is skipped by cascade (depends on a) -> c is skipped by
    // cascade (depends on b, not on a directly). c never appears in
    // graph.dependents.get('a'), only in graph.dependents.get('b'): if the
    // skip did not really propagate level by level, c would run.
    const record = await run(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: exit 1
    on_error: continue
    outputs: { n: number }
  - id: b
    type: shell
    run: echo '{"n":1}'
    inputs: ["a.n"]
    outputs: { n: number }
  - id: c
    type: shell
    run: 'true'
    inputs: ["b.n"]
`);
    expect(record.steps.a!.status).toBe('failed');
    expect(record.steps.b!.status).toBe('skipped');
    expect(record.steps.b!.skipReason).toContain('a');
    expect(record.steps.c!.status).toBe('skipped');
    expect(record.steps.c!.skipReason).toContain('b');
  });
});

describe('runPipeline — resume', () => {
  test('resume does not re-run steps that already completed', async () => {
    // Step `a` leaves a mark each time it runs. After resuming, the counter
    // must still have a single mark.
    const counter = join(root, 'counter.txt');
    const yaml = (bCommand: string) => `
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: printf x >> ${counter}; echo '{"n":1}'
    outputs: { n: number }
  - id: b
    type: shell
    run: ${bCommand}
`;

    const first = await run(yaml('exit 1'));
    expect(first.status).toBe('failed');
    expect(await Bun.file(counter).text()).toBe('x');

    // Note: `bCommand` is inserted as an unquoted YAML scalar. A bare
    // `true`/`false` there would be parsed by YAML as a boolean (same kind of
    // defect noted for `retry: { ..., on: any }`) and `run: z.string()` would
    // reject it before it ever ran. `exit 0` does not collide with any YAML
    // keyword.
    const resumed = await runPipeline({
      pipeline: parsePipeline(yaml('exit 0')),
      repoRoot: root, store, params: {}, secrets: {}, resumeFrom: first,
    });

    expect(resumed.status).toBe('success');
    expect(resumed.steps.a!.outputs).toEqual({ n: 1 });
    expect(await Bun.file(counter).text()).toBe('x');
  });

  test('resume rejects a run from another pipeline version', async () => {
    const first = await run(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: exit 1
`);
    await expect(
      runPipeline({
        pipeline: parsePipeline(`
name: demo
description: d
version: 2
steps:
  - id: a
    type: shell
    run: 'true'
`),
        repoRoot: root, store, params: {}, secrets: {}, resumeFrom: first,
      }),
    ).rejects.toThrow(/version/);
  });

  test('resume can unblock steps that were previously skipped by cascade', async () => {
    const yaml = (aCommand: string) => `
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: ${aCommand}
    on_error: continue
    outputs: { n: number }
  - id: b
    type: shell
    run: echo '{"n":1}'
    inputs: ["a.n"]
    outputs: { n: number }
  - id: c
    type: shell
    run: 'true'
    inputs: ["b.n"]
`;

    const first = await run(yaml('exit 1'));
    // The run's only failure: on_error: continue on "a" — tolerated, the
    // aggregate is success even though b/c were skipped by cascade.
    expect(first.status).toBe('success');
    expect(first.steps.a!.status).toBe('failed');
    expect(first.steps.b!.status).toBe('skipped');
    expect(first.steps.c!.status).toBe('skipped');

    // `aCommand` is inserted as an unquoted YAML scalar: it is written
    // directly with real single quotes around the JSON (instead of unwrapped
    // double quotes) so `sh` does not eat them — same defect shell.test.ts
    // already documents for `runShellStep`.
    const resumed = await runPipeline({
      pipeline: parsePipeline(yaml(`echo '{"n":1}'`)),
      repoRoot: root, store, params: {}, secrets: {}, resumeFrom: first,
    });

    expect(resumed.status).toBe('success');
    expect(resumed.steps.a!.status).toBe('success');
    expect(resumed.steps.b!.status).toBe('success');
    expect(resumed.steps.c!.status).toBe('success');
    // The original run must not be mutated by the resume. (And, under the new
    // criterion, it was never 'failed' — its only failure was tolerated.)
    expect(first.status).toBe('success');
    expect(first.steps.b!.status).toBe('skipped');
  });

  test('the .env credential (agentAuth) reaches the runner of the agent steps', async () => {
    const pipelineDir = join(root, 'pipelines', 'demo');
    mkdirSync(pipelineDir, { recursive: true });
    writeFileSync(join(pipelineDir, 'a.md'), 'Hello.');
    const pipeline = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: agent
    agent: worker
    prompt: a.md
`);
    let received: Record<string, string> | undefined;
    const agentRunner: NonNullable<RunOptions['agentRunner']> = async (_step, ctx) => {
      received = ctx.agentAuth;
      return { ok: true, outputs: {}, log: '', durationMs: 1 };
    };
    const record = await runPipeline({
      pipeline, repoRoot: root, store, params: {}, secrets: {},
      agentAuth: { ANTHROPIC_API_KEY: 'ap-test-from-env' }, agentRunner,
    });
    expect(record.status).toBe('success');
    expect(received).toEqual({ ANTHROPIC_API_KEY: 'ap-test-from-env' });
  });

  test('resume accumulates the cost of a previous step and a new one, through the agent branch (real prompt + injected agentRunner)', async () => {
    // The only test in this block that exercises the `agent` branch of
    // `executeOnce`: it reads a real prompt file from disk (that read is not
    // stubbed) and goes through an injected `agentRunner` — no network, no
    // real SDK.
    const pipelineDir = join(root, 'pipelines', 'demo');
    mkdirSync(pipelineDir, { recursive: true });
    writeFileSync(join(pipelineDir, 'a.md'), 'Introduce yourself.');
    writeFileSync(join(pipelineDir, 'b.md'), 'Summary about {{params.topic}}.');

    const pipeline = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: agent
    agent: worker
    prompt: a.md
  - id: b
    type: agent
    agent: worker
    prompt: b.md
`);

    let bShouldFail = true;
    let capturedPromptText: string | undefined;
    let capturedScope: InterpolationScope | undefined;

    const agentRunner: NonNullable<RunOptions['agentRunner']> = async (step, ctx) => {
      if (step.id === 'a') {
        // Step prior to the resume: always succeeds, with a fixed cost.
        return { ok: true, outputs: {}, log: '', durationMs: 1, costUsd: 0.5 };
      }
      // Step 'b': capture what the runner really received, to prove that
      // orchestrate.ts read the real file from disk and built the right
      // scope — not just that it "goes through the agent branch".
      capturedPromptText = ctx.promptText;
      capturedScope = ctx.scope;
      if (bShouldFail) {
        return { ok: false, error: 'simulated failure', transient: false, log: '', durationMs: 1 };
      }
      // New step, run only on resume: different cost.
      return { ok: true, outputs: {}, log: '', durationMs: 1, costUsd: 0.25 };
    };

    const first = await runPipeline({
      pipeline, repoRoot: root, store, params: { topic: 'testing' }, secrets: {}, agentRunner,
    });
    expect(first.status).toBe('failed');
    expect(first.steps.a!.status).toBe('success');
    expect(first.steps.a!.costUsd).toBe(0.5);
    expect(first.steps.b!.status).toBe('failed');

    bShouldFail = false;
    const resumed = await runPipeline({
      pipeline, repoRoot: root, store, params: { topic: 'testing' }, secrets: {},
      resumeFrom: first, agentRunner,
    });

    expect(resumed.status).toBe('success');
    expect(resumed.steps.b!.status).toBe('success');
    // 'a' is not re-run: its cost is the one inherited from the previous run.
    expect(resumed.steps.a!.costUsd).toBe(0.5);
    // 'b' is re-run in this pass: new cost.
    expect(resumed.steps.b!.costUsd).toBe(0.25);
    // The cost of a previous step (never re-run) and that of a new one are
    // added into the total: the history is not reset and the new one is not
    // lost.
    expect(resumed.totalCostUsd).toBe(0.75);

    // The prompt text is exactly the content read from disk (uninterpolated:
    // that is the runner's responsibility, not orchestrate.ts's), and the
    // scope the runner received allows rebuilding it interpolated with the
    // same function runAgentStep uses — proof that the file read and the scope
    // really made it to the agent branch.
    expect(capturedPromptText).toBe('Summary about {{params.topic}}.');
    expect(interpolate(capturedPromptText!, capturedScope!)).toBe('Summary about testing.');
  });
});

// Regression: `runAgentStep` computed `AgentOutcome.denials` correctly but
// `runPipeline` never copied it into the persisted `StepRecord` — this
// module's `const record: StepRecord = { ... }` did not reference it, and
// `StepRecord` did not even declare the field. The result: a real PreToolUse
// hook denial vanished without a trace between the return value of
// `runAgentStep` and `.runs/`, invisible via `pipelines show` — exactly what
// has to be visible. This test exercises the whole path (injected
// agentRunner -> runPipeline -> store.writeStep -> disk) instead of just
// building a StepRecord by hand, so that a future regression of this same
// kind (an AgentOutcome field that stops reaching the persisted record) is
// caught by this suite, not by a real run against a production pipeline.
describe('runPipeline — persistence of denials of an agent step', () => {
  test('a PreToolUse hook denial survives all the way to the StepRecord read from disk', async () => {
    const pipelineDir = join(root, 'pipelines', 'demo');
    mkdirSync(pipelineDir, { recursive: true });
    writeFileSync(join(pipelineDir, 'a.md'), 'Scan the repo.');

    const pipeline = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: agent
    agent: worker
    prompt: a.md
`);

    const agentRunner: NonNullable<RunOptions['agentRunner']> = async () => ({
      ok: true,
      outputs: {},
      log: '',
      durationMs: 1,
      denials: [
        { toolName: 'Read', toolUseId: 't1', reason: 'outside cwd', source: 'both' },
      ],
    });

    const record = await runPipeline({
      pipeline, repoRoot: root, store, params: {}, secrets: {}, agentRunner,
    });

    // 1. The RunRecord that runPipeline returns already carries it
    //    (store.writeStep mutates run.steps in place before persisting).
    expect(record.steps.a!.denials).toEqual([
      { toolName: 'Read', toolUseId: 't1', reason: 'outside cwd', source: 'both' },
    ]);

    // 2. And, more importantly — what was really written to `.runs/` and is
    //    what `pipelines show` ends up reading: a StepRecord freshly read from
    //    disk (not the in-memory object) keeps it too.
    const reread = await store.readRun(pipeline.name, record.id);
    expect(reread?.steps.a!.denials).toEqual([
      { toolName: 'Read', toolUseId: 't1', reason: 'outside cwd', source: 'both' },
    ]);
  });

  test('a shell step (no hook) carries no denials in its StepRecord', async () => {
    const record = await run(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: echo ok
`);
    expect(record.steps.a!.denials).toBeUndefined();
  });
});

describe('runPipeline — secret isolation', () => {
  test('secrets reach the step but not the run log', async () => {
    const record = await run(
      `
name: demo
description: d
version: 1
requires:
  env: [MY_TOKEN]
steps:
  - id: a
    type: shell
    run: echo "token=$MY_TOKEN"
`,
      { secrets: { MY_TOKEN: 'super-secret-value' } },
    );
    expect(record.steps.a!.status).toBe('success');
    const log = await Bun.file(join(root, '.runs', 'demo', record.id, 'a.log')).text();
    expect(log).not.toContain('super-secret-value');
    expect(log).toContain('[redacted]');
  });
});

describe('runPipeline — secrets in the prompt of agent steps', () => {
  // `{{secrets.X}}` in a prompt only resolves for LITERAL names in
  // requires.env (same criterion as `validate`); names resolved from
  // {{params.*}} templates remain in `secrets` for redaction/MCP/subprocess.
  const yaml = `
name: demo
description: d
version: 1
params:
  app: { type: string, description: app, default: myapp }
requires:
  env: [LITERAL_TOKEN, 'QA_{{params.app}}_USER']
steps:
  - id: a
    type: agent
    agent: worker
    prompt: a.md
`;
  const secrets = { LITERAL_TOKEN: 'literal-value', QA_myapp_USER: 'qa-value' };

  const runWithPrompt = async (promptText: string) => {
    const pipelineDir = join(root, 'pipelines', 'demo');
    mkdirSync(pipelineDir, { recursive: true });
    writeFileSync(join(pipelineDir, 'a.md'), promptText);
    let received = '';
    const agentRunner: NonNullable<RunOptions['agentRunner']> = (step, ctx) =>
      runAgentStep(step, {
        ...ctx,
        queryFn: ({ prompt }) => {
          received = prompt;
          return (async function* () {
            yield {
              type: 'result', subtype: 'success', duration_ms: 1, duration_api_ms: 1,
              is_error: false, num_turns: 1, result: 'ok', stop_reason: 'end_turn',
              total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [],
              uuid: '00000000-0000-0000-0000-000000000000', session_id: 's',
            } as never;
          })();
        },
      });
    const record = await run(yaml, { params: { app: 'myapp' }, secrets, agentRunner }).then(
      (r) => ({ r, err: undefined as unknown }),
      (err: unknown) => ({ r: undefined, err }),
    );
    return { received, ...record };
  };

  test('a literal requires.env secret still resolves in the prompt', async () => {
    const { received, r } = await runWithPrompt('Token: {{secrets.LITERAL_TOKEN}}');
    expect(r?.status).toBe('success');
    expect(received).toBe('Token: literal-value');
  });

  test('a name resolved from a template cannot be referenced from the prompt', async () => {
    const { received, r, err } = await runWithPrompt('User: {{secrets.QA_myapp_USER}}');
    expect(received).toBe('');
    expect(r?.status === 'success').toBe(false);
    if (err) expect(String(err)).toContain('QA_myapp_USER');
  });
});

describe('runPipeline — always', () => {
  test('an always step runs after a failure and does not affect the run status', async () => {
    const marker = join(root, 'marker.txt');
    const record = await run(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: exit 1
always:
  - id: cleanup
    run: printf done > ${marker}
`);
    expect(record.status).toBe('failed');
    expect(record.steps.cleanup!.status).toBe('success');
    expect(await Bun.file(marker).text()).toBe('done');
  });

  test('an always step also runs when the run succeeds', async () => {
    const record = await run(`
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
`);
    expect(record.status).toBe('success');
    expect(record.steps.cleanup!.status).toBe('success');
  });

  test('the failure of an always step does not change the run status', async () => {
    const record = await run(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: 'true'
always:
  - id: cleanup
    run: exit 1
`);
    expect(record.status).toBe('success');
    expect(record.steps.cleanup!.status).toBe('failed');
  });

  test('several always steps all run even if one fails', async () => {
    const record = await run(`
name: demo
description: d
version: 1
steps:
  - id: a
    type: shell
    run: 'true'
always:
  - id: cleanup-1
    run: exit 1
  - id: cleanup-2
    run: 'true'
`);
    expect(record.steps['cleanup-1']!.status).toBe('failed');
    expect(record.steps['cleanup-2']!.status).toBe('success');
  });
});
