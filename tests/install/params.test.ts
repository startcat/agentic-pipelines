import { describe, expect, test } from 'bun:test';
import { parsePipeline } from '../../src/schema/pipeline.ts';
import { unsetParamImpacts } from '../../src/install/params.ts';

const PIPELINE = parsePipeline(`
name: demo
description: d
version: 1
params:
  docs_repo:
    description: path
    required: true
  deploy_url:
    description: optional deploy url
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
  // The second incident of 2026-08-29: an optional param was missing, the
  // `deploy` step was skipped cleanly every night, and nothing ever said so.
  // The `when` of `deploy` is a BARE reference (`{{params.deploy_url}}`), so
  // here it can be asserted for certain that the step will be skipped.
  test('names the param without a value and the step that will be skipped because of it (bare reference)', () => {
    expect(unsetParamImpacts(PIPELINE, { docs_repo: '/repos/docs' })).toEqual([
      { param: 'deploy_url', skippedSteps: ['deploy'], uncertainSteps: [] },
    ]);
  });

  test('a param without a value that no step depends on is reported with no steps', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
params:
  loose:
    description: no when uses it
steps:
  - id: a
    type: shell
    run: 'true'
`);
    expect(unsetParamImpacts(p, {})).toEqual([{ param: 'loose', skippedSteps: [], uncertainSteps: [] }]);
  });

  test('with all params resolved there is nothing to warn about', () => {
    expect(unsetParamImpacts(PIPELINE, { docs_repo: '/r', deploy_url: 'https://x' })).toEqual([]);
  });

  // `evaluateWhen` treats a missing reference as `undefined`, and with `!=`
  // the comparison `undefined != "yes"` gives `true` — the step RUNS, it is
  // not skipped. Asserting "it will be skipped" here would be lying, so it
  // must fall into `uncertainSteps`, not
  // `skippedSteps`.
  test('a "when" with a comparison (!=) does not claim the step will be skipped', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
params:
  dry_run:
    description: dry-run mode
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

  // Two params without a value can depend on the same step at once (here,
  // both sides of a comparison between two references — syntax that
  // `evaluateWhen` would reject at runtime, but `unsetParamImpacts` only
  // scans text instead of evaluating, so it must still name the step under
  // EACH of the two params separately).
  test('two params without a value on the same step produce one impact each', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
params:
  a:
    description: one
  b:
    description: other
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
