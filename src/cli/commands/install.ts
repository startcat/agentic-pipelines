import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import { bootout, bootstrap, printDisabled } from '../../install/launchctl.ts';
import {
  buildPlistSpec,
  computePath,
  cronToCalendarIntervals,
  foreignJobsMentioning,
  jobsNamedAfter,
  labelFor,
  logPathFor,
  MAX_CALENDAR_INTERVALS,
  parseDisabledLabels,
  renderPlist,
  stableBunPath,
  unresolvedInPath,
} from '../../install/launchd.ts';
import { unsetParamImpacts } from '../../install/params.ts';
import { resolveParams } from '../../params/resolve.ts';
import { hasBlockingFailures, preflight } from '../../preflight/check.ts';
import { loadLocalParams, loadPipeline } from '../context.ts';
import { launchAgentsDir, readLaunchAgents, writeLocalParams } from '../install-helpers.ts';
import { collectSetFlag, EXIT_FAILURE, OK, parseSetFlags, printPreflight, withContext } from '../shared.ts';

export function registerInstall(program: Command): void {
  program
    .command('install')
    .argument('<name>')
    .option('--set <clave=valor>', 'valor de un param (repetible)', collectSetFlag, [] as string[])
    .option('--force', 'instala pese a doctor en rojo o a un job ajeno sospechoso', false)
    .option('--dry-run', 'muestra el plist que escribiría y no toca nada', false)
    .description('Instala el pipeline como job programado de launchd')
    .action(async (name: string, opts: { set: string[]; force: boolean; dryRun: boolean }) => {
      await withContext(async (ctx) => {
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
        const bunPath = stableBunPath(process.execPath, Bun.which('bun'), realpathSync);
        const path = computePath(requiredBinaries, (bin) => Bun.which(bin), [dirname(bunPath)]);

        // Cinturón, no solo el suelo de `computePath`: valida contra el PATH
        // QUE SE VA A ESCRIBIR, no contra el del operador que ejecuta
        // `install` — la regla general que deja el incidente de origen (un
        // plist cuyo PATH no podía ni lanzar `sh`). `doctor`/`preflight`, más
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
        // Solo rutas de fichero, no de red — `foreignJobsMentioning` busca
        // coincidencias literales en el contenido de otros plists.
        const paths = Object.values(params).filter((value) => value.startsWith('/'));
        const agents = await readLaunchAgents();
        // Dos redes distintas y complementarias, no una repetida: la de rutas ve
        // que dos jobs pisan los mismos ficheros; la de nombres ve que dos jobs
        // hacen el mismo trabajo aunque no compartan un solo fichero. Desde que
        // cada pipeline tiene espacio propio, un relevo cae SOLO en la segunda.
        // La lectura de `print-disabled` es PEREZOSA: solo se invoca a launchctl
        // si de verdad hay algún homónimo que filtrar. Así el caso corriente —que
        // no lo hay— no toca launchctl en absoluto, y `install --dry-run` sigue
        // cumpliendo su contrato de no invocarlo (hay un test que lo exige).
        const named = jobsNamedAfter(name, agents, label, []);
        const homonyms =
          named.length === 0
            ? []
            : jobsNamedAfter(name, agents, label, parseDisabledLabels((await printDisabled()).stdout));
        if (homonyms.length > 0) {
          const warning =
            `Hay otros jobs de launchd, no deshabilitados, que llevan el nombre de este pipeline: ${homonyms.join(', ')}.\n` +
            `Si son el predecesor al que este pipeline releva, harán el mismo trabajo dos veces. ` +
            `Retíralos con "launchctl bootout" Y "launchctl disable" — sin el disable vuelven al siguiente arranque.`;
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
            `Otros jobs de launchd mencionan rutas de este pipeline: ${foreign.join(', ')}.\n` +
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
          console.log(`  escaneados ${agents.length} job(s) de launchd, ninguno coincide`);
        }

        /**
         * Resumen que imprimen tanto la instalación real como el ensayo
         * (`--dry-run`), para que lo que ves antes de tocar sea literalmente lo
         * que verás después. Closure y no función suelta: captura todo lo que ya
         * está calculado en este punto del comando.
         */
        const printInstallSummary = (headline: string, plistLocation: string): void => {
          console.log(headline);
          console.log(`  plist    ${plistLocation}`);
          console.log(`  horarios ${intervals.length} (de ${pipeline.triggers.map((t) => t.cron).join(', ')})`);
          console.log(`  PATH     ${path}`);
          console.log(`  log      ${logPathFor(homedir(), name)}`);

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

        const plistPath = join(launchAgentsDir(), `${label}.plist`);
        // Se comprueba ANTES de escribir: la etiqueta es determinista
        // (`labelFor`, un pipeline -> un plist), así que la existencia previa
        // de ESTE fichero es exactamente "ya había un job con esta etiqueta
        // cargado". El reemplazo sigue ocurriendo igual y
        // sin pedir --force (adoptar el job propio es correcto), pero hay que
        // decirlo — el incidente de origen fue justo un plist desviado que
        // nadie notó durante diez días.
        const replacing = await Bun.file(plistPath).exists();

        const plistContents = renderPlist(
          buildPlistSpec({
            pipelineName: name,
            repoRoot: ctx.root,
            bunPath,
            cliEntry: join(import.meta.dir, '..', 'index.ts'),
            home: homedir(),
            path,
            calendarIntervals: intervals,
            generatedAt: new Date().toISOString(),
            guards: pipeline.when,
          }),
        );

        // El ensayo corta AQUÍ: después de haber validado exactamente lo mismo
        // que una instalación de verdad (cron, PATH, params, doctor, jobs
        // ajenos) y antes del primer efecto. Ni el plist, ni
        // `.params.local.json` aunque haya `--set`, ni `launchctl`: un ensayo
        // que deja rastro persistente deja de serlo, y este flag existe para
        // poder mirar antes de tocar. Comparar el plist generado contra el que ya corre es lo
        // que caza un artefacto desviado, y como entrada de checklist se salta.
        if (opts.dryRun) {
          console.log(plistContents);
          printInstallSummary(
            replacing
              ? `(--dry-run) reemplazaría el job que ya existe: ${label}`
              : `(--dry-run) instalaría ${label}`,
            `${plistPath} (no escrito)`,
          );
          return;
        }

        // El directorio puede no existir todavía (primera instalación en una
        // máquina limpia): sin `recursive: true` la escritura sale con un
        // ENOENT crudo. Se hace ANTES de `writeLocalParams` (ver más abajo) a
        // propósito: si esto falla, no debe quedar nada escrito.
        await mkdir(launchAgentsDir(), { recursive: true });
        await writeFile(plistPath, plistContents, 'utf8');

        // Se escribe DESPUÉS del plist a propósito: antes se escribía primero,
        // así que un aborto entre medias (p. ej. el `mkdir` de arriba
        // fallando por permisos) dejaba `.params.local.json` actualizado sin
        // ningún job instalado — estado a medias, peor que no haber hecho nada.
        await writeLocalParams(ctx.root, name, overrides);

        // El bootout previo puede fallar legítimamente ("no estaba cargado"):
        // se ignora su código a propósito. Mismo label = reemplazo, no duplicado.
        await bootout(label);
        const { code, stderr } = await bootstrap(plistPath);
        if (code !== 0) {
          console.error(`launchctl bootstrap salió con código ${code}; el plist está en ${plistPath}.`);
          if (stderr) console.error(`  launchctl: ${stderr}`);
          process.exitCode = EXIT_FAILURE;
          return;
        }

        printInstallSummary(
          replacing
            ? `${OK} reemplazado el job que ya existía: ${label}`
            : `${OK} instalado ${label}`,
          plistPath,
        );
      });
    });
}
