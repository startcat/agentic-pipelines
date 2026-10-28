import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

let root: string;
let fakeHome: string;
let launchctlLog: string;
const CLI = join(import.meta.dir, '..', '..', 'src', 'cli', 'index.ts');

function writePipeline(name: string, yaml: string) {
  mkdirSync(join(root, 'pipelines', name), { recursive: true });
  writeFileSync(join(root, 'pipelines', name, 'pipeline.yaml'), yaml);
}

/**
 * Fake `launchctl`: records its arguments in a file and exits 0. The suite
 * NEVER loads a real job into the machine's launchd.
 */
function writeFakeLaunchctl(): string {
  const path = join(fakeHome, 'fake-launchctl');
  writeFileSync(path, `#!/bin/sh\necho "$@" >> ${launchctlLog}\nexit 0\n`);
  chmodSync(path, 0o755);
  return path;
}

/**
 * Fake `launchctl` whose `bootstrap` fails on purpose, with a message on
 * stderr: `stdout`/`stderr` used to be discarded (`stdio: 'ignore'`), so a
 * failed `bootstrap` left no diagnostic. `bootout` (called earlier, inside
 * `install`) still exits 0 as usual.
 */
function writeFailingLaunchctl(stderrMessage: string, exitCode: number): string {
  const path = join(fakeHome, 'fake-launchctl-failing');
  writeFileSync(
    path,
    `#!/bin/sh\necho "$@" >> ${launchctlLog}\n` +
      `if [ "$1" = "bootstrap" ]; then echo "${stderrMessage}" >&2; exit ${exitCode}; fi\n` +
      `exit 0\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

async function cli(
  args: string[],
  opts: { launchctlBin?: string } = {},
): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['bun', CLI, ...args], {
    cwd: root,
    env: {
      ...process.env,
      HOME: fakeHome,
      ANTHROPIC_API_KEY: 'sk-test',
      // These tests are about launchd: on Linux the default scheduler would be systemd.
      PIPELINES_SCHEDULER: 'launchd',
      PIPELINES_LAUNCHCTL_BIN: opts.launchctlBin ?? writeFakeLaunchctl(),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out: stdout + stderr };
}

/** Value of the `EnvironmentVariables/PATH` of an already written plist, for assertions on it. */
function pathFromPlist(xml: string): string {
  const match = /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/.exec(xml);
  if (!match) throw new Error('the plist has no PATH key');
  return match[1]!;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ap-install-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'ap-home-'));
  mkdirSync(join(fakeHome, 'Library', 'LaunchAgents'), { recursive: true });
  mkdirSync(join(fakeHome, 'Library', 'Logs'), { recursive: true });
  launchctlLog = join(fakeHome, 'launchctl.log');
  writeFileSync(join(root, 'pipelines.yaml'), 'channels: {}\n');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

const DEMO = `name: demo
description: d
version: 1
params:
  docs_repo:
    description: path
    required: true
  deploy_url:
    description: optional url
requires:
  bin: [git]
triggers:
  - cron: "0 3 * * *"
steps:
  - id: build
    type: shell
    run: 'true'
  - id: deploy
    type: shell
    when: "{{params.deploy_url}}"
    run: 'true'
`;

describe('pipelines install', () => {
  test('writes the plist and the params, and loads the job', async () => {
    writePipeline('demo', DEMO);
    const { code, out } = await cli(['install', 'demo', '--set', 'docs_repo=/repos/docs']);
    expect(code).toBe(0);

    const plist = await Bun.file(
      join(fakeHome, 'Library', 'LaunchAgents', 'cat.start.pipelines.demo.plist'),
    ).text();
    expect(plist).toContain('<string>cat.start.pipelines.demo</string>');
    expect(plist).toContain('<key>Hour</key>');

    const params = await Bun.file(join(root, '.params.local.json')).json();
    expect(params.demo.docs_repo).toBe('/repos/docs');

    const launchctl = await Bun.file(launchctlLog).text();
    expect(launchctl).toContain('bootstrap');
    expect(out).toContain('cat.start.pipelines.demo');
  });

  // Fixed rule: no param value in the plist. If this breaks, the
  // plist carries live information again and can drift from the repo.
  test('the plist carries no param value', async () => {
    writePipeline('demo', DEMO);
    await cli(['install', 'demo', '--set', 'docs_repo=/repos/docs']);
    const plist = await Bun.file(
      join(fakeHome, 'Library', 'LaunchAgents', 'cat.start.pipelines.demo.plist'),
    ).text();
    expect(plist).not.toContain('/repos/docs');
  });

  test('warns about optional params with no value and about the step that will be skipped', async () => {
    writePipeline('demo', DEMO);
    const { out } = await cli(['install', 'demo', '--set', 'docs_repo=/repos/docs']);
    expect(out).toContain('deploy_url');
    expect(out).toContain('deploy');
  });

  test('fails naming the missing required param, writing nothing', async () => {
    writePipeline('demo', DEMO);
    const { code, out } = await cli(['install', 'demo']);
    expect(code).not.toBe(0);
    expect(out).toContain('docs_repo');
    expect(
      await Bun.file(join(fakeHome, 'Library', 'LaunchAgents', 'cat.start.pipelines.demo.plist')).exists(),
    ).toBe(false);
  });

  test('fails if the pipeline declares no triggers', async () => {
    writePipeline(
      'no-trigger',
      'name: no-trigger\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n',
    );
    const { code, out } = await cli(['install', 'no-trigger']);
    expect(code).not.toBe(0);
    expect(out).toContain('triggers');
  });

  test('preserves the entries of other pipelines in .params.local.json', async () => {
    writePipeline('demo', DEMO);
    writeFileSync(join(root, '.params.local.json'), JSON.stringify({ other: { x: '1' } }));
    await cli(['install', 'demo', '--set', 'docs_repo=/repos/docs']);
    const params = await Bun.file(join(root, '.params.local.json')).json();
    expect(params.other.x).toBe('1');
    expect(params.demo.docs_repo).toBe('/repos/docs');
  });

  test('warns about a foreign job that mentions the same path and does not install without --force', async () => {
    writePipeline('demo', DEMO);
    writeFileSync(
      join(fakeHome, 'Library', 'LaunchAgents', 'com.other.backup.plist'),
      '<plist><dict><string>/repos/docs</string></dict></plist>',
    );
    const { code, out } = await cli(['install', 'demo', '--set', 'docs_repo=/repos/docs']);
    expect(code).not.toBe(0);
    expect(out).toContain('com.other.backup');
    expect(out).toContain('--force');
  });

  test('with --force it installs anyway despite the foreign job', async () => {
    writePipeline('demo', DEMO);
    writeFileSync(
      join(fakeHome, 'Library', 'LaunchAgents', 'com.other.backup.plist'),
      '<plist><dict><string>/repos/docs</string></dict></plist>',
    );
    const { code } = await cli(['install', 'demo', '--set', 'docs_repo=/repos/docs', '--force']);
    expect(code).toBe(0);
  });

  // Replacing a job with the SAME label must still happen without --force,
  // but warning that it is a replacement and not a new install.
  test('the second install warns that it replaces the existing job', async () => {
    writePipeline('demo', DEMO);
    const first = await cli(['install', 'demo', '--set', 'docs_repo=/repos/docs']);
    expect(first.code).toBe(0);
    expect(first.out).not.toContain('replaced');

    const second = await cli(['install', 'demo', '--set', 'docs_repo=/repos/docs']);
    expect(second.code).toBe(0);
    expect(second.out).toContain('replaced');
    expect(second.out).toContain('cat.start.pipelines.demo');
  });

  // A PATH computed only from `requires.bin` may not include `/bin`, and on
  // macOS `sh` lives ONLY there — without it, the installed job would die on
  // the first `shell` step or `shell:` guard. Assertion on the plist ACTUALLY
  // written, not on `computePath` in isolation.
  test('the PATH of the installed plist includes /bin, so it can launch "sh"', async () => {
    writePipeline('demo', DEMO);
    await cli(['install', 'demo', '--set', 'docs_repo=/repos/docs']);
    const plist = await Bun.file(
      join(fakeHome, 'Library', 'LaunchAgents', 'cat.start.pipelines.demo.plist'),
    ).text();
    expect(pathFromPlist(plist).split(':')).toContain('/bin');
  });

  // The only previous "without LANG/LC_ALL" test called `renderPlist` with a
  // spec that never carried them — it could never fail. The real guarantee
  // lives in how `install` builds `environmentVariables` (only PATH and
  // HOME), so the assertion has to go on the plist the command really writes.
  test('the plist actually installed declares neither LANG nor LC_ALL', async () => {
    writePipeline('demo', DEMO);
    await cli(['install', 'demo', '--set', 'docs_repo=/repos/docs']);
    const plist = await Bun.file(
      join(fakeHome, 'Library', 'LaunchAgents', 'cat.start.pipelines.demo.plist'),
    ).text();
    expect(plist).not.toContain('LANG');
    expect(plist).not.toContain('LC_ALL');
  });

  // `computePath` ignored `mcp_servers[].command`, and until now it worked by
  // chance when that command shared a directory with some neighboring
  // `requires.bin`. Here `requires.bin` only declares "git" (which lives in
  // /usr/bin, and is already covered by the system floor), and the MCP server
  // uses "node" (which on this machine lives in a quite different nvm
  // directory) to show that its directory enters the PATH on its own.
  test('the plist PATH includes the directory of an MCP server "command"', async () => {
    const nodeBin = Bun.which('node');
    if (!nodeBin) {
      // Environment with no "node" on the PATH: nothing to show here.
      return;
    }
    const nodeDir = dirname(nodeBin);

    writePipeline(
      'demo-mcp',
      `name: demo-mcp
description: d
version: 1
params: {}
requires:
  bin: [git]
mcp_servers:
  fs:
    command: node
    args: []
triggers:
  - cron: "0 3 * * *"
steps:
  - id: build
    type: shell
    run: 'true'
`,
    );
    const { code } = await cli(['install', 'demo-mcp']);
    expect(code).toBe(0);
    const plist = await Bun.file(
      join(fakeHome, 'Library', 'LaunchAgents', 'cat.start.pipelines.demo-mcp.plist'),
    ).text();
    expect(pathFromPlist(plist).split(':')).toContain(nodeDir);
  });

  // With `--force`, the output used to be indistinguishable from a clean
  // install — neither the red doctor nor the foreign jobs were printed.
  // "--force skips it, WITH A WARNING".
  test('with --force it still warns about the red doctor and the foreign jobs detected', async () => {
    // The red check is of kind "env" (an undefined `requires.env` var), not
    // "bin": a `requires.bin` binary that does not resolve makes
    // `computePath` THROW (it needs that path to build the job's PATH), and
    // that would mask this test's check with a different error instead of the
    // "--force" warning being tested.
    writePipeline(
      'demo-red',
      `name: demo-red
description: d
version: 1
params:
  docs_repo:
    description: path
    required: true
requires:
  bin: [git]
  env: [MISSING_SECRET_XYZ]
triggers:
  - cron: "0 3 * * *"
steps:
  - id: build
    type: shell
    run: 'true'
`,
    );
    writeFileSync(
      join(fakeHome, 'Library', 'LaunchAgents', 'com.other.backup.plist'),
      '<plist><dict><string>/repos/docs</string></dict></plist>',
    );
    const { code, out } = await cli([
      'install',
      'demo-red',
      '--set',
      'docs_repo=/repos/docs',
      '--force',
    ]);
    expect(code).toBe(0);
    expect(out).toContain('MISSING_SECRET_XYZ');
    expect(out).toContain('com.other.backup');
    expect(out).toContain('--force');
  });

  // Without `mkdir(..., { recursive: true })`, a clean machine with no
  // `~/Library/LaunchAgents` yet fails with a raw ENOENT instead of creating
  // the directory.
  test('creates ~/Library/LaunchAgents if it does not exist yet', async () => {
    rmSync(join(fakeHome, 'Library', 'LaunchAgents'), { recursive: true, force: true });
    writePipeline('demo', DEMO);
    const { code } = await cli(['install', 'demo', '--set', 'docs_repo=/repos/docs']);
    expect(code).toBe(0);
    expect(
      await Bun.file(join(fakeHome, 'Library', 'LaunchAgents', 'cat.start.pipelines.demo.plist')).exists(),
    ).toBe(true);
  });

  // `launchctl`'s `stdout`/`stderr` used to be discarded (`stdio: 'ignore'`),
  // so a failed `bootstrap` left no diagnostic — exactly the case where it is
  // most needed.
  test('if "launchctl bootstrap" fails, the output includes its stderr', async () => {
    writePipeline('demo', DEMO);
    const failing = writeFailingLaunchctl('Load failed: 5: Input/output error', 5);
    const { code, out } = await cli(
      ['install', 'demo', '--set', 'docs_repo=/repos/docs'],
      { launchctlBin: failing },
    );
    expect(code).not.toBe(0);
    expect(out).toContain('5');
    expect(out).toContain('Load failed: 5: Input/output error');
  });
});

// `--dry-run` comes from a review: the step that compares the generated
// plist against the one already running is what would have caught the
// PATH-without-`/bin` failure, and it was a checklist entry run by hand once
// — in fact it was not run until the review pointed it out. As a flag, it is
// repeatable.
describe('pipelines install --dry-run', () => {
  test('prints the plist it would write and writes no file', async () => {
    writePipeline('demo', DEMO);
    const { code, out } = await cli(['install', 'demo', '--dry-run', '--set', 'docs_repo=/repos/docs']);
    expect(code).toBe(0);
    expect(out).toContain('<key>Label</key>');
    expect(out).toContain('cat.start.pipelines.demo');
    expect(
      await Bun.file(join(fakeHome, 'Library', 'LaunchAgents', 'cat.start.pipelines.demo.plist')).exists(),
    ).toBe(false);
  });

  // A "dry run" that leaves a persistent effect stops being a dry run.
  test('does not write .params.local.json even when given --set', async () => {
    writePipeline('demo', DEMO);
    await cli(['install', 'demo', '--dry-run', '--set', 'docs_repo=/repos/docs']);
    expect(await Bun.file(join(root, '.params.local.json')).exists()).toBe(false);
  });

  test('does not invoke launchctl', async () => {
    writePipeline('demo', DEMO);
    await cli(['install', 'demo', '--dry-run', '--set', 'docs_repo=/repos/docs']);
    expect(await Bun.file(launchctlLog).exists()).toBe(false);
  });

  test('still fails if a required param is missing, so it is useful in a script', async () => {
    writePipeline('demo', DEMO);
    const { code, out } = await cli(['install', 'demo', '--dry-run']);
    expect(code).not.toBe(0);
    expect(out).toContain('docs_repo');
  });

  test('still warns about optional params with no value', async () => {
    writePipeline('demo', DEMO);
    const { out } = await cli(['install', 'demo', '--dry-run', '--set', 'docs_repo=/repos/docs']);
    expect(out).toContain('deploy_url');
  });
});

describe('pipelines uninstall', () => {
  test('unloads the job and deletes the plist', async () => {
    writePipeline('demo', DEMO);
    await cli(['install', 'demo', '--set', 'docs_repo=/repos/docs']);
    const plistPath = join(fakeHome, 'Library', 'LaunchAgents', 'cat.start.pipelines.demo.plist');
    expect(await Bun.file(plistPath).exists()).toBe(true);

    const { code, out } = await cli(['uninstall', 'demo']);
    expect(code).toBe(0);
    expect(await Bun.file(plistPath).exists()).toBe(false);
    expect(await Bun.file(launchctlLog).text()).toContain('bootout');
    expect(out).toContain('.params.local.json');
  });

  // Idempotent: repeating an uninstall is not an error. An `uninstall` that
  // fails the second time pushes people to check state by hand.
  test('on a pipeline that is not installed it reports and exits 0', async () => {
    writePipeline('demo', DEMO);
    const { code, out } = await cli(['uninstall', 'demo']);
    expect(code).toBe(0);
    expect(out).toContain('is not installed');
  });

  // If the plist is deleted by hand but the job is still loaded, `uninstall`
  // must still unload it — it is not enough to look at whether the file
  // exists and leave. `bootout` must ALWAYS be called.
  test('calls bootout even if the plist was deleted by hand', async () => {
    writePipeline('demo', DEMO);
    await cli(['install', 'demo', '--set', 'docs_repo=/repos/docs']);
    const plistPath = join(fakeHome, 'Library', 'LaunchAgents', 'cat.start.pipelines.demo.plist');
    rmSync(plistPath); // deleted by hand: the job may still be loaded in launchd

    const bootoutsBefore = (await Bun.file(launchctlLog).text())
      .split('\n')
      .filter((line) => line.startsWith('bootout')).length;

    const { code, out } = await cli(['uninstall', 'demo']);
    expect(code).toBe(0);
    expect(out).toContain('is not installed');

    const bootoutsAfter = (await Bun.file(launchctlLog).text())
      .split('\n')
      .filter((line) => line.startsWith('bootout')).length;
    expect(bootoutsAfter).toBeGreaterThan(bootoutsBefore);
  });
});
