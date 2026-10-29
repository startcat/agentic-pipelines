/**
 * Reading a skill's Markdown the way the plugin test needs: the `pipelines …`
 * commands it cites, its ```yaml blocks, its frontmatter and the sections
 * shared word for word between skills. Plain text parsing, no Markdown
 * library: a skill is small and its conventions are ours.
 */
import type { Command } from 'commander';
import { parse as parseYaml } from 'yaml';

/** `words` is everything after the command, as written: arguments, flags and their values. */
export type Citation = { text: string; command: string; flags: string[]; words: string[] };

/** What the CLI accepts for one command. */
export type CommandSurface = {
  /** Long and short flags, global ones and help included. */
  flags: Set<string>;
  /** The flags that take a value (`--set k=v`, `-n 3`), so the next word is not an argument. */
  takesValue: Set<string>;
  /** How many positional arguments are required. */
  required: number;
};

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
  // The same three in the form the starter's README installs the engine with.
  'Bash(bun run ~/agentic-pipelines/src/cli/index.ts validate *)',
  'Bash(bun run ~/agentic-pipelines/src/cli/index.ts status *)',
  'Bash(bun run ~/agentic-pipelines/src/cli/index.ts show *)',
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

/** The word that runs the CLI: the binary, or the engine's entry point after `bun run`. */
const isCliHead = (word: string): boolean => word === 'pipelines' || word.endsWith('src/cli/index.ts');

/** `pipelines <command> …` inside one piece of code, stopping at shell operators. */
function citationsIn(code: string): Citation[] {
  const found: Citation[] = [];
  for (const segment of code.split(/\s*(?:&&|\|\||[|;])\s*/)) {
    const words = segment.trim().replace(/^\$\s+/, '').split(/\s+/);
    const at = words.findIndex(isCliHead);
    if (at === -1) continue;
    // `command -v pipelines` looks the binary up; it does not run it.
    if (at > 0 && words[at - 1] === '-v') continue;
    const rest = words.slice(at + 1);
    const flags: string[] = [];
    let command: string | undefined;
    let after: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const word = rest[i]!;
      if (command === undefined) {
        if (word.startsWith('-')) {
          const flag = word.split('=')[0]!;
          flags.push(flag);
          if (GLOBAL_WITH_VALUE.has(flag) && !word.includes('=')) i++;
        } else {
          command = word;
          after = rest.slice(i + 1);
        }
      } else if (word.startsWith('-')) flags.push(word.split('=')[0]!);
    }
    if (command !== undefined) found.push({ text: words.slice(at).join(' '), command, flags, words: after });
  }
  return found;
}

/** A fenced block's lines, with shell lines continued by a trailing backslash joined into one. */
function logicalLines(body: string): string[] {
  return body.replace(/\\\n/g, ' ').split('\n');
}

/** Every `pipelines …` cited in inline code spans and in non-yaml code blocks. */
export function citedCommands(markdown: string): Citation[] {
  const { fences, prose } = split(markdown);
  const cited: Citation[] = [];
  for (const match of prose.matchAll(/`([^`\n]+)`/g)) cited.push(...citationsIn(match[1]!));
  for (const fence of fences) {
    if (isYaml(fence.info)) continue;
    for (const line of logicalLines(fence.body)) cited.push(...citationsIn(line));
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

/** Each command and what it accepts: flags (global ones and help included), which take a value, and its required arguments. */
export function cliSurface(program: Command): Map<string, CommandSurface> {
  const globalFlags = new Set<string>(['-h', '--help']);
  const globalValued = new Set<string>();
  for (const option of program.options) {
    for (const flag of [option.long, option.short]) {
      if (!flag) continue;
      globalFlags.add(flag);
      if (option.required || option.optional) globalValued.add(flag);
    }
  }
  const surface = new Map<string, CommandSurface>();
  for (const command of program.commands) {
    const flags = new Set(globalFlags);
    const takesValue = new Set(globalValued);
    for (const option of command.options) {
      for (const flag of [option.long, option.short]) {
        if (!flag) continue;
        flags.add(flag);
        if (option.required || option.optional) takesValue.add(flag);
      }
    }
    const required = command.registeredArguments.filter((argument) => argument.required).length;
    surface.set(command.name(), { flags, takesValue, required });
  }
  return surface;
}

/**
 * What is wrong with each citation: a command the CLI doesn't have, a flag it
 * doesn't take, or fewer arguments than it requires. A bare `pipelines <command>`,
 * with nothing after it, names the command in a sentence ("ask before
 * `pipelines run`") and is not checked for arguments; neither is one asking for help.
 */
export function citationProblems(cited: Citation[], surface: Map<string, CommandSurface>): string[] {
  const problems: string[] = [];
  for (const { text, command, flags, words } of cited) {
    const known = surface.get(command);
    if (known === undefined) {
      problems.push(`\`${text}\`: there is no "${command}" command`);
      continue;
    }
    for (const flag of flags) {
      if (!known.flags.has(flag)) problems.push(`\`${text}\`: "${command}" has no ${flag} option`);
    }
    // With help asked for, the command prints it and needs no arguments.
    if (words.length === 0 || flags.includes('-h') || flags.includes('--help')) continue;
    let positional = 0;
    for (let i = 0; i < words.length; i++) {
      const word = words[i]!;
      if (word.startsWith('-')) {
        if (known.takesValue.has(word.split('=')[0]!) && !word.includes('=')) i++;
      } else positional++;
    }
    if (positional < known.required) {
      problems.push(`\`${text}\`: "${command}" needs ${known.required} argument(s), got ${positional}`);
    }
  }
  return problems;
}
