import { writeSync } from 'node:fs';
import type { Command } from 'commander';
import { RunStore } from '../../runs/store.ts';
import { EXIT_FAILURE, withContext } from '../shared.ts';

/**
 * Writes to stdout and WAITS for it to go out.
 *
 * WARNING: `console.log` of a large string gets truncated when stdout is a
 * PIPE: the write is asynchronous and the process exits before flushing it.
 * It does not happen to a file or a terminal, so it looks fine by hand and
 * breaks in production.
 *
 * Measured on 2026-09-14 with the `repo-audit` run (149,462 B):
 *   to a file → 149,462 B, valid JSON
 *   through a pipe → 98,304 B on one attempt and 69,279 B on another, cut
 *                    mid-string (the point varies: it is a race, not a fixed cap)
 *
 * What it cost: a notify script captures this output with `$( … )` — a
 * pipe — and feeds it to `jq`. `jq` died with "Unfinished string at EOF", the
 * script swallowed it (`2>/dev/null || echo ""`) and was left without
 * `alerts`. Without alerts, the email of a pipeline that HAD found things went
 * out as a "stopped" notice, which is the notice that it has not run for days.
 * Exactly the symptom an earlier notify fix was meant to remove, and could
 * not remove because it never got to see the data.
 */
function writeStdout(text: string): void {
  // `writeSync` in a loop, NOT `Bun.write`: the latter returns a promise that,
  // with stdout on a pipe, never resolved in tests (the command hung). A
  // synchronous `write(2)` repeated until the buffer is drained does not
  // depend on the event loop or on anyone closing anything.
  const buf = Buffer.from(text + '\n', 'utf8');
  let off = 0;
  while (off < buf.length) {
    try {
      off += writeSync(1, buf, off, buf.length - off);
    } catch (e) {
      // If the fd is in non-blocking mode, `write` can bounce with EAGAIN:
      // it is not an error, it is "does not fit right now". Retrying is
      // correct; anything else (EPIPE with the reader closed, e.g.) propagates.
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
    .description('Show the detail of a run or of one of its steps')
    .action(async (name: string, runId: string, step: string | undefined) => {
      await withContext(async (ctx) => {
        const run = await new RunStore(ctx.root).readRun(name, runId);
        if (!run) {
          console.error(`Run ${runId} of "${name}" does not exist.`);
          process.exitCode = EXIT_FAILURE;
          return;
        }
        if (step) {
          writeStdout(JSON.stringify(run.steps[step] ?? {}, null, 2));
          return;
        }
        writeStdout(JSON.stringify(run, null, 2));
      });
    });
}
