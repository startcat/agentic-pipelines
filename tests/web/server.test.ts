import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderHealthPanel } from '../../src/web/render.ts';
import {
  addPipelineWithTruncatedRun,
  addUnparseablePipeline,
  RUNNING_RUN_ID,
  serve,
  SKIPPED_RUN_ID,
  stripStyles,
} from './fixture.ts';

describe('GET /', () => {
  test('lista los pipelines con su último estado', async () => {
    const { server, base } = await serve();
    try {
      const html = stripStyles(await (await fetch(`${base}/`)).text());
      expect(html).toContain('demo');
      // El run más reciente de la fixture es RUNNING_RUN_ID, en curso: el
      // veredicto de esa fila tiene que reflejarlo. Se comprueba contra la
      // clase del punto de salud (`class="dot live"`), no contra la palabra
      // suelta — una palabra de estado sola puede colar aunque el dato real
      // sea otro (`stripStyles` quita además la hoja de estilos, que nombra
      // los cuatro tonos posibles en sus selectores).
      expect(html).toContain('class="dot live"');
      expect(html).toContain('Corriendo ahora');
    } finally {
      server.stop(true);
    }
  });

  test('un pipeline sin triggers no se pinta como roto', async () => {
    const { server, base } = await serve();
    try {
      const html = stripStyles(await (await fetch(`${base}/`)).text());
      // El panel no enseña el enum crudo, enseña la frase: `no-trigger` es un
      // pipeline manual, y pintarlo de rojo sería ruido.
      expect(html).toContain('sin cron');
      expect(html).not.toContain('no-trigger');
    } finally {
      server.stop(true);
    }
  });

  // Cobertura directa, sin fixture ni servidor: `renderHealthPanel` se llama
  // aquí con un `Health` construido a mano (mismo patrón que los dos tests de
  // 'la contradicción installed + silent' más abajo). El motivo por el que
  // hace falta, además del test de arriba contra el fixture real: cualquier
  // fixture futura que cambie qué run es el más reciente (como pasó
  // al añadir RUNNING_RUN_ID) puede volver a desplazar el motivo
  // del salto del panel sin que ningún test se ponga en rojo — como ya pasó
  // una vez. Esta prueba no depende de qué run sea el último en ningún
  // fixture: construye el Health directamente, así que ese desplazamiento no
  // puede desarmarla.
  // OJO: el motivo del salto YA NO se pinta en el panel — el veredicto dice
  // "salta N noches seguidas" y el motivo entero vive en la página del
  // pipeline, agrupado. La prueba de que ESE texto llega escapado no se ha
  // perdido: está en `render.test.ts`, sobre `renderPipelinePage`. Aquí queda
  // el otro texto que el panel sí interpola desde un fichero que no
  // controlamos: la descripción del `pipeline.yaml`.
  test('la descripción del pipeline llega escapada al panel', () => {
    const health = {
      trigger: 'installed', work: 'working', consecutiveSkips: 0, contradiction: false,
    } as never;
    const html = renderHealthPanel(
      [{ name: 'demo', description: 'redacta <guarda> y publica', health, pasosTotales: 1 }],
      new Date('2026-08-31T11:56:00.000Z'),
    );
    expect(html).toContain('&lt;guarda&gt;');
    expect(html).not.toContain('<guarda>');
  });

  test('el nombre del pipeline llega escapado en el enlace y en el texto', () => {
    const health = {
      trigger: 'installed', work: 'working', consecutiveSkips: 0, contradiction: false,
    } as never;
    const html = renderHealthPanel(
      [{ name: 'a&b', description: 'd', health, pasosTotales: 1 }],
      new Date('2026-08-31T11:56:00.000Z'),
    );
    expect(html).toContain('a%26b');
    expect(html).toContain('a&amp;b');
  });
});

describe('la contradicción installed + silent', () => {
  // Es el único caso en que se lee el log del job: el
  // rastro de un motor que muere antes de escribir run.json. Sin runs en la
  // ventana y con el job cargado, la alarma tiene que salir.
  test('la alarma se pinta y dice dónde mirar', () => {
    const health = {
      trigger: 'installed', work: 'silent', consecutiveSkips: 0, contradiction: true,
    } as never;
    const html = renderHealthPanel(
      [{ name: 'demo', description: 'd', health, pasosTotales: 1 }],
      new Date('2026-08-31T11:56:00.000Z'),
    );
    expect(html).toContain('class="alarmbox"');
    expect(html).toContain('CARGADO Y SIN PRODUCIR NADA');
    expect(html).toContain('no llegó ni a arrancar');
  });

  test('con cola de log, la enseña escapada', () => {
    const health = {
      trigger: 'installed', work: 'silent', consecutiveSkips: 0, contradiction: true,
    } as never;
    const html = renderHealthPanel(
      [{ name: 'demo', description: 'd', health, pasosTotales: 1, jobLogTail: 'error: <bun> not found' }],
      new Date('2026-08-31T11:56:00.000Z'),
    );
    expect(html).toContain('&lt;bun&gt;');
    expect(html).not.toContain('<bun>');
  });
});

// Los dos ficheros hostiles, sin cubrir hasta ahora: `loadPipeline`
// y `store.listRuns` propagan sus errores y `healthRows` no los contenía, así
// que un solo pipeline roto tumbaba `GET /` para TODOS los pipelines —
// exactamente cuando este visor es más útil (mitad de autoría de un
// pipeline, o un `run.json` a medio escribir).
describe('GET / — contención de errores', () => {
  test('un pipeline sin pipeline.yaml no tumba el panel', async () => {
    const { server, base, root } = await serve();
    try {
      await addUnparseablePipeline(root, 'a-medio-autoring');
      const res = await fetch(`${base}/`);
      expect(res.status).toBe(200);
      const html = stripStyles(await res.text());
      expect(html).toContain('class="dot live"'); // demo sigue en el panel
      expect(html).toContain('a-medio-autoring');
    } finally {
      server.stop(true);
    }
  });

  // `loadPipeline` está escrito para el CLI, donde el nombre lo
  // teclea una persona: «No existe el pipeline "x". Disponibles: demo, x» es
  // útil ahí y aquí se contradice — nombra a `x` como ausente y como
  // disponible en la misma frase, y se lee como que la herramienta está rota.
  test('un directorio sin pipeline.yaml dice lo que pasa, sin contradecirse', async () => {
    const { server, base, root } = await serve();
    try {
      await addUnparseablePipeline(root, 'a-medio-autoring');
      const html = stripStyles(await (await fetch(`${base}/`)).text());
      expect(html).toContain('no tiene pipeline.yaml');
      expect(html).not.toContain('Disponibles:');
      expect(html).not.toContain('No existe el pipeline');
    } finally {
      server.stop(true);
    }
  });

  // El otro camino del mismo `catch`: si el fichero SÍ está y lo que falla es
  // el parseo, el mensaje real es lo único que dice qué corregir. Ese no se
  // toca.
  test('un pipeline.yaml ilegible sí enseña el motivo real', async () => {
    const { server, base, root } = await serve();
    try {
      await mkdir(join(root, 'pipelines', 'yaml-malo'), { recursive: true });
      await writeFile(join(root, 'pipelines', 'yaml-malo', 'pipeline.yaml'), 'name: [sin cerrar\n');
      const html = stripStyles(await (await fetch(`${base}/`)).text());
      expect(html).toContain('yaml-malo');
      expect(html).not.toContain('no tiene pipeline.yaml');
    } finally {
      server.stop(true);
    }
  });

  test('un run.json truncado no tumba el panel', async () => {
    const { server, base, root } = await serve();
    try {
      await addPipelineWithTruncatedRun(root, 'run-corrupto', '2026-08-29T03-00-00-000Z');
      const res = await fetch(`${base}/`);
      expect(res.status).toBe(200);
      const html = stripStyles(await res.text());
      expect(html).toContain('class="dot live"'); // demo sigue en el panel
      expect(html).toContain('run-corrupto');
    } finally {
      server.stop(true);
    }
  });
});

describe('404', () => {
  test('una ruta desconocida es 404', async () => {
    const { server, base } = await serve();
    try {
      expect((await fetch(`${base}/no-existe`)).status).toBe(404);
    } finally {
      server.stop(true);
    }
  });
});

describe('GET /p/:name', () => {
  test('muestra los pasos, las guardas y el historial', async () => {
    const { server, base } = await serve();
    try {
      const html = stripStyles(await (await fetch(`${base}/p/demo`)).text());
      expect(html).toContain('Un pipeline de prueba');
      // No 'uno' a secas: otros textos de la página contienen esa subcadena
      // ("ninguno", "alguno"), así que la aserción pasaba aunque la lista de
      // pasos saliera vacía. `<code>uno</code>` dentro de `.sid` es el marcado
      // que SOLO produce una fila de paso.
      expect(html).toContain('<code>uno</code>'); // el paso
      expect(html).toContain(SKIPPED_RUN_ID); // el run
    } finally {
      server.stop(true);
    }
  });

  // El motivo del salto viene de un fichero y lleva `<` y `>`: si se
  // interpola sin escapar, el visor se convierte en su propio agujero. Vive
  // aquí (y no en `GET /`, donde estaba antes) porque el run
  // más reciente de la fixture ahora es RUNNING_RUN_ID, en curso — no hay
  // salto que enseñar en el panel de salud (su `consecutiveSkips` cae a 0),
  // así que el motivo saltado solo sigue siendo visible, igual de escapado,
  // en el historial de esta página. El escapado del panel en sí tiene su
  // propia cobertura, sin fixture, en `describe('GET /')`.
  test('el motivo del salto llega escapado', async () => {
    const { server, base } = await serve();
    try {
      const html = stripStyles(await (await fetch(`${base}/p/demo`)).text());
      expect(html).toContain('&lt;guarda&gt;');
      expect(html).not.toContain('<guarda>');
    } finally {
      server.stop(true);
    }
  });

  // El bug que esta ruta podría introducir, y su prueba.
  test('un nombre con travesía es 404, no un fichero', async () => {
    const { server, base } = await serve();
    try {
      const res = await fetch(`${base}/p/${encodeURIComponent('../../etc/passwd')}`);
      expect(res.status).toBe(404);
    } finally {
      server.stop(true);
    }
  });

  test('un pipeline inexistente es 404', async () => {
    const { server, base } = await serve();
    try {
      expect((await fetch(`${base}/p/nope`)).status).toBe(404);
    } finally {
      server.stop(true);
    }
  });
});

describe('GET /p/:name/runs/:runId', () => {
  test('muestra los pasos del run', async () => {
    const { server, base } = await serve();
    try {
      const html = stripStyles(await (await fetch(`${base}/p/demo/runs/${RUNNING_RUN_ID}`)).text());
      expect(html).toContain('uno');
    } finally {
      server.stop(true);
    }
  });

  test('un runId inventado es 404', async () => {
    const { server, base } = await serve();
    try {
      expect((await fetch(`${base}/p/demo/runs/9999`)).status).toBe(404);
    } finally {
      server.stop(true);
    }
  });
});

describe('GET /p/:name/runs/:runId/:stepId', () => {
  test('sirve el log escapado', async () => {
    const { server, base } = await serve();
    try {
      const html = stripStyles(await (await fetch(`${base}/p/demo/runs/${RUNNING_RUN_ID}/uno`)).text());
      expect(html).toContain('&lt;b&gt;');
    } finally {
      server.stop(true);
    }
  });

  test('?raw=1 lo sirve en texto plano, sin escapar', async () => {
    const { server, base } = await serve();
    try {
      const res = await fetch(`${base}/p/demo/runs/${RUNNING_RUN_ID}/uno?raw=1`);
      expect(res.headers.get('content-type')).toContain('text/plain');
      expect(await res.text()).toContain('<b>');
    } finally {
      server.stop(true);
    }
  });

  test('un stepId que no está en el run es 404', async () => {
    const { server, base } = await serve();
    try {
      const res = await fetch(`${base}/p/demo/runs/${RUNNING_RUN_ID}/${encodeURIComponent('../run')}`);
      expect(res.status).toBe(404);
    } finally {
      server.stop(true);
    }
  });

  // `run.steps[stepId] === undefined` es una búsqueda por la CADENA DE
  // PROTOTIPOS: `constructor`, `toString`, `__proto__`... existen en
  // cualquier objeto y no son `undefined`, así que devolvían 200 en vez de
  // 404 pese a no ser pasos reales del run. No es una travesía, pero el
  // comentario de al lado afirma "se valida contra las claves del run" y eso
  // no es lo que hacía el código.
  test('un stepId de la cadena de prototipos (constructor) es 404', async () => {
    const { server, base } = await serve();
    try {
      const res = await fetch(`${base}/p/demo/runs/${RUNNING_RUN_ID}/constructor`);
      expect(res.status).toBe(404);
    } finally {
      server.stop(true);
    }
  });

  // Esta página SÍ debe suscribirse al vivo mientras el run está
  // `running` — antes no lo hacía (`layout()` se llamaba sin `sse`), así que
  // el evento `log` que manda `createRunStream` no tenía consumidor. Se
  // comprueba que el script referencia el stream correcto Y que lleva su
  // propio stepId para poder escoger su porción del log (commit siguiente
  // en `sse.test.ts` comprueba que el evento la lleva de verdad).
  test('se suscribe al stream del run mientras corre, con su propio stepId', async () => {
    const { server, base } = await serve();
    try {
      const html = await (await fetch(`${base}/p/demo/runs/${RUNNING_RUN_ID}/uno`)).text();
      expect(html).toContain(`new EventSource("/sse/demo/${RUNNING_RUN_ID}")`);
      expect(html).toContain('payload.stepId !== "uno"');
    } finally {
      server.stop(true);
    }
  });
});

describe('solo GET', () => {
  // La única regla de esta superficie es "toda ruta es GET, nada muta".
  // Con el handler suelto de Bun, cualquier
  // verbo cae en la misma respuesta 200 — no hace falta que exista un
  // exploit concreto para que sea una violación de esa regla.
  test('un POST a / no devuelve la página', async () => {
    const { server, base } = await serve();
    try {
      const res = await fetch(`${base}/`, { method: 'POST' });
      expect(res.status).not.toBe(200);
    } finally {
      server.stop(true);
    }
  });
});
