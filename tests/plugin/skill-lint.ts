/**
 * Reading a skill's Markdown the way the plugin test needs: the `pipelines …`
 * commands it cites, its ```yaml blocks, its frontmatter and the sections
 * shared word for word between skills. Plain text parsing, no Markdown
 * library: a skill is small and its conventions are ours.
 */
import type { Command } from 'commander';
import { parse as parseYaml } from 'yaml';

export type Citation = { text: string; command: string; flags: string[] };

/**
 * What a skill may pre-approve in `allowed-tools`: reading files and the
 * commands that only read. `doctor` is not here (it starts MCP servers and
 * goes out to the network), nor `install`, `uninstall`, `run` or `resume`:
 * those must still ask.
 */
export const SAFE_TOOLS: readonly string[] = [
  'Read',
  'Grep',
  'Glob',
  'Bash(pipelines validate *)',
  'Bash(pipelines status *)',
  'Bash(pipelines show *)',
];

type Fence = { info: string; body: string };

/** The fenced blocks and the text outside them. */
function split(markdown: string): { fences: Fence[]; prose: string } {
  const fences: Fence[] = [];
  const prose: string[] = [];
  let open: { info: string; lines: string[] } | undefined;
  for (const line of markdown.split('\n')) {
    const fence = /^\s*```\s*([\w-]*)/.exec(line);
    if (open === undefined) {
      if (fence) open = { info: fence[1]!.toLowerCase(), lines: [] };
      else prose.push(line);
    } else if (fence && fence[1] === '') {
      fences.push({ info: open.info, body: open.lines.length > 0 ? `${open.lines.join('\n')}\n` : '' });
      open = undefined;
    } else open.lines.push(line);
  }
  return { fences, prose: prose.join('\n') };
}

const isYaml = (info: string): boolean => info === 'yaml' || info === 'yml';

/**
 * Global options that take a value, so the word after them is not the
 * command. Kept by hand: it is one option today.
 */
const GLOBAL_WITH_VALUE = new Set(['--repo']);

/** `pipelines <command> …` inside one piece of code, stopping at shell operators. */
function citationsIn(code: string): Citation[] {
  const found: Citation[] = [];
  for (const segment of code.split(/\s*(?:&&|\|\||[|;])\s*/)) {
    const words = segment.trim().replace(/^\$\s+/, '').split(/\s+/);
    const at = words.indexOf('pipelines');
    if (at === -1) continue;
    // `command -v pipelines` looks the binary up; it does not run it.
    if (at > 0 && words[at - 1] === '-v') continue;
    const rest = words.slice(at + 1);
    const flags: string[] = [];
    let command: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      const word = rest[i]!;
      if (word.startsWith('-')) {
        const flag = word.split('=')[0]!;
        flags.push(flag);
        if (command === undefined && GLOBAL_WITH_VALUE.has(flag) && !word.includes('=')) i++;
      } else if (command === undefined) command = word;
    }
    if (command !== undefined) found.push({ text: words.slice(at).join(' '), command, flags });
  }
  return found;
}

/** Every `pipelines …` cited in inline code spans and in non-yaml code blocks. */
export function citedCommands(markdown: string): Citation[] {
  const { fences, prose } = split(markdown);
  const cited: Citation[] = [];
  for (const match of prose.matchAll(/`([^`\n]+)`/g)) cited.push(...citationsIn(match[1]!));
  for (const fence of fences) {
    if (isYaml(fence.info)) continue;
    for (const line of fence.body.split('\n')) cited.push(...citationsIn(line));
  }
  return cited;
}

export function yamlBlocks(markdown: string): string[] {
  return split(markdown).fences.filter((fence) => isYaml(fence.info)).map((fence) => fence.body);
}

export function frontmatter(markdown: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  if (!match) return {};
  const parsed: unknown = parseYaml(match[1]!);
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

/** The text between `<!-- shared:id -->` and `<!-- /shared:id -->`. */
export function sharedSection(markdown: string, id: string): string | undefined {
  const open = `<!-- shared:${id} -->`;
  const close = `<!-- /shared:${id} -->`;
  const start = markdown.indexOf(open);
  const end = markdown.indexOf(close);
  if (start === -1 || end === -1 || end < start) return undefined;
  return markdown.slice(start + open.length, end);
}

/** Each command and the flags it accepts, long and short, global ones and help included. */
export function cliSurface(program: Command): Map<string, Set<string>> {
  const global = new Set<string>(['-h', '--help']);
  for (const option of program.options) {
    if (option.long) global.add(option.long);
    if (option.short) global.add(option.short);
  }
  const surface = new Map<string, Set<string>>();
  for (const command of program.commands) {
    const flags = new Set(global);
    for (const option of command.options) {
      if (option.long) flags.add(option.long);
      if (option.short) flags.add(option.short);
    }
    surface.set(command.name(), flags);
  }
  return surface;
}

export function citationProblems(cited: Citation[], surface: Map<string, Set<string>>): string[] {
  const problems: string[] = [];
  for (const { text, command, flags } of cited) {
    const known = surface.get(command);
    if (known === undefined) {
      problems.push(`\`${text}\`: there is no "${command}" command`);
      continue;
    }
    for (const flag of flags) {
      if (!known.has(flag)) problems.push(`\`${text}\`: "${command}" has no ${flag} option`);
    }
  }
  return problems;
}
