import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { parsePipeline } from '../../src/schema/pipeline.ts';
import { hasBlockingFailures, listMcpToolsViaStdio, preflight, type PreflightReport } from '../../src/preflight/check.ts';

let repoRoot: string;
let claudeDir: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'ap-repo-'));
  claudeDir = mkdtempSync(join(tmpdir(), 'ap-claude-'));
  mkdirSync(join(repoRoot, 'agents'), { recursive: true });
});
afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(claudeDir, { recursive: true, force: true });
});

const PIPELINE = parsePipeline(`
name: demo
description: d
version: 1
requires:
  agents: [local-writer, user-writer]
  skills: [docs:update]
  bin: [git]
  env: [MY_TOKEN]
  net: [example.com]
steps:
  - id: a
    type: shell
    run: 'true'
`);

// Same as PIPELINE but with an `agent` step: only these pipelines require
// Claude credentials.
const AGENT_PIPELINE = parsePipeline(`
name: demo
description: d
version: 1
requires:
  agents: [local-writer, user-writer]
  env: [MY_TOKEN]
steps:
  - id: a
    agent: local-writer
    prompt: a.md
`);

const okProbes = {
  hasBinary: async () => true,
  resolvesHost: async () => true,
  listUserAgents: async () => ['user-writer'],
  listUserSkills: async () => ['docs:update'],
  // Explicit, not by default: without this the real probe would query the
  // keychain of the machine running the tests and the "no credentials" case
  // would pass or fail depending on who runs them.
  hasKeychainSession: async () => false,
};

describe('preflight', () => {
  test('everything OK when each dependency is present', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# writer');
    const report = await preflight(PIPELINE, {
      repoRoot,
      userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x' },
      dotEnv: { MY_TOKEN: 'valid-secret' },
      probes: okProbes,
    });
    expect(report.ok).toBe(true);
    expect(report.checks.every((c) => c.ok)).toBe(true);
  });

  test('finds an agent in the repo agents/ before the user ones', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# writer');
    const report = await preflight(PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x' },
      dotEnv: { MY_TOKEN: 's' }, probes: okProbes,
    });
    const check = report.checks.find((c) => c.kind === 'agent' && c.name === 'local-writer');
    expect(check!.ok).toBe(true);
    expect(check!.detail).toContain('repo');
  });

  test('fails naming the agent it cannot find', async () => {
    const report = await preflight(PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x' },
      dotEnv: { MY_TOKEN: 's' }, probes: okProbes,
    });
    expect(report.ok).toBe(false);
    const check = report.checks.find((c) => c.kind === 'agent' && c.name === 'local-writer');
    expect(check!.ok).toBe(false);
  });

  test('fails if a declared environment variable is missing', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# w');
    const report = await preflight(PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x' },
      dotEnv: {}, probes: okProbes,
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.kind === 'env')!.ok).toBe(false);
  });

  test('accepts a variable present in the process environment even if it is not in .env', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# w');
    const report = await preflight(PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x', MY_TOKEN: 'from-the-env' },
      dotEnv: {}, probes: okProbes,
    });
    expect(report.checks.find((c) => c.kind === 'env')!.ok).toBe(true);
  });

  test('fails if a declared environment variable is empty', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# w');
    const report = await preflight(PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x' },
      dotEnv: { MY_TOKEN: '' }, probes: okProbes,
    });
    const check = report.checks.find((c) => c.kind === 'env')!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('short');
  });

  test('fails if a declared environment variable is only spaces', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# w');
    const report = await preflight(PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x' },
      dotEnv: { MY_TOKEN: '        ' }, probes: okProbes,
    });
    const check = report.checks.find((c) => c.kind === 'env')!;
    expect(check.ok).toBe(false);
  });

  test('fails if a declared environment variable is shorter than the minimum', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# w');
    const report = await preflight(PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x' },
      dotEnv: { MY_TOKEN: 'short12' }, probes: okProbes, // 7 characters
    });
    const check = report.checks.find((c) => c.kind === 'env')!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('short');
  });

  test('accepts an environment variable that meets exactly the minimum', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# w');
    const report = await preflight(PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x' },
      dotEnv: { MY_TOKEN: 'exact123' }, probes: okProbes, // 8 characters
    });
    const check = report.checks.find((c) => c.kind === 'env')!;
    expect(check.ok).toBe(true);
  });

  test('never exposes a secret value in the report', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# w');
    const report = await preflight(PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x' },
      dotEnv: { MY_TOKEN: 'very-secret-value' }, probes: okProbes,
    });
    expect(JSON.stringify(report)).not.toContain('very-secret-value');
  });

  test('fails if there are no Claude credentials in the environment', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# w');
    const report = await preflight(AGENT_PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: {}, dotEnv: { MY_TOKEN: 's' }, probes: okProbes,
    });
    expect(report.ok).toBe(false);
    const auth = report.checks.find((c) => c.kind === 'auth');
    expect(auth!.ok).toBe(false);
  });

  // Claude Code stores the credential in the macOS keychain, not in a file:
  // `~/.claude/.credentials.json` disappeared from this machine on 2026-08-29
  // and the check stopped seeing a session that WAS signed in, blocking any
  // `run` with agent steps.
  test('accepts a credential stored in the keychain, with no file or API key', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# w');
    const report = await preflight(AGENT_PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: {}, dotEnv: { MY_TOKEN: 's' },
      probes: { ...okProbes, hasKeychainSession: async () => true },
    });
    const auth = report.checks.find((c) => c.kind === 'auth');
    expect(auth!.ok).toBe(true);
    expect(auth!.detail).toContain('keychain');
  });

  test('accepts a Claude Code session as a valid credential', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# w');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, '.credentials.json'), '{}');
    const report = await preflight(AGENT_PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: {}, dotEnv: { MY_TOKEN: 's' }, probes: okProbes,
    });
    expect(report.checks.find((c) => c.kind === 'auth')!.ok).toBe(true);
  });

  // A session file whose refresh token has expired is not a credential: the
  // agent step fails with "OAuth session expired and could not be refreshed".
  // Seen on a Linux server, where `doctor` said "All set" and the run failed.
  test('rejects a Claude Code session that can no longer be refreshed', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# w');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { expiresAt: 0, refreshTokenExpiresAt: Date.parse('2026-10-24T12:00:00Z') } }),
    );
    const report = await preflight(AGENT_PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: {}, dotEnv: { MY_TOKEN: 's' }, probes: okProbes,
      now: new Date('2026-10-28T12:00:00Z'),
    });
    const auth = report.checks.find((c) => c.kind === 'auth');
    expect(auth!.ok).toBe(false);
    expect(auth!.detail).toBe(
      "Claude Code session expired on 2026-10-24: put ANTHROPIC_API_KEY in the data repo's .env, or sign in again with `claude`",
    );
  });

  test('accepts a Claude Code session whose access token expired but can still be refreshed', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# w');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { expiresAt: 0, refreshTokenExpiresAt: Date.parse('2026-11-30T12:00:00Z') } }),
    );
    const report = await preflight(AGENT_PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: {}, dotEnv: { MY_TOKEN: 's' }, probes: okProbes,
      now: new Date('2026-10-28T12:00:00Z'),
    });
    expect(report.checks.find((c) => c.kind === 'auth')!.ok).toBe(true);
  });

  // The documented route: an API key in the data repo's `.env`, which is the
  // only thing that reaches a run launched by launchd.
  test('accepts ANTHROPIC_API_KEY in the .env of the data repo', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# w');
    const report = await preflight(AGENT_PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: {}, dotEnv: { MY_TOKEN: 's', ANTHROPIC_API_KEY: 'sk-from-env' }, probes: okProbes,
    });
    const auth = report.checks.find((c) => c.kind === 'auth');
    expect(auth!.ok).toBe(true);
    expect(auth!.detail).toContain('.env');
  });

  test('a pipeline without agent steps does not require Claude credentials', async () => {
    const report = await preflight(PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: {}, dotEnv: { MY_TOKEN: 's' }, probes: okProbes,
    });
    expect(report.checks.find((c) => c.kind === 'auth')).toBeUndefined();
  });

  test('fails if a declared binary is not on the PATH', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# w');
    const report = await preflight(PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x' }, dotEnv: { MY_TOKEN: 's' },
      probes: { ...okProbes, hasBinary: async () => false },
    });
    expect(report.checks.find((c) => c.kind === 'bin')!.ok).toBe(false);
  });

  test('fails if a declared host does not resolve', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# w');
    const report = await preflight(PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x' }, dotEnv: { MY_TOKEN: 's' },
      probes: { ...okProbes, resolvesHost: async () => false },
    });
    expect(report.checks.find((c) => c.kind === 'net')!.ok).toBe(false);
  });

  test('finds a skill by its unqualified name when the probe only returns the final part', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# w');
    const report = await preflight(PIPELINE, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x' }, dotEnv: { MY_TOKEN: 's' },
      // The probe only returns the part after the colon, not the whole
      // 'docs:update': it must fall into the fallback branch.
      probes: { ...okProbes, listUserSkills: async () => ['update'] },
    });
    const check = report.checks.find((c) => c.kind === 'skill');
    expect(check!.ok).toBe(true);
    expect(check!.detail).toBe('available');
  });

  test('uses the default probes to list user agents and skills when none is injected', async () => {
    mkdirSync(join(claudeDir, 'agents'), { recursive: true });
    writeFileSync(join(claudeDir, 'agents', 'user-writer.md'), '# writer');
    mkdirSync(join(claudeDir, 'skills', 'docs-update'), { recursive: true });
    const pipeline = parsePipeline(`
name: demo-default-probes
description: d
version: 1
requires:
  agents: [user-writer]
  skills: [docs-update]
steps:
  - id: a
    type: shell
    run: 'true'
`);
    const report = await preflight(pipeline, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x' }, dotEnv: {},
      // Without `probes`: the real defaultProbes are exercised (listUserAgents /
      // listUserSkills). This pipeline declares no `bin` or `net`, so as not
      // to invoke Bun.which or real DNS in this case.
    });
    expect(report.checks.find((c) => c.kind === 'agent')!.ok).toBe(true);
    expect(report.checks.find((c) => c.kind === 'skill')!.ok).toBe(true);
  });

  test('the default probes do not blow up when agents/ or skills/ do not exist in the user directory', async () => {
    const pipeline = parsePipeline(`
name: demo-missing-dirs
description: d
version: 1
requires:
  agents: [ghost-agent]
  skills: [ghost-skill]
steps:
  - id: a
    type: shell
    run: 'true'
`);
    // claudeDir is a directory freshly created by mkdtempSync: it has no
    // agents/ or skills/ subdirectories. The default probes must return empty
    // lists (not throw) and the preflight must fail naming both dependencies,
    // not blow up.
    const report = await preflight(pipeline, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x' }, dotEnv: {},
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.kind === 'agent')!.ok).toBe(false);
    expect(report.checks.find((c) => c.kind === 'skill')!.ok).toBe(false);
  });

  test('the default binary probe uses Bun.which: it finds the binary running the test and fails with a missing one', async () => {
    // The binary that surely exists and is on the PATH in any environment
    // where these tests run is the very runtime executing them (the project
    // requires Bun >= 1.3.0 for tests). That avoids assuming a specific
    // binary of one platform (e.g. 'git' or 'sh').
    const currentBinary = basename(process.execPath);
    const pipeline = parsePipeline(`
name: demo-bun-which
description: d
version: 1
requires:
  bin: [${currentBinary}, zzz-missing-bin-xyz]
steps:
  - id: a
    type: shell
    run: 'true'
`);
    const report = await preflight(pipeline, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x' }, dotEnv: {},
    });
    const bins = report.checks.filter((c) => c.kind === 'bin');
    expect(bins.find((c) => c.name === currentBinary)!.ok).toBe(true);
    expect(bins.find((c) => c.name === 'zzz-missing-bin-xyz')!.ok).toBe(false);
  });

  test('checks the command of each declared MCP server, naming the server', async () => {
    writeFileSync(join(repoRoot, 'agents', 'local-writer.md'), '# w');
    const pipeline = parsePipeline(`
name: demo-mcp
description: d
version: 1
requires:
  agents: [local-writer, user-writer]
  skills: [docs:update]
  bin: [git]
  env: [MY_TOKEN]
  net: [example.com]
mcp_servers:
  playwright:
    command: npx
  broken:
    command: zzz-missing-mcp-xyz
steps:
  - id: a
    agent: writer
    prompt: p.md
    mcp_servers: [playwright, broken]
`);
    const report = await preflight(pipeline, {
      repoRoot, userClaudeDir: claudeDir,
      processEnv: { ANTHROPIC_API_KEY: 'sk-x' },
      dotEnv: { MY_TOKEN: 's' },
      probes: { ...okProbes, hasBinary: async (name) => name !== 'zzz-missing-mcp-xyz' },
    });
    const mcp = report.checks.filter((c) => c.kind === 'mcp');
    expect(mcp.find((c) => c.name === 'playwright')!.ok).toBe(true);
    const brokenCheck = mcp.find((c) => c.name === 'broken')!;
    expect(brokenCheck.ok).toBe(false);
    expect(brokenCheck.detail).toContain('zzz-missing-mcp-xyz');
    expect(report.ok).toBe(false);
  });
});

const PLAYWRIGHT_PIPELINE = parsePipeline(`
name: demo
description: d
version: 1
mcp_servers:
  pw:
    command: npx
    args: []
    kind: playwright
steps:
  - id: a
    agent: writer
    prompt: p.md
    mcp_servers: [pw]
    tools: [mcp__pw__browser_take_screenshot, mcp__pw__browser_click]
`);

// Real full fields of these two tools, captured live on 2026-08-18 with
// `listMcpToolsViaStdio` against the real `npx -y @playwright/mcp@latest` —
// the same values that `TOOL_FS_PROFILES[...].knownFields` now holds in
// fs-guard.ts (see the comment there). Reusing them here instead of inventing
// data makes these tests truly representative.
const REAL_BROWSER_TAKE_SCREENSHOT = ['element', 'target', 'type', 'filename', 'fullPage', 'scale'];
const REAL_BROWSER_CLICK = ['element', 'target', 'doubleClick', 'button', 'modifiers'];

describe('preflight — MCP schema drift (doctor)', () => {
  test('matches the engine table: no warning', async () => {
    const report = await preflight(PLAYWRIGHT_PIPELINE, {
      repoRoot,
      userClaudeDir: claudeDir,
      processEnv: {},
      dotEnv: {},
      probes: {
        hasBinary: async () => true,
        listMcpTools: async () => ({
          browser_take_screenshot: [...REAL_BROWSER_TAKE_SCREENSHOT],
          browser_click: [...REAL_BROWSER_CLICK],
        }),
      },
    });
    const check = report.checks.find((c) => c.kind === 'mcp-schema' && c.name === 'pw');
    expect(check?.ok).toBe(true);
  });

  // All three directions of drift must be detected: new field, renamed field,
  // disappeared field. The comparison is made against
  // `TOOL_FS_PROFILES[...].knownFields` (the tool's FULL known schema), not
  // just against the field the hook watches — comparing only against the
  // watched field can never detect a new field, because practically any real
  // tool has more parameters than the single path field tracked (confirmed
  // live: `browser_take_screenshot` has 6 real fields, the table only watches
  // `filename`) — hence the "no warning" case above must use the FULL list so
  // as not to fire noise by itself.
  test('a new field the table does not know at all produces a warning, it does not block the rest of the report', async () => {
    const report = await preflight(PLAYWRIGHT_PIPELINE, {
      repoRoot,
      userClaudeDir: claudeDir,
      processEnv: {},
      dotEnv: {},
      probes: {
        hasBinary: async () => true,
        listMcpTools: async () => ({
          browser_take_screenshot: [...REAL_BROWSER_TAKE_SCREENSHOT, 'new_field'],
          browser_click: [...REAL_BROWSER_CLICK],
        }),
      },
    });
    const check = report.checks.find((c) => c.kind === 'mcp-schema' && c.name === 'pw');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('browser_take_screenshot');
    expect(check?.detail).toContain('new_field');
  });

  // Strong signal: the field the HOOK really watches (`filename`, the only
  // field of `TOOL_FS_PROFILES.browser_take_screenshot`) disappears from the
  // real schema. The guard would keep trying to sanitize a field that no
  // longer exists, without noticing whether the tool gained another unwatched
  // path field — the most dangerous mutation of the three.
  test('the field the hook watches disappears from the real server: warning with the strong wording', async () => {
    const report = await preflight(PLAYWRIGHT_PIPELINE, {
      repoRoot,
      userClaudeDir: claudeDir,
      processEnv: {},
      dotEnv: {},
      probes: {
        hasBinary: async () => true,
        listMcpTools: async () => ({
          browser_take_screenshot: REAL_BROWSER_TAKE_SCREENSHOT.filter((f) => f !== 'filename'),
          browser_click: [...REAL_BROWSER_CLICK],
        }),
      },
    });
    const check = report.checks.find((c) => c.kind === 'mcp-schema' && c.name === 'pw');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('browser_take_screenshot');
    expect(check?.detail).toContain('filename');
    expect(check?.detail).toContain('the table expected that are no longer there');
  });

  // Weaker signal but still `ok:false`: a field of the FULL known schema (but
  // not watched by the hook, because `TOOL_FS_PROFILES` only tracks
  // `filename` for this tool) disappears. It doesn't compromise the guard
  // directly, but it indicates the package changed shape under the table —
  // the wording of the warning must differ from the strong signal above so
  // that a human reading `doctor` can prioritize.
  test('a known but unwatched field disappears from the real server: warning with wording different from the strong signal', async () => {
    const report = await preflight(PLAYWRIGHT_PIPELINE, {
      repoRoot,
      userClaudeDir: claudeDir,
      processEnv: {},
      dotEnv: {},
      probes: {
        hasBinary: async () => true,
        listMcpTools: async () => ({
          browser_take_screenshot: REAL_BROWSER_TAKE_SCREENSHOT.filter((f) => f !== 'scale'),
          browser_click: [...REAL_BROWSER_CLICK],
        }),
      },
    });
    const check = report.checks.find((c) => c.kind === 'mcp-schema' && c.name === 'pw');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('browser_take_screenshot');
    expect(check?.detail).toContain('scale');
    expect(check?.detail).not.toContain('the table expected that are no longer there');
  });

  // A renamed field needs no special case: it simply shows up as the
  // disappearance of the old name (missingGoverned/missingOther) plus the
  // appearance of the new name (extraFields) in the same tool.
  test('a renamed field produces both the disappearance signal and the new-field one, with no special case', async () => {
    const report = await preflight(PLAYWRIGHT_PIPELINE, {
      repoRoot,
      userClaudeDir: claudeDir,
      processEnv: {},
      dotEnv: {},
      probes: {
        hasBinary: async () => true,
        listMcpTools: async () => ({
          // 'filename' (watched by the hook) renamed to 'outputPath'.
          browser_take_screenshot: [
            ...REAL_BROWSER_TAKE_SCREENSHOT.filter((f) => f !== 'filename'),
            'outputPath',
          ],
          browser_click: [...REAL_BROWSER_CLICK],
        }),
      },
    });
    const check = report.checks.find((c) => c.kind === 'mcp-schema' && c.name === 'pw');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('filename');
    expect(check?.detail).toContain('outputPath');
  });

  describe('declared server', () => {
    const DECLARED_PIPELINE = parsePipeline(`
name: demo
description: d
version: 1
mcp_servers:
  dev:
    command: node
    args: []
    kind: declared
    allow: [screenshot, tap]
steps:
  - id: a
    agent: writer
    prompt: p.md
    mcp_servers: [dev]
    tools: [mcp__dev__screenshot, mcp__dev__tap]
`);
    const run = (real: Record<string, string[]>) =>
      preflight(DECLARED_PIPELINE, {
        repoRoot,
        userClaudeDir: claudeDir,
        processEnv: {},
        dotEnv: {},
        probes: { hasBinary: async () => true, listMcpTools: async () => real },
      });

    test('a declared server whose granted tools all exist in the real server passes the mcp-schema check', async () => {
      const report = await run({ screenshot: [], tap: ['text'] });
      const check = report.checks.find((c) => c.kind === 'mcp-schema' && c.name === 'dev');
      expect(check?.ok).toBe(true);
    });

    test('a granted tool of a declared server that the real server does not list is reported as drift', async () => {
      const report = await run({ screenshot: [] });
      const check = report.checks.find((c) => c.kind === 'mcp-schema' && c.name === 'dev');
      expect(check?.ok).toBe(false);
      expect(check?.detail).toContain('tap: the tool no longer exists on the real server');
    });

    test('a granted tool named like an inherited Object property does not count as existing', async () => {
      const pipeline = parsePipeline(`
name: demo
description: d
version: 1
mcp_servers:
  dev:
    command: node
    args: []
    kind: declared
    allow: [constructor]
steps:
  - id: a
    agent: writer
    prompt: p.md
    mcp_servers: [dev]
    tools: [mcp__dev__constructor]
`);
      const report = await preflight(pipeline, {
        repoRoot,
        userClaudeDir: claudeDir,
        processEnv: {},
        dotEnv: {},
        probes: { hasBinary: async () => true, listMcpTools: async () => ({ screenshot: [] }) },
      });
      const check = report.checks.find((c) => c.kind === 'mcp-schema' && c.name === 'dev');
      expect(check?.ok).toBe(false);
      expect(check?.detail).toContain('constructor: the tool no longer exists on the real server');
    });

    test('fields are not compared for a declared server', async () => {
      const report = await run({ screenshot: ['field_a', 'field_b'], tap: ['x', 'y', 'z'] });
      const check = report.checks.find((c) => c.kind === 'mcp-schema' && c.name === 'dev');
      expect(check?.ok).toBe(true);
      expect(check?.detail).not.toContain('field');
    });
  });

  test('a server without kind: produces no mcp-schema check', async () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
mcp_servers:
  x:
    command: npx
    args: []
steps:
  - id: a
    type: shell
    run: 'true'
`);
    const report = await preflight(p, {
      repoRoot,
      userClaudeDir: claudeDir,
      processEnv: {},
      dotEnv: {},
      probes: { hasBinary: async () => true },
    });
    expect(report.checks.some((c) => c.kind === 'mcp-schema')).toBe(false);
  });

  test('if listMcpTools fails (server does not start on this machine), the check is marked failed with the reason, without throwing', async () => {
    const report = await preflight(PLAYWRIGHT_PIPELINE, {
      repoRoot,
      userClaudeDir: claudeDir,
      processEnv: {},
      dotEnv: {},
      probes: {
        hasBinary: async () => true,
        listMcpTools: async () => {
          throw new Error('ECONNRESET');
        },
      },
    });
    const check = report.checks.find((c) => c.kind === 'mcp-schema' && c.name === 'pw');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('ECONNRESET');
  });
});

// `run` and `doctor` literally shared `preflight()` and the same gating
// criterion (`!report.ok`), so an `mcp-schema` check — purely informational,
// meant only for `doctor` (schema drift of an MCP server) — blocked a real
// run. `hasBlockingFailures` is what `run` in `cli/index.ts` now consults
// instead; `doctor` still uses `report.ok` unchanged.
describe('hasBlockingFailures', () => {
  function reportWith(checks: PreflightReport['checks']): PreflightReport {
    return { ok: checks.every((c) => c.ok), checks };
  }

  test('an mcp-schema failure on its own does NOT block — run must be able to proceed', () => {
    const report = reportWith([
      { kind: 'auth', name: 'claude', ok: true, detail: 'ok' },
      { kind: 'mcp-schema', name: 'pw', ok: false, detail: 'schema drift' },
    ]);
    expect(report.ok).toBe(false); // doctor still sees it as a failure...
    expect(hasBlockingFailures(report)).toBe(false); // ...but run must not block because of this alone
  });

  test('a failure of any other kind DOES block, whether or not accompanied by an mcp-schema failure', () => {
    const envOnly = reportWith([
      { kind: 'env', name: 'MY_TOKEN', ok: false, detail: 'not set' },
    ]);
    expect(hasBlockingFailures(envOnly)).toBe(true);

    const envAndMcpSchema = reportWith([
      { kind: 'env', name: 'MY_TOKEN', ok: false, detail: 'not set' },
      { kind: 'mcp-schema', name: 'pw', ok: false, detail: 'schema drift' },
    ]);
    expect(hasBlockingFailures(envAndMcpSchema)).toBe(true);
  });

  test('with no failure, it does not block', () => {
    const report = reportWith([{ kind: 'auth', name: 'claude', ok: true, detail: 'ok' }]);
    expect(hasBlockingFailures(report)).toBe(false);
  });
});

// `reader.read()` in `listMcpToolsViaStdio` waited indefinitely if the MCP
// server never answered. `sleep` as a "server" never writes anything to stdout
// nor ends by itself during the test window — the only reason this test
// finishes quickly is the new timeout (passed explicitly very short here; in
// production it is MCP_HANDSHAKE_TIMEOUT_MS, 12s).
describe('listMcpToolsViaStdio — handshake timeout', () => {
  test('a server that never answers fails with "timed out" instead of hanging — it does not wait the default 12s', async () => {
    await expect(
      listMcpToolsViaStdio({ command: 'sleep', args: ['30'], env: [] }, {}, 100),
    ).rejects.toThrow(/timed out/);
  });
});

describe('preflight — requires.env with templates', () => {
  const TPL = parsePipeline(`
name: tpl
description: d
version: 1
params:
  app:
    description: a
requires:
  env: ["QA_{{params.app}}_TOKEN"]
steps:
  - id: a
    type: shell
    run: 'true'
`);

  const base = () => ({
    repoRoot,
    userClaudeDir: claudeDir,
    processEnv: { ANTHROPIC_API_KEY: 'sk-x' },
    probes: okProbes,
  });

  const envCheck = (report: PreflightReport) => report.checks.find((c) => c.kind === 'env');

  test('resolves the name with the params and looks it up in .env', async () => {
    const report = await preflight(TPL, { ...base(), dotEnv: { QA_myapp_TOKEN: 'a-valid-secret' }, params: { app: 'myapp' } });
    expect(envCheck(report)).toEqual({ kind: 'env', name: 'QA_myapp_TOKEN', ok: true, detail: 'set' });
  });

  test('resolved name with no value in .env', async () => {
    const report = await preflight(TPL, { ...base(), dotEnv: {}, params: { app: 'myapp' } });
    expect(envCheck(report)).toEqual({
      kind: 'env',
      name: 'QA_myapp_TOKEN',
      ok: false,
      detail: 'not set (add it to .env)',
    });
  });

  test('without the param, the check fails and says which one is missing', async () => {
    const report = await preflight(TPL, { ...base(), dotEnv: {} });
    expect(envCheck(report)).toEqual({
      kind: 'env',
      name: 'QA_{{params.app}}_TOKEN',
      ok: false,
      detail: 'depends on params with no value: app (pass them with --set)',
    });
    expect(hasBlockingFailures(report)).toBe(true);
  });

  test('two entries that resolve to the same name give a single check', async () => {
    const DOUBLE = parsePipeline(`
name: double
description: d
version: 1
params:
  app:
    description: a
requires:
  env: ["QA_myapp_TOKEN", "QA_{{params.app}}_TOKEN"]
steps:
  - id: a
    type: shell
    run: 'true'
`);
    const report = await preflight(DOUBLE, { ...base(), dotEnv: { QA_myapp_TOKEN: 'a-valid-secret' }, params: { app: 'myapp' } });
    expect(report.checks.filter((c) => c.kind === 'env')).toEqual([
      { kind: 'env', name: 'QA_myapp_TOKEN', ok: true, detail: 'set' },
    ]);
  });

  test('an invalid resolved name fails and names the result', async () => {
    const report = await preflight(TPL, { ...base(), dotEnv: {}, params: { app: 'my-app' } });
    expect(envCheck(report)).toEqual({
      kind: 'env',
      name: 'QA_{{params.app}}_TOKEN',
      ok: false,
      detail: 'the resulting name "QA_my-app_TOKEN" is not a valid variable name (only letters, digits and _, and it cannot start with a digit)',
    });
  });

  test('a resolved name starting with a digit fails with the same message', async () => {
    const report = await preflight(
      { ...TPL, requires: { ...TPL.requires, env: ['{{params.app}}_X'] } } as typeof TPL,
      { ...base(), dotEnv: {}, params: { app: '9app' } },
    );
    expect(envCheck(report)).toMatchObject({
      ok: false,
      detail: 'the resulting name "9app_X" is not a valid variable name (only letters, digits and _, and it cannot start with a digit)',
    });
  });
});
