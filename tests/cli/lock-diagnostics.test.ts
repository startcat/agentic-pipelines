import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, readLock, releaseLock } from '../../src/guards/lock.ts';
import { RunStore } from '../../src/runs/store.ts';

// Coverage of the two lock diagnostics of the CLI (busy lock and damaged
// lock) and of two more guarantees: that `resume` also takes the lock, and
// that the process itself releases the lock when interrupted.

let root: string;
const CLI = join(import.meta.dir, '..', '..', 'src', 'cli', 'index.ts');

function writePipeline(name: string, yaml: string): void {
  mkdirSync(join(root, 'pipelines', name), { recursive: true });
  writeFileSync(join(root, 'pipelines', name, 'pipeline.yaml'), yaml);
}

// Annotated with the same literals passed to `Bun.spawn` below: without
// instantiating its generic parameters, `stdout`/`stderr` would be typed as
// `number | ReadableStream | undefined` instead of `ReadableStream` (same
// problem already documented in `src/runner/shell.ts`).
function spawnCli(args: string[]): Bun.Subprocess<'ignore', 'pipe', 'pipe'> {
  return Bun.spawn(['bun', CLI, ...args], {
    cwd: root,
    env: { ...process.env, ANTHROPIC_API_KEY: 'sk-test' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

async function cli(args: string[]): Promise<{ code: number; out: string }> {
  const proc = spawnCli(args);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out: stdout + stderr };
}

/** Waits until `predicate` is true, with no fixed wait. */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error('timeout waiting for the condition');
}

function latestRunId(pipeline: string): string {
  const entries = readdirSync(join(root, '.runs', pipeline)).sort();
  const last = entries[entries.length - 1];
  if (!last) throw new Error(`no runs of "${pipeline}"`);
  return last;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ap-lock-diag-'));
  writeFileSync(join(root, 'pipelines.yaml'), 'channels: {}\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('message when the lock is already held', () => {
  test('names the relative path of the lock, the pid and since when', async () => {
    writePipeline(
      'busy',
      'name: busy\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );

    // The test process itself holds the lock: its pid is alive throughout the
    // test, so the CLI subprocess's `acquireLock` will see it as a legitimate
    // run in progress, not as an orphaned lock.
    const handle = await acquireLock(root, 'busy');
    expect(handle).toBeDefined();

    try {
      const { code, out } = await cli(['run', 'busy']);
      expect(code).toBe(3); // EXIT_ALREADY_RUNNING
      expect(out).toContain('busy');
      expect(out).toContain(join('.runs', '.locks', 'busy.lock'));
      expect(out).toContain(String(process.pid));
      expect(out).toContain('since');
      // Never an absolute path of this machine (portability constraint).
      expect(out).not.toContain(root);
    } finally {
      await releaseLock(handle!);
    }
  });

  test('records the blocked attempt as skipped(already_running) in .runs/', async () => {
    writePipeline(
      'busy2',
      'name: busy2\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );
    const handle = await acquireLock(root, 'busy2');
    expect(handle).toBeDefined();
    try {
      const { code } = await cli(['run', 'busy2']);
      expect(code).toBe(3); // EXIT_ALREADY_RUNNING — unchanged
    } finally {
      await releaseLock(handle!);
    }

    const runs = await new RunStore(root).listRuns('busy2');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('skipped');
    expect(runs[0]!.skipReason).toBe('already_running');
  });
});

describe('damaged lock, different from "already in progress"', () => {
  test('is reported as a problem with the file itself, with a different exit code', async () => {
    writePipeline(
      'broken',
      'name: broken\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );
    mkdirSync(join(root, '.runs', '.locks'), { recursive: true });
    writeFileSync(join(root, '.runs', '.locks', 'broken.lock'), 'this is not valid JSON');

    const { code, out } = await cli(['run', 'broken']);

    expect(code).toBe(2); // EXIT_LOCK_ERROR — different from EXIT_ALREADY_RUNNING (3)
    expect(out).not.toContain('already in progress');
    expect(out.toLowerCase()).toContain('lock');
  });
});

describe('resume takes the lock', () => {
  test('a resume refuses to start if another run holds the lock of the same pipeline', async () => {
    writePipeline(
      'resumable',
      'name: resumable\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: exit 1\n',
    );
    const { code: runCode } = await cli(['run', 'resumable']);
    expect(runCode).toBe(1);
    const runId = latestRunId('resumable');

    const handle = await acquireLock(root, 'resumable');
    expect(handle).toBeDefined();
    try {
      const { code, out } = await cli(['resume', 'resumable', runId]);
      expect(code).toBe(3); // EXIT_ALREADY_RUNNING
      expect(out).toContain('in progress');

      const runs = await new RunStore(root).listRuns('resumable');
      // The first run (really failed) plus the blocked resume attempt.
      expect(runs).toHaveLength(2);
      const blocked = runs.find((r) => r.skipReason === 'already_running');
      expect(blocked?.status).toBe('skipped');
    } finally {
      await releaseLock(handle!);
    }
  });

  test('the record of a blocked resume uses the pipeline version of the run being resumed, not the freshly loaded one', async () => {
    writePipeline(
      'versioned',
      'name: versioned\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: exit 1\n',
    );
    const { code: runCode } = await cli(['run', 'versioned']);
    expect(runCode).toBe(1);
    const runId = latestRunId('versioned');
    const original = await new RunStore(root).readRun('versioned', runId);
    expect(original?.pipelineVersion).toBe(1);

    // The pipeline.yaml changes version BETWEEN the original run and the
    // resume attempt: the blocked attempt's record must stay anchored to the
    // version of the run being resumed (1), not the freshly loaded one (2).
    writePipeline(
      'versioned',
      'name: versioned\ndescription: d\nversion: 2\nsteps:\n  - id: a\n    type: shell\n    run: exit 1\n',
    );

    const handle = await acquireLock(root, 'versioned');
    expect(handle).toBeDefined();
    try {
      const { code } = await cli(['resume', 'versioned', runId]);
      expect(code).toBe(3); // EXIT_ALREADY_RUNNING
    } finally {
      await releaseLock(handle!);
    }

    const runs = await new RunStore(root).listRuns('versioned');
    const blocked = runs.find((r) => r.skipReason === 'already_running');
    expect(blocked?.pipelineVersion).toBe(1);
  });

  test('a normal resume (no conflict) retries the failed step and can succeed', async () => {
    // The gate uses a marker file inside the pipeline's own directory
    // (default cwd of a shell step): absent the first time (fails and creates
    // it), present the second (succeeds). This simulates a real transient
    // failure that an operator fixes before resuming, without depending on
    // the pipeline's own automatic retries.
    writePipeline(
      'recoverable',
      'name: recoverable\ndescription: d\nversion: 1\nsteps:\n  - id: gate\n    type: shell\n    run: test -f .flag && echo \'{"ok":true}\' || (touch .flag; exit 1)\n    outputs: { ok: boolean }\n',
    );

    const { code: firstCode } = await cli(['run', 'recoverable']);
    expect(firstCode).toBe(1);
    const runId = latestRunId('recoverable');

    const { code: resumeCode, out } = await cli(['resume', 'recoverable', runId]);
    expect(resumeCode).toBe(0);
    expect(out).toContain('success');

    // The lock was released after the resume: a later normal run should not
    // run into "already in progress".
    expect(await readLock(root, 'recoverable')).toBeUndefined();
  });
});

describe('process interruption (verification: is the lock released on every exit path?)', () => {
  test('SIGINT releases the lock before the process ends', async () => {
    writePipeline(
      'slow',
      'name: slow\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: sleep 5\n',
    );

    const proc = spawnCli(['run', 'slow']);
    await waitFor(async () => (await readLock(root, 'slow')) !== undefined);

    proc.kill('SIGINT');
    const code = await proc.exited;

    expect(code).toBe(130);
    expect(await readLock(root, 'slow')).toBeUndefined();
  });
});
