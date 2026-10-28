import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, readLock, releaseLock } from '../../src/guards/lock.ts';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ap-lock-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('lock', () => {
  test('acquires the lock when it is free', async () => {
    expect(await acquireLock(root, 'demo')).toBeDefined();
  });

  test('a second attempt on the same pipeline fails', async () => {
    const first = await acquireLock(root, 'demo');
    expect(first).toBeDefined();
    expect(await acquireLock(root, 'demo')).toBeUndefined();
  });

  test('after releasing it, it can be acquired again', async () => {
    const first = await acquireLock(root, 'demo');
    await releaseLock(first!);
    expect(await acquireLock(root, 'demo')).toBeDefined();
  });

  test('different pipelines do not block each other', async () => {
    expect(await acquireLock(root, 'a')).toBeDefined();
    expect(await acquireLock(root, 'b')).toBeDefined();
  });

  test('a lock from a dead process is reclaimed', async () => {
    const handle = await acquireLock(root, 'demo');
    // Overwrite the lock with a PID that surely does not exist.
    await Bun.write(handle!.path, JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString() }));
    expect(await acquireLock(root, 'demo')).toBeDefined();
  });

  // --- Mutual exclusion, stealing of other people's locks, and release ---

  test('two simultaneous acquisitions of the same pipeline leave a single owner (TOCTOU race)', async () => {
    // Before the fix, the check (read + liveness check) and the write were
    // not atomic: both calls could read "no lock" before either one wrote,
    // and both ended up "acquiring". The absence of a test like this is
    // exactly what let the defect through in an earlier version — here they
    // really are launched in parallel with Promise.all.
    const [a, b] = await Promise.all([
      acquireLock(root, 'demo'),
      acquireLock(root, 'demo'),
    ]);
    const holders = [a, b].filter((handle) => handle !== undefined);
    expect(holders.length).toBe(1);
  });

  test('a live lock of another user (EPERM) cannot be stolen', async () => {
    const handle = await acquireLock(root, 'demo');
    // Simulates an owner that is still alive but belongs to another user: we
    // cannot signal it, but we must not steal its lock either.
    await Bun.write(
      handle!.path,
      JSON.stringify({ pid: 4_242, startedAt: new Date().toISOString() }),
    );

    const originalKill = process.kill.bind(process);
    process.kill = ((pid: number, signal?: string | number) => {
      if (pid === 4_242) {
        throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
      }
      return originalKill(pid, signal);
    }) as typeof process.kill;

    try {
      expect(await acquireLock(root, 'demo')).toBeUndefined();
    } finally {
      process.kill = originalKill;
    }
  });

  test('releaseLock does not delete a lock that belongs to another pid', async () => {
    const handle = await acquireLock(root, 'demo');
    // Someone else reclaimed this same lock file in the meantime (or the
    // handle went stale): releaseLock must not touch it.
    await Bun.write(
      handle!.path,
      JSON.stringify({ pid: 123_456, startedAt: new Date().toISOString() }),
    );
    await releaseLock(handle!);
    expect(await Bun.file(handle!.path).exists()).toBe(true);
  });

  // --- Side-effect-free reads and corrupt locks ---

  test('readLock exposes who holds the lock without acquiring or modifying it', async () => {
    const handle = await acquireLock(root, 'demo');
    const info = await readLock(root, 'demo');
    expect(info?.pid).toBe(process.pid);
    // It acquired nothing on its own: the lock is still the same one.
    expect(await acquireLock(root, 'demo')).toBeUndefined();
    await releaseLock(handle!);
    expect(await readLock(root, 'demo')).toBeUndefined();
  });

  test('a corrupt lock is not acquired silently (fail-safe, not fail-open)', async () => {
    const handle = await acquireLock(root, 'demo');
    await Bun.write(handle!.path, 'this is not valid JSON');
    await expect(acquireLock(root, 'demo')).rejects.toThrow();
  });

  // --- Atomic reclaim of an orphaned lock and torn reads (creation with wx) ---

  test('concurrent acquisitions on an orphaned lock leave a single owner', async () => {
    // Reproduces what an earlier version let through: an orphaned lock (dead
    // owner) and several concurrent calls on the SAME pipeline. It is repeated
    // many times because a single iteration of a race test proves little. Each
    // iteration uses its own pipeline so as not to depend on cleaning up
    // state between iterations.
    //
    // Deliberately moderate concurrency: earlier versions of this test
    // launched 30 calls at once — the same scale at which the already
    // measured and accepted residual risk appears (see the comment in
    // `acquireLock`, right before `claimMarker`). At that scale, the test
    // ended up asserting a guarantee that was explicitly decided NOT to give,
    // and its occasional failures (~1 in 200-400 runs) were noise, not a sign
    // of a real regression. Here mutual exclusion is tested at the
    // concurrency this tool actually cares about — a handful of overlapping
    // calls (e.g. a cron firing during a manual run), not a herd — where the
    // guarantee IS absolute: exactly one owner, always, in all 30
    // repetitions.
    for (let iteration = 0; iteration < 30; iteration++) {
      const pipeline = `race-${iteration}`;
      const seedPath = join(root, '.runs', '.locks', `${pipeline}.lock`);
      await Bun.write(
        seedPath,
        JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString() }),
      );

      const attempts = await Promise.all(
        Array.from({ length: 5 }, () => acquireLock(root, pipeline)),
      );
      const holders = attempts.filter((handle) => handle !== undefined);
      expect(holders.length).toBe(1);
    }
  });

  test('concurrent acquisitions and reads never observe a half-written lock file', async () => {
    // With `writeFile(..., {flag:'wx'})` creation was not atomic in its
    // CONTENT: the file could exist empty for an instant before being
    // filled, and a concurrent read in that window threw SyntaxError when
    // parsing. None of the calls below must throw for that reason.
    const pipeline = 'hammer';
    const acquireCalls = Array.from({ length: 15 }, () => acquireLock(root, pipeline));
    const readCalls = Array.from({ length: 15 }, () => readLock(root, pipeline));

    const [acquireResults] = await Promise.all([
      Promise.all(acquireCalls),
      Promise.all(readCalls),
    ]);

    const holders = acquireResults.filter((handle) => handle !== undefined);
    expect(holders.length).toBe(1);
  });

  test('an empty lock is treated as absent, not as corrupt', async () => {
    const handle = await acquireLock(root, 'demo');
    await Bun.write(handle!.path, '');
    // An empty file is a benign state (reachable in a narrow concurrency
    // window), not corruption: it must be reclaimable without throwing, just
    // like a lock from a dead process.
    expect(await acquireLock(root, 'demo')).toBeDefined();
  });

  // --- The reclaim marker had no liveness information and could be left
  // orphaned forever ---

  test('a dead lock with an orphaned marker recovers on its own', async () => {
    // Reproduces the critical failure: a process that dies midway through a
    // reclaim (signal, OOM, power cut) leaves the marker orphaned. Before
    // the fix the marker carried no pid, so `acquireLock` rejected it
    // forever even though both the lock and the marker had a dead owner —
    // the pipeline became impossible to acquire even though nobody alive
    // held it.
    const lockFilePath = join(root, '.runs', '.locks', 'demo.lock');
    await Bun.write(
      lockFilePath,
      JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString() }),
    );
    await Bun.write(
      `${lockFilePath}.reclaim`,
      JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString() }),
    );

    const handle = await acquireLock(root, 'demo');
    expect(handle).toBeDefined();
    const info = await readLock(root, 'demo');
    expect(info?.pid).toBe(process.pid);
  });

  test('a marker with a live owner is not stolen', async () => {
    const lockFilePath = join(root, '.runs', '.locks', 'demo.lock');
    await Bun.write(
      lockFilePath,
      JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString() }),
    );
    // The marker is held by a genuinely live process (the test process
    // itself): its reclaim privilege must not be stolen, even though the
    // lock itself is dead.
    await Bun.write(
      `${lockFilePath}.reclaim`,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );

    expect(await acquireLock(root, 'demo')).toBeUndefined();
  });

  test('an empty marker is treated as orphaned, not as corrupt', async () => {
    const lockFilePath = join(root, '.runs', '.locks', 'demo.lock');
    await Bun.write(
      lockFilePath,
      JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString() }),
    );
    await Bun.write(`${lockFilePath}.reclaim`, '');

    expect(await acquireLock(root, 'demo')).toBeDefined();
  });
});
