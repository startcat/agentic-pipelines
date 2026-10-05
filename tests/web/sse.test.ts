import { describe, expect, test } from 'bun:test';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serve, RUNNING_RUN_ID } from './fixture.ts';

describe('GET /sse/:name/:runId', () => {
  test('manda solo el trozo nuevo del log, no el fichero entero', async () => {
    const { server, base, root } = await serve();
    const runId = RUNNING_RUN_ID;
    const res = await fetch(`${base}/sse/demo/${runId}`);
    const reader = res.body!.getReader();
    try {
      await appendFile(join(root, '.runs', 'demo', runId, 'uno.log'), 'NUEVO\n');

      let received = '';
      // El servidor compara mtime cada segundo: dos lecturas bastan.
      for (let i = 0; i < 4 && !received.includes('NUEVO'); i += 1) {
        const { value } = await reader.read();
        received += new TextDecoder().decode(value);
      }
      expect(received).toContain('NUEVO');
      expect(received).toContain('event: log');
      // Lo que ya estaba en el fichero antes de abrir el stream (fixture.ts,
      // uno.log) NO se reenvía: solo el delta posterior a la apertura.
      expect(received).not.toContain('arrancando el paso');
    } finally {
      await reader.cancel();
      server.stop(true);
    }
  }, 15_000);

  // El evento `log` no tenía consumidor: la página que se suscribe (el run
  // detail) no tiene `#log`, y la que lo tiene (el paso) no se suscribía.
  // Arreglado dándole ámbito: el dato ahora es `{ stepId, delta }`, no solo
  // el delta. Esta aserción SOLO puede pasar si el servidor manda el id del
  // paso junto al delta — con la forma antigua (`data: delta` a secas)
  // `JSON.parse` habría devuelto la cadena del delta, no un objeto, y
  // `payload.stepId` sería `undefined`, no `'uno'`.
  test('el evento log lleva el id del paso, para poder escogerse en el cliente', async () => {
    const { server, base, root } = await serve();
    const runId = RUNNING_RUN_ID;
    const res = await fetch(`${base}/sse/demo/${runId}`);
    const reader = res.body!.getReader();
    try {
      await appendFile(join(root, '.runs', 'demo', runId, 'uno.log'), 'NUEVO\n');

      let raw = '';
      let dataLine: string | undefined;
      for (let i = 0; i < 6 && dataLine === undefined; i += 1) {
        const { value } = await reader.read();
        raw += new TextDecoder().decode(value);
        dataLine = /^event: log\ndata: (.*)$/m.exec(raw)?.[1];
      }
      expect(dataLine).toBeDefined();
      const payload = JSON.parse(dataLine!) as { stepId: string; delta: string };
      expect(payload.stepId).toBe('uno');
      expect(payload.delta).toContain('NUEVO');
    } finally {
      await reader.cancel();
      server.stop(true);
    }
  }, 15_000);

  test('el evento panel manda solo la tabla de pasos, no la página entera', async () => {
    const { server, base } = await serve();
    const runId = RUNNING_RUN_ID;
    const res = await fetch(`${base}/sse/demo/${runId}`);
    const reader = res.body!.getReader();
    try {
      // El primer evento es el panel inicial. `sseEvent` deja el HTML en una
      // sola línea `data: "..."` (los saltos de línea del fragmento van
      // escapados dentro del JSON), así que basta con juntar lecturas hasta
      // ver la línea completa y parsear con JSON.parse — igual que hace el
      // cliente real (`SSE_CLIENT`, render.ts) — para comparar HTML contra
      // HTML y no contra el texto crudo del stream (que lleva las comillas
      // escapadas y no coincidiría con un `toContain` literal).
      let raw = '';
      let dataLine: string | undefined;
      for (let i = 0; i < 4 && dataLine === undefined; i += 1) {
        const { value } = await reader.read();
        raw += new TextDecoder().decode(value);
        dataLine = raw.match(/^data: (.*)$/m)?.[1];
      }
      expect(dataLine).toBeDefined();
      const html = JSON.parse(dataLine!) as string;

      // Es el vivo del run: la cabecera de estado —que también se refresca— y
      // el paso de la fixture, `uno`.
      expect(html).toContain('class="bigline');
      expect(html).toContain('>uno<');

      // Y SOLO la tabla — nada de lo que la envuelve en la página inicial.
      // Si esta prueba corriera contra la página entera (`renderRunPage` en
      // vez de `renderRunLive`), su propio `<div id="live">` y su `<h2>`
      // de título vendrían dentro del fragmento, y el cliente los anidaría
      // una segunda vez sobre sí mismos al hacer `#live.innerHTML = html`.
      // Se fija la FORMA, no la ausencia de marcadores conocidos: una lista de
      // ausencias no cubriría un envoltorio nuevo que se colara mañana.
      // `renderRunLive` empieza literalmente por `<div class="bigline` — es
      // justo lo que "solo lo que va dentro de #live" significa.
      expect(html.startsWith('<div class="bigline')).toBe(true);
      expect(html).not.toContain('id="live"');
    } finally {
      await reader.cancel();
      server.stop(true);
    }
  });

  test('el content-type es text/event-stream', async () => {
    const { server, base } = await serve();
    const runId = RUNNING_RUN_ID;
    const res = await fetch(`${base}/sse/demo/${runId}`);
    try {
      expect(res.headers.get('content-type')).toContain('text/event-stream');
    } finally {
      await res.body!.cancel();
      server.stop(true);
    }
  });
});

describe('GET /sse/health', () => {
  test('reemite el panel cuando aparece un run nuevo', async () => {
    const { server, base, root } = await serve();
    const res = await fetch(`${base}/sse/health`);
    const reader = res.body!.getReader();
    try {
      // Primer evento: el panel tal como está.
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first).toContain('event: panel');

      // Aparece un run nuevo en disco; el panel debe volver a emitirse.
      const dir = join(root, '.runs', 'demo', '2026-08-30T01-00-00-000Z');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'run.json'), JSON.stringify({
        id: '2026-08-30T01-00-00-000Z', pipeline: 'demo', pipelineVersion: 1,
        status: 'success', startedAt: '2026-08-30T01:00:00.000Z', params: {}, steps: {},
      }));

      // Antes se buscaba la cadena "2026-08-30" porque el panel imprimía el
      // `startedAt` en crudo. Ahora dice "ayer" / "30 ago", que depende del día
      // en que se ejecute la suite. Se busca el VEREDICTO, que es lo que
      // cambia: la fixture venía con un run en curso ("Corriendo ahora") y el
      // run nuevo, con éxito y más reciente, lo deja al día.
      expect(first).toContain('Corriendo ahora');
      let received = '';
      for (let i = 0; i < 4 && !received.includes('Al día'); i += 1) {
        received += new TextDecoder().decode((await reader.read()).value);
      }
      expect(received).toContain('Al día');
      expect(received).not.toContain('Corriendo ahora');
    } finally {
      await reader.cancel();
      server.stop(true);
    }
  }, 15_000);
});
