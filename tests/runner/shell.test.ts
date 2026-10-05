import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePipeline, type ShellStep } from '../../src/schema/pipeline.ts';
import {
  composeAgentEnv,
  composeEnv,
  ContractError,
  runShellStep,
  validateOutputs,
} from '../../src/runner/shell.ts';
import { REDACTION } from '../../src/runs/store.ts';

// Credenciales FALSAS con forma de verdaderas, montadas en tiempo de
// ejecución para que el literal no aparezca en el código fuente: los
// escáneres de secretos (push protection incluida) no distinguen una clave
// de prueba de una real.
const FAKE_STRIPE_KEY = ['sk', 'live', '51H8AbCdEfGhIjKlMnOpQrSt'].join('_');
const FAKE_STRIPE_KEY_2 = ['sk', 'live', 'ANOTHERSECRETKEYVALUE99'].join('_');
const STRIPE_PREFIX = ['sk', 'live', ''].join('_');
const FAKE_JWT = [
  'eyJhbGciOiJIUzI1NiJ9',
  'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
  'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PYE4Vg',
].join('.');

/** Señal 0: no mata nada, solo comprueba si el proceso sigue vivo. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Comprueba que un proceso muere en un plazo acotado, sin exigir que ya esté
 * muerto en el instante exacto en que `runShellStep` resuelve. Un hijo recién
 * rematado con SIGKILL puede quedar un instante como zombi reparentado — sigue
 * respondiendo a la señal 0 hasta que su nuevo padre (launchd/init) lo cosecha
 * — y esa ventana crece bajo la carga de la suite completa en paralelo. Lo que
 * el motor garantiza es que muere pronto, no que muera de forma síncrona.
 */
async function waitUntilDead(pid: number, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !isPidAlive(pid);
}

function shellStep(yaml: string): ShellStep {
  const p = parsePipeline(`
name: demo
description: d
version: 1
steps:
${yaml}
`);
  return p.steps[0] as ShellStep;
}

// Igual que el resto de tests del repo que tocan el sistema de ficheros
// (tests/runs/store.test.ts, tests/guards/lock.test.ts,
// tests/guards/evaluate.test.ts, tests/preflight/check.test.ts): un
// directorio propio por test bajo el tmpdir del SO, no el tmpdir compartido
// directamente. Hoy los comandos de este fichero (echo, exit, sleep, true)
// no escriben nada, pero un test futuro que sí escriba no debe compartir
// carpeta con el resto de la suite.
let defaultCwd: string;

beforeEach(() => {
  defaultCwd = mkdtempSync(join(tmpdir(), 'ap-shell-'));
});
afterEach(() => rmSync(defaultCwd, { recursive: true, force: true }));

function baseCtx() {
  return {
    scope: { params: {}, steps: {} },
    secrets: {},
    defaultCwd,
    timeoutMs: 5000,
  };
}

describe('composeEnv', () => {
  test('incluye un PATH heredado para que sh y los binarios se resuelvan', () => {
    expect(composeEnv({}).PATH).toBeTruthy();
  });
  test('añade los secretos declarados', () => {
    expect(composeEnv({ MY_TOKEN: 's' }).MY_TOKEN).toBe('s');
  });
  test('no arrastra variables del proceso que no estén en la lista base', () => {
    process.env.AP_VARIABLE_DE_PRUEBA = 'no-deberia-pasar';
    expect(composeEnv({}).AP_VARIABLE_DE_PRUEBA).toBeUndefined();
    delete process.env.AP_VARIABLE_DE_PRUEBA;
  });
});

// `Options.env` del SDK REEMPLAZA el
// entorno del subproceso entero (no lo fusiona con `process.env`), así que
// sin esta variante de `composeEnv` un paso agéntico en una máquina
// autenticada por `ANTHROPIC_API_KEY` fallaba siempre al autenticar.
describe('composeAgentEnv', () => {
  test('incluye una variable de autenticación presente en el entorno del proceso', () => {
    process.env.ANTHROPIC_API_KEY = 'ap-test-no-es-una-clave-real';
    expect(composeAgentEnv({}).ANTHROPIC_API_KEY).toBe('ap-test-no-es-una-clave-real');
    delete process.env.ANTHROPIC_API_KEY;
  });
  test('no arrastra una variable del proceso ajena a la base y a la lista de autenticación/red', () => {
    process.env.AP_VARIABLE_DE_PRUEBA = 'no-deberia-pasar';
    expect(composeAgentEnv({}).AP_VARIABLE_DE_PRUEBA).toBeUndefined();
    delete process.env.AP_VARIABLE_DE_PRUEBA;
  });
  // Bajo launchd el entorno no trae la clave: la del `.env` (agentAuth) es la
  // que cuenta, y gana a la del entorno si están las dos.
  test('la credencial del .env (agentAuth) gana a la del entorno del proceso', () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'ap-test-del-entorno';
    try {
      expect(composeAgentEnv({}, { ANTHROPIC_API_KEY: 'ap-test-del-env' }).ANTHROPIC_API_KEY).toBe('ap-test-del-env');
      expect(composeAgentEnv({}).ANTHROPIC_API_KEY).toBe('ap-test-del-entorno');
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });
});

describe('validateOutputs', () => {
  test('acepta un objeto que cumple el contrato', () => {
    const result = validateOutputs({ n: 7, s: 'x', b: true, arr: ['a'] }, {
      n: 'number', s: 'string', b: 'boolean', arr: 'string[]',
    }, 'paso-1');
    expect(result).toEqual({ n: 7, s: 'x', b: true, arr: ['a'] });
  });

  test('rechaza un tipo incorrecto nombrando el campo', () => {
    expect(() => validateOutputs({ n: 'siete' }, { n: 'number' }, 'paso-1')).toThrow(/n/);
  });

  test('rechaza un campo del contrato que falta', () => {
    expect(() => validateOutputs({}, { n: 'number' }, 'paso-1')).toThrow(ContractError);
  });

  test('descarta campos no declarados en el contrato', () => {
    expect(validateOutputs({ n: 1, extra: 'x' }, { n: 'number' }, 'paso-1')).toEqual({ n: 1 });
  });

  test('rechaza un array con elementos del tipo equivocado', () => {
    expect(() => validateOutputs({ arr: [1, 2] }, { arr: 'string[]' }, 'paso-1')).toThrow(ContractError);
  });

  test('rechaza que la raíz no sea un objeto', () => {
    expect(() => validateOutputs('no soy un objeto', { n: 'number' }, 'paso-1')).toThrow(ContractError);
  });

  // El mensaje tiene que decir qué falló, no solo «Contrato
  // incumplido» — paso, campo, tipo esperado, tipo recibido y un extracto del
  // valor, para que llegue legible al correo (`error` del paso).
  test('el mensaje nombra el paso, el campo, ambos tipos y el valor recibido', () => {
    expect(() => validateOutputs({ enqueued: 0 }, { enqueued: 'string' }, 'enqueue-covers')).toThrow(
      'Contrato incumplido en «enqueue-covers»: enqueued esperaba string, recibió number (0)',
    );
  });

  test('acumula todas las violaciones del paso en una sola línea, no solo la primera', () => {
    expect(() =>
      validateOutputs({ a: 1, b: 'x' }, { a: 'string', b: 'number', c: 'boolean' }, 'paso-multi'),
    ).toThrow(
      'Contrato incumplido en «paso-multi»: a esperaba string, recibió number (1); ' +
        'b esperaba number, recibió string (1 caracteres); falta el campo "c" (boolean)',
    );
  });

  test('describe un array con el tipo de elemento recibido, nunca sus valores', () => {
    expect(() => validateOutputs({ arr: [1, 2] }, { arr: 'string[]' }, 'paso-1')).toThrow(
      'arr esperaba string[], recibió number[] (length 2)',
    );
  });

  test('un objeto solo dice cuántas claves tiene: ni valores ni nombres de clave', () => {
    let message = '';
    try {
      validateOutputs({ o: { user: 'ana', password: 'hunter2' } }, { o: 'string' }, 'paso-1');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('o esperaba string, recibió object (2 claves)');
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain('password');
  });

  test('las CLAVES de un objeto no salen: un mapa indexado por token o por email', () => {
    const payloads = {
      porToken: { [FAKE_STRIPE_KEY]: 100, [FAKE_STRIPE_KEY_2]: 50 },
      porEmail: { 'persona.test@example.com': 1 },
    };
    for (const [nombre, valor] of Object.entries(payloads)) {
      let message = '';
      try {
        validateOutputs({ balances: valor }, { balances: 'string' }, 'paso-attack');
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message, nombre).toContain('balances esperaba string, recibió object');
      expect(message, nombre).not.toContain(STRIPE_PREFIX);
      expect(message, nombre).not.toContain('@example.com');
    }
  });

  test('un objeto con muchas claves no alarga la línea', () => {
    const grande = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`clave_${i}`, i]));
    let message = '';
    try {
      validateOutputs({ g: grande }, { g: 'string' }, 'paso-1');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('g esperaba string, recibió object (5000 claves)');
    expect(message.length).toBeLessThan(200);
  });

  test('null no añade nada al extracto: el tipo ya lo dice todo', () => {
    expect(() => validateOutputs({ n: null }, { n: 'string' }, 'paso-1')).toThrow(
      'n esperaba string, recibió null',
    );
  });

  // Por CONCEPTO, no por heurística: un número o un booleano no pueden llevar
  // texto arbitrario, así que se muestran enteros aunque el nombre del campo
  // suene a credencial. La ocultación es por TIPO (string), no por nombre.
  test('un valor numérico se muestra aunque el nombre del campo suene a credencial', () => {
    let message = '';
    try {
      validateOutputs({ api_key: 12345 }, { api_key: 'string' }, 'paso-1');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('api_key esperaba string, recibió number (12345)');
  });

  test('un string nunca enseña su contenido, aunque tenga pinta de credencial (JWT)', () => {
    const jwt = FAKE_JWT;
    let message = '';
    try {
      validateOutputs({ enqueued: jwt }, { enqueued: 'number' }, 'paso-1');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('enqueued esperaba number, recibió string');
    expect(message).not.toContain(jwt);
  });

  test('un string largo declara su longitud, nunca su contenido', () => {
    const largo = 'x'.repeat(80);
    let message = '';
    try {
      validateOutputs({ s: largo }, { s: 'number' }, 'paso-1');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('string (80 caracteres)');
    expect(message).not.toContain('x'.repeat(10));
  });

  // Un secreto a mitad de frase, bajo un
  // campo de nombre inocente (summary/detail/message), pasaba entero en el
  // extracto de 40 caracteres porque la heurística de «pinta de secreto»
  // solo reconocía la cadena ENTERA como secreto. Ahora un string nunca
  // enseña contenido, así que no hay heurística que esquivar.
  test('un secreto a mitad de frase en "summary" no llega al extracto', () => {
    let message = '';
    try {
      validateOutputs(
        { summary: `Payment created with key ${FAKE_STRIPE_KEY}` },
        { summary: 'number' },
        'paso-1',
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain(STRIPE_PREFIX);
    expect(message).toContain('summary esperaba number, recibió string');
  });

  test('un secreto a mitad de frase en "detail" no llega al extracto', () => {
    let message = '';
    try {
      validateOutputs(
        { detail: 'Falló la conexión a postgres://svc_user:hunter2@db.internal:5432/prod' },
        { detail: 'number' },
        'paso-1',
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain('postgres://');
    expect(message).not.toContain('hunter2');
    expect(message).toContain('detail esperaba number, recibió string');
  });

  test('un secreto a mitad de frase en "message" no llega al extracto', () => {
    const jwt = FAKE_JWT;
    let message = '';
    try {
      validateOutputs({ message: `token recibido: ${jwt}` }, { message: 'number' }, 'paso-1');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain('eyJ');
    expect(message).toContain('message esperaba number, recibió string');
  });
});

describe('runShellStep', () => {
  test('un comando correcto sin contrato termina ok', async () => {
    const outcome = await runShellStep(shellStep("  - id: a\n    type: shell\n    run: echo hola"), baseCtx());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.log).toContain('hola');
  });

  test('un exit code distinto de 0 es un fallo NO transitorio', async () => {
    const outcome = await runShellStep(shellStep("  - id: a\n    type: shell\n    run: exit 3"), baseCtx());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.transient).toBe(false);
      expect(outcome.error).toContain('3');
    }
  });

  test('un exit code distinto de 0 lleva la cola de stderr en el error', async () => {
    // Sin esto, el correo de un run fallido decía «verdict: exit code 1» y
    // las líneas que el paso había escrito a stderr solo vivían en el log
    // (pasó en un ensayo al migrar un pipeline real).
    const outcome = await runShellStep(
      shellStep("  - id: a\n    type: shell\n    run: |\n      echo primera >&2\n      echo boom >&2\n      exit 3"),
      baseCtx(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('exit code 3 — primera / boom');
  });

  test('la cola de stderr del error se limita a las últimas cinco líneas no vacías', async () => {
    const lines = Array.from({ length: 8 }, (_, i) => `echo l${i + 1} >&2`).join('\n      ');
    const outcome = await runShellStep(
      shellStep(`  - id: a\n    type: shell\n    run: |\n      ${lines}\n      echo >&2\n      exit 1`),
      baseCtx(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('exit code 1 — l4 / l5 / l6 / l7 / l8');
  });

  test('sin nada en stderr, el error es solo el exit code', async () => {
    const outcome = await runShellStep(shellStep("  - id: a\n    type: shell\n    run: exit 2"), baseCtx());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('exit code 2');
  });

  test('parsea stdout como JSON cuando el paso declara outputs', async () => {
    // Nota: las comillas dobles deben ir dentro de comillas simples de shell
    // (`echo '{"count":7}'`), o `sh -c` las trata como delimitadores de
    // cadena y las descarta, dejando un stdout que ya no es JSON válido
    // (`{count:7}`). Comprobado en bash y determinista en cualquier shell
    // POSIX: no es una peculiaridad de esta máquina.
    const step = shellStep(
      "  - id: a\n    type: shell\n    run: \"echo '{\\\"count\\\":7}'\"\n    outputs: { count: number }",
    );
    const outcome = await runShellStep(step, baseCtx());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.outputs).toEqual({ count: 7 });
  });

  test('stdout no-JSON con contrato declarado es fallo de contrato', async () => {
    const step = shellStep(
      "  - id: a\n    type: shell\n    run: echo no-soy-json\n    outputs: { count: number }",
    );
    const outcome = await runShellStep(step, baseCtx());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.transient).toBe(false);
  });

  test('interpola params y salidas de pasos anteriores en el comando', async () => {
    const step = shellStep("  - id: a\n    type: shell\n    run: echo {{params.saludo}}-{{prev.n}}");
    const outcome = await runShellStep(step, {
      ...baseCtx(),
      scope: { params: { saludo: 'hola' }, steps: { prev: { n: 3 } } },
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.log).toContain('hola-3');
  });

  test('un valor interpolado con metacaracteres de shell no se ejecuta (indirección por entorno)', async () => {
    const step = shellStep("  - id: a\n    type: shell\n    run: echo {{prev.payload}}");
    const outcome = await runShellStep(step, {
      ...baseCtx(),
      scope: { params: {}, steps: { prev: { payload: '$(touch pwned.txt)' } } },
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.log.trim()).toBe('$(touch pwned.txt)');
    expect(await Bun.file(join(defaultCwd, 'pwned.txt')).exists()).toBe(false);
  });

  test('el paso ve sus secretos declarados y nada más del entorno', async () => {
    process.env.AP_NO_DECLARADA = 'no-deberia-verse';
    const step = shellStep("  - id: a\n    type: shell\n    run: 'echo [$MY_TOKEN][$AP_NO_DECLARADA]'");
    const outcome = await runShellStep(step, { ...baseCtx(), secrets: { MY_TOKEN: 'secreto' } });
    delete process.env.AP_NO_DECLARADA;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.log).toContain(`[${REDACTION}]`); // vio su secreto declarado
      expect(outcome.log).toContain('[]'); // no vio la variable no declarada
      expect(outcome.log).not.toContain('secreto'); // y el valor no se filtra
    }
  });

  test('un timeout es un fallo transitorio', async () => {
    const step = shellStep("  - id: a\n    type: shell\n    run: sleep 5");
    const outcome = await runShellStep(step, { ...baseCtx(), timeoutMs: 100 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.transient).toBe(true);
      expect(outcome.error).toContain('timeout');
    }
  });

  // Reproduce un fallo real: `proc.kill()`
  // solo mata el `sh` del paso, no un hijo en segundo plano que hereda sus
  // tuberías (el caso real es `caffeinate -i claude -p …` desde un paso
  // headless). Sin matar el grupo entero, el hijo huérfano sigue vivo tras el
  // timeout y `runShellStep` tarda en resolver lo que tarde el hijo, no lo
  // que dice `timeoutMs`.
  test('un timeout mata también a los hijos en segundo plano del paso, no solo al shell', async () => {
    const pidFile = join(defaultCwd, 'child.pid');
    const step = shellStep(
      `  - id: a\n    type: shell\n    run: |\n      sleep 5 &\n      echo $! > '${pidFile}'`,
    );
    const started = Date.now();
    const outcome = await runShellStep(step, { ...baseCtx(), timeoutMs: 100 });
    const elapsed = Date.now() - started;

    expect(outcome.ok).toBe(false);
    // Muy por debajo de los 5s del hijo: si el motor sigue esperando a que
    // el huérfano cierre la tubería, este test tarda ~5s en vez de <1s.
    expect(elapsed).toBeLessThan(1000);

    const childPid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(await waitUntilDead(childPid)).toBe(true);
  });

  // El hijo huérfano puede ignorar SIGTERM (el caso real: `claude` atrapado en
  // trabajo de red). El motor debe escalar a SIGKILL en vez de esperarlo para
  // siempre.
  test('un timeout escala a SIGKILL si el grupo de procesos ignora SIGTERM', async () => {
    const pidFile = join(defaultCwd, 'child.pid');
    const step = shellStep(
      `  - id: a\n    type: shell\n    run: |\n      trap '' TERM\n      sleep 5 &\n      echo $! > '${pidFile}'\n      wait`,
    );
    const outcome = await runShellStep(step, { ...baseCtx(), timeoutMs: 100 });
    expect(outcome.ok).toBe(false);

    const childPid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(await waitUntilDead(childPid)).toBe(true);
  });

  test('mide la duración del paso', async () => {
    const outcome = await runShellStep(shellStep("  - id: a\n    type: shell\n    run: 'true'"), baseCtx());
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('un secreto ecoado en un output declarado también se redacta', async () => {
    // outputs se construye a partir del stdout crudo, no de `log` (que ya
    // está redactado), así que este es un camino de fuga distinto al de
    // `log`/`error` y necesita su propia comprobación.
    const step = shellStep(
      "  - id: a\n    type: shell\n    run: \"echo '{\\\"token\\\":\\\"'$MY_TOKEN'\\\"}'\"\n    outputs: { token: string }",
    );
    const outcome = await runShellStep(step, { ...baseCtx(), secrets: { MY_TOKEN: 'secreto' } });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.outputs.token).toBe(REDACTION);
      expect(JSON.stringify(outcome.outputs)).not.toContain('secreto');
    }
  });

  test('un secreto ecoado en un output numérico falla el paso en vez de exponerlo', async () => {
    // Un número no puede sustituirse por REDACTION sin dejar de ser un
    // número, así que aquí la única salida honesta es fallar el paso -
    // igual que un tipo incorrecto en el contrato.
    const step = shellStep(
      "  - id: a\n    type: shell\n    run: \"echo '{\\\"code\\\":'$MY_CODE'}'\"\n    outputs: { code: number }",
    );
    const outcome = await runShellStep(step, { ...baseCtx(), secrets: { MY_CODE: '424242' } });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.transient).toBe(false);
      expect(outcome.error).toContain('code');
      expect(outcome.error).not.toContain('424242');
      expect(outcome.log).not.toContain('424242');
    }
  });

  test('un secreto ecoado dentro de un array de números también falla el paso', async () => {
    const step = shellStep(
      "  - id: a\n    type: shell\n    run: \"echo '{\\\"codes\\\":[1,'$MY_CODE',3]}'\"\n    outputs: { codes: \"number[]\" }",
    );
    const outcome = await runShellStep(step, { ...baseCtx(), secrets: { MY_CODE: '424242' } });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.transient).toBe(false);
      expect(outcome.error).toContain('codes');
      expect(outcome.error).not.toContain('424242');
      expect(outcome.log).not.toContain('424242');
    }
  });
});

// Regresión de un fallo real en producción: bajo launchd solo llegan las
// variables que declara el plist (`PATH`, `HOME`) — nunca `LANG`/`LC_ALL`.
// Heredar el locale hacía que los subprocesos corrieran en locale C, donde
// `.` de una ERE casa UN BYTE; un carácter acentuado en UTF-8 son dos, así
// que cualquier patrón con `.` sobre texto acentuado fallaba SOLO en cron y
// pasaba a mano. El motor fija el locale en vez de heredarlo — mismo
// criterio que `settingSources: []` y `strictMcpConfig: true`: el
// comportamiento no depende de la configuración de la máquina que ejecuta.
describe('locale determinista', () => {
  let previous: { lang?: string; lcAll?: string };

  beforeEach(() => {
    previous = { lang: process.env.LANG, lcAll: process.env.LC_ALL };
  });
  afterEach(() => {
    if (previous.lang === undefined) delete process.env.LANG;
    else process.env.LANG = previous.lang;
    if (previous.lcAll === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = previous.lcAll;
  });

  test('composeEnv fija C.UTF-8 aunque el proceso traiga otro locale', () => {
    process.env.LANG = 'ca_ES.UTF-8';
    process.env.LC_ALL = 'ca_ES.UTF-8';
    const env = composeEnv({});
    expect(env.LANG).toBe('C.UTF-8');
    expect(env.LC_ALL).toBe('C.UTF-8');
  });

  test('composeEnv fija C.UTF-8 aunque el proceso no traiga ninguno (el caso launchd)', () => {
    delete process.env.LANG;
    delete process.env.LC_ALL;
    const env = composeEnv({});
    expect(env.LANG).toBe('C.UTF-8');
    expect(env.LC_ALL).toBe('C.UTF-8');
  });

  test('composeAgentEnv fija el mismo locale que composeEnv', () => {
    delete process.env.LANG;
    delete process.env.LC_ALL;
    const env = composeAgentEnv({});
    expect(env.LANG).toBe('C.UTF-8');
    expect(env.LC_ALL).toBe('C.UTF-8');
  });

  // El fallo tal cual se dio: `grep -qE` con un `.` donde el fichero tiene
  // una `Ú`. Sin `LANG` en el proceso (como bajo launchd) esto devolvía 1 y
  // saltaba el pipeline entero, noche tras noche, sin avisar a nadie.
  test('un paso shell casa `.` contra un carácter multibyte sin locale en el proceso', async () => {
    delete process.env.LANG;
    delete process.env.LC_ALL;
    const outcome = await runShellStep(
      shellStep("  - id: a\n    type: shell\n    run: printf 'Última revisió\\n' | grep -qE '^.ltima revisi.$'"),
      baseCtx(),
    );
    expect(outcome.ok).toBe(true);
  });
});

// Encontrado validando el canal de notify el 2026-08-31: un run con un
// `docs_repo` inexistente falló con "no se pudo lanzar el comando: ENOENT:
// no such file or directory, posix_spawn 'sh'". El cwd no existía, pero el
// mensaje acusa a `sh`, y eso manda a quien lo lea a buscar un problema de
// PATH que no existe. El correo de aviso lleva ese texto tal cual, así que
// es lo primero que se ve de una fallada nocturna.
describe('runShellStep con un cwd que no existe', () => {
  const step = () => shellStep(`
  - id: demo
    type: shell
    cwd: /tmp/ap-cwd-que-no-existe-nunca
    run: echo hola
`);

  test('el error nombra el directorio que falta', async () => {
    const outcome = await runShellStep(step(), baseCtx());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('inalcanzable');
    expect(outcome.error).toContain('/tmp/ap-cwd-que-no-existe-nunca');
  });

  // El texto crudo del sistema NO se tira: sigue siendo útil para diagnosticar.
  // Lo que se corrige es el ORDEN — que lo primero que se lea sea el diagnóstico
  // real y no la acusación a `sh`, que es la que despista.
  test('el diagnóstico va primero y el texto del sistema queda como cita', async () => {
    const outcome = await runShellStep(step(), baseCtx());
    if (outcome.ok) throw new Error('inalcanzable');
    expect(outcome.error.startsWith('el directorio de trabajo no existe:')).toBe(true);
    expect(outcome.error).toContain('el sistema lo reportó como');
  });
});
