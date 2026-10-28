import type { Command } from 'commander';
import { createServer } from '../../web/server.ts';
import { withContext } from '../shared.ts';

export function registerWeb(program: Command): void {
  program
    .command('web')
    .option('-p, --port <n>', 'port to listen on', '7717')
    .description('Start a local read-only dashboard over the repo and its runs')
    .action(async (opts: { port: string }) => {
      await withContext(async (ctx) => {
        const server = createServer(ctx, { port: Number(opts.port) });
        console.log(`Listening on http://127.0.0.1:${server.port} — Ctrl-C to stop.`);
        // Never resolves: the process lives until it is killed.
        await new Promise(() => {});
      });
    });
}
