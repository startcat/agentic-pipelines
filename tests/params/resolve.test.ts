import { describe, expect, test } from 'bun:test';
import { parsePipeline } from '../../src/schema/pipeline.ts';
import {
  findReferences,
  interpolate,
  interpolateForShell,
  MissingParamsError,
  resolveParams,
} from '../../src/params/resolve.ts';

const PIPELINE = parsePipeline(`
name: demo
description: d
version: 1
params:
  docs_repo:
    description: Ruta del repo
    required: true
  max_pages:
    description: Páginas por pasada
    default: 1
steps:
  - id: a
    type: shell
    run: 'true'
`);

describe('resolveParams', () => {
  test('aplica la precedencia default < local < override', () => {
    const params = resolveParams(PIPELINE, {
      local: { docs_repo: '/srv/docs', max_pages: '2' },
      overrides: { max_pages: '5' },
    });
    expect(params).toEqual({ docs_repo: '/srv/docs', max_pages: '5' });
  });

  test('usa el default cuando no hay local ni override', () => {
    const params = resolveParams(PIPELINE, { local: { docs_repo: '/srv/docs' } });
    expect(params.max_pages).toBe('1');
  });

  test('lanza MissingParamsError nombrando los que faltan', () => {
    try {
      resolveParams(PIPELINE, {});
      throw new Error('debería haber lanzado');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingParamsError);
      expect((err as MissingParamsError).missing).toEqual(['docs_repo']);
    }
  });

  test('rechaza un override de un param no declarado', () => {
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

  test('sustituye referencias a params', () => {
    expect(interpolate('cd {{params.docs_repo}}', scope)).toBe('cd /srv/docs');
  });

  test('sustituye referencias a salidas de pasos', () => {
    expect(interpolate('hay {{scan.stale_count}}', scope)).toBe('hay 7');
  });

  test('serializa un valor no escalar como JSON', () => {
    expect(interpolate('{{scan.pages}}', scope)).toBe('["a","b"]');
  });

  test('una referencia sin resolver es un error, no una cadena vacía', () => {
    expect(() => interpolate('{{scan.nope}}', scope)).toThrow(/scan\.nope/);
  });

  test('tolera espacios dentro de las llaves', () => {
    expect(interpolate('{{ params.docs_repo }}', scope)).toBe('/srv/docs');
  });

  test('sustituye referencias a secretos cuando el scope los trae', () => {
    const withSecrets = { ...scope, secrets: { API_KEY: 'sk-real' } };
    expect(interpolate('key: {{secrets.API_KEY}}', withSecrets)).toBe('key: sk-real');
  });

  test('una referencia a secrets sin scope.secrets lanza, igual que cualquier otra sin resolver', () => {
    expect(() => interpolate('{{secrets.API_KEY}}', scope)).toThrow(/secrets\.API_KEY/);
  });

  test('una referencia a un secreto no declarado en scope.secrets lanza', () => {
    const withSecrets = { ...scope, secrets: { OTRA: 'x' } };
    expect(() => interpolate('{{secrets.API_KEY}}', withSecrets)).toThrow(/secrets\.API_KEY/);
  });
});

describe('findReferences', () => {
  test('distingue referencias a params de referencias a pasos', () => {
    const refs = findReferences('cd {{params.docs_repo}} && echo {{scan.pages}}');
    expect(refs).toEqual([
      { kind: 'param', name: 'docs_repo' },
      { kind: 'step', step: 'scan', field: 'pages' },
    ]);
  });

  test('devuelve lista vacía cuando no hay referencias', () => {
    expect(findReferences('echo hola')).toEqual([]);
  });

  test('distingue referencias a secrets de referencias a params y a pasos', () => {
    const refs = findReferences('{{secrets.API_KEY}} {{params.x}} {{scan.y}}');
    expect(refs).toEqual([
      { kind: 'secret', name: 'API_KEY' },
      { kind: 'param', name: 'x' },
      { kind: 'step', step: 'scan', field: 'y' },
    ]);
  });
});

describe('interpolateForShell', () => {
  test('sustituye una referencia por una variable de entorno segura', () => {
    const { command, env } = interpolateForShell('echo {{params.saludo}}', {
      params: { saludo: 'hola' }, steps: {},
    });
    expect(command).toBe('echo ${__PIPELINES_REF_0}');
    expect(env).toEqual({ __PIPELINES_REF_0: 'hola' });
  });

  test('respeta el entrecomillado que ya tenga el YAML', () => {
    const { command, env } = interpolateForShell('telegram-relay "{{draft.pr_url}}"', {
      params: {}, steps: { draft: { pr_url: 'https://example.com/pr/1' } },
    });
    expect(command).toBe('telegram-relay "${__PIPELINES_REF_0}"');
    expect(env.__PIPELINES_REF_0).toBe('https://example.com/pr/1');
  });

  test('varias referencias reciben índices distintos', () => {
    const { command, env } = interpolateForShell('echo {{params.a}}-{{params.b}}', {
      params: { a: 'x', b: 'y' }, steps: {},
    });
    expect(command).toBe('echo ${__PIPELINES_REF_0}-${__PIPELINES_REF_1}');
    expect(env).toEqual({ __PIPELINES_REF_0: 'x', __PIPELINES_REF_1: 'y' });
  });

  test('un valor con metacaracteres de shell viaja intacto por el entorno, nunca por el texto', () => {
    const payload = '$(touch pwned.txt); echo `whoami`';
    const { command, env } = interpolateForShell('echo {{params.texto}}', {
      params: { texto: payload }, steps: {},
    });
    expect(command).not.toContain('touch');
    expect(command).not.toContain('`');
    expect(env.__PIPELINES_REF_0).toBe(payload);
  });

  test('una referencia sin resolver sigue lanzando, igual que interpolate()', () => {
    expect(() => interpolateForShell('echo {{params.no_declarado}}', { params: {}, steps: {} }))
      .toThrow(/no_declarado/);
  });

  test('sin ninguna referencia, el comando no cambia y el entorno está vacío', () => {
    const { command, env } = interpolateForShell('echo hola', { params: {}, steps: {} });
    expect(command).toBe('echo hola');
    expect(env).toEqual({});
  });

  test('una referencia pegada a texto sin separador no se trunca (llaves obligatorias)', () => {
    const { command, env } = interpolateForShell('echo {{params.nombre}}_final', {
      params: { nombre: 'hola' }, steps: {},
    });
    expect(command).toBe('echo ${__PIPELINES_REF_0}_final');
    expect(env.__PIPELINES_REF_0).toBe('hola');
  });
});
