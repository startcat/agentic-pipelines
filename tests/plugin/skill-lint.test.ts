import { describe, expect, test } from 'bun:test';
import { buildProgram } from '../../src/cli/program.ts';
import { citationProblems, citedCommands, cliSurface, frontmatter, sharedSection, yamlBlocks } from './skill-lint.ts';

const pick = (markdown: string) => citedCommands(markdown).map(({ command, flags }) => ({ command, flags }));

describe('citedCommands', () => {
  test('a command in an inline code span', () => {
    expect(pick('Run `pipelines status --json` first.')).toEqual([{ command: 'status', flags: ['--json'] }]);
  });

  test('global flags before the command, and flag values, are skipped over', () => {
    expect(pick('`pipelines --repo ~/r install x --set k=v --dry-run`')).toEqual([
      { command: 'install', flags: ['--repo', '--set', '--dry-run'] },
    ]);
  });

  test('a shell line in a bash block', () => {
    expect(pick('Then:\n\n```bash\n$ pipelines run demo\n```\n')).toEqual([{ command: 'run', flags: [] }]);
  });

  test('a flag written with its value after an equals sign', () => {
    expect(pick('`pipelines status --limit=3`')).toEqual([{ command: 'status', flags: ['--limit'] }]);
  });

  test('several commands on one line, joined by shell operators', () => {
    expect(pick('```sh\npipelines validate x && pipelines doctor x | tail\n```')).toEqual([
      { command: 'validate', flags: [] },
      { command: 'doctor', flags: [] },
    ]);
  });

  test('names that only start with the word are not commands', () => {
    expect(pick('`pipelines-starter`, `pipelines/<name>/pipeline.yaml`, `pipelines-status`, `pipelines.yaml`')).toEqual([]);
  });

  test('the bare word and a lookup of the binary are not commands', () => {
    expect(pick('`pipelines` and `command -v pipelines`')).toEqual([]);
  });

  test('yaml blocks are not read for commands', () => {
    expect(pick('```yaml\nrun: pipelines status --nope\n```')).toEqual([]);
  });

  test('keeps the text it came from', () => {
    expect(citedCommands('`pipelines show demo 1`')[0]?.text).toBe('pipelines show demo 1');
  });
});

describe('citationProblems against the real CLI', () => {
  const surface = cliSurface(buildProgram());
  const problems = (markdown: string) => citationProblems(citedCommands(markdown), surface);

  test('an unknown command is a problem', () => {
    expect(problems('`pipelines nope`')).toHaveLength(1);
  });

  test('an unknown flag is a problem', () => {
    expect(problems('`pipelines status --yes`')).toHaveLength(1);
  });

  test('real commands and flags are fine', () => {
    expect(problems('`pipelines install x --set k=v` and `pipelines validate --file d.yaml`')).toEqual([]);
  });

  test('the global flags and help work with any command', () => {
    expect(problems('`pipelines --repo ~/r status --json` `pipelines run -h` `pipelines show --help`')).toEqual([]);
  });
});

describe('yamlBlocks', () => {
  test('returns only the yaml blocks', () => {
    expect(yamlBlocks('```yaml\na: 1\n```\n```bash\nb\n```\n```yml\nc: 2\n```\n')).toEqual(['a: 1\n', 'c: 2\n']);
  });
});

describe('frontmatter', () => {
  test('parses the leading yaml block', () => {
    expect(frontmatter('---\nname: x\ndescription: Use when y\n---\n# Body\n')).toEqual({
      name: 'x',
      description: 'Use when y',
    });
  });

  test('is empty without one', () => {
    expect(frontmatter('# No frontmatter\n')).toEqual({});
  });
});

describe('sharedSection', () => {
  test('returns the text between the markers', () => {
    expect(sharedSection('a\n<!-- shared:locate -->\nbody\n<!-- /shared:locate -->\nb', 'locate')).toBe('\nbody\n');
  });

  test('is undefined without them', () => {
    expect(sharedSection('a\nbody\n', 'locate')).toBeUndefined();
  });
});
