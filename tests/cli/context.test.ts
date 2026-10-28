import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPipeline, loadRepoContext, parseDotEnv } from '../../src/cli/context.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ap-cli-'));
  writeFileSync(join(root, 'pipelines.yaml'), 'channels: {}\n');
  mkdirSync(join(root, 'pipelines', 'demo'), { recursive: true });
  writeFileSync(
    join(root, 'pipelines', 'demo', 'pipeline.yaml'),
    'name: demo\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('parseDotEnv', () => {
  test('parses key=value pairs', () => {
    expect(parseDotEnv('A=1\nB=two')).toEqual({ A: '1', B: 'two' });
  });
  test('ignores comments and blank lines', () => {
    expect(parseDotEnv('# comment\n\nA=1\n')).toEqual({ A: '1' });
  });
  test('strips quotes around the value', () => {
    expect(parseDotEnv('A="with spaces"\nB=\'x\'')).toEqual({ A: 'with spaces', B: 'x' });
  });
  test('keeps any = inside the value', () => {
    expect(parseDotEnv('A=a=b=c')).toEqual({ A: 'a=b=c' });
  });
});

describe('loadRepoContext', () => {
  test('finds the root from a subdirectory', async () => {
    const ctx = await loadRepoContext(join(root, 'pipelines', 'demo'));
    expect(ctx.root).toBe(root);
  });

  test('fails with a useful message outside a pipelines repo', async () => {
    const orphan = mkdtempSync(join(tmpdir(), 'ap-orphan-'));
    await expect(loadRepoContext(orphan)).rejects.toThrow(/pipelines\.yaml/);
    rmSync(orphan, { recursive: true, force: true });
  });

  test('loads the .env when it exists', async () => {
    writeFileSync(join(root, '.env'), 'MY_TOKEN=secret\n');
    const ctx = await loadRepoContext(root);
    expect(ctx.dotEnv.MY_TOKEN).toBe('secret');
  });

  test('without a .env the map is empty, it does not fail', async () => {
    const ctx = await loadRepoContext(root);
    expect(ctx.dotEnv).toEqual({});
  });
});

describe('loadPipeline', () => {
  test('loads and parses a pipeline by name', async () => {
    const ctx = await loadRepoContext(root);
    const p = await loadPipeline(ctx, 'demo');
    expect(p.name).toBe('demo');
  });

  test('fails naming the available pipelines', async () => {
    const ctx = await loadRepoContext(root);
    await expect(loadPipeline(ctx, 'nonexistent')).rejects.toThrow(/demo/);
  });

  test('fails if the YAML name does not match the directory', async () => {
    mkdirSync(join(root, 'pipelines', 'mismatched'), { recursive: true });
    writeFileSync(
      join(root, 'pipelines', 'mismatched', 'pipeline.yaml'),
      'name: other-name\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );
    const ctx = await loadRepoContext(root);
    await expect(loadPipeline(ctx, 'mismatched')).rejects.toThrow(/mismatched.*other-name|other-name.*mismatched/s);
  });
});
