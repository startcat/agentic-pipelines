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
import { loadRepoAgents, outputsToJsonSchema, runAgentStep } from '../../src/runner/agent.ts';
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
  promptText: 'Cuenta las páginas obsoletas.',
  mcpServers: {},
};

/** Fabrica un queryFn falso que emite los mensajes indicados. */
function fakeQuery(messages: SDKMessage[]) {
  return () => (async function* (): AsyncGenerator<SDKMessage> { for (const m of messages) yield m; })();
}

// ---------------------------------------------------------------------------
// Fábricas de mensajes reales del SDK. `SDKMessage` es una unión de más de 30
// variantes con campos obligatorios profundamente anidados (BetaMessage,
// BetaUsage...); estas fábricas rellenan lo obligatorio con valores neutros
// y dejan que cada test sobrescriba solo lo que le importa, sin recurrir a
// `any` ni a un cast que reintroduzca el problema de usar formas inventadas: si
// el SDK cambia un campo obligatorio, estas fábricas dejan de compilar igual
// que el runner.
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

/** Resultado de éxito (`SDKResultMessage` con `subtype: 'success'`), sdk.d.ts ~4382. */
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

/** Resultado de fallo (`SDKResultMessage` con uno de los 4 subtypes de error), sdk.d.ts ~4350. */
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

/** Mensaje `assistant` (`SDKAssistantMessage`, sdk.d.ts ~2929), con su `BetaMessage` mínimo. */
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

/** Reintento interno del propio CLI ante un error de API (`SDKAPIRetryMessage`, sdk.d.ts ~2917). */
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
  test('traduce el contrato a JSON Schema con additionalProperties false', () => {
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
  test('parsea y valida el resultado contra el contrato, y registra coste y tokens reales', async () => {
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

  test('registra las herramientas usadas, leídas de los bloques tool_use del mensaje assistant', async () => {
    const outcome = await runAgentStep(STEP, {
      ...baseCtx,
      queryFn: fakeQuery([
        assistantMessage({ content: [toolUseBlock('Read'), toolUseBlock('Grep'), toolUseBlock('Read')] }),
        resultSuccess({ result: '{"count": 1}' }),
      ]),
    });
    expect(outcome.toolsUsed).toEqual(['Read', 'Grep']);
  });

  test('un resultado que no cumple el contrato es fallo NO transitorio', async () => {
    const outcome = await runAgentStep(STEP, {
      ...baseCtx,
      queryFn: fakeQuery([resultSuccess({ result: '{"count": "siete"}' })]),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.transient).toBe(false);
  });

  test('un resultado que no es JSON es fallo de contrato', async () => {
    const outcome = await runAgentStep(STEP, {
      ...baseCtx,
      queryFn: fakeQuery([resultSuccess({ result: 'he contado siete páginas' })]),
    });
    expect(outcome.ok).toBe(false);
  });

  test('un paso sin contrato acepta cualquier texto', async () => {
    const step = agentStep('  - id: a\n    agent: w\n    prompt: p.md');
    const outcome = await runAgentStep(step, {
      ...baseCtx,
      queryFn: fakeQuery([resultSuccess({ result: 'texto libre' })]),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.outputs).toEqual({});
  });

  test('interpola el prompt con params y salidas anteriores', async () => {
    let receivedPrompt = '';
    const step = agentStep('  - id: a\n    agent: w\n    prompt: p.md');
    await runAgentStep(step, {
      ...baseCtx,
      promptText: 'Revisa {{params.repo}} con {{prev.n}} pendientes',
      scope: { params: { repo: '/srv' }, steps: { prev: { n: 4 } } },
      queryFn: ({ prompt }) => {
        receivedPrompt = prompt;
        return (async function* (): AsyncGenerator<SDKMessage> { yield resultSuccess({ result: 'ok' }); })();
      },
    });
    expect(receivedPrompt).toBe('Revisa /srv con 4 pendientes');
  });

  test('interpola {{secrets.X}} en el prompt, usando los secretos del paso', async () => {
    let receivedPrompt = '';
    const step = agentStep('  - id: a\n    agent: w\n    prompt: p.md');
    await runAgentStep(step, {
      ...baseCtx,
      promptText: 'Contraseña: {{secrets.DOCS_ADMIN_PASSWORD}}',
      secrets: { DOCS_ADMIN_PASSWORD: 'super-secreta' },
      queryFn: ({ prompt }) => {
        receivedPrompt = prompt;
        return (async function* (): AsyncGenerator<SDKMessage> { yield resultSuccess({ result: 'ok' }); })();
      },
    });
    expect(receivedPrompt).toBe('Contraseña: super-secreta');
  });

  test('{{secrets.X}} sin ese secreto declarado hace que runAgentStep rechace la promesa', async () => {
    const step = agentStep('  - id: a\n    agent: w\n    prompt: p.md');
    await expect(
      runAgentStep(step, {
        ...baseCtx,
        promptText: 'Contraseña: {{secrets.NO_DECLARADO}}',
        secrets: {},
      }),
    ).rejects.toThrow(/NO_DECLARADO/);
  });

  test('pasa a las opciones del SDK las herramientas, cwd y env declarados', async () => {
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
    // `tools` es la restricción real (sdk.d.ts ~1369-1371: `allowedTools`
    // por sí solo NO restringe, solo evita el prompt de aprobación).
    // Ambas deben llevar exactamente lo declarado en el YAML.
    expect(received.tools).toEqual(['Read', 'Write']);
    expect(received.allowedTools).toEqual(['Read', 'Write']);
    expect(received.agent).toBe('writer');
    expect(received.settingSources).toEqual([]);
    expect(received.permissionMode).toBe('bypassPermissions');
    const env = received.env as Record<string, string>;
    expect(env.MY_TOKEN).toBe('s');
    expect(env.PATH).toBeTruthy();
  });

  test('pasa max_cost_usd como maxBudgetUsd al SDK', async () => {
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

  test('sin max_cost_usd declarado, no se pasa maxBudgetUsd', async () => {
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

  test('activa los servidores MCP declarados por el paso, resolviendo env desde secrets', async () => {
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
      // UNSET_VAR se declara en el servidor pero no aquí: debe omitirse, no
      // aparecer como undefined ni hacer fallar la resolución.
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

  test('un paso sin mcp_servers no envía mcpServers al SDK', async () => {
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

  test('interpola {{params.*}} en command y args de un servidor MCP', async () => {
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

  test('siempre pasa strictMcpConfig: true, con o sin servidores declarados', async () => {
    let received: Record<string, unknown> = {};
    await runAgentStep(STEP, {
      ...baseCtx,
      queryFn: ({ options }) => {
        received = options;
        return (async function* (): AsyncGenerator<SDKMessage> { yield resultSuccess({ result: '{"count": 1}' }); })();
      },
    });
    // Sin esto, `Options.mcpServers` es ADITIVO a cualquier servidor MCP ya
    // configurado en la máquina (settings de usuario, plugins, .mcp.json de
    // proyecto).
    expect(received.strictMcpConfig).toBe(true);
  });

  test('reenvía las variables de red no-secretas a un servidor MCP declarado aunque no estén en requires.env', async () => {
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
        // secrets vacío a propósito: HTTP_PROXY no está en requires.env de
        // este pipeline y aun así debe llegar al servidor.
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
// Clasificación transient vs permanente contra la forma REAL del SDK. Una
// versión anterior clasificaba sobre un `error.message` inventado que el SDK
// nunca emite; estos tests fijan el comportamiento sobre las categorías
// estructuradas reales: `SDKAssistantMessage.error` / `SDKAPIRetryMessage.error`
// (tipo `SDKAssistantMessageError`) y, como último recurso, el `subtype` de
// `SDKResultError` y el texto libre de `errors`.
// ---------------------------------------------------------------------------
describe('runAgentStep — clasificación transient vs permanente', () => {
  test('un turno assistant marcado overloaded produce un fallo transitorio (debe reintentarse)', async () => {
    const outcome = await runAgentStep(STEP, {
      ...baseCtx,
      queryFn: fakeQuery([
        assistantMessage({ error: 'overloaded' }),
        resultError({ subtype: 'error_during_execution', errors: ['la API devolvió 529'] }),
      ]),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.transient).toBe(true);
  });

  test('un aviso de reintento interno del CLI por rate_limit también marca el fallo como transitorio', async () => {
    // SDKAPIRetryMessage es lo que emite el propio CLI cuando ÉL reintenta
    // una llamada a la API; si acaba fallando de todos modos (agotó sus
    // reintentos), la categoría de ese aviso sigue siendo la señal más
    // fiable de por qué.
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

  test('un turno assistant marcado authentication_failed NO es transitorio', async () => {
    const outcome = await runAgentStep(STEP, {
      ...baseCtx,
      queryFn: fakeQuery([
        assistantMessage({ error: 'authentication_failed' }),
        resultError({ subtype: 'error_during_execution', errors: ['credenciales inválidas'] }),
      ]),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.transient).toBe(false);
  });

  test('agotar el presupuesto en USD NO es transitorio aunque un turno anterior viera overloaded', async () => {
    // El subtype de agotamiento manda: un hipo transitorio ya absorbido por
    // el CLI en un turno intermedio no convierte en transitorio un fallo
    // final por presupuesto agotado.
    const outcome = await runAgentStep(STEP, {
      ...baseCtx,
      queryFn: fakeQuery([
        assistantMessage({ error: 'overloaded' }),
        resultError({ subtype: 'error_max_budget_usd', errors: ['se superó el presupuesto máximo'] }),
      ]),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.transient).toBe(false);
  });

  test('agotar los turnos máximos NO es transitorio', async () => {
    const outcome = await runAgentStep(STEP, {
      ...baseCtx,
      queryFn: fakeQuery([resultError({ subtype: 'error_max_turns', errors: ['se alcanzó el máximo de turnos'] })]),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.transient).toBe(false);
  });

  test('error_during_execution sin ninguna categoría estructurada cae al respaldo de texto (529 -> transitorio)', async () => {
    const outcome = await runAgentStep(STEP, {
      ...baseCtx,
      queryFn: fakeQuery([
        resultError({ subtype: 'error_during_execution', errors: ['overloaded_error: try again (529)'] }),
      ]),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.transient).toBe(true);
  });

  test('error_during_execution sin categoría estructurada ni patrón de texto reconocido cae del lado seguro (no transitorio)', async () => {
    const outcome = await runAgentStep(STEP, {
      ...baseCtx,
      queryFn: fakeQuery([
        resultError({ subtype: 'error_during_execution', errors: ['algo salió mal de un modo no catalogado'] }),
      ]),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.transient).toBe(false);
  });

  test('un flujo que termina sin emitir ningún mensaje result NO es transitorio', async () => {
    // Ni éxito ni excepción: el generador simplemente se agota sin haber
    // emitido nunca `{ type: 'result' }'. No hay nada en los tipos del SDK
    // que documente esto como un artefacto de transporte, así que cae del
    // lado seguro igual que cualquier otra condición sin reconocer.
    const outcome = await runAgentStep(STEP, {
      ...baseCtx,
      queryFn: () => (async function* (): AsyncGenerator<SDKMessage> {})(),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.transient).toBe(false);
      expect(outcome.error).toContain('resultado');
    }
  });

  test('una excepción lanzada por queryFn (fallo de transporte, sin mensaje result) se clasifica por texto', async () => {
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

  test('un timeout (nuestro propio AbortController) siempre es transitorio, aunque el mensaje no case con ningún patrón', async () => {
    const outcome = await runAgentStep(STEP, {
      ...baseCtx,
      timeoutMs: 10,
      queryFn: () =>
        (async function* (): AsyncGenerator<SDKMessage> {
          await new Promise((resolve) => setTimeout(resolve, 50));
          throw new Error('algo no catalogado');
        })(),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.transient).toBe(true);
      expect(outcome.error).toContain('timeout');
    }
  });
});

// Los secretos se redactan en la
// misma función que legítimamente los maneja (runAgentStep), en todo
// camino de retorno — no en un punto posterior de escritura. `composeEnv`
// pasa los secretos al SDK vía `env`, así que un paso con `Bash` en `tools`
// puede ecoarlos de vuelta exactamente igual que un paso `shell`.
describe('runAgentStep — redacción de secretos', () => {
  test('un secreto que aparece en el texto del resultado se redacta en el log', async () => {
    const step = agentStep('  - id: a\n    agent: w\n    prompt: p.md');
    const outcome = await runAgentStep(step, {
      ...baseCtx,
      secrets: { MY_TOKEN: 'secreto-xyz' },
      queryFn: fakeQuery([resultSuccess({ result: 'Usé el token secreto-xyz para autenticar' })]),
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.log).toContain(REDACTION);
    expect(outcome.log).not.toContain('secreto-xyz');
  });

  test('un error del SDK que menciona el secreto se redacta en error y en log', async () => {
    const step = agentStep('  - id: a\n    agent: w\n    prompt: p.md');
    const outcome = await runAgentStep(step, {
      ...baseCtx,
      secrets: { MY_TOKEN: 'secreto-xyz' },
      queryFn: fakeQuery([
        resultError({ subtype: 'error_during_execution', errors: ['token secreto-xyz inválido'] }),
      ]),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain(REDACTION);
      expect(outcome.error).not.toContain('secreto-xyz');
      expect(outcome.log).not.toContain('secreto-xyz');
    }
  });

  test('una excepción del queryFn que menciona el secreto se redacta', async () => {
    const step = agentStep('  - id: a\n    agent: w\n    prompt: p.md');
    const outcome = await runAgentStep(step, {
      ...baseCtx,
      secrets: { MY_TOKEN: 'secreto-xyz' },
      queryFn: () =>
        (async function* (): AsyncGenerator<SDKMessage> {
          throw new Error('fallo de red con secreto-xyz filtrado');
        })(),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).not.toContain('secreto-xyz');
      expect(outcome.log).not.toContain('secreto-xyz');
    }
  });

  test('un secreto ecoado en un output string declarado se redacta', async () => {
    const step = agentStep('  - id: a\n    agent: w\n    prompt: p.md\n    outputs: { note: string }');
    const outcome = await runAgentStep(step, {
      ...baseCtx,
      secrets: { MY_TOKEN: 'secreto-xyz' },
      queryFn: fakeQuery([resultSuccess({ result: '{"note": "token: secreto-xyz"}' })]),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.outputs.note).toBe(`token: ${REDACTION}`);
      expect(JSON.stringify(outcome.outputs)).not.toContain('secreto-xyz');
    }
  });

  test('un secreto ecoado en un output numérico falla el paso en vez de exponerlo', async () => {
    // Un número no puede sustituirse por REDACTION sin dejar de ser un
    // número, así que la única salida honesta es fallar el paso.
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

  test('un secreto ecoado dentro de un array de números también falla el paso', async () => {
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

// `AgentStepContext.repoRoot` se recibía
// pero nunca se leía, así que un agente en `<repoRoot>/agents/*.md` que
// pasaba `doctor` con ✓ no llegaba jamás al SDK. Directorio propio por test
// (nunca el tmpdir compartido), igual que el resto de la suite que toca disco.
describe('runAgentStep — agentes del repo', () => {
  test('un agente definido en agents/*.md del repo llega a las opciones del SDK', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'ap-agent-repo-'));
    try {
      mkdirSync(join(repoRoot, 'agents'), { recursive: true });
      writeFileSync(
        join(repoRoot, 'agents', 'doc-writer.md'),
        '---\ndescription: Escribe documentación\ntools: Read, Grep, Glob\n---\n\nEres un redactor técnico.\n',
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
      expect(agents['doc-writer']!.description).toBe('Escribe documentación');
      expect(agents['doc-writer']!.prompt).toBe('Eres un redactor técnico.');
      expect(agents['doc-writer']!.tools).toEqual(['Read', 'Grep', 'Glob']);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('un repoRoot sin directorio agents/ no lanza y pasa un objeto vacío', async () => {
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

  // Un fichero de
  // agente con front matter roto hacía que parseAgentMarkdown lanzara
  // dentro del bucle, así que loadRepoAgents descartaba TODOS los agentes
  // ya cargados, no solo el roto — un paso que ni usaba el agente roto
  // fallaba igual. Verificado también que el caso sin delimitadores `---`
  // (que ya funcionaba antes de esta corrección) sigue funcionando igual.
  test('un agente sin front matter carga con el fichero entero como prompt', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'ap-agent-repo-'));
    try {
      mkdirSync(join(repoRoot, 'agents'), { recursive: true });
      writeFileSync(join(repoRoot, 'agents', 'plain.md'), 'Eres un agente sin metadatos.\n');

      const agents = await loadRepoAgents(repoRoot);
      expect(agents['plain']).toBeDefined();
      expect(agents['plain']!.description).toBe('');
      expect(agents['plain']!.prompt).toBe('Eres un agente sin metadatos.');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('un agente con front matter inválido se omite con un aviso, sin descartar los demás', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'ap-agent-repo-'));
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mkdirSync(join(repoRoot, 'agents'), { recursive: true });
      writeFileSync(
        join(repoRoot, 'agents', 'good.md'),
        '---\ndescription: Agente válido\n---\n\nSoy un agente válido.\n',
      );
      writeFileSync(
        join(repoRoot, 'agents', 'bad.md'),
        '---\ndescription: [sin cerrar\n---\n\nEste prompt nunca se usa.\n',
      );

      const agents = await loadRepoAgents(repoRoot);
      expect(Object.keys(agents)).toEqual(['good']);
      expect(agents['good']!.description).toBe('Agente válido');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]![0]).toContain('bad.md');
    } finally {
      warnSpy.mockRestore();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('un front matter que parsea a una lista (no un mapeo) también se omite con aviso', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'ap-agent-repo-'));
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mkdirSync(join(repoRoot, 'agents'), { recursive: true });
      writeFileSync(
        join(repoRoot, 'agents', 'lista.md'),
        '---\n- uno\n- dos\n---\n\nCuerpo.\n',
      );

      const agents = await loadRepoAgents(repoRoot);
      expect(agents).toEqual({});
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]![0]).toContain('lista.md');
    } finally {
      warnSpy.mockRestore();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('runAgentStep — hook PreToolUse', () => {
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

  test('registra un hook PreToolUse sin matcher, con exactamente un callback', async () => {
    const { fn, getOptions } = capturingQueryFn();
    await runAgentStep(STEP, { ...baseCtx, queryFn: fn });
    const hooks = getOptions().hooks as { PreToolUse: Array<{ matcher?: string; hooks: unknown[] }> };
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PreToolUse[0]!.hooks).toHaveLength(1);
  });

  test('el hook registrado deniega una ruta fuera de cwd, con motivo', async () => {
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

  test('el hook registrado permite una ruta dentro de cwd', async () => {
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

  test('additional_dirs se interpola igual que cwd y se pasa a captureRoots — una ruta dentro se permite', async () => {
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

  test('cruce hook-log × permission_denials: una denegación que pasó por el hook durante el run aparece con source "both"', async () => {
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

  test('una entrada de permission_denials SIN pareja en el log del hook se marca "sdk-result" — señal de que algo ajeno al hook denegó', async () => {
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

  test('sin ninguna denegación, "denials" es un array vacío, no undefined', async () => {
    const { fn } = capturingQueryFn();
    const outcome = await runAgentStep(STEP, { ...baseCtx, queryFn: fn });
    expect(outcome.denials).toEqual([]);
  });

  // `redactOutcome` construye la rama `outcome.ok && !redacted.ok` (contrato
  // de `outputs` incumplido por contener un secreto) sin `...outcome` — a
  // diferencia de sus otras dos ramas. Este test fuerza esa rama exacta:
  // `outputs` declarado, un valor de campo numérico que coincide con un
  // secreto (falla la redacción, ver los tests de "redacción de secretos"
  // más arriba), y una denegación real del hook durante el mismo run — para
  // confirmar que `denials` sobrevive a esa rama concreta.
  test('la rama de contrato incumplido por secreto conserva "denials"', async () => {
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

// El SDK entrega el
// nombre de una tool MCP CUALIFICADO (`mcp__<servidor>__<tool>`), pero
// `TOOL_FS_PROFILES` está indexada por el sufijo desnudo — sin normalizar
// antes de `evaluateToolCall`, TODA llamada MCP real caía en "tool
// desconocida para el motor" y se denegaba, aunque el servidor y la tool
// estuvieran correctamente declarados y concedidos. Verificado empíricamente
// contra el fixture real de docs-review: sus 18
// `mcp__playwright__*` tools concedidas estaban muertas en tiempo de
// ejecución antes de este arreglo, pese a pasar `pipelines validate` y
// `doctor` sin ningún aviso (esas dos capas SÍ quitan el prefijo — ver
// `schema/pipeline.ts` y `preflight/check.ts` — solo el hook no lo hacía).
describe('runAgentStep — normalización de nombres MCP cualificados en el hook', () => {
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

  test('mcp__playwright__browser_take_screenshot con filename dentro de cwd se permite — igual que el nombre bare', async () => {
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

  test('mcp__playwright__browser_take_screenshot con filename FUERA de cwd se deniega con el motivo real, no "tool desconocida"', async () => {
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
    expect(outcome.hookSpecificOutput?.permissionDecisionReason).not.toContain('tool desconocida');
    expect(outcome.hookSpecificOutput?.permissionDecisionReason).toContain('resuelve fuera de toda raíz permitida');
  });

  test('un prefijo mcp__<servidor>__ de un servidor que este paso NO activó no se quita — se deniega como tool desconocida, no hereda el perfil de otro servidor', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-hook-mcp-'));
    // playwrightStep solo declara mcp_servers: [playwright].
    const hook = await hookFor(playwrightStep(cwd));
    const outcome = await hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__otro-servidor__browser_take_screenshot',
        tool_input: {},
        tool_use_id: 't3',
      },
      't3',
      { signal: new AbortController().signal },
    );
    expect(outcome.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(outcome.hookSpecificOutput?.permissionDecisionReason).toContain('tool desconocida para el motor');
  });

  test('una denegación de una tool MCP cualificada se registra en denials con el nombre CUALIFICADO — el mismo que usaría result.permission_denials del SDK', async () => {
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

  // La clase de test que faltaba por completo, no solo el caso puntual de
  // `browser_take_screenshot`: para
  // CADA tool `browser_*` de `TOOL_FS_PROFILES` (las ~20 de Playwright),
  // `mcp__playwright__<tool>` debe comportarse EXACTAMENTE igual que el
  // nombre bare. Con `tool_input: {}` las ~20 deben permitirse: ningún
  // campo de ruta obligatorio queda sin cubrir desde que
  // `browser_file_upload`/`browser_drop` pasaron a `required: false`) —
  // si cualquiera denegara aquí sería o una regresión de ese fix, o una
  // señal de que la normalización no encontró perfil para esa tool.
  test('para TODA tool browser_* de TOOL_FS_PROFILES, mcp__playwright__<tool> resuelve/permite igual que el nombre bare', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-hook-mcp-loop-'));
    const hook = await hookFor(playwrightStep(cwd));

    const browserTools = Object.keys(TOOL_FS_PROFILES).filter((name) => name.startsWith('browser_'));
    expect(browserTools.length).toBeGreaterThan(15); // las ~20 de Playwright, no un subconjunto accidental

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

// `denials[].reason`
// (`evaluateToolCall`, fs-guard.ts) incrusta la ruta cruda tal cual la pidió
// el modelo — si esa ruta contiene un valor de secreto (un `Bash`/prompt
// agéntico puede llegar a interpolar `{{secrets.X}}`), el motivo de la
// denegación lo llevaría en claro hasta `.runs/` sin este arreglo.
describe('runAgentStep — redacción de denials[].reason', () => {
  test('un secreto dentro de la ruta de una denegación se redacta en denials[].reason (camino de éxito)', async () => {
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
            tool_input: { file_path: '/etc/secreto-xyz/passwd' },
            tool_use_id: 't10',
          },
          't10',
          { signal: new AbortController().signal },
        );
        yield resultSuccess({ result: 'ok' });
      })();
    };
    const outcome = await runAgentStep(step, { ...baseCtx, secrets: { MY_TOKEN: 'secreto-xyz' }, queryFn: fn });
    expect(outcome.ok).toBe(true);
    expect(outcome.denials).toHaveLength(1);
    expect(outcome.denials![0]!.reason).toContain(REDACTION);
    expect(outcome.denials![0]!.reason).not.toContain('secreto-xyz');
  });

  test('un secreto dentro de la ruta de una denegación también se redacta en la rama de contrato incumplido por secreto', async () => {
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
            tool_input: { file_path: '/etc/secreto-xyz/passwd' },
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
      secrets: { MY_CODE: '424242', MY_TOKEN: 'secreto-xyz' },
      queryFn: fn,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.denials).toHaveLength(1);
    expect(outcome.denials![0]!.reason).not.toContain('secreto-xyz');
  });

  test('un secreto dentro de la ruta de una denegación también se redacta en un camino de fallo genérico', async () => {
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
            tool_input: { file_path: '/etc/secreto-xyz/passwd' },
            tool_use_id: 't12',
          },
          't12',
          { signal: new AbortController().signal },
        );
        yield resultError({ subtype: 'error_during_execution', errors: ['fallo genérico'] });
      })();
    };
    const outcome = await runAgentStep(step, { ...baseCtx, secrets: { MY_TOKEN: 'secreto-xyz' }, queryFn: fn });
    expect(outcome.ok).toBe(false);
    expect(outcome.denials).toHaveLength(1);
    expect(outcome.denials![0]!.reason).not.toContain('secreto-xyz');
  });
});
