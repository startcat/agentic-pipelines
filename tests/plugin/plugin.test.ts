/**
 * The Claude Code plugin in `claude-plugin/`, checked against the engine it
 * describes: every `pipelines …` a skill cites must exist in the real CLI,
 * every ```yaml block must pass the real schema, and the manifests must have
 * the shape Claude Code reads. If the CLI changes and a skill is left telling
 * something that is no longer true, this fails.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { buildProgram } from '../../src/cli/program.ts';
import { parsePipeline } from '../../src/schema/pipeline.ts';
import {
  citationProblems,
  citedCommands,
  cliSurface,
  frontmatter,
  SAFE_TOOLS,
  sharedSection,
  yamlBlocks,
} from './skill-lint.ts';

/** The skills the plugin ships, one folder each under `claude-plugin/skills/`. */
export const EXPECTED_SKILLS: string[] = ['new-pipeline', 'edit-pipeline', 'pipelines-status'];

const ROOT = join(import.meta.dir, '..', '..');
const PLUGIN = join(ROOT, 'claude-plugin');
const SKILLS = join(PLUGIN, 'skills');
const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8'));
const readSkill = (name: string): string => readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8');

/** Every key path in `value` named `version`, at any depth. */
function versionKeys(value: unknown, path = ''): string[] {
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, inner]) => [
    ...(key === 'version' ? [`${path}${key}`] : []),
    ...versionKeys(inner, `${path}${key}.`),
  ]);
}

function toolList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return value.split(',').map((tool) => tool.trim()).filter(Boolean);
  return [];
}

describe('manifests', () => {
  test('the marketplace at the root lists the plugin', () => {
    const marketplace = readJson(join(ROOT, '.claude-plugin', 'marketplace.json'));
    expect(marketplace.name).toBe('startcat');
    const owner = marketplace.owner as { name?: unknown };
    expect(typeof owner?.name === 'string' && owner.name.length > 0).toBe(true);
    const plugins = marketplace.plugins as Record<string, unknown>[];
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.name).toBe('agentic-pipelines');
    expect(plugins[0]!.source).toBe('./claude-plugin');
    expect(typeof plugins[0]!.description === 'string' && (plugins[0]!.description as string).length > 0).toBe(true);
  });

  test('the plugin manifest names the same plugin', () => {
    expect(readJson(join(PLUGIN, '.claude-plugin', 'plugin.json')).name).toBe('agentic-pipelines');
  });

  test('no version anywhere: every commit on main reaches auto-update', () => {
    expect(versionKeys(readJson(join(ROOT, '.claude-plugin', 'marketplace.json')))).toEqual([]);
    expect(versionKeys(readJson(join(PLUGIN, '.claude-plugin', 'plugin.json')))).toEqual([]);
  });

  test('the skills folder holds exactly the expected skills', () => {
    const found = existsSync(SKILLS)
      ? readdirSync(SKILLS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
      : [];
    expect(found.sort()).toEqual([...EXPECTED_SKILLS].sort());
  });

  test('the reference the skills point at exists', () => {
    // Translated checkouts name it `referencia.md`.
    const names = ['reference.md', 'referencia.md'];
    expect(names.some((name) => existsSync(join(ROOT, 'docs', name)))).toBe(true);
  });
});

describe('the shared section', () => {
  test('finds the CLI and the data repo the way the CLI does, and never trusts an alias', () => {
    const shared = sharedSection(readSkill(EXPECTED_SKILLS[0]!), 'locate') ?? '';
    for (const needle of [
      'command -v pipelines',
      '~/agentic-pipelines/src/cli/index.ts',
      'status --json',
      'No data repo found',
      'pipelines-starter',
    ]) {
      expect(shared).toContain(needle);
    }
    expect(shared).not.toContain('alias pipelines=');
  });
});

describe.each(EXPECTED_SKILLS.length > 0 ? EXPECTED_SKILLS : ['(none)'])('skill %s', (skill) => {
  if (skill === '(none)') {
    test.skip('no skills yet', () => {});
    return;
  }
  const markdown = readSkill(skill);
  const meta = frontmatter(markdown);
  const description = String(meta.description ?? '');
  const whenToUse = String(meta.when_to_use ?? '');

  test('its name is its folder', () => {
    expect(meta.name).toBe(skill);
  });

  test('the description says first when to use it, within what Claude Code shows', () => {
    expect(description.startsWith('Use when')).toBe(true);
    expect(description.length + whenToUse.length).toBeLessThanOrEqual(1536);
    expect(`${description}${whenToUse}`).not.toMatch(/[<>]/);
  });

  test('allowed-tools pre-approves only what has no risk', () => {
    const tools = toolList(meta['allowed-tools']);
    expect(tools.filter((tool) => !SAFE_TOOLS.includes(tool))).toEqual([]);
  });

  test('every pipelines command it cites exists in the CLI', () => {
    expect(citationProblems(citedCommands(markdown), cliSurface(buildProgram()))).toEqual([]);
  });

  test('every yaml block passes the pipeline schema', () => {
    for (const block of yamlBlocks(markdown)) expect(() => parsePipeline(block)).not.toThrow();
  });

  test('the shared section is there and the same in every skill', () => {
    const shared = sharedSection(markdown, 'locate');
    expect(shared).toBeDefined();
    expect(shared).toBe(sharedSection(readSkill(EXPECTED_SKILLS[0]!), 'locate'));
  });
});

/**
 * The eval cases are only run by hand (`claude plugin eval` costs money), and
 * a case that does not load is only found out then. This checks what can be
 * checked for free: the shape `claude plugin eval` reads, and that each case's
 * scaffold script is there.
 */
describe('eval cases', () => {
  const EVALS = join(PLUGIN, 'evals');
  const cases = readdirSync(EVALS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(EVALS, entry.name, 'case.yaml')))
    .map((entry) => entry.name);
  const GRADERS = new Set(['regex', 'tool_order', 'tool_used', 'file_exists', 'llm', 'baseline']);

  test('there is at least one case per skill', () => {
    const tags = cases.flatMap((name) => {
      const parsed = parseYaml(readFileSync(join(EVALS, name, 'case.yaml'), 'utf8')) as { tags?: string[] };
      return parsed.tags ?? [];
    });
    for (const skill of EXPECTED_SKILLS) expect(tags).toContain(skill);
  });

  test.each(cases)('%s has the shape claude plugin eval reads', (name) => {
    const parsed = parseYaml(readFileSync(join(EVALS, name, 'case.yaml'), 'utf8')) as Record<string, any>;
    expect(typeof parsed.schema_version).toBe('string');
    expect(parsed.name).toBe(name);
    expect(typeof parsed.execution?.prompt === 'string' && parsed.execution.prompt.length > 0).toBe(true);
    expect(Number.isInteger(parsed.runs ?? 3)).toBe(true);
    expect(Number.isInteger(parsed.execution?.max_turns ?? 10)).toBe(true);
    expect(Array.isArray(parsed.graders) && parsed.graders.length > 0).toBe(true);
    const names = new Set<string>();
    for (const grader of parsed.graders) {
      expect(GRADERS.has(grader.type)).toBe(true);
      expect(typeof grader.name).toBe('string');
      expect(names.has(grader.name)).toBe(false);
      names.add(grader.name);
      if (grader.type === 'llm') expect(typeof grader.criteria).toBe('string');
      if (grader.type === 'tool_used') expect(typeof grader.tool).toBe('string');
      if (grader.type === 'file_exists') expect(typeof grader.path).toBe('string');
    }
    const scaffold = parsed.context?.scaffold_script;
    if (scaffold !== undefined) expect(existsSync(join(EVALS, name, scaffold))).toBe(true);
  });
});
