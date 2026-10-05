import { writeSync } from 'node:fs';
import type { Command } from 'commander';
import { RunStore } from '../../runs/store.ts';
import { EXIT_FAILURE, withContext } from '../shared.ts';

/**
 * Escribe a stdout y ESPERA a que salga.
 *
 * ⚠️ `console.log` de una cadena grande se trunca cuando stdout es una TUBERÍA:
 * la escritura es asíncrona y el proceso sale antes de vaciarla. A fichero o a
 * terminal no pasa, así que se ve bien a mano y se rompe en producción.
 *
 * Medido el 14-09-2026 con el run de `repo-audit` (149.462 B):
 *   a fichero → 149.462 B, JSON válido
 *   por tubería → 98.304 B en una pasada y 69.279 B en otra, cortado a media
 *                 cadena (el punto varía: es una carrera, no un tope fijo)
 *
 * Lo que costó: `notify-resend.sh` captura esta salida con `$( … )` —una
 * tubería— y le pasa `jq`. El `jq` moría con «Unfinished string at EOF», el
 * script se lo tragaba (`2>/dev/null || echo ""`) y se quedaba sin `alerts`.
 * Sin alerts, el correo de un pipeline que SÍ había encontrado cosas salía como
 * «ATURAT», que es el aviso de que lleva días sin ejecutarse. Justo el síntoma
 * que el arreglo de notify del 13-09 venía a quitar, y que no podía quitar
 * porque nunca llegaba a ver los datos.
 */
function escribeStdout(texto: string): void {
  // `writeSync` en bucle, NO `Bun.write`: el segundo devuelve una promesa que
  // con stdout en tubería no llegó a resolver nunca en pruebas (el comando se
  // quedaba colgado). Un `write(2)` síncrono repetido hasta agotar el buffer
  // no depende del bucle de eventos ni de que nadie cierre nada.
  const buf = Buffer.from(texto + '\n', 'utf8');
  let off = 0;
  while (off < buf.length) {
    try {
      off += writeSync(1, buf, off, buf.length - off);
    } catch (e) {
      // Si el fd está en modo no bloqueante, `write` puede rebotar con EAGAIN:
      // no es un error, es «ahora no cabe». Reintentar es lo correcto; cualquier
      // otra cosa (EPIPE con el lector cerrado, p. ej.) se propaga.
      if ((e as NodeJS.ErrnoException).code !== 'EAGAIN') throw e;
    }
  }
}

export function registerShow(program: Command): void {
  program
    .command('show')
    .argument('<name>')
    .argument('<run-id>')
    .argument('[step]')
    .description('Detalle de una ejecución o de uno de sus pasos')
    .action(async (name: string, runId: string, step: string | undefined) => {
      await withContext(async (ctx) => {
        const run = await new RunStore(ctx.root).readRun(name, runId);
        if (!run) {
          console.error(`No existe el run ${runId} de "${name}".`);
          process.exitCode = EXIT_FAILURE;
          return;
        }
        if (step) {
          escribeStdout(JSON.stringify(run.steps[step] ?? {}, null, 2));
          return;
        }
        escribeStdout(JSON.stringify(run, null, 2));
      });
    });
}
