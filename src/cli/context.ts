import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseRepoConfig, type RepoConfig } from '../schema/config.ts';
import { parsePipeline, type Pipeline } from '../schema/pipeline.ts';

export type RepoContext = {
  root: string;
  config: RepoConfig;
  dotEnv: Record<string, string>;
};

/** Parses a .env file: KEY=value pairs, # comments and optional quotes. */
export function parseDotEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2]!;
    result[key] = value;
  }
  return result;
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Walks up directories from `cwd` until it finds the repo's `pipelines.yaml`. */
export async function loadRepoContext(cwd: string): Promise<RepoContext> {
  let dir = resolve(cwd);
  for (;;) {
    const configText = await readIfExists(join(dir, 'pipelines.yaml'));
    if (configText !== undefined) {
      const dotEnvText = await readIfExists(join(dir, '.env'));
      return {
        root: dir,
        config: parseRepoConfig(configText),
        dotEnv: dotEnvText ? parseDotEnv(dotEnvText) : {},
      };
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `No data repo found (pipelines.yaml is missing) from ${cwd}.\n` +
          `Create a pipelines.yaml file at the root of the data repo (it can be ` +
          `empty, \`touch pipelines.yaml\` is enough) or move into an existing repo.`,
      );
    }
    dir = parent;
  }
}

export async function listPipelineNames(ctx: RepoContext): Promise<string[]> {
  try {
    const entries = await readdir(join(ctx.root, 'pipelines'), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

/**
 * Loads and validates a pipeline by directory name. Requires the `name:`
 * declared in the YAML to match that directory exactly: it is not just
 * cosmetic — `evaluateGuards` (guards/evaluate.ts) queries the run store by
 * `pipeline.name`, while `withLock`/`store.createRun` (cli/index.ts) index by
 * this same directory `name`. If they diverge, `throttle`/`changed` query a
 * key that is never written and their guard stops holding anything back.
 */
export async function loadPipeline(ctx: RepoContext, name: string): Promise<Pipeline> {
  const path = join(ctx.root, 'pipelines', name, 'pipeline.yaml');
  const text = await readIfExists(path);
  if (text === undefined) {
    const available = await listPipelineNames(ctx);
    throw new Error(
      `Pipeline "${name}" does not exist.\n` + `Available: ${available.join(', ') || '(none)'}`,
    );
  }
  const pipeline = parsePipeline(text);
  if (pipeline.name !== name) {
    throw new Error(
      `pipelines/${name}/pipeline.yaml declares name: "${pipeline.name}", which does not ` +
        `match its directory ("${name}"). Locks, throttle and the run history ` +
        `are indexed by name: a mismatch makes guards query ` +
        `runs that are never written. Fix the "name" field or rename the directory.`,
    );
  }
  return pipeline;
}

/** Reads the params saved by `pipelines install`. */
export async function loadLocalParams(
  ctx: RepoContext,
  pipeline: string,
): Promise<Record<string, string>> {
  const text = await readIfExists(join(ctx.root, '.params.local.json'));
  if (!text) return {};
  const all = JSON.parse(text) as Record<string, Record<string, string>>;
  return all[pipeline] ?? {};
}

/**
 * Claude credential for `agent` steps, taken from the data repo's `.env`.
 * Under launchd the process environment does not carry it (the plist only has
 * PATH and HOME), so the `.env` is the route that works the same by hand and
 * scheduled. If it is not there, the SDK subprocess uses the one from the
 * environment.
 */
export function collectAgentAuth(ctx: RepoContext): Record<string, string> {
  const key = ctx.dotEnv.ANTHROPIC_API_KEY;
  return key ? { ANTHROPIC_API_KEY: key } : {};
}

/** Secrets declared by a pipeline or a notify channel, taken from the .env or the environment. */
export function collectSecrets(ctx: RepoContext, names: string[]): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const name of names) {
    const value = ctx.dotEnv[name] ?? process.env[name];
    if (value !== undefined) secrets[name] = value;
  }
  return secrets;
}
