import { describe, expect, test } from 'bun:test';
import { parsePipeline } from '../../src/schema/pipeline.ts';
import { unsetParamImpacts } from '../../src/install/params.ts';

const PIPELINE = parsePipeline(`
name: demo
description: d
version: 1
params:
  docs_repo:
    description: ruta
    required: true
  deploy_url:
    description: url opcional de deploy
steps:
  - id: build
    type: shell
    run: 'true'
  - id: deploy
    type: shell
    when: "{{params.deploy_url}}"
    run: 'true'
`);

describe('unsetParamImpacts', () => {
  // El segundo incidente del 2026-08-29: faltaba un param opcional, el paso
  // `deploy` se saltaba limpiamente cada noche, y nada lo dijo nunca. El
  // `when` de `deploy` es una referencia PELADA (`{{params.deploy_url}}`),
  // así que aquí sí se puede afirmar con certeza que el paso se saltará.
  test('nombra el param sin valor y el paso que se saltará por su culpa (referencia pelada)', () => {
    expect(unsetParamImpacts(PIPELINE, { docs_repo: '/repos/docs' })).toEqual([
      { param: 'deploy_url', skippedSteps: ['deploy'], uncertainSteps: [] },
    ]);
  });

  test('un param sin valor del que no depende ningún paso se reporta sin pasos', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
params:
  suelto:
    description: no lo usa ningún when
steps:
  - id: a
    type: shell
    run: 'true'
`);
    expect(unsetParamImpacts(p, {})).toEqual([{ param: 'suelto', skippedSteps: [], uncertainSteps: [] }]);
  });

  test('con todos los params resueltos no hay nada que avisar', () => {
    expect(unsetParamImpacts(PIPELINE, { docs_repo: '/r', deploy_url: 'https://x' })).toEqual([]);
  });

  // `evaluateWhen` trata una referencia
  // ausente como `undefined`, y con `!=` la comparación `undefined != "yes"`
  // da `true` — el paso SE EJECUTA, no se salta. Afirmar "se saltará" aquí
  // sería mentir, así que debe caer en `uncertainSteps`, no en
  // `skippedSteps`.
  test('un "when" con comparación (!=) no afirma que el paso se vaya a saltar', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
params:
  dry_run:
    description: modo simulación
steps:
  - id: deploy
    type: shell
    when: '{{params.dry_run}} != "yes"'
    run: 'true'
`);
    expect(unsetParamImpacts(p, {})).toEqual([
      { param: 'dry_run', skippedSteps: [], uncertainSteps: ['deploy'] },
    ]);
  });

  // Dos params sin valor pueden depender del mismo paso a la vez (aquí,
  // ambos lados de una comparación entre dos referencias — sintaxis que
  // `evaluateWhen` rechazaría en runtime, pero `unsetParamImpacts` solo
  // escanea texto en vez de evaluar, así que debe seguir nombrando el paso
  // bajo CADA uno de los dos params por separado).
  test('dos params sin valor sobre el mismo paso generan un impacto cada uno', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
params:
  a:
    description: uno
  b:
    description: otro
steps:
  - id: build
    type: shell
    when: '{{params.a}} != {{params.b}}'
    run: 'true'
`);
    expect(unsetParamImpacts(p, {})).toEqual([
      { param: 'a', skippedSteps: [], uncertainSteps: ['build'] },
      { param: 'b', skippedSteps: [], uncertainSteps: ['build'] },
    ]);
  });
});
