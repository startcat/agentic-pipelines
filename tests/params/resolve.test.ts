import { describe, expect, test } from 'bun:test';
import { parsePipeline } from '../../src/schema/pipeline.ts';
import {
  findReferences,
  interpolate,
  interpolateForShell,
  MissingParamsError,
  resolveParams,
  resolveParamsLenient,
} from '../../src/params/resolve.ts';

const PIPELINE = parsePipeline(`
name: demo
description: d
version: 1
params:
  docs_repo:
    description: Path to the repo
    required: true
  max_pages:
    description: Pages per run
    default: 1
steps:
  - id: a
    type: shell
    run: 'true'
`);

describe('resolveParams', () => {
  test('applies the precedence default < local < override', () => {
    const params = resolveParams(PIPELINE, {
      local: { docs_repo: '/srv/docs', max_pages: '2' },
      overrides: { max_pages: '5' },
    });
    expect(params).toEqual({ docs_repo: '/srv/docs', max_pages: '5' });
  });

  test('uses the default when there is no local or override', () => {
    const params = resolveParams(PIPELINE, { local: { docs_repo: '/srv/docs' } });
    expect(params.max_pages).toBe('1');
  });

  test('throws MissingParamsError naming the missing ones', () => {
    try {
      resolveParams(PIPELINE, {});
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingParamsError);
      expect((err as MissingParamsError).missing).toEqual(['docs_repo']);
    }
  });

  test('rejects an override of an undeclared param', () => {
    expect(() =>
      resolveParams(PIPELINE, { local: { docs_repo: '/x' }, overrides: { nope: '1' } }),
    ).toThrow(/nope/);
  });
});

describe('interpolate', () => {
  const scope = {
    params: { docs_repo: '/srv/docs' },
    steps: { scan: { stale_count: 7, pages: ['a', 'b'] } },
  };

  test('substitutes references to params', () => {
    expect(interpolate('cd {{params.docs_repo}}', scope)).toBe('cd /srv/docs');
  });

  test('substitutes references to step outputs', () => {
    expect(interpolate('there are {{scan.stale_count}}', scope)).toBe('there are 7');
  });

  test('serializes a non-scalar value as JSON', () => {
    expect(interpolate('{{scan.pages}}', scope)).toBe('["a","b"]');
  });

  test('an unresolved reference is an error, not an empty string', () => {
    expect(() => interpolate('{{scan.nope}}', scope)).toThrow(/scan\.nope/);
  });

  test('tolerates spaces inside the braces', () => {
    expect(interpolate('{{ params.docs_repo }}', scope)).toBe('/srv/docs');
  });

  test('substitutes references to secrets when the scope carries them', () => {
    const withSecrets = { ...scope, secrets: { API_KEY: 'sk-real' } };
    expect(interpolate('key: {{secrets.API_KEY}}', withSecrets)).toBe('key: sk-real');
  });

  test('a reference to secrets without scope.secrets throws, like any other unresolved one', () => {
    expect(() => interpolate('{{secrets.API_KEY}}', scope)).toThrow(/secrets\.API_KEY/);
  });

  test('a reference to a secret not declared in scope.secrets throws', () => {
    const withSecrets = { ...scope, secrets: { OTHER: 'x' } };
    expect(() => interpolate('{{secrets.API_KEY}}', withSecrets)).toThrow(/secrets\.API_KEY/);
  });
});

describe('findReferences', () => {
  test('tells references to params apart from references to steps', () => {
    const refs = findReferences('cd {{params.docs_repo}} && echo {{scan.pages}}');
    expect(refs).toEqual([
      { kind: 'param', name: 'docs_repo' },
      { kind: 'step', step: 'scan', field: 'pages' },
    ]);
  });

  test('returns an empty list when there are no references', () => {
    expect(findReferences('echo hello')).toEqual([]);
  });

  test('tells references to secrets apart from references to params and steps', () => {
    const refs = findReferences('{{secrets.API_KEY}} {{params.x}} {{scan.y}}');
    expect(refs).toEqual([
      { kind: 'secret', name: 'API_KEY' },
      { kind: 'param', name: 'x' },
      { kind: 'step', step: 'scan', field: 'y' },
    ]);
  });
});

describe('interpolateForShell', () => {
  test('replaces a reference with a safe environment variable', () => {
    const { command, env } = interpolateForShell('echo {{params.greeting}}', {
      params: { greeting: 'hello' }, steps: {},
    });
    expect(command).toBe('echo ${__PIPELINES_REF_0}');
    expect(env).toEqual({ __PIPELINES_REF_0: 'hello' });
  });

  test('respects the quoting the YAML already has', () => {
    const { command, env } = interpolateForShell('telegram-relay "{{draft.pr_url}}"', {
      params: {}, steps: { draft: { pr_url: 'https://example.com/pr/1' } },
    });
    expect(command).toBe('telegram-relay "${__PIPELINES_REF_0}"');
    expect(env.__PIPELINES_REF_0).toBe('https://example.com/pr/1');
  });

  test('several references get distinct indexes', () => {
    const { command, env } = interpolateForShell('echo {{params.a}}-{{params.b}}', {
      params: { a: 'x', b: 'y' }, steps: {},
    });
    expect(command).toBe('echo ${__PIPELINES_REF_0}-${__PIPELINES_REF_1}');
    expect(env).toEqual({ __PIPELINES_REF_0: 'x', __PIPELINES_REF_1: 'y' });
  });

  test('a value with shell metacharacters travels intact through the environment, never through the text', () => {
    const payload = '$(touch pwned.txt); echo `whoami`';
    const { command, env } = interpolateForShell('echo {{params.text}}', {
      params: { text: payload }, steps: {},
    });
    expect(command).not.toContain('touch');
    expect(command).not.toContain('`');
    expect(env.__PIPELINES_REF_0).toBe(payload);
  });

  test('an unresolved reference still throws, like interpolate()', () => {
    expect(() => interpolateForShell('echo {{params.not_declared}}', { params: {}, steps: {} }))
      .toThrow(/not_declared/);
  });

  test('with no reference, the command does not change and the environment is empty', () => {
    const { command, env } = interpolateForShell('echo hello', { params: {}, steps: {} });
    expect(command).toBe('echo hello');
    expect(env).toEqual({});
  });

  test('a reference stuck to text with no separator is not truncated (braces required)', () => {
    const { command, env } = interpolateForShell('echo {{params.name}}_final', {
      params: { name: 'hello' }, steps: {},
    });
    expect(command).toBe('echo ${__PIPELINES_REF_0}_final');
    expect(env.__PIPELINES_REF_0).toBe('hello');
  });
});

describe('resolveParamsLenient', () => {
  const P = parsePipeline(`
name: demo
description: d
version: 1
params:
  app:
    description: a
    required: true
  stage:
    description: e
    default: pro
steps:
  - id: a
    type: shell
    run: 'true'
`);

  test('does not throw if a required one is missing: returns what there is', () => {
    expect(resolveParamsLenient(P, {})).toEqual({ stage: 'pro' });
  });

  test('applies the same precedence as resolveParams', () => {
    expect(resolveParamsLenient(P, { local: { app: 'a1' }, overrides: { app: 'a2' } })).toEqual({
      app: 'a2',
      stage: 'pro',
    });
  });

  test('still rejects an undeclared override', () => {
    expect(() => resolveParamsLenient(P, { overrides: { ap: 'x' } })).toThrow('is not declared');
  });
});
