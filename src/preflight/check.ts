import { access, readdir } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { join } from 'node:path';
import type { Pipeline } from '../schema/pipeline.ts';
import { TOOL_FS_PROFILES, type ToolFsProfile } from '../runner/fs-guard.ts';
import type { McpServerConfig } from '../schema/pipeline.ts';

/**
 * Longitud mínima para que un valor de `requires.env` cuente como un
 * secreto real. Sin esto, una variable vacía o un placeholder de tres
 * letras pasaba `preflight`/`doctor` igual que un valor legítimo. Sin cálculo
 * de entropía: el objetivo es pillar "vacío o casi vacío", no auditar la
 * calidad criptográfica del secreto.
 */
const MIN_SECRET_LENGTH = 8;

export type PreflightCheck = {
  kind: 'agent' | 'skill' | 'bin' | 'env' | 'net' | 'auth' | 'mcp' | 'mcp-schema';
  name: string;
  ok: boolean;
  /** Explicación breve. Nunca contiene valores de secretos. */
  detail: string;
};

export type PreflightReport = { ok: boolean; checks: PreflightCheck[] };

/**
 * ¿Debe este informe impedir que `pipelines run` arranque? Distinto de
 * `report.ok` (usado por `pipelines doctor`, que sigue exigiendo TODOS los
 * checks, `mcp-schema` incluido — tan ruidoso como se diseñó): un check
 * `mcp-schema` es puramente informativo para `run` — es la deriva de
 * esquema de un servidor MCP que vigila `pipelines doctor`, así que nunca
 * fue pensado como una condición que bloquee una ejecución real.
 * Antes de este arreglo, `run` y `doctor` compartían literalmente `preflight()` Y el mismo
 * criterio de gating (`!report.ok`), así que un servidor MCP lento/caído en
 * el momento equivocado bloqueaba una ejecución real por un chequeo que
 * nunca debía bloquear nada fuera de `doctor`.
 */
export function hasBlockingFailures(report: PreflightReport): boolean {
  return report.checks.some((c) => !c.ok && c.kind !== 'mcp-schema');
}

export type Probes = {
  hasBinary(name: string): Promise<boolean>;
  resolvesHost(host: string): Promise<boolean>;
  listUserAgents(): Promise<string[]>;
  listUserSkills(): Promise<string[]>;
  /** Nombres de propiedad del inputSchema de cada tool que expone el servidor real, por nombre de tool. */
  listMcpTools(server: McpServerConfig, env: Record<string, string>): Promise<Record<string, string[]>>;
  /** ¿Hay una credencial de Claude Code en el llavero del sistema? */
  hasKeychainSession(): Promise<boolean>;
};

export type PreflightEnv = {
  repoRoot: string;
  userClaudeDir: string;
  processEnv: Record<string, string | undefined>;
  dotEnv: Record<string, string>;
  probes?: Partial<Probes>;
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Nombres de fichero .md de un directorio, sin extensión. */
async function markdownNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((e) => e.endsWith('.md')).map((e) => e.slice(0, -3));
  } catch {
    return [];
  }
}

/**
 * Tiempo máximo para todo el handshake MCP (`initialize` + `tools/list`),
 * cada `readOneMessage()` por separado. `reader.read()` esperaba indefinidamente sin
 * esto — un servidor colgado (caché de npx fría, registro npm caído,
 * cualquier motivo) dejaba `doctor` (y, antes del arreglo del punto
 * contiguo, también `run`) esperando para siempre. 12s es generoso para un
 * `npx` con caché tibia en una máquina normal, sin llegar a sentirse como un
 * cuelgue para quien ejecuta `doctor` a mano.
 */
const MCP_HANDSHAKE_TIMEOUT_MS = 12_000;

/**
 * Corre `promise` con un límite de tiempo: si `ms` transcurren antes de que
 * resuelva o rechace, la carrera la gana un rechazo con un mensaje claro de
 * "tiempo agotado" — nunca un cuelgue silencioso. El temporizador se limpia
 * en cuanto `promise` decide primero, para no dejar un timer vivo más de lo
 * necesario.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label}: sin respuesta tras ${ms} ms — tiempo agotado`)),
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
 * Handshake MCP mínimo por stdio: `initialize` seguido de `tools/list`. Sin
 * dependencias de protocolo más allá de JSON-RPC sobre líneas — el mismo
 * transporte que ya usa `mcp_servers` en producción (`resolveMcpServers`,
 * `runner/agent.ts`). Cierra el proceso con `.kill()` en cuanto tiene la
 * respuesta que necesita (o en cuanto el handshake se agota, vía `finally`
 * — el timeout rechaza la promesa pero no mata el proceso por sí solo); no
 * deja el servidor corriendo en segundo plano.
 *
 * `timeoutMs` es un parámetro (no una constante interna fija) solo para que
 * los tests puedan ejercitar el camino de "tiempo agotado" sin esperar los
 * `MCP_HANDSHAKE_TIMEOUT_MS` por defecto; en producción `defaultProbes`
 * nunca lo pasa, así que siempre corre con el valor por defecto.
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
      if (done) throw new Error('el servidor MCP cerró stdout antes de responder');
      buffer += decoder.decode(value, { stream: true });
    }
  }
  async function readOneMessageWithTimeout(): Promise<Record<string, unknown>> {
    return withTimeout(readOneMessage(), timeoutMs, 'handshake MCP');
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
    await readOneMessageWithTimeout(); // respuesta a initialize — se descarta, solo hace falta el handshake
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
    // Bun.which busca en PATH sin lanzar un subproceso ni depender de un
    // binario externo `which` (ausente, p. ej., en muchas imágenes
    // distroless): devuelve la ruta resuelta o null si no existe.
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
      // A diferencia de los agentes (un fichero .md por agente), cada skill
      // es un directorio propio (con su SKILL.md dentro), así que aquí no
      // se filtra por extensión: el nombre de la entrada de directorio ES
      // el nombre de la skill.
      try {
        return await readdir(join(env.userClaudeDir, 'skills'));
      } catch {
        return [];
      }
    },
    async listMcpTools(server, resolvedEnv) {
      return listMcpToolsViaStdio(server, resolvedEnv);
    },
    // Claude Code guarda su credencial en el llavero de macOS, no siempre en
    // `~/.claude/.credentials.json` — ese fichero puede no existir en una
    // máquina perfectamente autenticada (desapareció de la máquina de
    // desarrollo el 2026-08-29, dejando el check `auth` en rojo y bloqueando
    // cualquier `run`). `security find-generic-password` SIN `-w`: comprueba
    // que el ítem existe imprimiendo solo atributos, nunca la contraseña; aun
    // así se descarta stdout, para que ningún valor pueda acabar en un log.
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
 * Verifica todas las dependencias declaradas en `requires` antes de que el
 * runner gaste un solo token. Es lo que permite fallar antes de gastar nada
 * y el motor del comando `pipelines doctor`.
 */
export async function preflight(
  pipeline: Pipeline,
  env: PreflightEnv,
): Promise<PreflightReport> {
  const probes = { ...defaultProbes(env), ...env.probes };
  const checks: PreflightCheck[] = [];

  // Autenticación. El motor nunca la intermedia: solo comprueba que existe.
  const hasApiKey = Boolean(env.processEnv.ANTHROPIC_API_KEY);
  const hasSessionFile = await exists(join(env.userClaudeDir, '.credentials.json'));
  const hasKeychain = hasSessionFile ? false : await probes.hasKeychainSession();
  checks.push({
    kind: 'auth',
    name: 'claude',
    ok: hasApiKey || hasSessionFile || hasKeychain,
    detail: hasApiKey
      ? 'ANTHROPIC_API_KEY presente'
      : hasSessionFile
        ? 'sesión de Claude Code iniciada'
        : hasKeychain
          ? 'sesión de Claude Code en el llavero'
          : 'sin credenciales: define ANTHROPIC_API_KEY o inicia sesión con `claude`',
  });

  // Agentes: primero los del repo, después los del usuario.
  const repoAgents = await markdownNames(join(env.repoRoot, 'agents'));
  const userAgents = await probes.listUserAgents();
  for (const name of pipeline.requires.agents) {
    const inRepo = repoAgents.includes(name);
    const inUser = userAgents.includes(name);
    checks.push({
      kind: 'agent',
      name,
      ok: inRepo || inUser,
      detail: inRepo ? 'repo' : inUser ? 'usuario' : 'no encontrado',
    });
  }

  const userSkills = await probes.listUserSkills();
  for (const name of pipeline.requires.skills) {
    const ok = userSkills.includes(name) || userSkills.includes(name.split(':').pop()!);
    checks.push({ kind: 'skill', name, ok, detail: ok ? 'disponible' : 'no encontrada' });
  }

  for (const name of pipeline.requires.bin) {
    const ok = await probes.hasBinary(name);
    checks.push({ kind: 'bin', name, ok, detail: ok ? 'en PATH' : 'no está en PATH' });
  }

  // Servidores MCP: mismo chequeo que `bin` (¿arranca el comando?), pero
  // derivado de `mcp_servers` en vez de declararlo dos veces en `requires`.
  for (const [name, server] of Object.entries(pipeline.mcpServers)) {
    const ok = await probes.hasBinary(server.command);
    checks.push({
      kind: 'mcp',
      name,
      ok,
      detail: ok
        ? `comando "${server.command}" en PATH`
        : `comando "${server.command}" no está en PATH`,
    });
  }

  // Deriva de esquema: para cada servidor con `kind:` conocido, compara los
  // nombres de propiedad reales de cada tool CONCEDIDA (no toda la
  // superficie del servidor) contra lo que TOOL_FS_PROFILES recuerda. Es la
  // única de las dos capas (junto al gobierno estático de `validate`) que
  // compara contra el paquete real en vez de contra una tabla,
  // motivada por @playwright/mcp@latest cambiando de 69 a 24 tools en un
  // solo día.
  //
  // La comparación se hace contra `profile.knownFields` (el esquema
  // COMPLETO conocido de la tool, verificado en vivo — ver el comentario de
  // `TOOL_FS_PROFILES` en fs-guard.ts), no solo contra `field`/`fields` (el
  // campo que el hook realmente vigila). Comparar solo contra el campo
  // vigilado no puede detectar un campo NUEVO: prácticamente cualquier tool
  // real tiene más parámetros que el único campo de ruta que la tabla
  // rastrea, así que "cualquier campo no vigilado es aviso" dispararía en
  // casi cualquier llamada real. Hacen falta las tres direcciones —
  // campo nuevo, renombrado, desaparecido — así que se calculan tres
  // conjuntos por tool concedida:
  //   - `missingGoverned`: el/los campo(s) que el HOOK vigila de verdad
  //     (`profile.field`/`profile.fields`) ya no están en el esquema real.
  //     Señal fuerte: el guard sigue intentando sanear un campo que ya no
  //     existe, así que cualquier campo de ruta nuevo que la tool haya
  //     podido ganar queda sin vigilar.
  //   - `missingOther`: un campo del `knownFields` COMPLETO (pero no
  //     vigilado por el hook) que ha desaparecido. Señal más débil — no
  //     compromete el guard directamente — pero indica que el paquete
  //     cambió de forma bajo la tabla.
  //   - `extraFields`: un campo real que no está en `knownFields`. Cubre
  //     tanto "campo nuevo" como la mitad "aparece" de un renombrado — un
  //     campo renombrado se ve, sin ningún caso especial, como una entrada
  //     en `missingGoverned`/`missingOther` (el nombre viejo) más una en
  //     `extraFields` (el nombre nuevo).
  const grantedMcpTools = new Map<string, Set<string>>(); // nombre de servidor -> sufijos de tool concedidos
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
      const real = await probes.listMcpTools(server, {}); // env real resuelto por el llamante si hace falta en el futuro
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
          drift.push(`${suffix}: la tool ya no existe en el servidor real`);
          continue;
        }
        const missingGoverned = governedFields.filter((f) => !realFields.includes(f));
        if (missingGoverned.length > 0) {
          drift.push(`${suffix}: campo(s) que la tabla esperaba y ya no están: ${missingGoverned.join(', ')}`);
        }
        const missingOther = knownFields.filter(
          (f) => !governedFields.includes(f) && !realFields.includes(f),
        );
        if (missingOther.length > 0) {
          drift.push(
            `${suffix}: campo(s) conocidos que ya no están (sin campo de ruta vigilado): ${missingOther.join(', ')}`,
          );
        }
        const extraFields = realFields.filter((f) => !knownFields.includes(f));
        if (extraFields.length > 0) {
          drift.push(`${suffix}: campo(s) nuevos que la tabla no conocía: ${extraFields.join(', ')}`);
        }
      }
      checks.push({
        kind: 'mcp-schema',
        name,
        ok: drift.length === 0,
        detail: drift.length === 0 ? 'esquema real coincide con la tabla del motor' : drift.join('; '),
      });
    } catch (err) {
      checks.push({
        kind: 'mcp-schema',
        name,
        ok: false,
        detail: `no se pudo comparar contra el servidor real: ${(err as Error).message}`,
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
          ? 'sin definir (añádela a .env)'
          : ok
            ? 'definida'
            : `definida pero demasiado corta (mínimo ${MIN_SECRET_LENGTH} caracteres)`,
    });
  }

  for (const name of pipeline.requires.net) {
    const ok = await probes.resolvesHost(name);
    checks.push({ kind: 'net', name, ok, detail: ok ? 'alcanzable' : 'no resuelve' });
  }

  return { ok: checks.every((c) => c.ok), checks };
}
