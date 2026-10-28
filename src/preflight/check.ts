import { access, readdir } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { join } from 'node:path';
import { schedulerFor, type SchedulerBackend } from '../install/backend.ts';
import { platformChecks } from '../install/platform-checks.ts';
import type { Pipeline } from '../schema/pipeline.ts';
import { TOOL_FS_PROFILES, type ToolFsProfile } from '../runner/fs-guard.ts';
import type { McpServerConfig } from '../schema/pipeline.ts';

/**
 * Minimum length for a `requires.env` value to count as a real secret.
 * Without this, an empty variable or a three-letter placeholder passed
 * `preflight`/`doctor` just like a legitimate value. No entropy calculation:
 * the goal is to catch "empty or nearly empty", not to audit the
 * cryptographic quality of the secret.
 */
const MIN_SECRET_LENGTH = 8;

export type PreflightCheck = {
  kind: 'agent' | 'skill' | 'bin' | 'env' | 'net' | 'auth' | 'mcp' | 'mcp-schema' | 'platform';
  name: string;
  ok: boolean;
  /** Short explanation. Never contains secret values. */
  detail: string;
};

export type PreflightReport = { ok: boolean; checks: PreflightCheck[] };

/**
 * Should this report keep `pipelines run` from starting? Different from
 * `report.ok` (used by `pipelines doctor`, which still demands ALL the checks,
 * `mcp-schema` included — as noisy as designed): an `mcp-schema` check is
 * purely informational for `run` — it is the schema drift of an MCP server
 * that `pipelines doctor` watches, so it was never meant to be a condition
 * that blocks a real run. Before this fix, `run` and `doctor` literally shared
 * `preflight()` AND the same gating criterion (`!report.ok`), so an MCP server
 * that was slow or down at the wrong moment blocked a real run over a check
 * that was never meant to block anything outside `doctor`.
 */
export function hasBlockingFailures(report: PreflightReport): boolean {
  return report.checks.some((c) => !c.ok && c.kind !== 'mcp-schema' && c.kind !== 'platform');
}

export type Probes = {
  hasBinary(name: string): Promise<boolean>;
  resolvesHost(host: string): Promise<boolean>;
  listUserAgents(): Promise<string[]>;
  listUserSkills(): Promise<string[]>;
  /** Property names of the inputSchema of each tool the real server exposes, by tool name. */
  listMcpTools(server: McpServerConfig, env: Record<string, string>): Promise<Record<string, string[]>>;
  /** Is there a Claude Code credential in the system keychain? */
  hasKeychainSession(): Promise<boolean>;
};

export type PreflightEnv = {
  repoRoot: string;
  userClaudeDir: string;
  processEnv: Record<string, string | undefined>;
  dotEnv: Record<string, string>;
  probes?: Partial<Probes>;
  /** Adds the platform checks (systemd, linger, zone). `doctor` only: `run` must not take longer. */
  includePlatform?: boolean;
  /** This machine's scheduler. `schedulerFor()` by default; tests replace it. */
  scheduler?: () => SchedulerBackend;
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** File names of the .md files in a directory, without the extension. */
async function markdownNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((e) => e.endsWith('.md')).map((e) => e.slice(0, -3));
  } catch {
    return [];
  }
}

/**
 * Maximum time for the whole MCP handshake (`initialize` + `tools/list`),
 * each `readOneMessage()` separately. `reader.read()` waited indefinitely
 * without this — a hung server (cold npx cache, npm registry down, any reason)
 * left `doctor` (and, before the adjacent fix, `run` too) waiting forever. 12s
 * is generous for an `npx` with a warm cache on a normal machine, without
 * feeling like a hang to whoever runs `doctor` by hand.
 */
const MCP_HANDSHAKE_TIMEOUT_MS = 12_000;

/**
 * Runs `promise` with a time limit: if `ms` elapse before it resolves or
 * rejects, the race is won by a rejection with a clear "timed out" message —
 * never a silent hang. The timer is cleared as soon as `promise` settles
 * first, so no timer is left alive longer than necessary.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label}: no response after ${ms} ms — timed out`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Minimal MCP handshake over stdio: `initialize` followed by `tools/list`.
 * No protocol dependencies beyond JSON-RPC over lines — the same transport
 * `mcp_servers` already uses in production (`resolveMcpServers`,
 * `runner/agent.ts`). It closes the process with `.kill()` as soon as it has
 * the answer it needs (or as soon as the handshake times out, via `finally` —
 * the timeout rejects the promise but doesn't kill the process by itself); it
 * doesn't leave the server running in the background.
 *
 * `timeoutMs` is a parameter (not a fixed internal constant) only so tests
 * can exercise the "timed out" path without waiting for the default
 * `MCP_HANDSHAKE_TIMEOUT_MS`; in production `defaultProbes` never passes it,
 * so it always runs with the default value.
 */
export async function listMcpToolsViaStdio(
  server: McpServerConfig,
  env: Record<string, string>,
  timeoutMs: number = MCP_HANDSHAKE_TIMEOUT_MS,
): Promise<Record<string, string[]>> {
  const proc = Bun.spawn([server.command, ...server.args], {
    env: { ...process.env, ...env },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const writer = proc.stdin;
  const send = (msg: Record<string, unknown>) => writer.write(`${JSON.stringify(msg)}\n`);
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  async function readOneMessage(): Promise<Record<string, unknown>> {
    for (;;) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim().length === 0) continue;
        return JSON.parse(line) as Record<string, unknown>;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('the MCP server closed stdout before answering');
      buffer += decoder.decode(value, { stream: true });
    }
  }
  async function readOneMessageWithTimeout(): Promise<Record<string, unknown>> {
    return withTimeout(readOneMessage(), timeoutMs, 'MCP handshake');
  }
  try {
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'agentic-pipelines-doctor', version: '0' },
      },
    });
    await readOneMessageWithTimeout(); // response to initialize — discarded, only the handshake is needed
    send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const response = await readOneMessageWithTimeout();
    const tools = (response.result as { tools?: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }> })?.tools ?? [];
    const out: Record<string, string[]> = {};
    for (const tool of tools) {
      out[tool.name] = Object.keys(tool.inputSchema?.properties ?? {});
    }
    return out;
  } finally {
    proc.kill();
  }
}

function defaultProbes(env: PreflightEnv): Probes {
  return {
    // Bun.which searches the PATH without launching a subprocess or relying
    // on an external `which` binary (absent, e.g., in many distroless
    // images): it returns the resolved path or null if it doesn't exist.
    async hasBinary(name) {
      return Bun.which(name) !== null;
    },
    async resolvesHost(host) {
      try {
        await lookup(host);
        return true;
      } catch {
        return false;
      }
    },
    async listUserAgents() {
      return markdownNames(join(env.userClaudeDir, 'agents'));
    },
    async listUserSkills() {
      // Unlike agents (one .md file per agent), each skill is a directory of
      // its own (with its SKILL.md inside), so there is no extension filter
      // here: the name of the directory entry IS the name of the skill.
      try {
        return await readdir(join(env.userClaudeDir, 'skills'));
      } catch {
        return [];
      }
    },
    async listMcpTools(server, resolvedEnv) {
      return listMcpToolsViaStdio(server, resolvedEnv);
    },
    // Claude Code stores its credential in the macOS keychain, not always in
    // `~/.claude/.credentials.json` — that file may not exist on a perfectly
    // authenticated machine (it disappeared from the development machine on
    // 2026-08-29, leaving the `auth` check red and blocking any `run`).
    // `security find-generic-password` WITHOUT `-w`: it checks that the item
    // exists by printing only attributes, never the password; stdout is still
    // discarded so that no value can end up in a log.
    async hasKeychainSession() {
      if (process.platform !== 'darwin') return false;
      try {
        const proc = Bun.spawn(
          ['security', 'find-generic-password', '-s', 'Claude Code-credentials'],
          { stdout: 'ignore', stderr: 'ignore' },
        );
        return (await proc.exited) === 0;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Verifies all the dependencies declared in `requires` before the runner
 * spends a single token. It is what lets it fail before spending anything and
 * the engine of the `pipelines doctor` command.
 */
export async function preflight(
  pipeline: Pipeline,
  env: PreflightEnv,
): Promise<PreflightReport> {
  const probes = { ...defaultProbes(env), ...env.probes };
  const checks: PreflightCheck[] = [];

  // Authentication. The engine never mediates it: it only checks that it
  // exists, and only if the pipeline has some `agent` step — a shell-only one
  // doesn't talk to Claude and must not be blocked for lacking credentials.
  // The documented route is an API key, in the data repo's `.env` (it is the
  // only thing that reaches a run launched by launchd) or in the environment.
  if (pipeline.steps.some((step) => step.type === 'agent')) {
    const apiKeySource = env.dotEnv.ANTHROPIC_API_KEY
      ? '.env'
      : env.processEnv.ANTHROPIC_API_KEY
        ? 'environment'
        : undefined;
    const hasSessionFile = apiKeySource ? false : await exists(join(env.userClaudeDir, '.credentials.json'));
    const hasKeychain = apiKeySource || hasSessionFile ? false : await probes.hasKeychainSession();
    checks.push({
      kind: 'auth',
      name: 'claude',
      ok: Boolean(apiKeySource) || hasSessionFile || hasKeychain,
      detail: apiKeySource
        ? `ANTHROPIC_API_KEY present (${apiKeySource})`
        : hasSessionFile
          ? 'Claude Code session signed in'
          : hasKeychain
            ? 'Claude Code session in the keychain'
            : "no credentials: put ANTHROPIC_API_KEY in the data repo's .env",
    });
  }

  // Agents: the repo's first, then the user's.
  const repoAgents = await markdownNames(join(env.repoRoot, 'agents'));
  const userAgents = await probes.listUserAgents();
  for (const name of pipeline.requires.agents) {
    const inRepo = repoAgents.includes(name);
    const inUser = userAgents.includes(name);
    checks.push({
      kind: 'agent',
      name,
      ok: inRepo || inUser,
      detail: inRepo ? 'repo' : inUser ? 'user' : 'not found',
    });
  }

  const userSkills = await probes.listUserSkills();
  for (const name of pipeline.requires.skills) {
    const ok = userSkills.includes(name) || userSkills.includes(name.split(':').pop()!);
    checks.push({ kind: 'skill', name, ok, detail: ok ? 'available' : 'not found' });
  }

  for (const name of pipeline.requires.bin) {
    const ok = await probes.hasBinary(name);
    checks.push({ kind: 'bin', name, ok, detail: ok ? 'on PATH' : 'not on PATH' });
  }

  // MCP servers: same check as `bin` (does the command start?), but derived
  // from `mcp_servers` instead of declaring it twice in `requires`.
  for (const [name, server] of Object.entries(pipeline.mcpServers)) {
    const ok = await probes.hasBinary(server.command);
    checks.push({
      kind: 'mcp',
      name,
      ok,
      detail: ok
        ? `command "${server.command}" on PATH`
        : `command "${server.command}" not on PATH`,
    });
  }

  // Schema drift: for each server with a known `kind:`, compares the real
  // property names of each GRANTED tool (not the server's whole surface)
  // against what TOOL_FS_PROFILES remembers. It is the only one of the two
  // layers (together with the static governance of `validate`) that compares
  // against the real package instead of against a table, motivated by
  // @playwright/mcp@latest going from 69 to 24 tools in a single day.
  //
  // The comparison is made against `profile.knownFields` (the tool's FULL
  // known schema, verified live — see the comment on `TOOL_FS_PROFILES` in
  // fs-guard.ts), not just against `field`/`fields` (the field the hook
  // actually watches). Comparing only against the watched field cannot detect
  // a NEW field: practically any real tool has more parameters than the single
  // path field the table tracks, so "any unwatched field is a warning" would
  // fire on almost any real call. All three directions are needed — new,
  // renamed, gone — so three sets are computed per granted tool:
  //   - `missingGoverned`: the field(s) the HOOK really watches
  //     (`profile.field`/`profile.fields`) are no longer in the real schema.
  //     Strong signal: the guard keeps trying to sanitize a field that no
  //     longer exists, so any new path field the tool may have gained goes
  //     unwatched.
  //   - `missingOther`: a field of the FULL `knownFields` (but not watched by
  //     the hook) that has gone. Weaker signal — it doesn't compromise the
  //     guard directly — but it indicates the package changed shape under the
  //     table.
  //   - `extraFields`: a real field that is not in `knownFields`. Covers both
  //     "new field" and the "appears" half of a rename — a renamed field shows
  //     up, with no special case, as one entry in
  //     `missingGoverned`/`missingOther` (the old name) plus one in
  //     `extraFields` (the new name).
  const grantedMcpTools = new Map<string, Set<string>>(); // server name -> granted tool suffixes
  for (const step of pipeline.steps) {
    if (step.type !== 'agent') continue;
    for (const tool of step.tools) {
      if (!tool.startsWith('mcp__')) continue;
      const server = step.mcpServers.find((name) => tool.startsWith(`mcp__${name}__`));
      if (!server) continue;
      const suffix = tool.slice(`mcp__${server}__`.length);
      if (!grantedMcpTools.has(server)) grantedMcpTools.set(server, new Set());
      grantedMcpTools.get(server)!.add(suffix);
    }
  }
  for (const [name, server] of Object.entries(pipeline.mcpServers)) {
    if (!server.kind) continue;
    const granted = grantedMcpTools.get(name);
    if (!granted || granted.size === 0) continue;
    try {
      const real = await probes.listMcpTools(server, {}); // real env resolved by the caller if needed in the future
      const drift: string[] = [];
      for (const suffix of granted) {
        const profile: ToolFsProfile | undefined = TOOL_FS_PROFILES[suffix];
        const governedFields =
          profile?.kind === 'path' ? [profile.field]
          : profile?.kind === 'multi-path' ? profile.fields.map((f) => f.name)
          : profile?.kind === 'url' ? [profile.field]
          : [];
        const knownFields = profile?.knownFields ?? [];
        const realFields = real[suffix];
        if (realFields === undefined) {
          drift.push(`${suffix}: the tool no longer exists on the real server`);
          continue;
        }
        const missingGoverned = governedFields.filter((f) => !realFields.includes(f));
        if (missingGoverned.length > 0) {
          drift.push(`${suffix}: field(s) the table expected that are no longer there: ${missingGoverned.join(', ')}`);
        }
        const missingOther = knownFields.filter(
          (f) => !governedFields.includes(f) && !realFields.includes(f),
        );
        if (missingOther.length > 0) {
          drift.push(
            `${suffix}: known field(s) that are no longer there (no watched path field): ${missingOther.join(', ')}`,
          );
        }
        const extraFields = realFields.filter((f) => !knownFields.includes(f));
        if (extraFields.length > 0) {
          drift.push(`${suffix}: new field(s) the table didn't know: ${extraFields.join(', ')}`);
        }
      }
      checks.push({
        kind: 'mcp-schema',
        name,
        ok: drift.length === 0,
        detail: drift.length === 0 ? 'real schema matches the engine table' : drift.join('; '),
      });
    } catch (err) {
      checks.push({
        kind: 'mcp-schema',
        name,
        ok: false,
        detail: `could not compare against the real server: ${(err as Error).message}`,
      });
    }
  }

  for (const name of pipeline.requires.env) {
    const value = env.dotEnv[name] ?? env.processEnv[name];
    const ok = value !== undefined && value.trim().length >= MIN_SECRET_LENGTH;
    checks.push({
      kind: 'env',
      name,
      ok,
      detail:
        value === undefined
          ? 'not set (add it to .env)'
          : ok
            ? 'set'
            : `set but too short (minimum ${MIN_SECRET_LENGTH} characters)`,
    });
  }

  for (const name of pipeline.requires.net) {
    const ok = await probes.resolvesHost(name);
    checks.push({ kind: 'net', name, ok, detail: ok ? 'reachable' : 'does not resolve' });
  }

  // Informational: they warn, but don't make `doctor` or `run` fail.
  // On a platform without a scheduler (FreeBSD, for example) there is nothing
  // to check: the platform error belongs only to `install`/`uninstall`, and
  // `doctor` still serves to tell whether it can run.
  if (env.includePlatform === true) {
    let backend: SchedulerBackend | undefined;
    try {
      backend = (env.scheduler ?? schedulerFor)();
    } catch {
      backend = undefined;
    }
    if (backend) checks.push(...(await platformChecks(backend)));
  }

  return { ok: checks.filter((c) => c.kind !== 'platform').every((c) => c.ok), checks };
}
