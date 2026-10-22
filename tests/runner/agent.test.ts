import { describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  NonNullableUsage,
  SDKAPIRetryMessage,
  SDKAssistantMessage,
  SDKAssistantMessageError,
  SDKMessage,
  SDKResultError,
  SDKResultSuccess,
} from '@anthropic-ai/claude-agent-sdk';
import { parsePipeline, type AgentStep } from '../../src/schema/pipeline.ts';
import { loadRepoAgents, makePreToolUseHook, outputsToJsonSchema, runAgentStep } from '../../src/runner/agent.ts';
import { TOOL_FS_PROFILES } from '../../src/runner/fs-guard.ts';
import { REDACTION } from '../../src/runs/store.ts';

function agentStep(yaml: string): AgentStep {
  const p = parsePipeline(`
name: demo
description: d
version: 1
steps:
${yaml}
`);
  return p.steps[0] as AgentStep;
}

const STEP = agentStep('  - id: scan\n    agent: writer\n    prompt: steps/01.md\n    outputs: { count: number }');

const baseCtx = {
  scope: { params: {}, steps: {} },
  secrets: {},
  defaultCwd: tmpdir(),
  timeoutMs: 5000,
  repoRoot: tmpdir(),
  promptText: 'Count the outdated pages.',
  mcpServers: {},
};

/** Builds a fake queryFn that emits the given messages. */
function fakeQuery(messages: SDKMessage[]) {
  return () => (async function* (): AsyncGenerator<SDKMessage> { for (const m of messages) yield m; })();
}

// ---------------------------------------------------------------------------
// Factories for real SDK messages. `SDKMessage` is a union of more than 30
// variants with deeply nested required fields (BetaMessage, BetaUsage...);
// these factories fill in the required parts with neutral values and let each
// test override only what it cares about, without resorting to `any` or to a
// cast that would reintroduce the problem of using invented shapes: if the
// SDK changes a required field, these factories stop compiling just like the
// runner does.
// ---------------------------------------------------------------------------

const FAKE_UUID = '00000000-0000-0000-0000-000000000000';
const FAKE_SESSION = 'test-session';

function nonNullableUsage(inputTokens = 0, outputTokens = 0): NonNullableUsage {
  return {
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    fallback_credit: { status: { type: 'redeemed' } },
    inference_geo: '',
    input_tokens: inputTokens,
    iterations: [],
    output_tokens: outputTokens,
    output_tokens_details: { thinking_tokens: 0 },
    server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
    service_tier: 'standard',
    speed: 'standard',
  };
}

/** Success result (`SDKResultMessage` with `subtype: 'success'`), sdk.d.ts ~4382. */
function resultSuccess(overrides: Partial<SDKResultSuccess> = {}): SDKResultSuccess {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 900,
    duration_api_ms: 900,
    is_error: false,
    num_turns: 1,
    result: '',
    stop_reason: 'end_turn',
    total_cost_usd: 0,
    usage: nonNullableUsage(),
    modelUsage: {},
    permission_denials: [],
    uuid: FAKE_UUID,
    session_id: FAKE_SESSION,
    ...overrides,
  };
}

/** Failure result (`SDKResultMessage` with one of the 4 error subtypes), sdk.d.ts ~4350. */
function resultError(overrides: Partial<SDKResultError> = {}): SDKResultError {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    duration_ms: 900,
    duration_api_ms: 900,
    is_error: true,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: nonNullableUsage(),
    modelUsage: {},
    permission_denials: [],
    errors: [],
    uuid: FAKE_UUID,
    session_id: FAKE_SESSION,
    ...overrides,
  };
}

type ContentBlock = SDKAssistantMessage['message']['content'][number];
type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>;

function toolUseBlock(name: string): ToolUseBlock {
  return { id: `tool-${name}`, input: {}, name, type: 'tool_use' };
}

/** `assistant` message (`SDKAssistantMessage`, sdk.d.ts ~2929), with its minimal `BetaMessage`. */
function assistantMessage(options: {
  content?: ContentBlock[];
  error?: SDKAssistantMessageError;
} = {}): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: {
      id: 'msg-1',
      container: null,
      content: options.content ?? [],
      context_management: null,
      diagnostics: null,
      model: 'test-model',
      role: 'assistant',
      stop_details: null,
      stop_reason: null,
      stop_sequence: null,
      type: 'message',
      usage: {
        cache_creation: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        fallback_credit: null,
        inference_geo: null,
        input_tokens: 0,
        iterations: null,
        output_tokens: 0,
        output_tokens_details: null,
        server_tool_use: null,
        service_tier: null,
        speed: null,
      },
    },
    parent_tool_use_id: null,
    error: options.error,
    uuid: FAKE_UUID,
    session_id: FAKE_SESSION,
  };
}

/** Internal retry by the CLI itself on an API error (`SDKAPIRetryMessage`, sdk.d.ts ~2917). */
function apiRetryMessage(error: SDKAssistantMessageError, errorStatus: number | null = null): SDKAPIRetryMessage {
  return {
    type: 'system',
    subtype: 'api_retry',
    attempt: 1,
    max_retries: 3,
    retry_delay_ms: 500,
    error_status: errorStatus,
    error,
    uuid: FAKE_UUID,
    session_id: FAKE_SESSION,
  };
}

describe('outputsToJsonSchema', () => {
  test('translates the contract into a JSON Schema with additionalProperties false', () => {
    const schema = outputsToJsonSchema({ count: 'number', pages: 'string[]' });
    expect(schema).toEqual({
      type: 'object',
      properties: {
        count: { type: 'number' },
        pages: { type: 'array', items: { type: 'string' } },
      },
      required: ['count', 'pages'],
      additionalProperties: false,
    });
  });
});

describe('runAgentStep', () => {
  test('parses and validates the result against the contract, and records real cost and tokens', async () => {
    const outcome = await runAgentStep(STEP, {
      ...baseCtx,
      queryFn: fakeQuery([
        resultSuccess({ result: '{"count": 7}', total_cost_usd: 0.04, usage: nonNullableUsage(100, 20) }),
      ]),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.outputs).toEqual({ count: 7 });
    expect(outcome.costUsd).toBe(0.04);
    expect(outcome.inputTokens).toBe(100);
    expect(outcome.outputTokens).toBe(20);
  });

  test('records the tools used, read from the tool_use blocks of the assistant message', async () => {
    const outcome = await runAgentStep(STEP, {
      ...baseCtx,
      queryFn: fakeQuery([
        assistantMessage({ content: [toolUseBlock('Read'), toolUseBlock('Grep'), toolUseBlock('Read')] }),
        resultSuccess({ result: '{"count": 1}' }),
      ]),
    });
    expect(outcome.toolsUsed).toEqual(['Read', 'Grep']);
  });

  test('a result that does not meet the contract is a NON-transient failure', async () => {
    const outcome = await runAgentStep(STEP, {
      ...baseCtx,
      queryFn: fakeQuery([resultSuccess({ result: '{"count": "seven"}' })]),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.transient).toBe(false);
  });

  test('a result that is not JSON is a contract failure', async () => {
    const outcome = await runAgentStep(STEP, {
      ...baseCtx,
      queryFn: fakeQuery([resultSuccess({ result: 'I counted seven pages' })]),
    });
    expect(outcome.ok).toBe(false);
  });

  test('a step with no contract accepts any text', async () => {
    const step = agentStep('  - id: a\n    agent: w\n    prompt: p.md');
    const outcome = await runAgentStep(step, {
      ...baseCtx,
      queryFn: fakeQuery([resultSuccess({ result: 'free text' })]),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.outputs).toEqual({});
  });

  test('interpolates the prompt with params and earlier outputs', async () => {
    let receivedPrompt = '';
    const step = agentStep('  - id: a\n    agent: w\n    prompt: p.md');
    await runAgentStep(step, {
      ...baseCtx,
      promptText: 'Review {{params.repo}} with {{prev.n}} pending',
      scope: { params: { repo: '/srv' }, steps: { prev: { n: 4 } } },
      queryFn: ({ prompt }) => {
        receivedPrompt = prompt;
        return (async function* (): AsyncGenerator<SDKMessage> { yield resultSuccess({ result: 'ok' }); })();
      },
    });
    expect(receivedPrompt).toBe('Review /srv with 4 pending');
  });

  test('interpolates {{secrets.X}} in the prompt, using the secrets of the step', async () => {
    let receivedPrompt = '';
    const step = agentStep('  - id: a\n    agent: w\n    prompt: p.md');
    await runAgentStep(step, {
      ...baseCtx,
      promptText: 'Password: {{secrets.DOCS_ADMIN_PASSWORD}}',
      secrets: { DOCS_ADMIN_PASSWORD: 'super-secret' },
      queryFn: ({ prompt }) => {
        receivedPrompt = prompt;
        return (async function* (): AsyncGenerator<SDKMessage> { yield resultSuccess({ result: 'ok' }); })();
      },
    });
    expect(receivedPrompt).toBe('Password: super-secret');
  });

  test('{{secrets.X}} without that secret declared makes runAgentStep reject the promise', async () => {
    const step = agentStep('  - id: a\n    agent: w\n    prompt: p.md');
    await expect(
      runAgentStep(step, {
        ...baseCtx,
        promptText: 'Password: {{secrets.UNDECLARED}}',
        secrets: {},
      }),
    ).rejects.toThrow(/UNDECLARED/);
  });

  test('passes the declared tools, cwd and env to the SDK options', async () => {
    let received: Record<string, unknown> = {};
    const step = agentStep('  - id: a\n    agent: writer\n    prompt: p.md\n    tools: [Read, Write]');
    await runAgentStep(step, {
      ...baseCtx,
      secrets: { MY_TOKEN: 's' },
      queryFn: ({ options }) => {
        received = options;
        return (async function* (): AsyncGenerator<SDKMessage> { yield resultSuccess({ result: 'ok' }); })();
      },
    });
    // `tools` is the real restriction (sdk.d.ts ~1369-1371: `allowedTools`
    // on its own does NOT restrict, it only avoids the approval prompt).
    // Both must carry exactly what is declared in the YAML.
    expect(received.tools).toEqual(['Read', 'Write']);
    expect(received.allowedTools).toEqual(['Read', 'Write']);
    expect(received.agent).toBe('writer');
    expect(received.settingSources).toEqual([]);
    expect(received.permissionMode).toBe('bypassPermissions');
    const env = received.env as Record<string, string>;
    expect(env.MY_TOKEN).toBe('s');
    expect(env.PATH).toBeTruthy();
  });

  test('passes max_cost_usd to the SDK as maxBudgetUsd', async () => {
    let received: Record<string, unknown> = {};
    const step = agentStep('  - id: a\n    agent: writer\n    prompt: p.md\n    max_cost_usd: 3.5');
    await runAgentStep(step, {
      ...baseCtx,
      queryFn: ({ options }) => {
        received = options;
        return (async function* (): AsyncGenerator<SDKMessage> { yield resultSuccess({ result: 'ok' }); })();
      },
    });
    expect(received.maxBudgetUsd).toBe(3.5);
  });

  test('without a declared max_cost_usd, maxBudgetUsd is not passed', async () => {
    let received: Record<string, unknown> = {};
    await runAgentStep(STEP, {
      ...baseCtx,
      queryFn: ({ options }) => {
        received = options;
        return (async function* (): AsyncGenerator<SDKMessage> { yield resultSuccess({ result: '{"count":1}' }); })();
      },
    });
    expect(received.maxBudgetUsd).toBeUndefined();
  });

  test('enables the MCP servers declared by the step, resolving env from secrets', async () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
mcp_servers:
  playwright:
    command: npx
    args: ["-y", "@playwright/mcp@latest"]
    env: [PLAYWRIGHT_TOKEN, UNSET_VAR]
steps:
  - id: a
    agent: writer
    prompt: p.md
    mcp_servers: [playwright]
`);
    const step = p.steps[0] as AgentStep;
    let received: Record<string, unknown> = {};
    await runAgentStep(step, {
      ...baseCtx,
      mcpServers: p.mcpServers,
      // UNSET_VAR is declared on the server but not here: it must be omitted,
      // not show up as undefined nor make the resolution fail.
      secrets: { PLAYWRIGHT_TOKEN: 'tok-123' },
      queryFn: ({ options }) => {
        received = options;
        return (async function* (): AsyncGenerator<SDKMessage> { yield resultSuccess({ result: 'ok' }); })();
      },
    });
    expect(received.mcpServers).toEqual({
      playwright: {
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest'],
        env: { PLAYWRIGHT_TOKEN: 'tok-123' },
      },
    });
  });

  test('a step without mcp_servers does not send mcpServers to the SDK', async () => {
    let received: Record<string, unknown> = {};
    await runAgentStep(STEP, {
      ...baseCtx,
      queryFn: ({ options }) => {
        received = options;
        return (async function* (): AsyncGenerator<SDKMessage> { yield resultSuccess({ result: '{"count": 1}' }); })();
      },
    });
    expect(received.mcpServers).toBeUndefined();
  });

  test('interpolates {{params.*}} in the command and args of an MCP server', async () => {
    const p = parsePipeline(`
name: demo
description: d
version: 1
mcp_servers:
  local:
    command: "{{params.root}}/bin/server"
    args: ["--flag", "{{params.root}}/data"]
steps:
  - id: a
    agent: writer
    prompt: p.md
    mcp_servers: [local]
`);
    const step = p.steps[0] as AgentStep;
    let received: Record<string, unknown> = {};
    await runAgentStep(step, {
      ...baseCtx,
      mcpServers: p.mcpServers,
      scope: { params: { root: '/srv/tools' }, steps: {} },
      queryFn: ({ options }) => {
        received = options;
        return (async function* (): AsyncGenerator<SDKMessage> { yield resultSuccess({ result: 'ok' }); })();
      },
    });
    expect(received.mcpServers).toEqual({
      local: { command: '/srv/tools/bin/server', args: ['--flag', '/srv/tools/data'], env: {} },
    });
  });

  test('always passes strictMcpConfig: true, with or without declared servers', async () => {
    let received: Record<string, unknown> = {};
    await runAgentStep(STEP, {
      ...baseCtx,
      queryFn: ({ options }) => {
        received = options;
        return (async function* (): AsyncGenerator<SDKMessage> { yield resultSuccess({ result: '{"count": 1}' }); })();
      },
    });
    // Without this, `Options.mcpServers` is ADDITIVE to any MCP server already
    // configured on the machine (user settings, plugins, project .mcp.json).
    expect(received.strictMcpConfig).toBe(true);
  });

  test('forwards the non-secret network variables to a declared MCP server even if they are not in requires.env', async () => {
    process.env.HTTP_PROXY = 'http://proxy.local:3128';
    try {
      const p = parsePipeline(`
name: demo
description: d
version: 1
mcp_servers:
  playwright:
    command: npx
steps:
  - id: a
    agent: writer
    prompt: p.md
    mcp_servers: [playwright]
`);
      const step = p.steps[0] as AgentStep;
      let received: Record<string, unknown> = {};
      await runAgentStep(step, {
        ...baseCtx,
        mcpServers: p.mcpServers,
        // secrets empty on purpose: HTTP_PROXY is not in this pipeline's
        // requires.env and it must still reach the server.
        secrets: {},
        queryFn: ({ options }) => {
          received = options;
          return (async function* (): AsyncGenerator<SDKMessage> { yield resultSuccess({ result: 'ok' }); })();
        },
      });
      const mcpServers = received.mcpServers as Record<string, { env: Record<string, string> }>;
      expect(mcpServers.playwright!.env.HTTP_PROXY).toBe('http://proxy.local:3128');
    } finally {
      delete process.env.HTTP_PROXY;
    }
  });
});

// ---------------------------------------------------------------------------
// Transient vs permanent classification against the REAL shape of the SDK.
// An earlier version classified over an invented `error.message` the SDK never
// emits; these tests pin the behavior over the real structured categories:
// `SDKAssistantMessage.error` / `SDKAPIRetryMessage.error` (type
// `SDKAssistantMessageError`) and, as a last resort, the `subtype` of
// `SDKResultError` and the free text of `errors`.
// ---------------------------------------------------------------------------
describe('runAgentStep — transient vs permanent classification', () => {
  test('an assistant turn marked overloaded produces a transient failure (must be retried)', async () => {
    const outcome = await runAgentStep(STEP, {
      ...baseCtx,
      queryFn: fakeQuery([
        assistantMessage({ error: 'overloaded' }),
        resultError({ subtype: 'error_during_execution', errors: ['the API returned 529'] }),
      ]),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.transient).toBe(true);
  });

  test('an internal retry notice from the CLI for rate_limit also marks the failure as transient', async () => {
    // SDKAPIRetryMessage is what the CLI itself emits when IT retries an API
    // call; if it ends up failing anyway (it exhausted its retries), the
    // category of that notice is still the most reliable signal of why.
    const outcome = await runAgentStep(STEP, {
      ...baseCtx,
      queryFn: fakeQuery([
        apiRetryMessage('rate_limit', 429),
        resultError({ subtype: 'error_during_execution', errors: ['rate limited'] }),
      ]),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.transient).toBe(true);
  });

  test('an assistant turn marked authentication_failed is NOT transient', async () => {
    const outcome = await runAgentStep(STEP, {
      ...baseCtx,
      queryFn: fakeQuery([
        assistantMessage({ error: 'authentication_failed' }),
        resultError({ subtype: 'error_during_execution', errors: ['invalid credentials'] }),
      ]),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.transient).toBe(false);
  });

  test('running out of the USD budget is NOT transient even if an earlier turn saw overloaded', async () => {
    // The exhaustion subtype takes precedence: a transient hiccup already
    // absorbed by the CLI in an intermediate turn does not make a final
    // failure due to an exhausted budget transient.
    const outcome = await runAgentStep(STEP, {
      ...baseCtx,
      queryFn: fakeQuery([
        assistantMessage({ error: 'overloaded' }),
        resultError({ subtype: 'error_max_budget_usd', errors: ['the maximum budget was exceeded'] }),
      ]),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.transient).toBe(false);
  });

  test('running out of maximum turns is NOT transient', async () => {
    const outcome = await runAgentStep(STEP, {
      ...baseCtx,
      queryFn: fakeQuery([resultError({ subtype: 'error_max_turns', errors: ['the maximum number of turns was reached'] })]),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.transient).toBe(false);
  });

  test('error_during_execution with no structured category falls back to the text match (529 -> transient)', async () => {
    const outcome = await runAgentStep(STEP, {
      ...baseCtx,
      queryFn: fakeQuery([
        resultError({ subtype: 'error_during_execution', errors: ['overloaded_error: try again (529)'] }),
      ]),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.transient).toBe(true);
  });

  test('error_during_execution with no structured category nor recognized text pattern falls on the safe side (not transient)', async () => {
    const outcome = await runAgentStep(STEP, {
      ...baseCtx,
      queryFn: fakeQuery([
        resultError({ subtype: 'error_during_execution', errors: ['something went wrong in an uncataloged way'] }),
      ]),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.transient).toBe(false);
  });

  test('a stream that ends without emitting any result message is NOT transient', async () => {
    // Neither success nor exception: the generator simply runs out without
    // ever having emitted `{ type: 'result' }'. Nothing in the SDK types
    // documents this as a transport artifact, so it falls on the safe side
    // just like any other unrecognized condition.
    const outcome = await runAgentStep(STEP, {
      ...baseCtx,
      queryFn: () => (async function* (): AsyncGenerator<SDKMessage> {})(),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.transient).toBe(false);
      expect(outcome.error).toContain('result');
    }
  });

  test('an exception thrown by queryFn (transport failure, no result message) is classified by text', async () => {
    const outcome = await runAgentStep(STEP, {
      ...baseCtx,
      queryFn: () =>
        (async function* (): AsyncGenerator<SDKMessage> {
          throw new Error('socket hang up');
        })(),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.transient).toBe(true);
  });

  test('a timeout (our own AbortController) is always transient, even if the message matches no pattern', async () => {
    const outcome = await runAgentStep(STEP, {
      ...baseCtx,
      timeoutMs: 10,
      queryFn: () =>
        (async function* (): AsyncGenerator<SDKMessage> {
          await new Promise((resolve) => setTimeout(resolve, 50));
          throw new Error('something uncataloged');
        })(),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.transient).toBe(true);
      expect(outcome.error).toContain('timed out');
    }
  });
});

// Secrets are redacted in the same function that legitimately handles them
// (runAgentStep), on every return path — not at a later write point.
// `composeEnv` passes the secrets to the SDK via `env`, so a step with `Bash`
// in `tools` can echo them back exactly like a `shell` step.
describe('runAgentStep — secret redaction', () => {
  test('a secret that appears in the result text is redacted in the log', async () => {
    const step = agentStep('  - id: a\n    agent: w\n    prompt: p.md');
    const outcome = await runAgentStep(step, {
      ...baseCtx,
      secrets: { MY_TOKEN: 'secret-xyz' },
      queryFn: fakeQuery([resultSuccess({ result: 'I used the token secret-xyz to authenticate' })]),
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.log).toContain(REDACTION);
    expect(outcome.log).not.toContain('secret-xyz');
  });

  test('an SDK error that mentions the secret is redacted in error and in log', async () => {
    const step = agentStep('  - id: a\n    agent: w\n    prompt: p.md');
    const outcome = await runAgentStep(step, {
      ...baseCtx,
      secrets: { MY_TOKEN: 'secret-xyz' },
      queryFn: fakeQuery([
        resultError({ subtype: 'error_during_execution', errors: ['token secret-xyz invalid'] }),
      ]),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain(REDACTION);
      expect(outcome.error).not.toContain('secret-xyz');
      expect(outcome.log).not.toContain('secret-xyz');
    }
  });

  test('an exception from queryFn that mentions the secret is redacted', async () => {
    const step = agentStep('  - id: a\n    agent: w\n    prompt: p.md');
    const outcome = await runAgentStep(step, {
      ...baseCtx,
      secrets: { MY_TOKEN: 'secret-xyz' },
      queryFn: () =>
        (async function* (): AsyncGenerator<SDKMessage> {
          throw new Error('network failure with secret-xyz leaked');
        })(),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).not.toContain('secret-xyz');
      expect(outcome.log).not.toContain('secret-xyz');
    }
  });

  test('a secret echoed into a declared string output is redacted', async () => {
    const step = agentStep('  - id: a\n    agent: w\n    prompt: p.md\n    outputs: { note: string }');
    const outcome = await runAgentStep(step, {
      ...baseCtx,
      secrets: { MY_TOKEN: 'secret-xyz' },
      queryFn: fakeQuery([resultSuccess({ result: '{"note": "token: secret-xyz"}' })]),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.outputs.note).toBe(`token: ${REDACTION}`);
      expect(JSON.stringify(outcome.outputs)).not.toContain('secret-xyz');
    }
  });

  test('a secret echoed into a numeric output fails the step instead of exposing it', async () => {
    // A number cannot be replaced by REDACTION without ceasing to be a
    // number, so the only honest way out is to fail the step.
    const step = agentStep('  - id: a\n    agent: w\n    prompt: p.md\n    outputs: { code: number }');
    const outcome = await runAgentStep(step, {
      ...baseCtx,
      secrets: { MY_CODE: '424242' },
      queryFn: fakeQuery([resultSuccess({ result: '{"code": 424242}' })]),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.transient).toBe(false);
      expect(outcome.error).toContain('code');
      expect(outcome.error).not.toContain('424242');
      expect(outcome.log).not.toContain('424242');
    }
  });

  test('a secret echoed inside an array of numbers also fails the step', async () => {
    const step = agentStep('  - id: a\n    agent: w\n    prompt: p.md\n    outputs: { codes: "number[]" }');
    const outcome = await runAgentStep(step, {
      ...baseCtx,
      secrets: { MY_CODE: '424242' },
      queryFn: fakeQuery([resultSuccess({ result: '{"codes": [1, 424242, 3]}' })]),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.transient).toBe(false);
      expect(outcome.error).toContain('codes');
      expect(outcome.error).not.toContain('424242');
      expect(outcome.log).not.toContain('424242');
    }
  });
});

// `AgentStepContext.repoRoot` was received but never read, so an agent in
// `<repoRoot>/agents/*.md` that passed `doctor` with ✓ never reached the SDK.
// A directory of its own per test (never the shared tmpdir), like the rest of
// the suite that touches disk.
describe('runAgentStep — repo agents', () => {
  test('an agent defined in the agents/*.md of the repo reaches the SDK options', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'ap-agent-repo-'));
    try {
      mkdirSync(join(repoRoot, 'agents'), { recursive: true });
      writeFileSync(
        join(repoRoot, 'agents', 'doc-writer.md'),
        '---\ndescription: Writes documentation\ntools: Read, Grep, Glob\n---\n\nYou are a technical writer.\n',
      );

      let received: Record<string, unknown> = {};
      const step = agentStep('  - id: a\n    agent: doc-writer\n    prompt: p.md');
      await runAgentStep(step, {
        ...baseCtx,
        repoRoot,
        queryFn: ({ options }) => {
          received = options;
          return (async function* (): AsyncGenerator<SDKMessage> {
            yield resultSuccess({ result: 'ok' });
          })();
        },
      });

      const agents = received.agents as Record<string, { description: string; prompt: string; tools?: string[] }>;
      expect(agents['doc-writer']).toBeDefined();
      expect(agents['doc-writer']!.description).toBe('Writes documentation');
      expect(agents['doc-writer']!.prompt).toBe('You are a technical writer.');
      expect(agents['doc-writer']!.tools).toEqual(['Read', 'Grep', 'Glob']);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('a repoRoot without an agents/ directory does not throw and passes an empty object', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'ap-agent-repo-'));
    try {
      let received: Record<string, unknown> = {};
      const outcome = await runAgentStep(STEP, {
        ...baseCtx,
        repoRoot,
        queryFn: ({ options }) => {
          received = options;
          return (async function* (): AsyncGenerator<SDKMessage> {
            yield resultSuccess({ result: '{"count": 1}' });
          })();
        },
      });
      expect(outcome.ok).toBe(true);
      expect(received.agents).toEqual({});
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  // An agent file with broken front matter made parseAgentMarkdown throw
  // inside the loop, so loadRepoAgents discarded ALL the agents already
  // loaded, not just the broken one — a step that did not even use the broken
  // agent failed anyway. Also verified that the case without `---` delimiters
  // (which already worked before this fix) keeps working the same.
  test('an agent without front matter loads with the whole file as prompt', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'ap-agent-repo-'));
    try {
      mkdirSync(join(repoRoot, 'agents'), { recursive: true });
      writeFileSync(join(repoRoot, 'agents', 'plain.md'), 'You are an agent without metadata.\n');

      const agents = await loadRepoAgents(repoRoot);
      expect(agents['plain']).toBeDefined();
      expect(agents['plain']!.description).toBe('');
      expect(agents['plain']!.prompt).toBe('You are an agent without metadata.');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('an agent with invalid front matter is skipped with a warning, without discarding the others', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'ap-agent-repo-'));
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mkdirSync(join(repoRoot, 'agents'), { recursive: true });
      writeFileSync(
        join(repoRoot, 'agents', 'good.md'),
        '---\ndescription: Valid agent\n---\n\nI am a valid agent.\n',
      );
      writeFileSync(
        join(repoRoot, 'agents', 'bad.md'),
        '---\ndescription: [unclosed\n---\n\nThis prompt is never used.\n',
      );

      const agents = await loadRepoAgents(repoRoot);
      expect(Object.keys(agents)).toEqual(['good']);
      expect(agents['good']!.description).toBe('Valid agent');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]![0]).toContain('bad.md');
    } finally {
      warnSpy.mockRestore();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('a front matter that parses to a list (not a mapping) is also skipped with a warning', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'ap-agent-repo-'));
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mkdirSync(join(repoRoot, 'agents'), { recursive: true });
      writeFileSync(
        join(repoRoot, 'agents', 'list.md'),
        '---\n- one\n- two\n---\n\nBody.\n',
      );

      const agents = await loadRepoAgents(repoRoot);
      expect(agents).toEqual({});
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]![0]).toContain('list.md');
    } finally {
      warnSpy.mockRestore();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('runAgentStep — PreToolUse hook', () => {
  async function callHook(
    declaredAllow: Map<string, Set<string>>,
    toolName: string,
    toolInput: unknown,
    hookLog = new Map<string, { toolName: string; reason: string }>(),
  ) {
    const hook = makePreToolUseHook(
      { cwdRoot: tmpdir(), readRoots: [tmpdir()] },
      hookLog,
      ['my-device'],
      declaredAllow,
    );
    const outcome = await hook(
      { hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput, tool_use_id: 'd1' } as never,
      'd1',
      { signal: new AbortController().signal },
    );
    return outcome as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  }

  test('the hook allows a tool of a declared server that is in allow', async () => {
    const outcome = await callHook(new Map([['my-device', new Set(['screenshot'])]]), 'mcp__my-device__screenshot', {
      any: 'thing',
    });
    expect(outcome.hookSpecificOutput?.permissionDecision).toBe('allow');
  });

  test('the hook denies a tool of a declared server that is not in allow, with a reason', async () => {
    const log = new Map<string, { toolName: string; reason: string }>();
    const outcome = await callHook(new Map([['my-device', new Set(['screenshot'])]]), 'mcp__my-device__erase', {}, log);
    expect(outcome.hookSpecificOutput?.permissionDecision).toBe('deny');
    const reason = outcome.hookSpecificOutput?.permissionDecisionReason ?? '';
    expect(reason).toContain('allow');
    expect(reason).toContain('my-device');
    expect(log.get('d1')?.toolName).toBe('mcp__my-device__erase');
  });

  test('a tool of a declared server named like a Playwright tool does not use the Playwright profile', async () => {
    const outcome = await callHook(
      new Map([['my-device', new Set(['tap'])]]),
      'mcp__my-device__browser_navigate',
      { url: 'https://x' },
    );
    expect(outcome.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  async function stepHook(yaml: string) {
    const p = parsePipeline(yaml);
    let received: Record<string, unknown> = {};
    await runAgentStep(p.steps[0] as AgentStep, {
      ...baseCtx,
      mcpServers: p.mcpServers,
      queryFn: ({ options }) => {
        received = options;
        return (async function* (): AsyncGenerator<SDKMessage> { yield resultSuccess({ result: 'ok' }); })();
      },
    });
    const hook = (received.hooks as { PreToolUse: Array<{ hooks: [Function] }> }).PreToolUse[0]!.hooks[0]!;
    return async (tool: string, input: unknown = {}): Promise<string | undefined> => {
      const out = await hook(
        { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 'x' },
        'x',
        { signal: new AbortController().signal },
      );
      return out.hookSpecificOutput?.permissionDecision;
    };
  }

  test('runAgentStep gives the hook only the declared tools the step grants, not the whole allow', async () => {
    const decide = await stepHook(`
name: demo
description: d
version: 1
mcp_servers:
  my-device:
    command: node
    args: [srv.js]
    kind: declared
    allow: [screenshot, tap]
steps:
  - id: a
    agent: writer
    prompt: p.md
    mcp_servers: [my-device]
    tools: [mcp__my-device__screenshot]
`);
    expect(await decide('mcp__my-device__screenshot')).toBe('allow');
    expect(await decide('mcp__my-device__tap')).toBe('deny'); // in allow, but the step does not grant it
    expect(await decide('mcp__my-device__erase')).toBe('deny');
  });

  test('a step with a declared server active and no tools: grants nothing from that server', async () => {
    const decide = await stepHook(`
name: demo
description: d
version: 1
mcp_servers:
  my-device:
    command: node
    kind: declared
    allow: [screenshot]
steps:
  - id: a
    agent: writer
    prompt: p.md
    mcp_servers: [my-device]
`);
    expect(await decide('mcp__my-device__screenshot')).toBe('deny');
  });

  test('playwright and declared in the same step (including names dev and dev-x) are each decided on their own', async () => {
    const decide = await stepHook(`
name: demo
description: d
version: 1
mcp_servers:
  pw:
    command: npx
    kind: playwright
  dev:
    command: qa
    kind: declared
    allow: [screenshot, tap]
  dev-x:
    command: qa
    kind: playwright
steps:
  - id: a
    agent: writer
    prompt: p.md
    mcp_servers: [pw, dev, dev-x]
    tools: [mcp__pw__browser_navigate, mcp__dev__screenshot, mcp__dev-x__browser_navigate]
`);
    expect(await decide('mcp__pw__browser_navigate', { url: 'https://x' })).toBe('allow');
    expect(await decide('mcp__pw__browser_navigate', { url: 'file:///etc/passwd' })).toBe('deny');
    expect(await decide('mcp__dev__browser_navigate', { url: 'https://x' })).toBe('deny');
    expect(await decide('mcp__dev__screenshot')).toBe('allow');
    expect(await decide('mcp__dev__tap')).toBe('deny'); // in allow, not granted
    expect(await decide('mcp__dev-x__screenshot')).toBe('deny');
    expect(await decide('mcp__dev-x__browser_navigate', { url: 'https://x' })).toBe('allow');
    expect(await decide('mcp__dev__Bash')).toBe('deny');
  });

  function capturingQueryFn(resultOverrides: Partial<SDKResultSuccess> = {}) {
    let receivedOptions: Record<string, unknown> | undefined;
    const fn = (args: { prompt: string; options: Record<string, unknown> }) => {
      receivedOptions = args.options;
      return (async function* (): AsyncGenerator<SDKMessage> {
        yield resultSuccess(resultOverrides);
      })();
    };
    return { fn, getOptions: () => receivedOptions! };
  }

  test('registers a PreToolUse hook without a matcher, with exactly one callback', async () => {
    const { fn, getOptions } = capturingQueryFn();
    await runAgentStep(STEP, { ...baseCtx, queryFn: fn });
    const hooks = getOptions().hooks as { PreToolUse: Array<{ matcher?: string; hooks: unknown[] }> };
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PreToolUse[0]!.hooks).toHaveLength(1);
  });

  test('the registered hook denies a path outside cwd, with a reason', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-hook-'));
    const { fn, getOptions } = capturingQueryFn();
    const step = agentStep(`  - id: scan\n    agent: writer\n    prompt: steps/01.md\n    cwd: "${cwd}"`);
    await runAgentStep(step, { ...baseCtx, queryFn: fn });
    const hook = (getOptions().hooks as { PreToolUse: Array<{ hooks: [Function] }> }).PreToolUse[0]!.hooks[0]!;
    const outcome = await hook(
      { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/etc/passwd' }, tool_use_id: 't1' },
      't1',
      { signal: new AbortController().signal },
    );
    expect(outcome.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(outcome.hookSpecificOutput?.permissionDecisionReason).toBeTruthy();
  });

  test('the registered hook allows a path inside cwd', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-hook-'));
    const { fn, getOptions } = capturingQueryFn();
    const step = agentStep(`  - id: scan\n    agent: writer\n    prompt: steps/01.md\n    cwd: "${cwd}"`);
    await runAgentStep(step, { ...baseCtx, queryFn: fn });
    const hook = (getOptions().hooks as { PreToolUse: Array<{ hooks: [Function] }> }).PreToolUse[0]!.hooks[0]!;
    const outcome = await hook(
      { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(cwd, 'x.txt') }, tool_use_id: 't2' },
      't2',
      { signal: new AbortController().signal },
    );
    expect(outcome.hookSpecificOutput?.permissionDecision).toBe('allow');
  });

  test('additional_dirs is interpolated like cwd and passed to captureRoots — a path inside is allowed', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-hook-cwd-'));
    const extra = mkdtempSync(join(tmpdir(), 'agent-hook-extra-'));
    writeFileSync(join(extra, 'ref.md'), 'x');
    const { fn, getOptions } = capturingQueryFn();
    const step = agentStep(
      `  - id: scan\n    agent: writer\n    prompt: steps/01.md\n    cwd: "${cwd}"\n    additional_dirs: ["${extra}"]`,
    );
    await runAgentStep(step, { ...baseCtx, queryFn: fn });
    const hook = (getOptions().hooks as { PreToolUse: Array<{ hooks: [Function] }> }).PreToolUse[0]!.hooks[0]!;
    const outcome = await hook(
      { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(extra, 'ref.md') }, tool_use_id: 't3' },
      't3',
      { signal: new AbortController().signal },
    );
    expect(outcome.hookSpecificOutput?.permissionDecision).toBe('allow');
  });

  test('hook-log × permission_denials cross-check: a denial that went through the hook during the run appears with source "both"', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-hook-'));
    let capturedHook: Function | undefined;
    const fn = (args: { prompt: string; options: Record<string, unknown> }) => {
      capturedHook = (args.options.hooks as { PreToolUse: Array<{ hooks: [Function] }> }).PreToolUse[0]!.hooks[0]!;
      return (async function* (): AsyncGenerator<SDKMessage> {
        await capturedHook!(
          { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/etc/passwd' }, tool_use_id: 't5' },
          't5',
          { signal: new AbortController().signal },
        );
        yield resultSuccess({
          permission_denials: [{ tool_name: 'Read', tool_use_id: 't5', tool_input: { file_path: '/etc/passwd' } }] as SDKResultSuccess['permission_denials'],
        });
      })();
    };
    const step = agentStep(`  - id: scan\n    agent: writer\n    prompt: steps/01.md\n    cwd: "${cwd}"`);
    const outcome = await runAgentStep(step, { ...baseCtx, queryFn: fn });
    expect(outcome.ok).toBe(true);
    expect(outcome.denials).toEqual([
      expect.objectContaining({ toolName: 'Read', toolUseId: 't5', source: 'both' }),
    ]);
  });

  test('a permission_denials entry WITHOUT a match in the hook log is marked "sdk-result" — a sign that something other than the hook denied', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-hook-'));
    const { fn } = capturingQueryFn({
      permission_denials: [{ tool_name: 'Write', tool_use_id: 't6', tool_input: { file_path: '/x' } }] as SDKResultSuccess['permission_denials'],
    });
    const step = agentStep(`  - id: scan\n    agent: writer\n    prompt: steps/01.md\n    cwd: "${cwd}"`);
    const outcome = await runAgentStep(step, { ...baseCtx, queryFn: fn });
    expect(outcome.denials).toEqual([
      expect.objectContaining({ toolName: 'Write', toolUseId: 't6', source: 'sdk-result' }),
    ]);
  });

  test('with no denial at all, "denials" is an empty array, not undefined', async () => {
    const { fn } = capturingQueryFn();
    const outcome = await runAgentStep(STEP, { ...baseCtx, queryFn: fn });
    expect(outcome.denials).toEqual([]);
  });

  // `redactOutcome` builds the `outcome.ok && !redacted.ok` branch (`outputs`
  // contract not met because it contains a secret) without `...outcome` —
  // unlike its other two branches. This test forces that exact branch:
  // declared `outputs`, a numeric field value that matches a secret
  // (redaction fails, see the "secret redaction" tests above), and a real
  // hook denial during the same run — to confirm that `denials` survives that
  // specific branch.
  test('the branch for a contract not met because of a secret keeps "denials"', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-hook-'));
    const step = agentStep(
      `  - id: scan\n    agent: writer\n    prompt: steps/01.md\n    cwd: "${cwd}"\n    outputs: { code: number }`,
    );
    let capturedHook: Function | undefined;
    const fn = (args: { prompt: string; options: Record<string, unknown> }) => {
      capturedHook = (args.options.hooks as { PreToolUse: Array<{ hooks: [Function] }> }).PreToolUse[0]!.hooks[0]!;
      return (async function* (): AsyncGenerator<SDKMessage> {
        await capturedHook!(
          { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/etc/passwd' }, tool_use_id: 't7' },
          't7',
          { signal: new AbortController().signal },
        );
        yield resultSuccess({ result: '{"code": 424242}' });
      })();
    };
    const outcome = await runAgentStep(step, { ...baseCtx, secrets: { MY_CODE: '424242' }, queryFn: fn });
    expect(outcome.ok).toBe(false);
    expect(outcome.denials).toEqual([
      expect.objectContaining({ toolName: 'Read', toolUseId: 't7', source: 'hook-log' }),
    ]);
  });
});

// The SDK delivers the name of an MCP tool QUALIFIED
// (`mcp__<server>__<tool>`), but `TOOL_FS_PROFILES` is indexed by the bare
// suffix — without normalizing before `evaluateToolCall`, EVERY real MCP call
// fell into "unknown tool for the engine" and was denied, even though the
// server and the tool were correctly declared and granted. Verified
// empirically against the real docs-review fixture: its 18 granted
// `mcp__playwright__*` tools were dead at runtime before this fix, despite
// passing `pipelines validate` and `doctor` without any warning (those two
// layers DO strip the prefix — see `schema/pipeline.ts` and
// `preflight/check.ts` — only the hook did not).
describe('runAgentStep — normalization of qualified MCP names in the hook', () => {
  function playwrightStep(cwd: string): AgentStep {
    const p = parsePipeline(`
name: demo
description: d
version: 1
mcp_servers:
  playwright:
    command: npx
    args: ["-y", "@playwright/mcp@latest"]
    kind: playwright
steps:
  - id: scan
    agent: writer
    prompt: steps/01.md
    cwd: "${cwd}"
    mcp_servers: [playwright]
    tools: [mcp__playwright__browser_take_screenshot]
`);
    return p.steps[0] as AgentStep;
  }

  const playwrightMcpServers = { playwright: { command: 'npx', args: [], env: [] } };

  async function hookFor(step: AgentStep) {
    let receivedOptions: Record<string, unknown> | undefined;
    const fn = (args: { prompt: string; options: Record<string, unknown> }) => {
      receivedOptions = args.options;
      return (async function* (): AsyncGenerator<SDKMessage> {
        yield resultSuccess();
      })();
    };
    await runAgentStep(step, { ...baseCtx, mcpServers: playwrightMcpServers, queryFn: fn });
    return (receivedOptions!.hooks as { PreToolUse: Array<{ hooks: [Function] }> }).PreToolUse[0]!.hooks[0]!;
  }

  test('mcp__playwright__browser_take_screenshot with a filename inside cwd is allowed — same as the bare name', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-hook-mcp-'));
    const hook = await hookFor(playwrightStep(cwd));
    const outcome = await hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__playwright__browser_take_screenshot',
        tool_input: { filename: join(cwd, 'shot.png') },
        tool_use_id: 't1',
      },
      't1',
      { signal: new AbortController().signal },
    );
    expect(outcome.hookSpecificOutput?.permissionDecision).toBe('allow');
  });

  test('mcp__playwright__browser_take_screenshot with a filename OUTSIDE cwd is denied with the real reason, not "unknown tool"', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-hook-mcp-'));
    const outside = mkdtempSync(join(tmpdir(), 'agent-hook-mcp-outside-'));
    const hook = await hookFor(playwrightStep(cwd));
    const outcome = await hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__playwright__browser_take_screenshot',
        tool_input: { filename: join(outside, 'shot.png') },
        tool_use_id: 't2',
      },
      't2',
      { signal: new AbortController().signal },
    );
    expect(outcome.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(outcome.hookSpecificOutput?.permissionDecisionReason).not.toContain('unknown tool');
    expect(outcome.hookSpecificOutput?.permissionDecisionReason).toContain('resolves outside every allowed root');
  });

  test('an mcp__<server>__ prefix of a server this step did NOT enable is not stripped — it is denied as an unknown tool, it does not inherit the profile of another server', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-hook-mcp-'));
    // playwrightStep only declares mcp_servers: [playwright].
    const hook = await hookFor(playwrightStep(cwd));
    const outcome = await hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__other-server__browser_take_screenshot',
        tool_input: {},
        tool_use_id: 't3',
      },
      't3',
      { signal: new AbortController().signal },
    );
    expect(outcome.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(outcome.hookSpecificOutput?.permissionDecisionReason).toContain('unknown tool for the engine');
  });

  test('a denial of a qualified MCP tool is recorded in denials with the QUALIFIED name — the same one the SDK result.permission_denials would use', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-hook-mcp-'));
    const outside = mkdtempSync(join(tmpdir(), 'agent-hook-mcp-outside-'));
    const step = playwrightStep(cwd);
    let capturedHook: Function | undefined;
    const fn = (args: { prompt: string; options: Record<string, unknown> }) => {
      capturedHook = (args.options.hooks as { PreToolUse: Array<{ hooks: [Function] }> }).PreToolUse[0]!.hooks[0]!;
      return (async function* (): AsyncGenerator<SDKMessage> {
        await capturedHook!(
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'mcp__playwright__browser_take_screenshot',
            tool_input: { filename: join(outside, 'x.png') },
            tool_use_id: 't9',
          },
          't9',
          { signal: new AbortController().signal },
        );
        yield resultSuccess({ result: 'ok' });
      })();
    };
    const outcome = await runAgentStep(step, { ...baseCtx, mcpServers: playwrightMcpServers, queryFn: fn });
    expect(outcome.denials).toEqual([
      expect.objectContaining({ toolName: 'mcp__playwright__browser_take_screenshot', toolUseId: 't9' }),
    ]);
  });

  // The class of test that was missing entirely, not just the one-off case of
  // `browser_take_screenshot`: for EVERY `browser_*` tool in
  // `TOOL_FS_PROFILES` (the ~20 Playwright ones), `mcp__playwright__<tool>`
  // must behave EXACTLY like the bare name. With `tool_input: {}` all ~20 must
  // be allowed: no required path field is left uncovered since
  // `browser_file_upload`/`browser_drop` became `required: false` — if any
  // denied here it would be either a regression of that fix, or a sign that
  // the normalization found no profile for that tool.
  test('for EVERY browser_* tool in TOOL_FS_PROFILES, mcp__playwright__<tool> resolves/allows the same as the bare name', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-hook-mcp-loop-'));
    const hook = await hookFor(playwrightStep(cwd));

    const browserTools = Object.keys(TOOL_FS_PROFILES).filter((name) => name.startsWith('browser_'));
    expect(browserTools.length).toBeGreaterThan(15); // the ~20 Playwright ones, not an accidental subset

    for (const bare of browserTools) {
      const qualified = `mcp__playwright__${bare}`;
      const bareResult = await hook(
        { hook_event_name: 'PreToolUse', tool_name: bare, tool_input: {}, tool_use_id: `bare-${bare}` },
        `bare-${bare}`,
        { signal: new AbortController().signal },
      );
      const qualifiedResult = await hook(
        { hook_event_name: 'PreToolUse', tool_name: qualified, tool_input: {}, tool_use_id: `qual-${bare}` },
        `qual-${bare}`,
        { signal: new AbortController().signal },
      );
      expect(qualifiedResult.hookSpecificOutput?.permissionDecision).toBe('allow');
      expect(qualifiedResult.hookSpecificOutput?.permissionDecision).toBe(
        bareResult.hookSpecificOutput?.permissionDecision,
      );
    }
  });
});

// `denials[].reason` (`evaluateToolCall`, fs-guard.ts) embeds the raw path
// exactly as the model asked for it — if that path contains a secret value (an
// agent `Bash`/prompt can end up interpolating `{{secrets.X}}`), the denial
// reason would carry it in the clear all the way to `.runs/` without this fix.
describe('runAgentStep — redaction of denials[].reason', () => {
  test('a secret inside the path of a denial is redacted in denials[].reason (success path)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-hook-redact-'));
    const step = agentStep(`  - id: scan\n    agent: writer\n    prompt: steps/01.md\n    cwd: "${cwd}"`);
    let capturedHook: Function | undefined;
    const fn = (args: { prompt: string; options: Record<string, unknown> }) => {
      capturedHook = (args.options.hooks as { PreToolUse: Array<{ hooks: [Function] }> }).PreToolUse[0]!.hooks[0]!;
      return (async function* (): AsyncGenerator<SDKMessage> {
        await capturedHook!(
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'Read',
            tool_input: { file_path: '/etc/secret-xyz/passwd' },
            tool_use_id: 't10',
          },
          't10',
          { signal: new AbortController().signal },
        );
        yield resultSuccess({ result: 'ok' });
      })();
    };
    const outcome = await runAgentStep(step, { ...baseCtx, secrets: { MY_TOKEN: 'secret-xyz' }, queryFn: fn });
    expect(outcome.ok).toBe(true);
    expect(outcome.denials).toHaveLength(1);
    expect(outcome.denials![0]!.reason).toContain(REDACTION);
    expect(outcome.denials![0]!.reason).not.toContain('secret-xyz');
  });

  test('a secret inside the path of a denial is also redacted in the branch for a contract not met because of a secret', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-hook-redact-'));
    const step = agentStep(
      `  - id: scan\n    agent: writer\n    prompt: steps/01.md\n    cwd: "${cwd}"\n    outputs: { code: number }`,
    );
    let capturedHook: Function | undefined;
    const fn = (args: { prompt: string; options: Record<string, unknown> }) => {
      capturedHook = (args.options.hooks as { PreToolUse: Array<{ hooks: [Function] }> }).PreToolUse[0]!.hooks[0]!;
      return (async function* (): AsyncGenerator<SDKMessage> {
        await capturedHook!(
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'Read',
            tool_input: { file_path: '/etc/secret-xyz/passwd' },
            tool_use_id: 't11',
          },
          't11',
          { signal: new AbortController().signal },
        );
        yield resultSuccess({ result: '{"code": 424242}' });
      })();
    };
    const outcome = await runAgentStep(step, {
      ...baseCtx,
      secrets: { MY_CODE: '424242', MY_TOKEN: 'secret-xyz' },
      queryFn: fn,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.denials).toHaveLength(1);
    expect(outcome.denials![0]!.reason).not.toContain('secret-xyz');
  });

  test('a secret inside the path of a denial is also redacted in a generic failure path', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-hook-redact-'));
    const step = agentStep(`  - id: scan\n    agent: writer\n    prompt: steps/01.md\n    cwd: "${cwd}"`);
    let capturedHook: Function | undefined;
    const fn = (args: { prompt: string; options: Record<string, unknown> }) => {
      capturedHook = (args.options.hooks as { PreToolUse: Array<{ hooks: [Function] }> }).PreToolUse[0]!.hooks[0]!;
      return (async function* (): AsyncGenerator<SDKMessage> {
        await capturedHook!(
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'Read',
            tool_input: { file_path: '/etc/secret-xyz/passwd' },
            tool_use_id: 't12',
          },
          't12',
          { signal: new AbortController().signal },
        );
        yield resultError({ subtype: 'error_during_execution', errors: ['generic failure'] });
      })();
    };
    const outcome = await runAgentStep(step, { ...baseCtx, secrets: { MY_TOKEN: 'secret-xyz' }, queryFn: fn });
    expect(outcome.ok).toBe(false);
    expect(outcome.denials).toHaveLength(1);
    expect(outcome.denials![0]!.reason).not.toContain('secret-xyz');
  });
});
