import type { Command } from 'commander';
import { createServer } from '../../web/server.ts';
import { withContext } from '../shared.ts';

export function registerWeb(program: Command): void {
  program
    .command('web')
    .option('-p, --port <n>', 'puerto en el que escuchar', '7717')
    .description('Servidor local de lectura sobre el repo y sus ejecuciones')
    .action(async (opts: { port: string }) => {
      await withContext(async (ctx) => {
        const server = createServer(ctx, { port: Number(opts.port) });
        console.log(`Escuchando en http://127.0.0.1:${server.port} — Ctrl-C para parar.`);
        // No se resuelve nunca: el proceso vive hasta que lo maten.
        await new Promise(() => {});
      });
    });
}
