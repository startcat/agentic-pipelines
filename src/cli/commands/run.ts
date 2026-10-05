import { homedir } from 'node:os';
import type { Command } from 'commander';
import { evaluateGuards } from '../../guards/evaluate.ts';
import { resolveParams } from '../../params/resolve.ts';
import { hasBlockingFailures, preflight } from '../../preflight/check.ts';
import { runPipeline } from '../../runner/orchestrate.ts';
import { RunStore } from '../../runs/store.ts';
import { collectAgentAuth, collectSecrets, loadLocalParams, loadPipeline } from '../context.ts';
import { withLock } from '../lock.ts';
import {
  collectSetFlag,
  EXIT_FAILURE,
  KO,
  notifyRunClosed,
  OK,
  parseSetFlags,
  printPreflight,
  withContext,
} from '../shared.ts';
import { unknownToolWarnings } from '../warnings.ts';

export function registerRun(program: Command): void {
  program
    .command('run')
    .argument('<name>')
    .option('--set <clave=valor>', 'valor de un param (repetible)', collectSetFlag, [] as string[])
    .option('--force', 'ejecuta aunque una guarda de `when:` no pase', false)
    .description('Ejecuta el pipeline ahora')
    .action(async (name: string, opts: { set: string[]; force: boolean }) => {
      await withContext(async (ctx) => {
        const pipeline = await loadPipeline(ctx, name);
        const store = new RunStore(ctx.root);

        const report = await preflight(pipeline, {
          repoRoot: ctx.root,
          userClaudeDir: `${homedir()}/.claude`,
          processEnv: process.env,
          dotEnv: ctx.dotEnv,
        });
        // `hasBlockingFailures`, no `report.ok`: un check `mcp-schema` es
        // puramente informativo de `doctor` (ver su doc comment) — nunca debe
        // impedir una ejecución real. `doctor`, más abajo, sigue usando
        // `report.ok` sin cambios: ahí SÍ debe ser tan ruidoso como siempre.
        if (hasBlockingFailures(report)) {
          printPreflight(report);
          console.error('\nFaltan dependencias — no se ejecuta nada.');
          process.exitCode = EXIT_FAILURE;
          return;
        }
        if (!report.ok) {
          // Únicamente fallos advisory (mcp-schema): no bloquean `run`, pero
          // se avisan igualmente — el operador debería poder verlos sin tener
          // que acordarse de correr `doctor` aparte.
          for (const check of report.checks.filter((c) => !c.ok)) {
            console.error(`  aviso: ${check.kind} ${check.name} — ${check.detail}`);
          }
        }

        // Se resuelve ANTES de tomar el lock: un param obligatorio ausente no
        // debe hacer que este proceso compita por (ni bloquee) una ejecución
        // que no va a llegar a arrancar.
        const params = resolveParams(pipeline, {
          local: await loadLocalParams(ctx, name),
          overrides: parseSetFlags(opts.set),
        });

        await withLock(
          ctx.root,
          name,
          async () => {
            // `--force` no toca preflight: eso mide si esta máquina PUEDE
            // ejecutar el pipeline (auth, binarios, secretos), y saltárselo solo
            // adelantaría el mismo fallo unos segundos. Lo que omite son las
            // guardas de `when:`, que son política — "hoy no toca" —, y esa es
            // la única que un humano delante puede contradecir a sabiendas.
            const guards = opts.force
              ? ({ pass: true } as const)
              : await evaluateGuards(pipeline, { store, params, now: new Date() });
            if (opts.force) {
              console.error('aviso: --force, se omite la evaluación de las guardas `when:`.');
            }
            if (!guards.pass) {
              const run = await store.createRun(name, pipeline.version, params);
              // `finishRun` muta `run` (le fija status y finishedAt), así que
              // lo que se notifica es ya el registro cerrado, no el de arranque.
              await store.finishRun(run, 'skipped', guards.reason);
              console.log(`saltado: ${guards.reason}`);
              await notifyRunClosed(pipeline, run, ctx, store);
              return;
            }

            const record = await runPipeline({
              pipeline,
              repoRoot: ctx.root,
              store,
              params,
              secrets: collectSecrets(ctx, pipeline.requires.env),
              agentAuth: collectAgentAuth(ctx),
              forced: opts.force,
            });

            await notifyRunClosed(pipeline, record, ctx, store);

            for (const id of Object.keys(record.steps)) {
              const step = record.steps[id]!;
              const mark = step.status === 'success' ? OK : step.status === 'skipped' ? '○' : KO;
              console.log(`  ${mark} ${id.padEnd(20)} ${step.status}`);
            }
            for (const warning of unknownToolWarnings(record)) {
              console.error(warning);
            }
            console.log(`\n${record.status} — ${record.id}`);
            if (record.status === 'failed') process.exitCode = EXIT_FAILURE;
          },
          async () => {
            const blocked = await store.createRun(name, pipeline.version, params);
            await store.finishRun(blocked, 'skipped', 'already_running');
            await notifyRunClosed(pipeline, blocked, ctx, store);
          },
        );
      });
    });
}
