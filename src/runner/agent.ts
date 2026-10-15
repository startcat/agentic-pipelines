import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  query,
  type AgentDefinition,
  type Options,
  type SDKAssistantMessageError,
  type SDKMessage,
  type SDKResultError,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { interpolate, type InterpolationScope } from '../params/resolve.ts';
import type { AgentStep, McpServerConfig, OutputType } from '../schema/pipeline.ts';
import {
  composeAgentEnv,
  redactOutputValues,
  validateOutputs,
  type StepContext,
  type StepOutcome,
} from './shell.ts';
import { redactSecrets } from '../runs/store.ts';
import { captureRoots, evaluateToolCall, type FsRoots } from './fs-guard.ts';
import type { HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
// `Denial` lives in `runs/types.ts` (not here) to avoid a module cycle —
// see the comment next to its definition there. It is re-exported from this
// file for the convenience of whoever already imports types from agent.ts.
import type { Denial } from '../runs/types.ts';
export type { Denial } from '../runs/types.ts';

export type JsonSchemaObject = {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
};

/**
 * Minimal signature the runner needs from the SDK; injectable for tests.
 * The messages are `SDKMessage`, the real type the SDK itself exports — not
 * an invented shape — so a test fake or a future SDK change that does not fit
 * fails in `tsc`, not in production.
 */
export type QueryFn = (args: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<SDKMessage>;

export type AgentStepContext = StepContext & {
  repoRoot: string;
  /** Content of the prompt file, already read from disk. */
  promptText: string;
  /** The pipeline's `mcp_servers` registry; the step enables a subset by name. */
  mcpServers: Record<string, McpServerConfig>;
  /** Claude credential taken from the data repo's `.env`; it only reaches `agent` steps. */
  agentAuth?: Record<string, string>;
  /**
   * Secretos que el prompt puede interpolar con `{{secrets.X}}`: solo los
   * nombres literales de `requires.env` (mismo criterio que `validate`). Si
   * falta, se usa `secrets`. `secrets` (completo) sigue siendo lo que se usa
   * para redactar, el `env` de los servidores MCP y el subproceso.
   */
  promptSecrets?: Record<string, string>;
  queryFn?: QueryFn;
};

export type AgentOutcome = StepOutcome & {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  toolsUsed?: string[];
  /** Denials from the PreToolUse hook during this step — see buildDenials. */
  denials?: Denial[];
};

/**
 * Cross-checks the hook's own log (reason, by tool_use_id) against the SDK's
 * `result.permission_denials` (authoritative count, no reason). A mismatch
 * between the two sources is the most valuable signal: a `hookLog` entry with
 * no match in `sdkDenials` suggests the hook denied but the SDK did not
 * record it (unexpected); an `sdkDenials` entry with no match in `hookLog`
 * suggests something other than the hook itself produced the denial — in
 * both cases, exactly the kind of discrepancy a silent fail-open would
 * produce — and the sandbox must never fail open without it being noticed.
 */
function buildDenials(
  hookLog: Map<string, { toolName: string; reason: string }>,
  sdkDenials: ReadonlyArray<{ tool_name: string; tool_use_id: string }>,
): Denial[] {
  const denials: Denial[] = [];
  const sdkByToolUseId = new Map(sdkDenials.map((d) => [d.tool_use_id, d]));
  for (const [toolUseId, entry] of hookLog) {
    const inSdk = sdkByToolUseId.has(toolUseId);
    denials.push({
      toolName: entry.toolName,
      toolUseId,
      reason: entry.reason,
      source: inSdk ? 'both' : 'hook-log',
    });
    sdkByToolUseId.delete(toolUseId);
  }
  for (const [toolUseId, entry] of sdkByToolUseId) {
    denials.push({ toolName: entry.tool_name, toolUseId, source: 'sdk-result' });
  }
  return denials;
}

/**
 * The SDK delivers the name of an MCP tool in its QUALIFIED form
 * (`mcp__<server>__<tool>`, e.g. `mcp__playwright__browser_take_screenshot`),
 * but `TOOL_FS_PROFILES` (fs-guard.ts) is indexed by the BARE suffix
 * (`browser_take_screenshot`) — just as the static governance of `tools:` in
 * `schema/pipeline.ts` (`parsePipeline`) and the schema drift check of
 * `doctor` (`preflight/check.ts`) already do, both stripping the same prefix
 * before consulting the table. This hook was the only one of the three
 * consumers that did NOT, and without this normalization EVERY call to a real
 * MCP tool fell into `if (!profile) return deny('unknown tool for the
 * engine')` of `evaluateToolCall`, in practice denying the 18+ Playwright
 * tools a real pipeline grants — failing closed (never a security leak), but
 * leaving the MCP half of the table never applied.
 *
 * The prefix is only stripped for a server THIS step really enabled
 * (`mcpServerNames`, `step.mcpServers`) — never blindly for any
 * `mcp__<something>__`: if it were stripped without checking the server name,
 * a tool from an ungoverned or unexpected server could accidentally inherit
 * the profile of a Playwright tool that merely shares the suffix. A native
 * name with no prefix (`Read`, `Bash`...) matches no pattern and is returned
 * as is.
 */
function normalizeToolName(toolName: string, mcpServerNames: readonly string[]): string {
  for (const server of mcpServerNames) {
    const prefix = `mcp__${server}__`;
    if (toolName.startsWith(prefix)) return toolName.slice(prefix.length);
  }
  return toolName;
}

/**
 * Builds the `PreToolUse` hook for a step, closed over `roots`, a mutable
 * denial log (`hookLog`, populated as a side effect every time the hook
 * denies — `buildDenials` consumes it at the end of the step) and the MCP
 * server names the step enabled (`mcpServerNames`, for
 * `normalizeToolName`). The whole body is wrapped in a single `try/catch`
 * that never lets an exception escape — `evaluateToolCall` no longer throws
 * on its own, but this layer is the safety net if something in the future
 * broke that guarantee before a test caught it: the sandbox never fails
 * open, and when in doubt it denies.
 */
function makePreToolUseHook(
  roots: FsRoots,
  hookLog: Map<string, { toolName: string; reason: string }>,
  mcpServerNames: readonly string[],
): (input: HookInput, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<HookJSONOutput> {
  return async (input, toolUseId) => {
    try {
      if (input.hook_event_name !== 'PreToolUse') return {};
      // `hookLog`/the final result ALWAYS use the name exactly as the SDK
      // reported it (`input.tool_name`, qualified if MCP) — that is what
      // `result.permission_denials` uses too, so `buildDenials` pairs them by
      // the same name. Only the LOOKUP in `TOOL_FS_PROFILES` uses the
      // normalized suffix.
      const normalized = normalizeToolName(input.tool_name, mcpServerNames);
      const result = evaluateToolCall(normalized, input.tool_input, roots);
      if (result.allowed) {
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
      }
      if (toolUseId) hookLog.set(toolUseId, { toolName: input.tool_name, reason: result.reason });
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: result.reason,
        },
      };
    } catch (err) {
      const reason = `internal hook error — denied by default (${(err as Error).message})`;
      if (toolUseId) hookLog.set(toolUseId, { toolName: (input as { tool_name?: string }).tool_name ?? '?', reason });
      return {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
      };
    }
  };
}

/**
 * Error categories the SDK itself assigns to a failed `assistant` turn
 * (`SDKAssistantMessage.error`, `sdk.d.ts` line ~2933) or to an internal
 * retry the CLI itself performs (`SDKAPIRetryMessage.error`, line ~2924) —
 * same `SDKAssistantMessageError` type in both places (line ~2976). These
 * are the three categories whose origin is the server/network side, not the
 * content of the request: the same request can succeed on a second attempt.
 * The rest of the enum's categories ('authentication_failed',
 * 'oauth_org_not_allowed', 'billing_error', 'invalid_request',
 * 'model_not_found', 'max_output_tokens') are about configuration,
 * credentials or content — retrying the same request does not resolve them.
 */
const TRANSIENT_ASSISTANT_ERRORS: ReadonlySet<SDKAssistantMessageError> = new Set([
  'rate_limit',
  'overloaded',
  'server_error',
]);

/**
 * Subtypes of `SDKResultError` (`sdk.d.ts` line ~4352) that are NOT a
 * transient server-side failure under any interpretation: running out of
 * turns, of the USD budget or of structured-output retries are configuration
 * or content conditions, not network ones — repeating the same request does
 * not resolve them. Only `error_during_execution` is a catch-all that may or
 * may not be a real API error; for that case the text-matching fallback
 * (`isTransientText`) is used when no structured category was observed
 * during the stream.
 */
const NON_TRANSIENT_RESULT_SUBTYPES: ReadonlySet<SDKResultError['subtype']> = new Set([
  'error_max_turns',
  'error_max_budget_usd',
  'error_max_structured_output_retries',
]);

/**
 * Text-matching fallback for two cases that carry no structured category
 * from the SDK: an exception thrown by `queryFn` (transport failure before
 * any message exists) and an `SDKResultError` with `subtype:
 * 'error_during_execution'` where neither `SDKAssistantMessage.error` nor
 * `SDKAPIRetryMessage.error` was ever observed during the stream.
 *
 * They are compared as delimited fragments, not as a free substring: a naive
 * `.includes('429')` would confuse HTTP code 429 with, for example, the
 * number "14290" in "processed 14290 items". The delimiter cannot be
 * JavaScript's native `\b` because it treats `_` as a word character, and the
 * real error types of the Anthropic API are snake_case (`overloaded_error`,
 * `rate_limit_error`): with `\b`, `/\boverloaded\b/` does NOT match inside
 * "overloaded_error" because there is no word boundary between "d" and "_".
 * Here the boundary is defined as "non-alphanumeric" (it includes `_`,
 * spaces, `:`, start/end of string), so a pattern isolated by underscores
 * still matches.
 */
const TRANSIENT_TEXT_PATTERNS = [
  'overloaded',
  'rate_limit',
  'timeout',
  'econnreset',
  'etimedout',
  'socket hang up',
  '429',
  '529',
  '503',
];

/** Does `pattern` appear in `text` delimited by non-alphanumeric characters (or the string's ends)? */
function containsDelimited(text: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`).test(text);
}

/**
 * Free text is classified as transient only if it matches a known pattern.
 * An unrecognized error is classified as NOT transient (permanent): an agent
 * step may have `Bash` or other tools with real effects in `tools`, so
 * blindly retrying on an error that is not understood risks repeating those
 * effects and spending API budget with no guarantee of success. The
 * conservative classification is to stop the run and let a person decide,
 * not to retry by default. Same safe default `classifyResultError` uses for
 * its own "unrecognized" category.
 */
function isTransientText(message: string): boolean {
  const lower = message.toLowerCase();
  return TRANSIENT_TEXT_PATTERNS.some((p) => containsDelimited(lower, p));
}

/**
 * Classifies an `SDKResultError` as transient or permanent. `subtype` comes
 * first, not `lastStructuredError`: the three exhaustion subtypes (turns,
 * budget, structured-output retries) are ALWAYS permanent regardless of what
 * happened along the way — if an intermediate turn saw 'overloaded' and the
 * CLI itself retried it successfully (see `SDKAPIRetryMessage` below), but
 * the query ended up running out of turns anyway, the real reason for the
 * failure is "ran out of turns", not "the server was overloaded" — that
 * hiccup was already absorbed and retrying our step from scratch will not fix
 * it just because of that. That is why `lastStructuredError` is only
 * consulted inside the ambiguous `error_during_execution` category; if there
 * is none either, it falls back to the text match over `errors`. An
 * unrecognized `subtype`/category falls on the safe side (not transient),
 * just like `isTransientText`.
 */
function classifyResultError(
  result: SDKResultError,
  lastStructuredError: SDKAssistantMessageError | undefined,
): boolean {
  if (NON_TRANSIENT_RESULT_SUBTYPES.has(result.subtype)) return false;
  if (lastStructuredError) return TRANSIENT_ASSISTANT_ERRORS.has(lastStructuredError);
  return isTransientText(result.errors.join(' '));
}

function typeToSchema(type: OutputType): unknown {
  if (type.endsWith('[]')) {
    return { type: 'array', items: { type: type.slice(0, -2) } };
  }
  return { type };
}

/** Translates the `outputs` contract into a JSON Schema for the SDK's `outputFormat`. */
export function outputsToJsonSchema(
  contract: Record<string, OutputType>,
): JsonSchemaObject {
  const properties: Record<string, unknown> = {};
  for (const [name, type] of Object.entries(contract)) {
    properties[name] = typeToSchema(type);
  }
  return {
    type: 'object',
    properties,
    required: Object.keys(contract),
    additionalProperties: false,
  };
}

/**
 * Non-secret network variables forwarded to EVERY declared MCP server, in
 * addition to the explicit `env` names of each one. An MCP server's typical
 * `command` is `npx`, which resolves the package against the registry on
 * every start; without this, a pipeline behind a corporate proxy fails to
 * start the server with a network error nothing in the YAML explains, and
 * there is no way to declare them via `env` because that field only resolves
 * names present in `requires.env` (meant for secrets, not network
 * configuration). A different list from `AGENT_AUTH_ENV_KEYS` in `shell.ts`
 * on purpose: those carry credentials (`ANTHROPIC_API_KEY`...) that a generic
 * MCP server does not need to see; these are not secret, so they are always
 * forwarded, not only when the pipeline declares them.
 */
const MCP_NETWORK_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE'];

/**
 * Resolves the names in `step.mcpServers` against the pipeline's
 * `mcp_servers` registry, into the `McpStdioServerConfig` shape `Options`
 * expects (`sdk.d.ts` ~1167). The return type is anchored to the SDK's own
 * `Options['mcpServers']` (not an invented shape): if a future SDK version
 * changes that shape, this breaks `tsc`, not a 3am cron — same criterion
 * that already governs `SDKMessage` in the rest of this module.
 * `parsePipeline` already guarantees that every name a step references
 * exists in the registry — the `!` below relies on that guarantee, it is not
 * an assumption of this module.
 *
 * `command`/`args` are interpolated against `scope` just like `cwd`/`prompt`
 * (same mechanism, same reason: a `command` or `args` that depends on
 * `{{params.*}}` without hardcoding a machine path, e.g. a binary installed
 * at a different user path on each machine). The dependency graph does NOT
 * see these references — same limit already accepted for the content of
 * prompt files: an MCP server whose `command` depended on the output of
 * ANOTHER step is outside what this field covers.
 *
 * Each server's `env` entries are NAMES (see `mcpServerSchema` in
 * `schema/pipeline.ts`), resolved here against `secrets` — the same values
 * `requires.env` already filtered. A name with no value in `secrets`
 * (declared on the server but not in the pipeline's `requires.env`) is
 * omitted instead of throwing: the MCP server will start without that
 * variable and fail with its own authentication error, which is more
 * diagnosable for whoever writes the pipeline than a generic exception from
 * this runner.
 */
function resolveMcpServers(
  names: string[],
  registry: Record<string, McpServerConfig>,
  secrets: Record<string, string>,
  scope: InterpolationScope,
): NonNullable<Options['mcpServers']> {
  const resolved: NonNullable<Options['mcpServers']> = {};
  for (const name of names) {
    const config = registry[name]!;
    const env: Record<string, string> = {};
    for (const key of MCP_NETWORK_ENV_KEYS) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    for (const key of config.env) {
      const value = secrets[key];
      if (value !== undefined) env[key] = value;
    }
    resolved[name] = {
      command: interpolate(config.command, scope),
      args: config.args.map((arg) => interpolate(arg, scope)),
      env,
    };
  }
  return resolved;
}

/**
 * Splits the YAML front matter (delimited by `---` at the start of the file)
 * from the body of a Markdown agent. The body is the agent's prompt exactly
 * as `AgentDefinition.prompt` expects it.
 *
 * A file WITHOUT `---` delimiters is not an error: it is treated as if all of
 * it were body (empty front matter) — the normal case of a prompt with no
 * metadata, and `loadRepoAgents` must keep loading it.
 *
 * When there ARE delimiters but what is inside is not usable as front matter
 * — syntactically invalid YAML, or valid YAML that is not a key-value mapping
 * (a list, a scalar...) — this function throws. That is intentional:
 * `loadRepoAgents` catches that exception per file, so that a broken agent is
 * skipped with a warning instead of taking the others down.
 */
function parseAgentMarkdown(text: string): { frontMatter: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { frontMatter: {}, body: text };
  const parsed: unknown = parseYaml(match[1] ?? '');
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('the front matter is not a YAML key: value mapping');
  }
  return { frontMatter: parsed as Record<string, unknown>, body: match[2] ?? '' };
}

/**
 * Loads the pipeline repo's own agents (`<repoRoot>/agents/*.md`) into the
 * shape the SDK's `Options.agents` expects (`AgentDefinition`, `sdk.d.ts`
 * ~38-70): `description` from the front matter and the Markdown body as
 * `prompt`. The agent's name is the file name without `.md`, just as
 * `preflight` already does (`markdownNames` in `preflight/check.ts`) for
 * `doctor`'s `✓ agent <name> repo` check — so an agent that passes that check
 * is exactly the one loaded here and passed to the SDK. Before this function
 * `AgentStepContext.repoRoot` was received but never read: the runner never
 * got to inject the repo's agents.
 *
 * A missing `agents/` directory is normal (not every pipeline brings its own
 * agents) and does not throw, just like `markdownNames`.
 *
 * Loading each file is independent: it is best-effort discovery, not a
 * validation gate. A file that cannot be read or whose front matter cannot be
 * interpreted is SKIPPED with a warning naming the file and the reason —
 * it never aborts the whole directory. Before, an exception from
 * `parseAgentMarkdown` on a single broken `.md` escaped the loop and also
 * discarded the valid agents already loaded; a step that did not even use
 * the broken agent failed anyway.
 */
export async function loadRepoAgents(repoRoot: string): Promise<Record<string, AgentDefinition>> {
  let entries: string[];
  try {
    entries = await readdir(join(repoRoot, 'agents'));
  } catch {
    return {};
  }

  const agents: Record<string, AgentDefinition> = {};
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const name = entry.slice(0, -3);
    const path = join(repoRoot, 'agents', entry);

    let frontMatter: Record<string, unknown>;
    let body: string;
    try {
      const text = await readFile(path, 'utf8');
      ({ frontMatter, body } = parseAgentMarkdown(text));
    } catch (err) {
      console.warn(
        `Warning: skipping agent "${name}" (${path}): ${(err as Error).message}`,
      );
      continue;
    }

    const definition: AgentDefinition = {
      description: typeof frontMatter.description === 'string' ? frontMatter.description : '',
      prompt: body.trim(),
    };
    if (Array.isArray(frontMatter.tools) && frontMatter.tools.every((t) => typeof t === 'string')) {
      definition.tools = frontMatter.tools as string[];
    } else if (typeof frontMatter.tools === 'string') {
      definition.tools = frontMatter.tools
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
    }
    if (typeof frontMatter.model === 'string') definition.model = frontMatter.model;
    agents[name] = definition;
  }
  return agents;
}

/**
 * Redacts the `reason` of each denial (where present) — same criterion as the
 * rest of `redactOutcome`, applied separately because `denials` is a nested
 * array that `redactSecrets` (meant for plain text) cannot touch on its own.
 * Necessary because `reason` (`evaluateToolCall`, fs-guard.ts) embeds the raw
 * path exactly as the model asked for it (`"${raw}" resolves outside every
 * allowed root...`), and an agent prompt CAN interpolate `{{secrets.X}}` in
 * its own text (see the comment about `scope`/`secrets` in `runAgentStep`) —
 * so a secret that ends up inside a denied path would reach that run's
 * `run.json` inside `.runs/` in the clear without this redaction.
 */
function redactDenials(denials: Denial[] | undefined, values: string[]): Denial[] | undefined {
  if (!denials) return denials;
  return denials.map((d) =>
    d.reason === undefined ? d : { ...d, reason: redactSecrets(d.reason, values) },
  );
}

/**
 * Redacts the secret values of an AgentOutcome before it leaves this
 * function, on every return path of `runAgentStep` (success, failure,
 * timeout, contract violation). Same criterion as `redactOutcome` in
 * `shell.ts`: the secret value exists in the clear only inside this function
 * (it has to be passed to the SDK via `env`), so it is also the only point
 * where it must be guaranteed not to survive the output — from here on the
 * outcome is written to `.runs/` and printed by the CLI. `log`, `error`, the
 * text values inside `outputs` and the `reason` of each denial
 * (`denials[].reason`, see `redactDenials`) are redacted; an agent step with
 * `Bash` in `tools` can echo a secret in its own result exactly like a
 * `shell` step, so the same treatment applies here.
 *
 * The two branches that do `{ ...outcome, ... }` (success with no contract
 * violation, and failure) do NOT inherit already-redacted `denials` just from
 * the spread: `outcome.denials` travels as is inside that spread unless it is
 * explicitly overwritten here — hence the `denials: redactDenials(...)` in
 * all three branches, not only in the one that builds a new object.
 */
function redactOutcome(outcome: AgentOutcome, secrets: Record<string, string>): AgentOutcome {
  const values = Object.values(secrets);
  if (outcome.ok) {
    const redacted = redactOutputValues(outcome.outputs, values);
    if (!redacted.ok) {
      const issues = redacted.violatingFields.map(
        (field) => `field "${field}" contains a secret value`,
      );
      return {
        ok: false,
        error: redactSecrets(`Contract not met: ${issues.join('; ')}`, values),
        transient: false,
        log: redactSecrets(outcome.log, values),
        durationMs: outcome.durationMs,
        costUsd: outcome.costUsd,
        inputTokens: outcome.inputTokens,
        outputTokens: outcome.outputTokens,
        toolsUsed: outcome.toolsUsed,
        denials: redactDenials(outcome.denials, values),
      };
    }
    return {
      ...outcome,
      outputs: redacted.outputs,
      log: redactSecrets(outcome.log, values),
      denials: redactDenials(outcome.denials, values),
    };
  }
  return {
    ...outcome,
    log: redactSecrets(outcome.log, values),
    error: redactSecrets(outcome.error, values),
    denials: redactDenials(outcome.denials, values),
  };
}

/**
 * Runs an agent step against the Claude Agent SDK.
 *
 * `permissionMode: 'bypassPermissions'` is deliberate: an unattended run has
 * nobody to approve anything. The real control over what the step can do is
 * `tools` (decision 15): `allowedTools` on its own restricts NOTHING — it is
 * only the list that is auto-approved without asking (`sdk.d.ts`
 * ~1369-1371, "To restrict which tools are available, use the `tools` option
 * instead") — so both are passed: `tools` so the SDK exposes nothing to the
 * model outside what the YAML declares, and `allowedTools` so that what is
 * declared does not trigger a permission prompt that, under
 * `bypassPermissions`, nobody would ever answer.
 *
 * `strictMcpConfig: true` is the same logic applied to `mcpServers`: without
 * it, `Options.mcpServers` is ADDITIVE to any project `.mcp.json`, user MCP
 * server or plugin MCP server already configured on the machine running the
 * pipeline (`sdk.d.ts` ~2006) — the pipeline would declare one server and the
 * step would start that one PLUS whatever was lying around, without
 * `mcp_servers:` or `doctor` knowing anything about them. Verified in a
 * review of this same change: a `.mcp.json` from another repo with database
 * credentials in the clear in its `args` is exactly the kind of "ambient"
 * server this avoids loading.
 *
 * `settingSources: []`: no ambient sources, neither `user` nor `project`.
 * It used to pass `['user']` with no written justification — it loaded the
 * operator's GLOBAL `~/.claude/settings.json`, hooks included. Verified live:
 * a single installed plugin that ships a blocking `SessionStart` hook is
 * enough to hang an unattended run, the same kind of hang the original bash
 * script deliberately avoided with `--setting-sources project`. Same
 * criterion as `strictMcpConfig: true`: a pipeline inherits nothing from the
 * machine running it except what its own YAML declares.
 */
export async function runAgentStep(
  step: AgentStep,
  ctx: AgentStepContext,
): Promise<AgentOutcome> {
  const started = Date.now();
  // Local copy of the scope, only for the prompt: `ctx.scope` itself never
  // carries `secrets` (orchestrate.ts builds it without that field), so
  // `{{secrets.X}}` cannot resolve anywhere else (`cwd:` of this same step,
  // `run:`/`shell:` guard of any other): a secret only reaches the prompt of
  // the agent step that asks for it.
  const prompt = interpolate(ctx.promptText, { ...ctx.scope, secrets: ctx.promptSecrets ?? ctx.secrets });
  const cwd = step.cwd ? interpolate(step.cwd, ctx.scope) : ctx.defaultCwd;
  const additionalDirs = step.additionalDirs.map((d) => interpolate(d, ctx.scope));
  // Resolve the roots BEFORE creating the AbortController/timer: if
  // `captureRoots` throws (a root does not exist), the step must close as a
  // configuration error without leaking a timer of up to 50 minutes that
  // nobody would clean up. That is why the order of these lines matters.
  const roots = captureRoots(cwd, additionalDirs);
  const hookLog = new Map<string, { toolName: string; reason: string }>();
  const agents = await loadRepoAgents(ctx.repoRoot);
  const mcpServers = resolveMcpServers(step.mcpServers, ctx.mcpServers, ctx.secrets, ctx.scope);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);

  const options: Record<string, unknown> = {
    agent: step.agent,
    agents,
    allowedTools: step.tools,
    tools: step.tools,
    cwd,
    additionalDirectories: additionalDirs, // informational for the SDK/model — the real enforcement is the hook
    env: composeAgentEnv(ctx.secrets, ctx.agentAuth),
    settingSources: [],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    strictMcpConfig: true,
    abortController: controller,
    persistSession: false,
    hooks: { PreToolUse: [{ hooks: [makePreToolUseHook(roots, hookLog, step.mcpServers)] }] },
  };
  if (step.outputs) {
    options.outputFormat = { type: 'json_schema', schema: outputsToJsonSchema(step.outputs) };
  }
  if (Object.keys(mcpServers).length > 0) options.mcpServers = mcpServers;
  if (step.maxCostUsd !== undefined) options.maxBudgetUsd = step.maxCostUsd;

  // `options` is built as `Record<string, unknown>` to match the signature of
  // `QueryFn` (the one under test), while the real `query()` expects
  // `Options`, a type with dozens of concrete fields. No cast is needed to go
  // from one to the other: in `Options` (SDK 0.3.223) all top-level fields
  // are optional, so TypeScript does not require the index signature of
  // `Record<string, unknown>` to be compatible with each field's concrete
  // type — it only checks that no required field is missing, and there is
  // none. The return value of `query()` needs no cast either: `Query`
  // extends `AsyncGenerator<SDKMessage, void>`, which is already an
  // `AsyncIterable<SDKMessage>` — exactly what `QueryFn` declares. Verified by
  // removing both casts and checking that `bun run typecheck` stays clean:
  // they were not needed and were not hiding any real error.
  const run = ctx.queryFn ?? ((args) => query(args));

  const toolsUsed: string[] = [];
  const transcript: string[] = [];
  let result: SDKResultMessage | undefined;
  // Last structured error category seen in the stream, from
  // `SDKAssistantMessage.error` or `SDKAPIRetryMessage.error` (see
  // `classifyResultError`). It is overwritten with the most recent one: if the
  // CLI retried internally several times, the category closest to the final
  // failure is the most representative of why it ended up failing.
  let lastStructuredError: SDKAssistantMessageError | undefined;

  try {
    for await (const message of run({ prompt, options })) {
      if (message.type === 'assistant') {
        // Tool usage travels inside the content blocks of the `assistant`
        // message (`BetaContentBlock` with `type: 'tool_use'`), not as
        // standalone `tool_use` messages — the real SDK does not emit them
        // that way.
        for (const block of message.message.content) {
          if (block.type === 'tool_use' && !toolsUsed.includes(block.name)) {
            toolsUsed.push(block.name);
            transcript.push(`[tool] ${block.name}`);
          }
        }
        if (message.error) lastStructuredError = message.error;
      } else if (message.type === 'system' && message.subtype === 'api_retry') {
        lastStructuredError = message.error;
      } else if (message.type === 'result') {
        result = message;
      }
    }
  } catch (err) {
    clearTimeout(timer);
    const message = (err as Error).message;
    return redactOutcome(
      {
        ok: false,
        error: controller.signal.aborted ? `timed out after ${ctx.timeoutMs} ms` : message,
        transient: controller.signal.aborted || isTransientText(message),
        log: transcript.join('\n'),
        durationMs: Date.now() - started,
        toolsUsed,
        denials: buildDenials(hookLog, []),
      },
      ctx.secrets,
    );
  }

  clearTimeout(timer);

  if (!result) {
    // The stream ended (without throwing) never having emitted a `result`
    // message. It is an unrecognized condition, not a known transport
    // artifact: nothing in the SDK types documents it as transient, and
    // "the agent did nothing" cannot be told apart from "it did everything
    // and lost the final message". The same criterion that governs the rest
    // of this classification applies here: when in doubt, NOT transient — an
    // agent step may have `Bash` with real effects in `tools`, and retrying
    // blindly risks repeating them.
    return redactOutcome(
      {
        ok: false,
        error: 'the SDK ended the stream without emitting any result message',
        transient: false,
        log: transcript.join('\n'),
        durationMs: Date.now() - started,
        toolsUsed,
        denials: buildDenials(hookLog, []),
      },
      ctx.secrets,
    );
  }

  const durationMs = result.duration_ms;
  const metrics = {
    costUsd: result.total_cost_usd,
    inputTokens: result.usage.input_tokens,
    outputTokens: result.usage.output_tokens,
    toolsUsed,
    denials: buildDenials(hookLog, result.permission_denials),
  };

  if (result.subtype !== 'success') {
    const log = [...transcript, result.errors.join('\n')].join('\n');
    return redactOutcome(
      {
        ok: false,
        error: result.errors.join('; ') || `SDK failure: ${result.subtype}`,
        transient: classifyResultError(result, lastStructuredError),
        log,
        durationMs,
        ...metrics,
      },
      ctx.secrets,
    );
  }

  const log = [...transcript, result.result].join('\n');

  if (!step.outputs) return redactOutcome({ ok: true, outputs: {}, log, durationMs, ...metrics }, ctx.secrets);

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.result);
  } catch {
    return redactOutcome(
      {
        ok: false,
        error: 'the step declares outputs but the result is not valid JSON',
        transient: false,
        log,
        durationMs,
        ...metrics,
      },
      ctx.secrets,
    );
  }

  try {
    return redactOutcome(
      { ok: true, outputs: validateOutputs(parsed, step.outputs, step.id), log, durationMs, ...metrics },
      ctx.secrets,
    );
  } catch (err) {
    return redactOutcome(
      { ok: false, error: (err as Error).message, transient: false, log, durationMs, ...metrics },
      ctx.secrets,
    );
  }
}
