import { describe, expect, test } from 'bun:test';
import {
  escapeHtml,
  layout,
  renderHealthPanel,
  renderPipelinePage,
  renderRunLive,
  renderRunPage,
} from '../../src/web/render.ts';

describe('escapeHtml', () => {
  test('neutraliza una etiqueta', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  // Un skipReason real lleva comillas y barras: es el texto más hostil que
  // este visor va a renderizar, y viene de un fichero, no de un usuario.
  test('escapa comillas y ampersands de un skipReason real', () => {
    const reason = 'shell: "grep -qE "^\\| Slug" f.md" & devolvió 1';
    const escaped = escapeHtml(reason);
    expect(escaped).not.toContain('"');
    expect(escaped).toContain('&amp;');
  });

  test('undefined es la cadena vacía, no "undefined"', () => {
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('layout', () => {
  test('escapa el título', () => {
    expect(layout('<b>x</b>', '')).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  test('sin sse no incluye EventSource', () => {
    expect(layout('t', '<p>b</p>')).not.toContain('EventSource');
  });

  test('con sse incluye el cliente', () => {
    expect(layout('t', '<p>b</p>', { sse: '/sse/health' })).toContain('/sse/health');
  });
});

describe('renderPipelinePage', () => {
  const AHORA = new Date('2026-08-31T11:56:00.000Z');
  const GREP = 'shell: "grep -qE x" devolvió 1';

  const PIPE = {
    name: 'demo', description: 'Un pipeline de prueba', version: 1,
    params: { docs_repo: { description: 'Ruta local del clon' } },
    when: [{ throttle: '46h' }, { shell: 'grep -qE "^\\| Slug" f.md' }],
    triggers: [{ cron: '0 3 * * *' }],
    steps: [{ id: 'uno', type: 'shell' }, { id: 'dos', type: 'agent' }],
  } as never;

  const SALUD = {
    trigger: 'installed', work: 'working', consecutiveSkips: 0, contradiction: false,
  } as never;

  function salto(dia: string, motivo: string) {
    return {
      id: `2026-08-${dia}T01-00-00-000Z`, pipeline: 'demo', pipelineVersion: 1,
      status: 'skipped', startedAt: `2026-08-${dia}T01:00:00.000Z`, params: {}, steps: {},
      skipReason: motivo,
    } as never;
  }

  test('la cadencia se dice en palabras', () => {
    expect(renderPipelinePage(PIPE, [], SALUD, AHORA)).toContain('cada noche a las 3:00');
  });

  test('los pasos agent se marcan: son los que cuestan dinero', () => {
    const html = renderPipelinePage(PIPE, [], SALUD, AHORA);
    expect(html).toContain('kind agent');
    expect(html).toContain('1 con agente');
  });

  test('una guarda se pinta como comando, no como JSON escapado', () => {
    const html = renderPipelinePage(PIPE, [], SALUD, AHORA);
    expect(html).toContain('46h');
    expect(html).toContain('class="cmd"');
    expect(html).not.toContain('&quot;throttle&quot;');
  });

  // El motivo de existir de esta página: ocho párrafos con el mismo grep.
  test('ocho saltos con la misma guarda son un bloque, no ocho filas', () => {
    const runs = ['29', '28', '27', '26', '25', '24', '23', '22'].map((d) => salto(d, GREP));
    const html = renderPipelinePage(PIPE, runs, SALUD, AHORA);
    expect(html).toContain('colapso');
    expect(html).toContain('8 noches');
    // El grep aparece UNA vez, no ocho. Eso es todo lo que se comprueba.
    expect(html.split('grep -qE x').length - 1).toBe(1);
  });

  test('las fechas del bloque siguen siendo enlaces a cada run', () => {
    const runs = ['29', '28'].map((d) => salto(d, GREP));
    const html = renderPipelinePage(PIPE, runs, SALUD, AHORA);
    expect(html).toContain('/runs/2026-08-29T01-00-00-000Z');
    expect(html).toContain('/runs/2026-08-28T01-00-00-000Z');
  });

  // Un salto suelto no se agrupa, así que su motivo tiene que seguir saliendo
  // en su fila: si no, la explicación se perdería justo en el caso más simple.
  test('un salto suelto conserva su motivo, escapado', () => {
    const runs = [salto('29', 'shell: <guarda> devolvió 1')];
    const html = renderPipelinePage(PIPE, runs, SALUD, AHORA);
    expect(html).toContain('&lt;guarda&gt;');
    expect(html).not.toContain('<guarda>');
  });

  test('el motivo agrupado también llega escapado', () => {
    const runs = ['29', '28'].map((d) => salto(d, 'shell: <guarda> devolvió 1'));
    const html = renderPipelinePage(PIPE, runs, SALUD, AHORA);
    expect(html).toContain('&lt;guarda&gt;');
    expect(html).not.toContain('<guarda>');
  });

  test('un run forzado se marca', () => {
    const forzado = {
      id: 'r', pipeline: 'demo', pipelineVersion: 1, status: 'success',
      startedAt: '2026-08-31T08:58:12.953Z', params: {}, steps: {}, forced: true,
    } as never;
    expect(renderPipelinePage(PIPE, [forzado], SALUD, AHORA)).toContain('forzado');
  });

  test('un pipeline sin guardas lo dice, y no deja el hueco mudo', () => {
    const sinGuardas = { ...(PIPE as object), when: [] } as never;
    expect(renderPipelinePage(sinGuardas, [], SALUD, AHORA)).toContain('Ninguna');
  });
});

describe('renderRunLive', () => {
  function paso(id: string, over: Record<string, unknown> = {}) {
    return {
      id, status: 'success', startedAt: '2026-08-30T01:00:00.000Z',
      durationMs: 1000, outputs: {}, effects: [], attempts: 1, ...over,
    };
  }

  const RUN = {
    id: '2026-08-30T01-00-07-795Z', pipeline: 'demo', pipelineVersion: 1, status: 'failed',
    startedAt: '2026-08-30T01:00:07.795Z', params: {}, totalCostUsd: 7.36,
    steps: {
      redact: paso('redact', { durationMs: 470_000, costUsd: 6.71, toolsUsed: ['Read', 'Edit'] }),
      build: paso('build', { status: 'failed', durationMs: 14_000, error: 'exit code 1' }),
    },
  } as never;

  // Si la cabecera se quedara fuera de #live, un run que termina mientras
  // miras seguiría diciendo "corriendo" hasta que recargaras.
  test('la cabecera del run va dentro de lo que se refresca', () => {
    const html = renderRunLive(RUN);
    expect(html.startsWith('<div class="bigline')).toBe(true);
    expect(html).toContain('Duración');
    expect(html).toContain('$7.36');
  });

  test('dice en qué paso falló', () => {
    expect(renderRunLive(RUN)).toContain('<code>build</code>');
  });

  test('la barra es proporcional al paso más largo', () => {
    const html = renderRunLive(RUN);
    expect(html).toContain('width: 100.0%'); // redact, 470s
    expect(html).toContain('width: 3.0%'); // build, 14s sobre 470s
  });

  // Un run recién empezado tiene todos los pasos a cero: sin el tope, cada
  // barra saldría con `width: NaN%`.
  test('un run con todos los pasos a cero no divide por cero', () => {
    const cero = { ...(RUN as object), steps: { a: paso('a', { durationMs: 0 }) } } as never;
    const html = renderRunLive(cero);
    expect(html).not.toContain('NaN');
  });

  test('un run sin ningún paso no revienta', () => {
    const vacio = { ...(RUN as object), steps: {} } as never;
    expect(() => renderRunLive(vacio)).not.toThrow();
  });

  test('el motivo del fallo se ve, y escapado', () => {
    const hostil = {
      ...(RUN as object),
      steps: { build: paso('build', { status: 'failed', error: 'falló <b>build</b>' }) },
    } as never;
    const html = renderRunLive(hostil);
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toContain('<b>build</b>');
  });

  // Antes se imprimía `redact: Read (both)` y el reason —la parte que explica
  // por qué el sandbox no dejó pasar la herramienta— se tiraba.
  test('una denegación conserva su motivo', () => {
    const conDenegacion = {
      ...(RUN as object),
      steps: {
        redact: paso('redact', {
          denials: [{
            toolName: 'Read', toolUseId: 't1', source: 'both',
            reason: '"/repo/x.mdx" resuelve fuera de toda raíz permitida',
          }],
        }),
      },
    } as never;
    const html = renderRunLive(conDenegacion);
    expect(html).toContain('Denegaciones del sandbox');
    expect(html).toContain('resuelve fuera de toda raíz permitida');
  });

  test('una denegación sin motivo no imprime "undefined"', () => {
    const sinMotivo = {
      ...(RUN as object),
      steps: {
        redact: paso('redact', {
          denials: [{ toolName: 'Read', toolUseId: 't1', source: 'hook-log' }],
        }),
      },
    } as never;
    expect(renderRunLive(sinMotivo)).not.toContain('undefined');
  });

  test('sin denegaciones no se pinta la sección', () => {
    expect(renderRunLive(RUN)).not.toContain('Denegaciones');
  });

  test('un run forzado dice que se saltó las guardas', () => {
    const forzado = { ...(RUN as object), forced: true } as never;
    expect(renderRunLive(forzado)).toContain('forzado');
  });
});

describe('renderRunPage', () => {
  const RUN = {
    id: 'r1', pipeline: 'demo', pipelineVersion: 1, status: 'success',
    startedAt: '2026-08-30T01:00:07.795Z', params: {}, steps: {},
  } as never;

  test('envuelve el vivo en #live una sola vez', () => {
    expect(renderRunPage('demo', RUN).split('id="live"').length - 1).toBe(1);
  });

  test('el nombre del pipeline llega escapado', () => {
    expect(renderRunPage('a&b', RUN)).toContain('a&amp;b');
  });
});

describe('renderHealthPanel — estabilidad del fragmento', () => {
  const FILA = {
    name: 'demo', description: 'd', pasosTotales: 3,
    health: { trigger: 'installed', work: 'working', consecutiveSkips: 0, contradiction: false },
  } as never;

  // `createHealthStream` compara el HTML de este fragmento con el del tick
  // anterior (`rendered === last`) y solo reemite si cambió. Cualquier cosa que
  // dependa del instante y no del ESTADO —un reloj en el subtítulo, por
  // ejemplo— hace que el panel se reemita cada minuto sin novedad, y se pierde
  // la única señal que distingue "ha pasado algo" de "sigue todo igual".
  // Pasó una vez: el subtítulo llevaba la hora.
  test('el mismo estado da el mismo HTML aunque avance el reloj', () => {
    const a = renderHealthPanel([FILA], new Date('2026-08-31T11:56:00.000Z'));
    const b = renderHealthPanel([FILA], new Date('2026-08-31T11:59:30.000Z'));
    expect(a).toBe(b);
  });

  // Pero sí tiene que cambiar cuando cambia el DÍA relativo del último run:
  // "hoy · 13:42" y "ayer · 13:42" no son lo mismo.
  test('cambia cuando el último run pasa a ser de ayer', () => {
    const conRun = {
      ...(FILA as object),
      health: {
        trigger: 'installed', work: 'working', consecutiveSkips: 0, contradiction: false,
        lastRun: { startedAt: new Date(2026, 7, 31, 13, 42).toISOString(), status: 'success' },
      },
    } as never;
    const hoy = renderHealthPanel([conRun], new Date(2026, 7, 31, 23, 0));
    const manana = renderHealthPanel([conRun], new Date(2026, 8, 1, 9, 0));
    expect(hoy).not.toBe(manana);
    expect(hoy).toContain('hoy');
    expect(manana).toContain('ayer');
  });
});
