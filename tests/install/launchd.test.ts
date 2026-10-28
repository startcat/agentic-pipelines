import { describe, expect, test } from 'bun:test';
import {
  computePath,
  stableBunPath,
  cronToCalendarIntervals,
  foreignJobsMentioning,
  jobsNamedAfter,
  labelFor,
  stripGeneratedAt,
  unresolvedInPath,
} from '../../src/install/common.ts';
import { buildPlistSpec, logPathFor, parseDisabledLabels, renderPlist } from '../../src/install/launchd.ts';

describe('cronToCalendarIntervals', () => {
  test('a fixed time omits the asterisk fields', () => {
    expect(cronToCalendarIntervals('0 3 * * *')).toEqual([{ Minute: 0, Hour: 3 }]);
  });

  test('a list expands to one schedule per value', () => {
    expect(cronToCalendarIntervals('0 3,15 * * *')).toEqual([
      { Minute: 0, Hour: 3 },
      { Minute: 0, Hour: 15 },
    ]);
  });

  test('lists in two fields expand to the product of both', () => {
    expect(cronToCalendarIntervals('0,30 3 * * *')).toEqual([
      { Minute: 0, Hour: 3 },
      { Minute: 30, Hour: 3 },
    ]);
  });

  test('Sunday 7 in cron is normalized to 0 in launchd', () => {
    expect(cronToCalendarIntervals('0 3 * * 7')).toEqual([{ Minute: 0, Hour: 3, Weekday: 0 }]);
  });

  test('five asterisks is "every minute": no field, a single schedule', () => {
    expect(cronToCalendarIntervals('* * * * *')).toEqual([{}]);
  });

  // The error has to name the alternative, not just say it can't be done: it is
  // the difference between the operator writing a list and going off to write
  // the plist by hand, which is what this command exists to avoid.
  test('a step is rejected naming the alternative', () => {
    expect(() => cronToCalendarIntervals('*/15 * * * *')).toThrow(/comma-separated list/);
  });

  test('a range is rejected naming the alternative', () => {
    expect(() => cronToCalendarIntervals('0 9-17 * * *')).toThrow(/comma-separated list/);
  });

  test('a number of fields other than 5 is rejected saying how many there are', () => {
    expect(() => cronToCalendarIntervals('0 3 * *')).toThrow(/5 fields/);
  });

  test('an out-of-range value is rejected naming the field', () => {
    expect(() => cronToCalendarIntervals('0 25 * * *')).toThrow(/Hour/);
  });

  test('an expansion above the cap is rejected', () => {
    expect(() => cronToCalendarIntervals('0,1,2,3,4,5 0,1,2,3,4 * * *')).toThrow(/24/);
  });
});

describe('labelFor', () => {
  test('the label is deterministic from the pipeline name', () => {
    expect(labelFor('docs-review')).toBe('cat.start.pipelines.docs-review');
  });
});

describe('computePath', () => {
  const which = (name: string): string | null =>
    ({
      git: '/usr/bin/git',
      jq: '/opt/homebrew/bin/jq',
      yarn: '/Users/x/.nvm/versions/node/v22/bin/yarn',
    })[name] ?? null;

  test('includes the directory of each declared binary', () => {
    const path = computePath(['git', 'jq'], which);
    expect(path.split(':')).toEqual(['/usr/bin', '/opt/homebrew/bin', '/bin', '/usr/sbin', '/sbin']);
  });

  test('extra directories go first and are not duplicated', () => {
    const path = computePath(['git'], which, ['/Users/x/.bun/bin', '/usr/bin']);
    expect(path.split(':')).toEqual(['/Users/x/.bun/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']);
  });

  // The incident of 2026-08-29: the hand-written plist did not carry the
  // directory of one of the declared binaries. Computing it makes that impossible.
  test('a binary that does not resolve fails naming it, instead of generating an incomplete PATH', () => {
    expect(() => computePath(['git', 'missing'], which)).toThrow(/missing/);
  });

  // A PATH computed only from `requires.bin` may not include `/bin`, and on
  // macOS `sh` ONLY lives there. `runner/shell.ts` and `guards/evaluate.ts`
  // launch `sh -c` with this PATH for any `shell` step or `shell:` guard:
  // without `/bin`, the installed job would die at the first step
  // ("Executable not found in $PATH: sh", verified live).
  test('the generated PATH always includes the floor of system directories, with /bin', () => {
    const path = computePath(['git'], which);
    expect(path.split(':')).toContain('/bin');
    expect(path.split(':')).toContain('/usr/bin');
    expect(path.split(':')).toContain('/usr/sbin');
    expect(path.split(':')).toContain('/sbin');
  });

  test('the system floor is not duplicated if a binary already lives in one of those directories', () => {
    // "git" resolves to /usr/bin/git, which is already part of the floor.
    const path = computePath(['git'], which);
    expect(path.split(':').filter((dir) => dir === '/usr/bin')).toHaveLength(1);
  });
});

describe('unresolvedInPath', () => {
  // Reproduces the incident: a PATH that does not include /bin cannot resolve
  // "sh", even if all the declared `requires.bin` do resolve.
  test('detects that "sh" does not resolve if the PATH lacks /bin', () => {
    const which = (name: string, path?: string): string | null => {
      if (path !== '/usr/bin:/opt/homebrew/bin') return null;
      return name === 'git' ? '/usr/bin/git' : null;
    };
    expect(unresolvedInPath('/usr/bin:/opt/homebrew/bin', ['git'], which, 'sh')).toEqual(['sh']);
  });

  // With the system floor in place (the computePath fix), "sh" resolves
  // too, so the belt finds nothing to object to.
  test('with the already computed PATH (floor in place) everything resolves, including "sh"', () => {
    const which = (name: string, path?: string): string | null => {
      if (path !== '/usr/bin:/opt/homebrew/bin:/bin') return null;
      return { git: '/usr/bin/git', sh: '/bin/sh' }[name] ?? null;
    };
    expect(unresolvedInPath('/usr/bin:/opt/homebrew/bin:/bin', ['git'], which, 'sh')).toEqual([]);
  });

  test('also names a declared binary that does not resolve, not just "sh"', () => {
    const which = (name: string): string | null => (name === 'sh' ? '/bin/sh' : null);
    expect(unresolvedInPath('/bin', ['missing'], which, 'sh')).toEqual(['missing']);
  });

  // Belt and braces, not just the floor: it checks against the PATH it is given,
  // NEVER against the one the calling process would have — hence `which`
  // receives the PATH as its second argument instead of looking at
  // `process.env.PATH`.
  test('passes the computed PATH to the which function, not the calling process PATH', () => {
    const seen: (string | undefined)[] = [];
    const which = (name: string, path?: string): string | null => {
      seen.push(path);
      return name === 'sh' ? '/bin/sh' : null;
    };
    unresolvedInPath('/a/computed', [], which);
    expect(seen).toEqual(['/a/computed']);
  });
});

describe('renderPlist', () => {
  const spec = {
    label: 'cat.start.pipelines.demo',
    programArguments: ['/bun', '/cli.ts', '--repo', '/repo', 'run', 'demo'],
    environmentVariables: { PATH: '/usr/bin', HOME: '/Users/x' },
    calendarIntervals: [{ Minute: 0, Hour: 3 }],
    logPath: '/Users/x/Library/Logs/pipelines-demo.log',
    sourcePipelineYaml: '/repo/pipelines/demo/pipeline.yaml',
    generatedAt: '2026-08-29T10:00:00.000Z',
    runAtLoad: false,
  };

  test('carries the label, the arguments and the schedule', () => {
    const xml = renderPlist(spec);
    expect(xml).toContain('<string>cat.start.pipelines.demo</string>');
    expect(xml).toContain('<string>--repo</string>');
    expect(xml).toContain('<key>Hour</key>');
    expect(xml).toContain('<integer>3</integer>');
  });

  test('RunAtLoad is true when the spec asks for it', () => {
    expect(renderPlist({ ...spec, runAtLoad: true })).toContain(
      '<key>RunAtLoad</key>\n\t<true/>',
    );
  });

  test('RunAtLoad is false when the spec does not ask for it', () => {
    expect(renderPlist({ ...spec, runAtLoad: false })).toContain(
      '<key>RunAtLoad</key>\n\t<false/>',
    );
  });

  test('the header says where it comes from and not to edit it by hand', () => {
    const xml = renderPlist(spec);
    expect(xml).toContain('/repo/pipelines/demo/pipeline.yaml');
    expect(xml).toContain('DO NOT EDIT BY HAND');
  });

  // Fixed rule: the engine sets the locale on its own. Declaring it here
  // would reopen the door that fix closed.
  test('does not declare LANG or LC_ALL', () => {
    const xml = renderPlist(spec);
    expect(xml).not.toContain('LANG');
    expect(xml).not.toContain('LC_ALL');
  });

  test('escapes the characters that would break the XML', () => {
    const xml = renderPlist({ ...spec, programArguments: ['a&b', 'c<d'] });
    expect(xml).toContain('<string>a&amp;b</string>');
    expect(xml).toContain('<string>c&lt;d</string>');
  });
});

describe('foreignJobsMentioning', () => {
  const agents = [
    { label: 'cat.start.pipelines.demo', contents: '<string>/repos/docs</string>' },
    { label: 'com.other.backup', contents: '<string>/repos/docs</string>' },
    { label: 'com.other.unrelated', contents: '<string>/other/thing</string>' },
  ];

  test('finds a foreign job that mentions a path of the pipeline', () => {
    expect(foreignJobsMentioning(['/repos/docs'], agents, 'cat.start.pipelines.demo')).toEqual([
      'com.other.backup',
    ]);
  });

  // The job's own entry is not a collision: same label means replacement
  // (adoption), which is exactly what `install` must do with it.
  test('the own job never counts as a collision', () => {
    const hits = foreignJobsMentioning(['/repos/docs'], agents, 'cat.start.pipelines.demo');
    expect(hits).not.toContain('cat.start.pipelines.demo');
  });

  test('with no matches returns an empty list', () => {
    expect(foreignJobsMentioning(['/nothing'], agents, 'cat.start.pipelines.demo')).toEqual([]);
  });
});

describe('parseDisabledLabels', () => {
  test('returns only the disabled ones', () => {
    const out = [
      'disabled services = {',
      '\t"com.example.old" => disabled',
      '\t"cat.start.pipelines.demo" => enabled',
      '}',
    ].join('\n');
    expect(parseDisabledLabels(out)).toEqual(['com.example.old']);
  });

  test('an empty output is not an error, it is an empty list', () => {
    expect(parseDisabledLabels('')).toEqual([]);
  });
});

describe('stripGeneratedAt', () => {
  // Without this, `drifted` would be a permanent false positive: the plist on
  // disk and the freshly generated one ALWAYS differ in the timestamp.
  test('two plists equal except for the timestamp end up identical', () => {
    const a = 'x\n  Generado:  2026-08-29T10:00:00.000Z\ny';
    const b = 'x\n  Generado:  2026-08-30T03:00:00.000Z\ny';
    expect(stripGeneratedAt(a)).toBe(stripGeneratedAt(b));
  });

  test('a real difference survives', () => {
    const a = 'Generado:  2026-08-29T10:00:00.000Z\n<string>0 3 * * *</string>';
    const b = 'Generado:  2026-08-29T10:00:00.000Z\n<string>0 5 * * *</string>';
    expect(stripGeneratedAt(a)).not.toBe(stripGeneratedAt(b));
  });

  // Files written before the translation carry a Spanish header and
  // "(horario)" in the timer description: they must not read as drifted.
  test('a plist written with the Spanish header equals one rendered now', () => {
    const spec = {
      label: 'cat.start.pipelines.demo',
      programArguments: ['/bun', '/cli.ts'],
      environmentVariables: { PATH: '/usr/bin', HOME: '/Users/x' },
      calendarIntervals: [{ Minute: 0, Hour: 3 }],
      logPath: '/Users/x/Library/Logs/pipelines-demo.log',
      sourcePipelineYaml: '/repo/pipelines/demo/pipeline.yaml',
      generatedAt: '2026-08-29T10:00:00.000Z',
      runAtLoad: false,
    };
    const fresh = renderPlist(spec);
    const legacy = fresh.replace(/<!--[\s\S]*?-->/, [
      '<!--',
      '  GENERADO POR `pipelines install` — NO EDITAR A MANO.',
      '  Origen:    /repo/pipelines/demo/pipeline.yaml',
      '  Generado:  2026-08-01T00:00:00.000Z',
      '-->',
    ].join('\n'));
    expect(legacy).not.toBe(fresh);
    expect(stripGeneratedAt(legacy)).toBe(stripGeneratedAt(fresh));
  });

  test('a systemd unit written with the Spanish header equals one rendered now', () => {
    const fresh =
      '# Generated by `pipelines install` from /r/pipeline.yaml\n# Generated: 2026-10-27T10:00:00Z\n' +
      '# Do not edit by hand: it is regenerated with `pipelines install demo`.\n\n[Unit]\nDescription=agentic-pipelines: demo (schedule)\n';
    const legacy =
      '# Generado por `pipelines install` desde /r/pipeline.yaml\n# Generado: 2026-08-01T00:00:00Z\n' +
      '# No editar a mano: se regenera con `pipelines install demo`.\n\n[Unit]\nDescription=agentic-pipelines: demo (horario)\n';
    expect(stripGeneratedAt(legacy)).toBe(stripGeneratedAt(fresh));
  });
});

describe('buildPlistSpec', () => {
  const input = {
    pipelineName: 'demo',
    repoRoot: '/repo',
    bunPath: '/opt/bun/bin/bun',
    cliEntry: '/engine/src/cli/index.ts',
    home: '/home/user',
    path: '/opt/bun/bin:/usr/bin:/bin',
    calendarIntervals: [{ Minute: 0, Hour: 3 }],
    generatedAt: '2026-08-29T10:00:00.000Z',
    guards: [],
  };

  test('the arguments are bun run <cli> --repo <root> run <name>', () => {
    expect(buildPlistSpec(input).programArguments).toEqual([
      '/opt/bun/bin/bun', 'run', '/engine/src/cli/index.ts',
      '--repo', '/repo', 'run', 'demo',
    ]);
  });

  // The plist is a derived, dumb artifact. A parameter here would reopen the
  // YAML/plist drift that `install` exists to close.
  test('carries no pipeline parameter', () => {
    expect(buildPlistSpec(input).programArguments).not.toContain('--set');
  });

  test('declares only PATH and HOME — LANG/LC_ALL are set by the engine', () => {
    expect(buildPlistSpec(input).environmentVariables).toEqual({
      PATH: '/opt/bun/bin:/usr/bin:/bin',
      HOME: '/home/user',
    });
  });

  test('the source points to the pipeline.yaml of the data repo', () => {
    expect(buildPlistSpec(input).sourcePipelineYaml).toBe('/repo/pipelines/demo/pipeline.yaml');
  });

  // A weekly report once failed to fire: the machine rebooted at 06:31, the
  // gui/$UID domain was not loaded until login, and launchd does NOT repeat
  // the StartCalendarInterval entries that fall while the domain is not
  // loaded. `RunAtLoad` recovers that lost trigger — but it is only safe if a
  // `throttle` guard can skip it when the window has not expired, so it is
  // granted EXACTLY to the pipelines that declare one.
  test('without guards there is no RunAtLoad: it would run on every login', () => {
    expect(buildPlistSpec(input).runAtLoad).toBe(false);
  });

  test('a throttle guard grants RunAtLoad', () => {
    expect(buildPlistSpec({ ...input, guards: [{ throttle: '46h' }] }).runAtLoad).toBe(true);
  });

  // The long form is the same guard. A skipped run does not count as an
  // attempt (RunStore.lastAttempt), so even with `last_attempt` a skipped
  // login trigger does not push the window's anchor.
  test('the long form of throttle grants it too', () => {
    const guards = [{ throttle: { every: '46h', since: 'last_attempt' as const } }];
    expect(buildPlistSpec({ ...input, guards }).runAtLoad).toBe(true);
  });

  test('a guard that is not throttle does not grant it', () => {
    const guards = [{ shell: 'test -f /tmp/x' }];
    expect(buildPlistSpec({ ...input, guards }).runAtLoad).toBe(false);
  });
});

describe('logPathFor', () => {
  test('the log lives in Library/Logs with the pipeline name', () => {
    expect(logPathFor('/home/user', 'demo')).toBe('/home/user/Library/Logs/pipelines-demo.log');
  });
});

// The handover of a real pipeline went by without the engine saying anything:
// `foreignJobsMentioning` compares PATHS, and since each pipeline has its own
// workspace there is none in common with the bash script it takes over from.
// The collision of a migration is SEMANTIC —same work, same email, same
// people— and a different net is needed to see it.
describe('jobsNamedAfter', () => {
  const agents = [
    { label: 'com.example.nightly-checks', contents: '' },
    { label: 'cat.start.pipelines.nightly-checks', contents: '' },
    { label: 'com.example.legacy-nightly', contents: '' },
  ];

  test('finds the bash predecessor with another prefix', () => {
    expect(jobsNamedAfter('nightly-checks', agents, 'cat.start.pipelines.nightly-checks', []))
      .toEqual(['com.example.nightly-checks']);
  });

  // The predecessor's plist is deliberately left ON DISK, as a way back, and
  // `readLaunchAgents` reads files, not loaded jobs. Without this exclusion
  // the warning would fire on every reinstall after the handover, forever —
  // the noise that teaches people to ignore warnings. A disabled job cannot
  // run, so it duplicates nothing.
  test('stays quiet about an already disabled predecessor, which is a well-done handover', () => {
    expect(jobsNamedAfter('nightly-checks', agents, 'cat.start.pipelines.nightly-checks',
      ['com.example.nightly-checks'])).toEqual([]);
  });

  test('does not flag itself', () => {
    expect(jobsNamedAfter('nightly-checks', agents, 'cat.start.pipelines.nightly-checks', []))
      .not.toContain('cat.start.pipelines.nightly-checks');
  });

  test('ignores jobs that do not carry that name', () => {
    expect(jobsNamedAfter('nightly-checks', agents, 'cat.start.pipelines.nightly-checks', []))
      .not.toContain('com.example.legacy-nightly');
  });

  // A bare `endsWith` would match `com.example.other-nightly-checks`, which is
  // a DIFFERENT job with a name that ends the same way. The boundary has to be
  // a dot of the label, which is how launchd separates its segments.
  test('requires the name to start at a label boundary', () => {
    const trap = [{ label: 'com.example.other-nightly-checks', contents: '' }];
    expect(jobsNamedAfter('nightly-checks', trap, 'x', [])).toEqual([]);
  });

  test('with no same-named job it reports nothing', () => {
    expect(jobsNamedAfter('weekly-report', agents, 'x', [])).toEqual([]);
  });
});

// With Homebrew, process.execPath is the versioned folder, which disappears
// on the next `brew upgrade`: the plist must carry the stable link.
describe('stableBunPath', () => {
  const real = '/usr/local/Cellar/bun/1.4.2/bin/bun';
  const realpath = (p: string) => (p === '/usr/local/bin/bun' ? real : p);

  test('uses the bun from the PATH if it points to the same binary', () => {
    expect(stableBunPath(real, '/usr/local/bin/bun', realpath)).toBe('/usr/local/bin/bun');
  });
  test('keeps the real one if the one on the PATH is another bun', () => {
    expect(stableBunPath(real, '/opt/other/bun', realpath)).toBe(real);
  });
  test('keeps the real one if there is no bun on the PATH or it cannot be resolved', () => {
    expect(stableBunPath(real, null, realpath)).toBe(real);
    expect(stableBunPath(real, '/broken/bun', () => { throw new Error('ENOENT'); })).toBe(real);
  });
});
