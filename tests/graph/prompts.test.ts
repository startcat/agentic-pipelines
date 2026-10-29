import { describe, expect, test } from 'bun:test';
import { parsePipeline } from '../../src/schema/pipeline.ts';
import { checkAlwaysReferences, checkEnvReferences, checkGuardReferences, checkPromptReferences, checkStepReferences } from '../../src/graph/prompts.ts';

const PIPELINE = parsePipeline(`
name: demo
description: d
version: 1
params:
  topic:
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
  test('with no references, there are no issues', () => {
    expect(checkPromptReferences(PIPELINE, { draft: 'Write a summary.' })).toEqual([]);
  });

  test('a reference to a declared param gives no issues', () => {
    expect(checkPromptReferences(PIPELINE, { draft: 'Summary about {{params.topic}}.' })).toEqual([]);
  });

  test('a reference to a declared output of an earlier step gives no issues', () => {
    expect(checkPromptReferences(PIPELINE, { draft: 'There are {{scan.count}} pending.' })).toEqual([]);
  });

  test('a reference to an undeclared param is reported naming the step and the param', () => {
    const issues = checkPromptReferences(PIPELINE, { draft: 'About {{params.does_not_exist}}.' });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('draft');
    expect(issues[0]).toContain('does_not_exist');
  });

  test('a reference to a nonexistent step is reported', () => {
    const issues = checkPromptReferences(PIPELINE, { draft: 'See {{ghost.x}}.' });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('ghost');
  });

  test('a reference to an output not declared by a real step is reported', () => {
    const issues = checkPromptReferences(PIPELINE, { draft: 'There are {{scan.other_field}} pending.' });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('scan');
    expect(issues[0]).toContain('other_field');
  });

  test('a reference to a secret declared in requires.env gives no issues', () => {
    expect(checkPromptReferences(PIPELINE, { draft: 'Use {{secrets.API_KEY}}.' })).toEqual([]);
  });

  test('a reference to a secret not declared in requires.env is reported', () => {
    const issues = checkPromptReferences(PIPELINE, { draft: 'Use {{secrets.NOT_DECLARED}}.' });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('draft');
    expect(issues[0]).toContain('NOT_DECLARED');
  });

  test('accumulates issues from several prompts at once', () => {
    const issues = checkPromptReferences(PIPELINE, {
      draft: 'About {{params.does_not_exist}}.',
      scan: 'See {{ghost.x}}.',
    });
    expect(issues).toHaveLength(2);
  });
});

describe('checkAlwaysReferences', () => {
  test('with no always declared, there are no issues', () => {
    expect(checkAlwaysReferences(PIPELINE)).toEqual([]);
  });

  test('with no references in run/cwd, there are no issues', () => {
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

  test('a reference to a declared param in run gives no issues', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
params:
  topic:
    description: t
steps:
  - id: scan
    type: shell
    run: 'true'
    outputs: { count: number }
always:
  - id: cleanup
    run: 'echo {{params.topic}}'
`);
    expect(checkAlwaysReferences(p)).toEqual([]);
  });

  test('a reference to a declared output of a steps step gives no issues', () => {
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

  test('a reference in cwd is also checked', () => {
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
    cwd: '{{params.does_not_exist}}'
`);
    const issues = checkAlwaysReferences(p);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('cleanup');
    expect(issues[0]).toContain('does_not_exist');
  });

  test('a reference to an undeclared param is reported naming the always step and the param', () => {
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
    run: 'echo {{params.does_not_exist}}'
`);
    const issues = checkAlwaysReferences(p);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('cleanup');
    expect(issues[0]).toContain('does_not_exist');
  });

  test('a reference to a nonexistent step is reported', () => {
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
    run: 'git -C {{ghost.path}} reset --hard'
`);
    const issues = checkAlwaysReferences(p);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('cleanup');
    expect(issues[0]).toContain('ghost');
  });

  test('a reference to an output not declared by a real step is reported', () => {
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
    run: 'echo {{scan.other_field}}'
`);
    const issues = checkAlwaysReferences(p);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('scan');
    expect(issues[0]).toContain('other_field');
  });

  test('a reference from an always to ANOTHER always is reported as a nonexistent step (always declares no outputs)', () => {
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

  test('accumulates issues from several always entries at once', () => {
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
    run: 'echo {{params.does_not_exist}}'
  - id: cleanup-b
    run: 'echo {{ghost.x}}'
`);
    expect(checkAlwaysReferences(p)).toHaveLength(2);
  });

  test('a reference to secrets in always is always rejected, whatever the name', () => {
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

  test('cwd/additional_dirs/when that resolve against params or step outputs give no issues', () => {
    expect(checkStepReferences(PIPELINE)).toEqual([]);
  });

  test('a {{secrets.X}} in cwd is rejected', () => {
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

  test('a {{secrets.X}} in additional_dirs is rejected', () => {
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

  test('a {{secrets.X}} in when is rejected', () => {
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

  test('a reference to an undeclared param in cwd is reported', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    agent: writer
    prompt: p.md
    cwd: "{{params.not_declared}}"
`);
    const issues = checkStepReferences(p);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('not_declared');
  });

  test('a reference to a nonexistent step in additional_dirs is reported', () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: a
    agent: writer
    prompt: p.md
    additional_dirs: ["{{no-such-step.field}}"]
`);
    const issues = checkStepReferences(p);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('no-such-step');
  });
});

describe('checkStepReferences: the run: of a shell step', () => {
  test('catches a nonexistent param in run:', () => {
    const pipeline = parsePipeline(`
name: demo
description: d
version: 1
params:
  real:
    description: exists
steps:
  - id: one
    type: shell
    run: "echo {{params.does_not_exist}} {{params.real}}"
`);
    const issues = checkStepReferences(pipeline);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('one.run');
    expect(issues[0]).toContain('params.does_not_exist');
  });

  test('catches a reference to an undeclared output in run:', () => {
    const pipeline = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: one
    type: shell
    run: "true"
  - id: two
    type: shell
    run: "echo {{one.head}}"
`);
    const issues = checkStepReferences(pipeline);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('two.run');
    expect(issues[0]).toContain('one.head');
  });

  test('a run: with no references produces nothing', () => {
    const pipeline = parsePipeline(`
name: demo
description: d
version: 1
steps:
  - id: one
    type: shell
    run: "echo hello"
`);
    expect(checkStepReferences(pipeline)).toEqual([]);
  });
});

describe('checkGuardReferences', () => {
  test('catches a nonexistent param in a shell: guard', () => {
    const pipeline = parsePipeline(`
name: demo
description: d
version: 1
when:
  - shell: "test -n {{params.does_not_exist}}"
steps:
  - id: one
    type: shell
    run: "true"
`);
    const issues = checkGuardReferences(pipeline);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('when.0.shell');
    expect(issues[0]).toContain('params.does_not_exist');
  });

  test('catches a nonexistent param in a changed: guard', () => {
    const pipeline = parsePipeline(`
name: demo
description: d
version: 1
when:
  - changed:
      path: "{{params.does_not_exist}}/docs"
steps:
  - id: one
    type: shell
    run: "true"
`);
    const issues = checkGuardReferences(pipeline);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('when.0.changed.path');
  });

  test('a guard cannot reference an output, not even of a step that exists', () => {
    const pipeline = parsePipeline(`
name: demo
description: d
version: 1
when:
  - shell: "test -n {{one.head}}"
steps:
  - id: one
    type: shell
    run: "true"
    outputs:
      head: string
`);
    const issues = checkGuardReferences(pipeline);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('BEFORE');
  });

  test('a guard does not resolve secrets', () => {
    const pipeline = parsePipeline(`
name: demo
description: d
version: 1
requires:
  env: [TOKEN]
when:
  - shell: "test -n {{secrets.TOKEN}}"
steps:
  - id: one
    type: shell
    run: "true"
`);
    const issues = checkGuardReferences(pipeline);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('secrets.TOKEN');
  });

  test('a throttle or between guard has no text to interpolate', () => {
    const pipeline = parsePipeline(`
name: demo
description: d
version: 1
when:
  - throttle: 46h
  - between: "01:00-05:00"
steps:
  - id: one
    type: shell
    run: "true"
`);
    expect(checkGuardReferences(pipeline)).toEqual([]);
  });
});

describe('checkEnvReferences', () => {
  const withEnv = (env: string) =>
    parsePipeline(`
name: demo
description: d
version: 1
params:
  app:
    description: a
requires:
  env: ["${env}"]
steps:
  - id: a
    type: shell
    run: 'true'
`);

  test('a literal name raises no issues', () => {
    expect(checkEnvReferences(withEnv('MY_TOKEN'))).toEqual([]);
  });

  test('a reference to a declared param raises no issues', () => {
    expect(checkEnvReferences(withEnv('QA_{{params.app}}_TOKEN'))).toEqual([]);
  });

  test('a reference to an undeclared param is an issue', () => {
    expect(checkEnvReferences(withEnv('QA_{{params.stage}}_TOKEN'))).toEqual([
      'requires.env.0: references "{{params.stage}}", not declared in params',
    ]);
  });

  test('a reference to secrets is an issue', () => {
    expect(checkEnvReferences(withEnv('QA_{{secrets.OTHER}}'))).toEqual([
      'requires.env.0: references "{{secrets.OTHER}}" — the name of a secret can only depend on params',
    ]);
  });

  test('a reference to an output is an issue', () => {
    expect(checkEnvReferences(withEnv('QA_{{scan.count}}'))).toEqual([
      'requires.env.0: references "scan.count" — the name of a secret is resolved before any step runs, it can only depend on params',
    ]);
  });
});
