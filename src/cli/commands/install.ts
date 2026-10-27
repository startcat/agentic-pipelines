import { homedir } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import type { Command } from 'commander';
import { schedulerFor } from '../../install/backend.ts';
import {
  computePath,
  cronToCalendarIntervals,
  foreignJobsMentioning,
  jobsNamedAfter,
  labelFor,
  MAX_CALENDAR_INTERVALS,
  unresolvedInPath,
} from '../../install/common.ts';
import { currentTimezone } from '../../install/platform-checks.ts';
import { unsetParamImpacts } from '../../install/params.ts';
import { resolveParams } from '../../params/resolve.ts';
import { hasBlockingFailures, preflight } from '../../preflight/check.ts';
import { loadLocalParams, loadPipeline } from '../context.ts';
import { jobBunPath, userHome, writeLocalParams } from '../install-helpers.ts';
import { collectSetFlag, EXIT_FAILURE, KO, OK, parseSetFlags, printPreflight, withContext } from '../shared.ts';

export function registerInstall(program: Command): void {
  program
    .command('install')
    .argument('<name>')
    .option('--set <clave=valor>', 'valor de un param (repetible)', collectSetFlag, [] as string[])
    .option('--force', 'instala pese a doctor en rojo o a un job ajeno sospechoso', false)
    .option('--dry-run', 'muestra los ficheros del job que escribiría y no toca nada', false)
    .description('Instala el pipeline como job programado (launchd en macOS, systemd en Linux)')
    .action(async (name: string, opts: { set: string[]; force: boolean; dryRun: boolean }) => {
      await withContext(async (ctx) => {
        // Lo primero: en una plataforma sin programador, el error tiene que
        // decirlo antes que cualquier otra cosa.
        const backend = schedulerFor();
        const pipeline = await loadPipeline(ctx, name);

        // `triggers.cron` es la ÚNICA fuente de la cadencia:
        // sin él no hay nada que instalar, y duplicarlo en un flag reabriría la
        // discrepancia YAML/plist que este comando existe para cerrar.
        if (pipeline.triggers.length === 0) {
          console.error(
            `El pipeline "${name}" no declara ningún "triggers.cron", así que no hay cadencia que ` +
              `instalar. Añádelo al pipeline.yaml y repite.`,
          );
          process.exitCode = EXIT_FAILURE;
          return;
        }
        const intervals = pipeline.triggers.flatMap((trigger) =>
          cronToCalendarIntervals(trigger.cron),
        );
        // `MAX_CALENDAR_INTERVALS` ya se aplica POR TRIGGER dentro de
        // `cronToCalendarIntervals` (una expansión enorme en un solo
        // `triggers.cron` suele pedir un paso con slash, que este subconjunto
        // no soporta a propósito), pero varios triggers pequeños pueden sumar
        // igualmente un plist de decenas de horarios que nadie revisa — el
        // mismo problema por otra vía, así que el tope se aplica también al
        // TOTAL combinado.
        if (intervals.length > MAX_CALENDAR_INTERVALS) {
          console.error(
            `Los "triggers.cron" declarados suman ${intervals.length} horarios combinados, más del ` +
              `máximo de ${MAX_CALENDAR_INTERVALS} en total. Declara menos triggers o simplifícalos.`,
          );
          process.exitCode = EXIT_FAILURE;
          return;
        }

        const report = await preflight(pipeline, {
          repoRoot: ctx.root,
          userClaudeDir: `${homedir()}/.claude`,
          processEnv: process.env,
          dotEnv: ctx.dotEnv,
        });
        const blocked = hasBlockingFailures(report);
        if (blocked && !opts.force) {
          printPreflight(report);
          console.error('\nEsta máquina no puede ejecutar el pipeline. Usa --force para instalar igualmente.');
          process.exitCode = EXIT_FAILURE;
          return;
        }
        if (blocked) {
          // "--force lo salta, AVISANDO": instalar en silencio
          // pese a checks en rojo fabricaría un camino nuevo indistinguible de
          // una instalación limpia, justo lo contrario de para qué existe
          // `--force`.
          printPreflight(report);
          console.error('\n--force: se instala igualmente pese a los checks en rojo de arriba.');
        }

        // Puertas propias de la plataforma (en systemd, el "linger": sin él el
        // temporizador no se dispara con la sesión cerrada). Mismo trato que el
        // preflight, pero el ensayo las muestra y NUNCA se bloquea por ellas.
        const failedChecks = (await backend.preInstallChecks()).filter((check) => !check.ok);
        for (const check of failedChecks) {
          console.error(`  ${KO} ${check.name}: ${check.detail}${check.fix ? `\n    arréglalo con: ${check.fix}` : ''}`);
        }
        if (failedChecks.length > 0 && !opts.dryRun) {
          if (!opts.force) {
            console.error('\nEsta máquina no está lista para programar el pipeline. Usa --force para instalar igualmente.');
            process.exitCode = EXIT_FAILURE;
            return;
          }
          console.error('\n--force: se instala igualmente pese a los checks en rojo de arriba.');
        }

        const overrides = parseSetFlags(opts.set);
        const params = resolveParams(pipeline, {
          local: await loadLocalParams(ctx, name),
          overrides,
        });

        // El PATH del job tiene que cubrir todo lo que puede necesitar
        // arrancar en marcha: los binarios de `requires.bin` Y el `command` de
        // cada `mcp_servers` — `preflight/check.ts` ya trata `server.command`
        // como binario requerido (ver su check `kind: 'mcp'`); hasta ahora
        // aquí no, y solo funcionaba cuando ese comando compartía directorio
        // con algún bin ya declarado.
        const requiredBinaries = [
          ...pipeline.requires.bin,
          ...Object.values(pipeline.mcpServers).map((server) => server.command),
        ];
        const bunPath = jobBunPath();
        const path = computePath(requiredBinaries, (bin) => Bun.which(bin), [dirname(bunPath)]);

        // Cinturón, no solo el suelo de `computePath`: valida contra el PATH
        // QUE SE VA A ESCRIBIR, no contra el del operador que ejecuta
        // `install` — la regla general que deja el incidente de origen (un
        // plist cuyo PATH no podía ni lanzar `sh`; hoy, el intérprete de la
        // plataforma: `sh` en macOS, `bash` en Linux). `doctor`/`preflight`, más
        // arriba, valida binarios contra el PATH del OPERADOR: puede estar en
        // verde y aun así el PATH calculado para el job fallar, si este
        // proceso ve binarios que el entorno del job no vería.
        const unresolved = unresolvedInPath(path, requiredBinaries, (bin, p) =>
          Bun.which(bin, { PATH: p }),
        );
        if (unresolved.length > 0) {
          console.error(
            `El PATH calculado para el job no resuelve: ${unresolved.join(', ')}. El job instalado ` +
              `fallaría al arrancar cualquier paso "shell" o guarda "shell:". Esto no debería pasar — ` +
              `revisa "requires.bin" y "mcp_servers" del pipeline.`,
          );
          console.error(`  PATH calculado: ${path}`);
          process.exitCode = EXIT_FAILURE;
          return;
        }

        const label = labelFor(name);
        const home = userHome();
        // Solo rutas de fichero, no de red — `foreignJobsMentioning` busca
        // coincidencias literales en el contenido de los ficheros de otros jobs.
        const paths = Object.values(params).filter((value) => value.startsWith('/'));
        const agents = await backend.readUserJobs();
        // Dos redes distintas y complementarias, no una repetida: la de rutas ve
        // que dos jobs pisan los mismos ficheros; la de nombres ve que dos jobs
        // hacen el mismo trabajo aunque no compartan un solo fichero. Desde que
        // cada pipeline tiene espacio propio, un relevo cae SOLO en la segunda.
        // La consulta de deshabilitados es PEREZOSA: solo se pregunta al
        // programador si de verdad hay algún homónimo que filtrar. Así el caso
        // corriente —que no lo hay— no lo toca en absoluto, y `install --dry-run`
        // sigue cumpliendo su contrato de no invocarlo (hay un test que lo exige).
        const named = jobsNamedAfter(name, agents, label, []);
        const homonyms =
          named.length === 0
            ? []
            : jobsNamedAfter(name, agents, label, await backend.disabledLabels(named));
        if (homonyms.length > 0) {
          const warning =
            `Hay otros jobs de ${backend.label}, no deshabilitados, que llevan el nombre de este pipeline: ${homonyms.join(', ')}.\n` +
            `Si son el predecesor al que este pipeline releva, harán el mismo trabajo dos veces. ` +
            // Sin repetir: en launchd la pista es la misma frase para todos.
            [...new Set(homonyms.map((homonym) => backend.retireHint(homonym)))].join(' ');
          if (!opts.force) {
            console.error(`${warning} Revísalos, o repite con --force.`);
            process.exitCode = EXIT_FAILURE;
            return;
          }
          console.error(`${warning}\n--force: se instala igualmente.`);
        }

        const foreign = foreignJobsMentioning(paths, agents, label);
        if (foreign.length > 0) {
          const warning =
            `Otros jobs de ${backend.label} mencionan rutas de este pipeline: ${foreign.join(', ')}.\n` +
            `Si trabajan sobre lo mismo a la vez, se pisarán.`;
          if (!opts.force) {
            console.error(`${warning} Revísalos, o repite con --force.`);
            process.exitCode = EXIT_FAILURE;
            return;
          }
          console.error(`${warning}\n--force: se instala igualmente.`);
        } else {
          // Antes, sin coincidencias, este escaneo no decía nada: no había
          // forma de saber si de verdad se había comprobado algo o si la red
          // estaba echada en el vacío (p. ej. `~/Library/LaunchAgents` recién
          // creado en una máquina limpia).
          console.log(`  escaneados ${agents.length} job(s) de ${backend.label}, ninguno coincide`);
        }

        const files = backend.jobFiles({
          pipelineName: name,
          repoRoot: ctx.root,
          bunPath,
          cliEntry: join(import.meta.dir, '..', 'index.ts'),
          home,
          path,
          calendarIntervals: intervals,
          generatedAt: new Date().toISOString(),
          guards: pipeline.when,
        });
        // Se comprueba ANTES de escribir: la etiqueta es determinista
        // (`labelFor`, un pipeline -> unos ficheros fijos), así que la
        // existencia previa del primero es exactamente "ya había un job con
        // esta etiqueta cargado". El reemplazo sigue
        // ocurriendo igual y sin pedir --force (adoptar el job propio es
        // correcto), pero hay que decirlo — el incidente de origen fue justo un
        // plist desviado que nadie notó durante diez días.
        const replacing = await Bun.file(files[0]!.path).exists();

        /**
         * Resumen que imprimen tanto la instalación real como el ensayo
         * (`--dry-run`), para que lo que ves antes de tocar sea literalmente lo
         * que verás después. Closure y no función suelta: captura todo lo que ya
         * está calculado en este punto del comando.
         */
        const timezone = await currentTimezone();
        const printInstallSummary = (headline: string, suffix: string): void => {
          console.log(headline);
          // Una línea por fichero, con su extensión como rótulo: «plist» en
          // launchd, «service» y «timer» en systemd.
          for (const file of files) {
            console.log(`  ${extname(file.path).slice(1).padEnd(8)} ${file.path}${suffix}`);
          }
          console.log(`  horarios ${intervals.length} (de ${pipeline.triggers.map((t) => t.cron).join(', ')})`);
          console.log(`  PATH     ${path}`);
          console.log(`  log      ${backend.logPath(home, name)}`);
          console.log(`  zona     ${timezone}`);

          for (const impact of unsetParamImpacts(pipeline, params)) {
            if (impact.skippedSteps.length > 0) {
              console.log(
                `  aviso: el param "${impact.param}" no tiene valor — se saltará: ${impact.skippedSteps.join(', ')}`,
              );
            }
            if (impact.uncertainSteps.length > 0) {
              console.log(
                `  aviso: el param "${impact.param}" no tiene valor — pasos cuyo "when:" depende de él: ${impact.uncertainSteps.join(', ')}`,
              );
            }
            if (impact.skippedSteps.length === 0 && impact.uncertainSteps.length === 0) {
              console.log(`  aviso: el param "${impact.param}" no tiene valor — ningún paso depende de él`);
            }
          }
        };

        // El ensayo corta AQUÍ: después de haber validado exactamente lo mismo
        // que una instalación de verdad (cron, PATH, params, doctor, jobs
        // ajenos) y antes del primer efecto. Ni los ficheros del job, ni
        // `.params.local.json` aunque haya `--set`, ni el programador: un ensayo
        // que deja rastro persistente deja de serlo, y este flag existe para
        // poder mirar antes de tocar. Comparar el plist generado contra el que ya corre es lo
        // que caza un artefacto desviado, y como entrada de checklist se salta.
        if (opts.dryRun) {
          // En launchd el plist sale tal cual, como siempre; en los demás,
          // cada fichero lleva delante su ruta para saber cuál es cuál.
          for (const file of files) {
            if (backend.kind !== 'launchd') console.log(`# ${file.path}`);
            console.log(file.contents);
          }
          printInstallSummary(
            replacing
              ? `(--dry-run) reemplazaría el job que ya existe: ${label}`
              : `(--dry-run) instalaría ${label}`,
            ' (no escrito)',
          );
          return;
        }

        // El directorio puede no existir todavía (primera instalación en una
        // máquina limpia): sin `recursive: true` la escritura sale con un
        // ENOENT crudo. Se hace ANTES de `writeLocalParams` (ver más abajo) a
        // propósito: si esto falla, no debe quedar nada escrito.
        // El directorio del log también: systemd no lo crea, y sin él el
        // servicio falla al abrir la salida antes de ejecutar nada.
        await mkdir(dirname(backend.logPath(home, name)), { recursive: true });
        for (const file of files) {
          await mkdir(dirname(file.path), { recursive: true });
          await writeFile(file.path, file.contents, 'utf8');
        }

        // Se escribe DESPUÉS del job a propósito: antes se escribía primero,
        // así que un aborto entre medias (p. ej. el `mkdir` de arriba
        // fallando por permisos) dejaba `.params.local.json` actualizado sin
        // ningún job instalado — estado a medias, peor que no haber hecho nada.
        await writeLocalParams(ctx.root, name, overrides);

        const { code, stderr } = await backend.activate(label, files);
        if (code !== 0) {
          console.error(
            `${backend.label} no pudo cargar el job (código ${code}); ` +
              (files.length === 1 ? 'el fichero del job está en ' : 'los ficheros del job están en ') +
              `${files.map((file) => file.path).join(' y ')}.`,
          );
          if (stderr) console.error(`  ${backend.label}: ${stderr}`);
          process.exitCode = EXIT_FAILURE;
          return;
        }

        printInstallSummary(
          replacing
            ? `${OK} reemplazado el job que ya existía: ${label}`
            : `${OK} instalado ${label}`,
          '',
        );
      });
    });
}
