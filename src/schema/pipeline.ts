import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { HARD_DENY_TOOLS, TOOL_FS_PROFILES } from '../runner/fs-guard.ts';

/** Parse or validation error of a pipeline.yaml. */
export class PipelineParseError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid pipeline.yaml:\n  - ${issues.join('\n  - ')}`);
    this.name = 'PipelineParseError';
    this.issues = issues;
  }
}

/** Data types allowed in an `outputs` contract. */
const OUTPUT_TYPES = [
  'string',
  'number',
  'boolean',
  'string[]',
  'number[]',
  'boolean[]',
] as const;
export type OutputType = (typeof OUTPUT_TYPES)[number];

const durationSchema = z
  .string()
  .regex(/^\d+(s|m|h)$/, 'must be a number followed by s, m or h (e.g. 30m)');

const retrySchema = z.union([
  z.number().int().min(0),
  z.object({
    attempts: z.number().int().min(0),
    on: z.enum(['transient', 'any']).default('transient'),
  }),
]);

const throttleGuardSchema = z
  .object({
    throttle: z.union([
      durationSchema,
      z
        .object({
          every: durationSchema,
          since: z.enum(['last_success', 'last_attempt']).default('last_success'),
        })
        .strict(),
    ]),
  })
  .strict();
const changedGuardSchema = z
  .object({
    changed: z
      .object({
        path: z.string(),
        since: z.enum(['last_success', 'last_attempt']).default('last_success'),
      })
      .strict(),
  })
  .strict();
const shellGuardSchema = z.object({ shell: z.string() }).strict();
const betweenGuardSchema = z
  .object({
    between: z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/, 'must have the form HH:MM-HH:MM'),
  })
  .strict();

const guardSchema = z.union([
  throttleGuardSchema,
  changedGuardSchema,
  shellGuardSchema,
  betweenGuardSchema,
]);

const GUARD_BRANCHES = {
  throttle: throttleGuardSchema,
  changed: changedGuardSchema,
  shell: shellGuardSchema,
  between: betweenGuardSchema,
} as const;
type GuardKey = keyof typeof GUARD_BRANCHES;
const GUARD_KEYS = Object.keys(GUARD_BRANCHES) as GuardKey[];

/**
 * Validates a `when:` guard (`raw`) against the schema of its real branch,
 * identified by which of the four known keys the object carries.
 * Same reason and same pattern as `parseStepAt` a bit further down: a bare
 * `z.union` gives "does not match any option" without naming the real
 * field that fails.
 */
function parseGuardAt(raw: unknown, index: number): { data?: Guard; issues: string[] } {
  if (raw === null || typeof raw !== 'object') {
    return {
      issues: [`when.${index}: must be an object with one of the keys throttle, changed, shell or between`],
    };
  }
  const presentKeys = GUARD_KEYS.filter((k) => k in (raw as object));
  if (presentKeys.length !== 1) {
    return {
      issues: [
        presentKeys.length === 0
          ? `when.${index}: must declare one of the keys throttle, changed, shell or between`
          : `when.${index}: must declare a single guard key, found: ${presentKeys.join(', ')}`,
      ],
    };
  }
  const key = presentKeys[0]!;
  const result = GUARD_BRANCHES[key].safeParse(raw);
  if (!result.success) {
    return {
      issues: result.error.issues.map(
        (i) => `when.${index}.${i.path.join('.') || key}: ${i.message}`,
      ),
    };
  }
  return { data: result.data as Guard, issues: [] };
}

const paramSchema = z.object({
  description: z.string(),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

const requiresSchema = z.object({
  agents: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  bin: z.array(z.string()).default([]),
  env: z.array(z.string()).default([]),
  net: z.array(z.string()).default([]),
});

/**
 * MCP stdio server (`sdk.d.ts` `McpStdioServerConfig`): same shape as
 * `command`/`args`/`env` of a `.mcp.json`. Only stdio for now — no real
 * pipeline needs SSE/HTTP yet; they get added when needed.
 *
 * `env` is a list of NAMES, not values — like `requires.env`: the value is
 * resolved at runtime from the secrets already declared in `requires.env`
 * and never lives in clear text in the YAML.
 */
const mcpServerSchema = z
  .object({
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.array(z.string()).default([]),
    /**
     * Identifies which MCP package it is, for the governance of `tools:`
     * — the name the author gives the server in `mcp_servers:` is arbitrary,
     * so the engine cannot know on its own whether "pw" is Playwright. If
     * undeclared, no tool of that server passes `validate` — same
     * deny-by-default criterion as the rest.
     */
    kind: z.enum(['playwright']).optional(),
  })
  .strict();

const baseStepSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase kebab-case'),
    cwd: z.string().optional(),
    inputs: z.array(z.string()).default([]),
    outputs: z.record(z.enum(OUTPUT_TYPES)).optional(),
    when: z.string().optional(),
    retry: retrySchema.optional(),
    on_error: z.enum(['stop', 'continue']).optional(),
    timeout: durationSchema.optional(),
    effects: z.array(z.string()).default([]),
  })
  .strict();

const agentStepSchema = baseStepSchema.extend({
  type: z.literal('agent').default('agent'),
  agent: z.string(),
  prompt: z.string(),
  tools: z.array(z.string()).optional(),
  /** Names from the pipeline's `mcp_servers` registry that this step enables. */
  mcp_servers: z.array(z.string()).default([]),
  /** Read-only directories outside cwd that this step can reach. */
  additional_dirs: z.array(z.string()).default([]),
  /**
   * Spending cap in USD for THIS step, mapped 1:1 to `Options.maxBudgetUsd`
   * of the Agent SDK (native support — `sdk.d.ts` ~1683). No cap if not
   * declared.
   */
  max_cost_usd: z.number().positive().optional(),
});

const shellStepSchema = baseStepSchema.extend({
  type: z.literal('shell'),
  run: z.string(),
});

/**
 * A step of `always:` (pipeline level): a list of cleanup actions that
 * always run when the run closes, success or failure. Deliberately without
 * `inputs`/`outputs`/`when`/`on_error`: they take no part in the dependency
 * graph or the run's error policy.
 */
const alwaysStepSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase kebab-case'),
    run: z.string(),
    cwd: z.string().optional(),
    timeout: durationSchema.optional(),
  })
  .strict();

type ShellStepData = z.infer<typeof shellStepSchema>;
type AgentStepData = z.infer<typeof agentStepSchema>;
type StepData = ShellStepData | AgentStepData;

/**
 * Validates an individual step (`raw`) against the schema of its real
 * `type`, treating a missing `type` as 'agent'.
 *
 * Why this indirection instead of `z.discriminatedUnion('type', ...)`:
 * the `type` discriminant carries `.default('agent')` on the agent branch (a
 * step without `type` must parse as agent), but in zod 3.25.76 routing by
 * discriminant happens BEFORE `.default()`s are resolved — verified
 * empirically: an object without `type` fits no branch and the failure is a
 * generic "Invalid discriminator value". Worse, when both branches fail for
 * the same reason (e.g. a required field is missing), Zod cannot decide
 * which was the "right" branch and collapses the error into an "Invalid
 * input" that does not name the real field. So a manual second pass is done
 * here: the branch is chosen from the raw `type` and only that branch is
 * reparsed, so the resulting issue names the exact missing field (e.g.
 * `steps.0.prompt`) instead of a generic `steps.0: Invalid input`.
 */
function parseStepAt(raw: unknown, index: number): { data?: StepData; issues: string[] } {
  const rawType =
    raw !== null && typeof raw === 'object' && 'type' in raw
      ? (raw as { type?: unknown }).type
      : undefined;

  if (rawType !== undefined && rawType !== 'shell' && rawType !== 'agent') {
    return { issues: [`steps.${index}.type: must be "shell" or "agent"`] };
  }

  const schema = rawType === 'shell' ? shellStepSchema : agentStepSchema;
  const result = schema.safeParse(raw);
  if (!result.success) {
    return {
      issues: result.error.issues.map(
        (i) => `steps.${index}.${i.path.join('.') || '(root)'}: ${i.message}`,
      ),
    };
  }
  return { data: result.data, issues: [] };
}

const defaultsSchema = z
  .object({
    on_error: z.enum(['stop', 'continue']).default('stop'),
    retry: retrySchema.default(0),
    timeout: durationSchema.default('15m'),
  })
  .strict();

const pipelineSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase kebab-case'),
    description: z.string().min(1),
    version: z.number().int().min(1),
    params: z.record(paramSchema).default({}),
    requires: requiresSchema.default({}),
    // Same shape as `id` (kebab-case): the name becomes part of the tool
    // prefix `mcp__<name>__<tool>` that the author writes by hand in
    // `tools:`, so a space or an embedded `__` would make it unreadable or
    // ambiguous to write.
    mcp_servers: z
      .record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase kebab-case'), mcpServerSchema)
      .default({}),
    when: z.array(z.record(z.unknown())).default([]),
    triggers: z.array(z.object({ cron: z.string() })).default([]),
    // `stale_after`: fires the channel when the pipeline has gone that
    // window without a single successful run, whatever the state of the
    // current run. It is the signal `on:` cannot give — a bare
    // `on: [skipped]` would be noise (with `throttle: 46h` on a daily cron,
    // half the nights skip by design), whereas "it has not really run for
    // three days" is always worth a notice. See `notify/dispatch.ts`.
    //
    // `.strict()`: without it, a misspelled `stale_afer:` would be ignored
    // silently, which is exactly the class of silent failure this field
    // exists to detect.
    notify: z
      .object({
        on: z.array(z.enum(['failed', 'success', 'skipped'])),
        stale_after: durationSchema.optional(),
        channel: z.string(),
      })
      .strict()
      .optional(),
    defaults: defaultsSchema.default({}),
    // The fine shape of each step (according to its `type`) is validated
    // separately, in parseStepAt — see the comment there.
    steps: z.array(z.record(z.unknown())).min(1),
    always: z.array(alwaysStepSchema).default([]),
  })
  .strict();

/** Tools allowed when an agent step does not declare `tools`. */
export const DEFAULT_TOOLS = ['Read', 'Grep', 'Glob'] as const;

/** Tool names known as "no filesystem surface" for each kind. */
const MCP_TOOLS_BY_KIND: Record<'playwright', ReadonlySet<string>> = {
  playwright: new Set(Object.keys(TOOL_FS_PROFILES).filter((name) => name.startsWith('browser_'))),
};

export type Guard = z.infer<typeof guardSchema>;
export type Requires = z.infer<typeof requiresSchema>;
export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type RetryPolicy = { attempts: number; on: 'transient' | 'any' };

type StepCommon = {
  id: string;
  cwd?: string;
  inputs: string[];
  outputs?: Record<string, OutputType>;
  when?: string;
  effects: string[];
  /** Already resolved against `defaults`; never undefined after parsing. */
  retry: RetryPolicy;
  onError: 'stop' | 'continue';
  timeout: string;
};

export type AgentStep = StepCommon & {
  type: 'agent';
  agent: string;
  prompt: string;
  tools: string[];
  /** Names from the pipeline's `mcpServers` registry that this step enables. */
  mcpServers: string[];
  /** Additional directory names, already interpolable as cwd (params only, never secrets). */
  additionalDirs: string[];
  maxCostUsd?: number;
};

export type ShellStep = StepCommon & { type: 'shell'; run: string };

export type Step = AgentStep | ShellStep;

export type Pipeline = {
  name: string;
  description: string;
  version: number;
  params: Record<string, z.infer<typeof paramSchema>>;
  requires: Requires;
  mcpServers: Record<string, McpServerConfig>;
  when: Guard[];
  triggers: { cron: string }[];
  notify?: {
    on: ('failed' | 'success' | 'skipped')[];
    /** Window with no successful run after which to notify anyway. */
    staleAfter?: string;
    channel: string;
  };
  steps: Step[];
  always: ShellStep[];
};

function normalizeRetry(raw: z.infer<typeof retrySchema>): RetryPolicy {
  return typeof raw === 'number' ? { attempts: raw, on: 'transient' } : raw;
}

/**
 * Parses and validates a pipeline.yaml. Resolves the pipeline's `defaults`
 * into each step, so the rest of the system never sees a policy field
 * without a value.
 */
export function parsePipeline(yamlText: string): Pipeline {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new PipelineParseError([`Malformed YAML: ${(err as Error).message}`]);
  }

  const result = pipelineSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new PipelineParseError(issues);
  }
  const parsed = result.data;

  // Second pass: each step is validated against the schema of its real
  // `type` (see parseStepAt) so errors name the specific field.
  const stepIssues: string[] = [];
  const validatedSteps: StepData[] = [];
  parsed.steps.forEach((rawStep, index) => {
    const { data, issues } = parseStepAt(rawStep, index);
    if (data) validatedSteps.push(data);
    stepIssues.push(...issues);
  });
  if (stepIssues.length > 0) throw new PipelineParseError(stepIssues);

  // Second pass, same reason as for steps: each `when` guard is validated
  // against the schema of its real branch (see parseGuardAt) so errors name
  // the specific field.
  const guardIssues: string[] = [];
  const validatedGuards: Guard[] = [];
  parsed.when.forEach((rawGuard, index) => {
    const { data, issues } = parseGuardAt(rawGuard, index);
    if (data) validatedGuards.push(data);
    guardIssues.push(...issues);
  });
  if (guardIssues.length > 0) throw new PipelineParseError(guardIssues);

  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const step of validatedSteps) {
    if (seen.has(step.id)) duplicates.push(`steps: duplicate id "${step.id}"`);
    seen.add(step.id);
  }
  for (const step of parsed.always) {
    if (seen.has(step.id)) duplicates.push(`always: duplicate id "${step.id}"`);
    seen.add(step.id);
  }
  if (duplicates.length > 0) throw new PipelineParseError(duplicates);

  // Referential checks, in both directions:
  //  1. Every name in `steps[].mcp_servers` must exist in the pipeline's
  //     `mcp_servers` registry. Catching it here (instead of letting
  //     `runAgentStep` receive an unresolved name) gives an error that names
  //     the exact field, like the rest of this parser.
  //  2. Every `mcp__<server>__...` tool in `tools:` must have its `<server>`
  //     enabled in `mcp_servers:` of the same step. Without this reverse
  //     direction, an author can list the tool in `tools` (it is required)
  //     and forget the `mcp_servers: [...]` line: `validate` and
  //     `doctor` pass, and the failure only shows up midway through an
  //     unattended run when the agent lacks the server its own tool list
  //     promises.
  //  3. Tool governance — deny-by-default: every tool
  //     declared in an agent step must be in `TOOL_FS_PROFILES` (native) or
  //     be a valid MCP tool for its server and its kind.
  const mcpIssues: string[] = [];
  validatedSteps.forEach((step, index) => {
    if (step.type !== 'agent') return;
    step.mcp_servers.forEach((name, mcpIndex) => {
      if (!(name in parsed.mcp_servers)) {
        mcpIssues.push(
          `steps.${index}.mcp_servers.${mcpIndex}: MCP server "${name}" not declared in mcp_servers`,
        );
      }
    });

    // Check of native tools (non-mcp__) — deny-by-default.
    step.tools?.forEach((tool, toolIndex) => {
      if (tool.startsWith('mcp__')) return; // covered in the forEach below
      if (HARD_DENY_TOOLS.has(tool)) {
        mcpIssues.push(
          `steps.${index}.tools.${toolIndex}: "${tool}" is not allowed in an agent step` +
            (tool === 'Bash' ? ' — if you need to run commands, use a type: shell step' : ''),
        );
        return;
      }
      if (!(tool in TOOL_FS_PROFILES)) {
        mcpIssues.push(`steps.${index}.tools.${toolIndex}: unknown tool for the engine: "${tool}"`);
      }
    });

    // Check of MCP tools (mcp__<server>__<suffix>).
    step.tools?.forEach((tool, toolIndex) => {
      if (!tool.startsWith('mcp__')) return;
      const hasServer = step.mcp_servers.some((name) => tool.startsWith(`mcp__${name}__`));
      if (!hasServer) {
        mcpIssues.push(
          `steps.${index}.tools.${toolIndex}: the tool "${tool}" requires enabling its server in mcp_servers`,
        );
        return;
      }
      const serverName = step.mcp_servers.find((name) => tool.startsWith(`mcp__${name}__`))!;
      const kind = parsed.mcp_servers[serverName]?.kind;
      const suffix = tool.slice(`mcp__${serverName}__`.length);
      if (HARD_DENY_TOOLS.has(suffix)) {
        mcpIssues.push(
          `steps.${index}.tools.${toolIndex}: "${tool}" is not allowed in an agent step — it runs arbitrary code/JS`,
        );
        return;
      }
      if (!kind) {
        mcpIssues.push(
          `steps.${index}.tools.${toolIndex}: "${tool}" cannot be granted — the server "${serverName}" does not declare kind: in mcp_servers`,
        );
        return;
      }
      if (!MCP_TOOLS_BY_KIND[kind].has(suffix)) {
        mcpIssues.push(
          `steps.${index}.tools.${toolIndex}: "${suffix}" is not a known tool for kind: ${kind}`,
        );
      }
    });
  });
  if (mcpIssues.length > 0) throw new PipelineParseError(mcpIssues);

  const steps: Step[] = validatedSteps.map((step) => {
    const common: StepCommon = {
      id: step.id,
      cwd: step.cwd,
      inputs: step.inputs,
      outputs: step.outputs,
      when: step.when,
      effects: step.effects,
      retry: normalizeRetry(step.retry ?? parsed.defaults.retry),
      onError: step.on_error ?? parsed.defaults.on_error,
      timeout: step.timeout ?? parsed.defaults.timeout,
    };
    if (step.type === 'shell') return { ...common, type: 'shell', run: step.run };
    return {
      ...common,
      type: 'agent',
      agent: step.agent,
      prompt: step.prompt,
      tools: step.tools ?? [...DEFAULT_TOOLS],
      mcpServers: step.mcp_servers,
      additionalDirs: step.additional_dirs,
      maxCostUsd: step.max_cost_usd,
    };
  });

  const always: ShellStep[] = parsed.always.map((step) => ({
    id: step.id,
    type: 'shell',
    run: step.run,
    cwd: step.cwd,
    inputs: [],
    outputs: undefined,
    when: undefined,
    effects: [],
    retry: { attempts: 0, on: 'transient' },
    onError: 'stop',
    timeout: step.timeout ?? parsed.defaults.timeout,
  }));

  return {
    name: parsed.name,
    description: parsed.description,
    version: parsed.version,
    params: parsed.params,
    requires: parsed.requires,
    mcpServers: parsed.mcp_servers,
    when: validatedGuards,
    triggers: parsed.triggers,
    notify: parsed.notify && {
      on: parsed.notify.on,
      staleAfter: parsed.notify.stale_after,
      channel: parsed.notify.channel,
    },
    steps,
    always,
  };
}
