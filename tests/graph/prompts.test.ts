import { describe, expect, test } from 'bun:test';
import { parsePipeline } from '../../src/schema/pipeline.ts';
import { checkAlwaysReferences, checkGuardReferences, checkPromptReferences, checkStepReferences } from '../../src/graph/prompts.ts';

const PIPELINE = parsePipeline(`
name: demo
description: d
version: 1
params:
  tema:
    description: t
requires:
  env: [API_KEY]
steps:
  - id: scan
    type: shell
    run: 'true'
    outputs: { count: number }
  - id: draft
    agent: writer
    prompt: draft.md
`);

describe('checkPromptReferences', () => {
  test('sin referencias, no hay problemas', () => {
    expect(checkPromptReferences(PIPELINE, { draft: 'Redacta un resumen.' })).toEqual([]);
  });

  test('una referencia a un param declarado no da problemas', () => {
    expect(checkPromptReferences(PIPELINE, { draft: 'Resumen sobre {{params.tema}}.' })).toEqual([]);
  });

  test('una referencia a un output declarado de un paso anterior no da problemas', () => {
    expect(checkPromptReferences(PIPELINE, { draft: 'Hay {{scan.count}} pendientes.' })).toEqual([]);
  });

  test('una referencia a un param no declarado se reporta nombrando el paso y el param', () => {
    const issues = checkPromptReferences(PIPELINE, { draft: 'Sobre {{params.no_existe}}.' });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('draft');
    expect(issues[0]).toContain('no_existe');
  });

  test('una referencia a un paso inexistente se reporta', () => {
    const issues = checkPromptReferences(PIPELINE, { draft: 'Ver {{fantasma.x}}.' });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('fantasma');
  });

  test('una referencia a un output no declarado por un paso real se reporta', () => {
    const issues = checkPromptReferences(PIPELINE, { draft: 'Hay {{scan.otro_campo}} pendientes.' });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('scan');
    expect(issues[0]).toContain('otro_campo');
  });

  test('una referencia a un secreto declarado en requires.env no da problemas', () => {
    expect(checkPromptReferences(PIPELINE, { draft: 'Usa {{secrets.API_KEY}}.' })).toEqual([]);
  });

  test('una referencia a un secreto no declarado en requires.env se reporta', () => {
    const issues = checkPromptReferences(PIPELINE, { draft: 'Usa {{secrets.NO_DECLARADO}}.' });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('draft');
    expect(issues[0]).toContain('NO_DECLARADO');
  });

  test('acumula problemas de varios prompts a la vez', () => {
    const issues = checkPromptReferences(PIPELINE, {
      draft: 'Sobre {{params.no_existe}}.',
      scan: 'Ver {{fantasma.x}}.',
    });
    expect(issues).toHaveLength(2);
  });
});

describe('checkAlwaysReferences', () => {
  test('sin always declarado, no hay problemas', () => {
    expect(checkAlwaysReferences(PIPELINE)).toEqual([]);
  });

  test('sin referencias en run/cwd, no hay problemas', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: scan
    type: shell
    run: 'true'
    outputs: { count: number }
always:
  - id: cleanup
    run: git reset --hard
`);
    expect(checkAlwaysReferences(p)).toEqual([]);
  });

  test('una referencia a un param declarado en run no da problemas', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
params:
  tema:
    description: t
steps:
  - id: scan
    type: shell
    run: 'true'
    outputs: { count: number }
always:
  - id: cleanup
    run: 'echo {{params.tema}}'
`);
    expect(checkAlwaysReferences(p)).toEqual([]);
  });

  test('una referencia a un output declarado de un paso de steps no da problemas', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: scan
    type: shell
    run: 'true'
    outputs: { count: number }
always:
  - id: cleanup
    run: 'echo {{scan.count}}'
`);
    expect(checkAlwaysReferences(p)).toEqual([]);
  });

  test('una referencia en cwd también se comprueba', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: scan
    type: shell
    run: 'true'
    outputs: { count: number }
always:
  - id: cleanup
    run: 'true'
    cwd: '{{params.no_existe}}'
`);
    const issues = checkAlwaysReferences(p);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('cleanup');
    expect(issues[0]).toContain('no_existe');
  });

  test('una referencia a un param no declarado se reporta nombrando el paso always y el param', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: scan
    type: shell
    run: 'true'
    outputs: { count: number }
always:
  - id: cleanup
    run: 'echo {{params.no_existe}}'
`);
    const issues = checkAlwaysReferences(p);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('cleanup');
    expect(issues[0]).toContain('no_existe');
  });

  test('una referencia a un paso inexistente se reporta', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: scan
    type: shell
    run: 'true'
    outputs: { count: number }
always:
  - id: cleanup
    run: 'git -C {{fantasma.path}} reset --hard'
`);
    const issues = checkAlwaysReferences(p);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('cleanup');
    expect(issues[0]).toContain('fantasma');
  });

  test('una referencia a un output no declarado por un paso real se reporta', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: scan
    type: shell
    run: 'true'
    outputs: { count: number }
always:
  - id: cleanup
    run: 'echo {{scan.otro_campo}}'
`);
    const issues = checkAlwaysReferences(p);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('scan');
    expect(issues[0]).toContain('otro_campo');
  });

  test('una referencia de un always a OTRO always se reporta como paso inexistente (always no declara outputs)', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: scan
    type: shell
    run: 'true'
    outputs: { count: number }
always:
  - id: first-cleanup
    run: 'true'
  - id: second-cleanup
    run: 'echo {{first-cleanup.count}}'
`);
    const issues = checkAlwaysReferences(p);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('second-cleanup');
    expect(issues[0]).toContain('first-cleanup');
  });

  test('acumula problemas de varias entradas always a la vez', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: scan
    type: shell
    run: 'true'
    outputs: { count: number }
always:
  - id: cleanup-a
    run: 'echo {{params.no_existe}}'
  - id: cleanup-b
    run: 'echo {{fantasma.x}}'
`);
    expect(checkAlwaysReferences(p)).toHaveLength(2);
  });

  test('una referencia a secrets en always se rechaza siempre, sin importar el nombre', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
requires:
  env: [API_KEY]
steps:
  - id: scan
    type: shell
    run: 'true'
    outputs: { count: number }
always:
  - id: cleanup
    run: 'echo {{secrets.API_KEY}}'
`);
    const issues = checkAlwaysReferences(p);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('cleanup');
    expect(issues[0]).toContain('secrets');
  });
});

describe('checkStepReferences', () => {
  const PIPELINE = parsePipeline(`
name: demo
description: d
version: 1
params:
  admin_repo:
    description: r
requires:
  env: [API_KEY]
steps:
  - id: scan
    type: shell
    run: 'true'
    outputs: { count: number }
  - id: draft
    agent: writer
    prompt: draft.md
    cwd: "{{params.admin_repo}}"
    additional_dirs: ["{{scan.count}}"]
    when: "{{scan.count}}"
`);

  test('cwd/additional_dirs/when que resuelven contra params u outputs de pasos no dan problemas', () => {
    expect(checkStepReferences(PIPELINE)).toEqual([]);
  });

  test('un {{secrets.X}} en cwd se rechaza', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
requires:
  env: [API_KEY]
steps:
  - id: a
    agent: writer
    prompt: p.md
    cwd: "{{secrets.API_KEY}}"
`);
    const issues = checkStepReferences(p);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('secrets');
  });

  test('un {{secrets.X}} en additional_dirs se rechaza', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
requires:
  env: [API_KEY]
steps:
  - id: a
    agent: writer
    prompt: p.md
    additional_dirs: ["{{secrets.API_KEY}}"]
`);
    const issues = checkStepReferences(p);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('additional_dirs');
  });

  test('un {{secrets.X}} en when se rechaza', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
requires:
  env: [API_KEY]
steps:
  - id: a
    type: shell
    run: 'true'
    when: "{{secrets.API_KEY}}"
`);
    const issues = checkStepReferences(p);
    expect(issues).toHaveLength(1);
  });

  test('una referencia a un param no declarado en cwd se reporta', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    agent: writer
    prompt: p.md
    cwd: "{{params.no_declarado}}"
`);
    const issues = checkStepReferences(p);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('no_declarado');
  });

  test('una referencia a un paso inexistente en additional_dirs se reporta', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    agent: writer
    prompt: p.md
    additional_dirs: ["{{no-existe.campo}}"]
`);
    const issues = checkStepReferences(p);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('no-existe');
  });
});

describe('checkStepReferences: el run: de un paso shell', () => {
  test('caza un param inexistente en run:', () => {
    const pipeline = parsePipeline(`
name: demo
description: d
version: 1
params:
  real:
    description: existe
steps:
  - id: uno
    type: shell
    run: "echo {{params.no_existe}} {{params.real}}"
`);
    const issues = checkStepReferences(pipeline);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('uno.run');
    expect(issues[0]).toContain('params.no_existe');
  });

  test('caza una referencia a un output no declarado en run:', () => {
    const pipeline = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: uno
    type: shell
    run: "true"
  - id: dos
    type: shell
    run: "echo {{uno.head}}"
`);
    const issues = checkStepReferences(pipeline);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('dos.run');
    expect(issues[0]).toContain('uno.head');
  });

  test('un run: sin referencias no produce nada', () => {
    const pipeline = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: uno
    type: shell
    run: "echo hola"
`);
    expect(checkStepReferences(pipeline)).toEqual([]);
  });
});

describe('checkGuardReferences', () => {
  test('caza un param inexistente en una guarda shell:', () => {
    const pipeline = parsePipeline(`
name: demo
description: d
version: 1
when:
  - shell: "test -n {{params.no_existe}}"
steps:
  - id: uno
    type: shell
    run: "true"
`);
    const issues = checkGuardReferences(pipeline);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('when.0.shell');
    expect(issues[0]).toContain('params.no_existe');
  });

  test('caza un param inexistente en una guarda changed:', () => {
    const pipeline = parsePipeline(`
name: demo
description: d
version: 1
when:
  - changed:
      path: "{{params.no_existe}}/docs"
steps:
  - id: uno
    type: shell
    run: "true"
`);
    const issues = checkGuardReferences(pipeline);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('when.0.changed.path');
  });

  test('una guarda no puede referenciar un output NI SIQUIERA de un paso que existe', () => {
    const pipeline = parsePipeline(`
name: demo
description: d
version: 1
when:
  - shell: "test -n {{uno.head}}"
steps:
  - id: uno
    type: shell
    run: "true"
    outputs:
      head: string
`);
    const issues = checkGuardReferences(pipeline);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('ANTES');
  });

  test('una guarda no resuelve secrets', () => {
    const pipeline = parsePipeline(`
name: demo
description: d
version: 1
requires:
  env: [TOKEN]
when:
  - shell: "test -n {{secrets.TOKEN}}"
steps:
  - id: uno
    type: shell
    run: "true"
`);
    const issues = checkGuardReferences(pipeline);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('secrets.TOKEN');
  });

  test('una guarda throttle o between no tiene texto que interpolar', () => {
    const pipeline = parsePipeline(`
name: demo
description: d
version: 1
when:
  - throttle: 46h
  - between: "01:00-05:00"
steps:
  - id: uno
    type: shell
    run: "true"
`);
    expect(checkGuardReferences(pipeline)).toEqual([]);
  });
});
