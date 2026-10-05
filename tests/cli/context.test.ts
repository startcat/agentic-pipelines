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
  test('parsea pares clave=valor', () => {
    expect(parseDotEnv('A=1\nB=dos')).toEqual({ A: '1', B: 'dos' });
  });
  test('ignora comentarios y líneas vacías', () => {
    expect(parseDotEnv('# comentario\n\nA=1\n')).toEqual({ A: '1' });
  });
  test('quita comillas alrededor del valor', () => {
    expect(parseDotEnv('A="con espacios"\nB=\'x\'')).toEqual({ A: 'con espacios', B: 'x' });
  });
  test('conserva los = que haya dentro del valor', () => {
    expect(parseDotEnv('A=a=b=c')).toEqual({ A: 'a=b=c' });
  });
});

describe('loadRepoContext', () => {
  test('encuentra la raíz desde un subdirectorio', async () => {
    const ctx = await loadRepoContext(join(root, 'pipelines', 'demo'));
    expect(ctx.root).toBe(root);
  });

  test('falla con un mensaje útil fuera de un repo de pipelines', async () => {
    const orphan = mkdtempSync(join(tmpdir(), 'ap-orphan-'));
    await expect(loadRepoContext(orphan)).rejects.toThrow(/pipelines\.yaml/);
    rmSync(orphan, { recursive: true, force: true });
  });

  test('carga el .env cuando existe', async () => {
    writeFileSync(join(root, '.env'), 'MY_TOKEN=secreto\n');
    const ctx = await loadRepoContext(root);
    expect(ctx.dotEnv.MY_TOKEN).toBe('secreto');
  });

  test('sin .env el mapa está vacío, no falla', async () => {
    const ctx = await loadRepoContext(root);
    expect(ctx.dotEnv).toEqual({});
  });
});

describe('loadPipeline', () => {
  test('carga y parsea un pipeline por nombre', async () => {
    const ctx = await loadRepoContext(root);
    const p = await loadPipeline(ctx, 'demo');
    expect(p.name).toBe('demo');
  });

  test('falla nombrando los pipelines disponibles', async () => {
    const ctx = await loadRepoContext(root);
    await expect(loadPipeline(ctx, 'inexistente')).rejects.toThrow(/demo/);
  });

  test('falla si el name del YAML no coincide con el directorio', async () => {
    mkdirSync(join(root, 'pipelines', 'mismatched'), { recursive: true });
    writeFileSync(
      join(root, 'pipelines', 'mismatched', 'pipeline.yaml'),
      'name: otro-nombre\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );
    const ctx = await loadRepoContext(root);
    await expect(loadPipeline(ctx, 'mismatched')).rejects.toThrow(/mismatched.*otro-nombre|otro-nombre.*mismatched/s);
  });
});
