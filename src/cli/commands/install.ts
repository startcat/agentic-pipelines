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
    .option('--set <key=value>', 'value of a param (repeatable)', collectSetFlag, [] as string[])
    .option('--force', 'install despite a red doctor or a suspicious foreign job', false)
    .option('--dry-run', 'show the job files it would write and touch nothing', false)
    .description('Install the pipeline as a scheduled job (launchd on macOS, systemd on Linux)')
    .action(async (name: string, opts: { set: string[]; force: boolean; dryRun: boolean }) => {
      await withContext(async (ctx) => {
        // First thing: on a platform with no scheduler, the error has to say
        // so before anything else.
        const backend = schedulerFor();
        const pipeline = await loadPipeline(ctx, name);

        // `triggers.cron` is the ONLY source of the cadence: without it there
        // is nothing to install, and duplicating it in a flag would reopen the
        // YAML/plist discrepancy this command exists to close.
        if (pipeline.triggers.length === 0) {
          console.error(
            `Pipeline "${name}" does not declare any "triggers.cron", so there is no cadence to ` +
              `install. Add it to pipeline.yaml and try again.`,
          );
          process.exitCode = EXIT_FAILURE;
          return;
        }
        const intervals = pipeline.triggers.flatMap((trigger) =>
          cronToCalendarIntervals(trigger.cron),
        );
        // `MAX_CALENDAR_INTERVALS` is already applied PER TRIGGER inside
        // `cronToCalendarIntervals` (a huge expansion in a single
        // `triggers.cron` usually asks for a slash step, which this subset
        // deliberately does not support), but several small triggers can still
        // add up to a plist with dozens of schedules that nobody reviews — the
        // same problem by another route, so the cap is also applied to the
        // combined TOTAL.
        if (intervals.length > MAX_CALENDAR_INTERVALS) {
          console.error(
            `The declared "triggers.cron" add up to ${intervals.length} combined schedules, more than the ` +
              `maximum of ${MAX_CALENDAR_INTERVALS} in total. Declare fewer triggers or simplify them.`,
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
          console.error('\nThis machine cannot run the pipeline. Use --force to install anyway.');
          process.exitCode = EXIT_FAILURE;
          return;
        }
        if (blocked) {
          // "--force skips it, WITH A WARNING": installing silently despite
          // red checks would create a new path indistinguishable from a clean
          // install, exactly the opposite of what `--force` is for.
          printPreflight(report);
          console.error('\n--force: installing anyway despite the red checks above.');
        }

        // Platform-specific gates (in systemd, "linger": without it the timer
        // does not fire with the session closed). Same treatment as the
        // preflight, but the dry run shows them and NEVER blocks on them.
        const failedChecks = (await backend.preInstallChecks()).filter((check) => !check.ok);
        for (const check of failedChecks) {
          console.error(`  ${KO} ${check.name}: ${check.detail}${check.fix ? `\n    fix it with: ${check.fix}` : ''}`);
        }
        if (failedChecks.length > 0 && !opts.dryRun) {
          if (!opts.force) {
            console.error('\nThis machine is not ready to schedule the pipeline. Use --force to install anyway.');
            process.exitCode = EXIT_FAILURE;
            return;
          }
          console.error('\n--force: installing anyway despite the red checks above.');
        }

        const overrides = parseSetFlags(opts.set);
        const params = resolveParams(pipeline, {
          local: await loadLocalParams(ctx, name),
          overrides,
        });

        // The job's PATH has to cover everything it may need to start up on
        // the fly: the `requires.bin` binaries AND the `command` of each
        // `mcp_servers` — `preflight/check.ts` already treats `server.command`
        // as a required binary (see its `kind: 'mcp'` check); until now it did
        // not here, and it only worked when that command shared a directory
        // with some already declared bin.
        const requiredBinaries = [
          ...pipeline.requires.bin,
          ...Object.values(pipeline.mcpServers).map((server) => server.command),
        ];
        const bunPath = jobBunPath();
        const path = computePath(requiredBinaries, (bin) => Bun.which(bin), [dirname(bunPath)]);

        // Belt and braces, not just `computePath`'s floor: it validates against
        // the PATH THAT WILL BE WRITTEN, not against that of the operator
        // running `install` — the general rule left by the originating
        // incident (a plist whose PATH could not even launch `sh`; today, the
        // platform's interpreter: `sh` on macOS, `bash` on Linux).
        // `doctor`/`preflight`, further up, validates binaries against the
        // OPERATOR's PATH: it can be green and the PATH computed for the job
        // can still fail, if this process sees binaries that the job's
        // environment would not.
        const unresolved = unresolvedInPath(path, requiredBinaries, (bin, p) =>
          Bun.which(bin, { PATH: p }),
        );
        if (unresolved.length > 0) {
          console.error(
            `The PATH computed for the job does not resolve: ${unresolved.join(', ')}. The installed job ` +
              `would fail when starting any "shell" step or "shell:" guard. This should not happen — ` +
              `check the pipeline's "requires.bin" and "mcp_servers".`,
          );
          console.error(`  computed PATH: ${path}`);
          process.exitCode = EXIT_FAILURE;
          return;
        }

        const label = labelFor(name);
        const home = userHome();
        // File paths only, not network ones — `foreignJobsMentioning` looks for
        // literal matches in the contents of other jobs' files.
        const paths = Object.values(params).filter((value) => value.startsWith('/'));
        const agents = await backend.readUserJobs();
        // Two different and complementary nets, not a repeated one: the paths
        // one sees that two jobs step on the same files; the names one sees
        // that two jobs do the same work even if they share not a single file.
        // Since every pipeline has its own space, a predecessor job being
        // replaced is caught ONLY by the second. The disabled query is LAZY: the scheduler is only asked if
        // there really is a homonym to filter. That way the usual case — where
        // there is none — does not touch it at all, and `install --dry-run`
        // keeps honoring its contract of not invoking it (a test requires it).
        const named = jobsNamedAfter(name, agents, label, []);
        const homonyms =
          named.length === 0
            ? []
            : jobsNamedAfter(name, agents, label, await backend.disabledLabels(named));
        if (homonyms.length > 0) {
          const warning =
            `There are other ${backend.label} jobs, not disabled, named after this pipeline: ${homonyms.join(', ')}.\n` +
            `If they are the predecessor this pipeline replaces, they will do the same work twice. ` +
            // Deduplicated: in launchd the hint is the same sentence for every job.
            [...new Set(homonyms.map((homonym) => backend.retireHint(homonym)))].join(' ');
          if (!opts.force) {
            console.error(`${warning} Check them, or run again with --force.`);
            process.exitCode = EXIT_FAILURE;
            return;
          }
          console.error(`${warning}\n--force: installing anyway.`);
        }

        const foreign = foreignJobsMentioning(paths, agents, label);
        if (foreign.length > 0) {
          const warning =
            `Other ${backend.label} jobs mention paths of this pipeline: ${foreign.join(', ')}.\n` +
            `If they work on the same thing at the same time, they will step on each other.`;
          if (!opts.force) {
            console.error(`${warning} Check them, or run again with --force.`);
            process.exitCode = EXIT_FAILURE;
            return;
          }
          console.error(`${warning}\n--force: installing anyway.`);
        } else {
          // Before, with no matches, this scan said nothing: there was no way
          // to know whether anything had really been checked or whether the scan
          // had nothing to look at (e.g. a freshly created
          // `~/Library/LaunchAgents` on a clean machine).
          console.log(`  scanned ${agents.length} ${backend.label} job(s), none match`);
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
        // Checked BEFORE writing: the label is deterministic (`labelFor`, one
        // pipeline -> fixed files), so the prior existence of the first one is
        // exactly "there was already a job with this label loaded". The
        // replacement still happens the same way and without asking for
        // --force (adopting your own job is correct), but it has to be said —
        // the originating incident was precisely a drifted plist that nobody
        // noticed for ten days.
        const replacing = await Bun.file(files[0]!.path).exists();

        /**
         * Summary printed by both the real install and the dry run
         * (`--dry-run`), so that what you see before touching is literally what
         * you will see afterwards. A closure and not a loose function: it
         * captures everything already computed at this point of the command.
         */
        const timezone = await currentTimezone();
        const printInstallSummary = (headline: string, suffix: string): void => {
          console.log(headline);
          // One line per file, with its extension as the label: "plist" in
          // launchd, "service" and "timer" in systemd.
          for (const file of files) {
            console.log(`  ${extname(file.path).slice(1).padEnd(8)} ${file.path}${suffix}`);
          }
          console.log(`  times    ${intervals.length} (from ${pipeline.triggers.map((t) => t.cron).join(', ')})`);
          console.log(`  PATH     ${path}`);
          console.log(`  log      ${backend.logPath(home, name)}`);
          console.log(`  timezone ${timezone}`);

          for (const impact of unsetParamImpacts(pipeline, params)) {
            if (impact.skippedSteps.length > 0) {
              console.log(
                `  warning: param "${impact.param}" has no value — will be skipped: ${impact.skippedSteps.join(', ')}`,
              );
            }
            if (impact.uncertainSteps.length > 0) {
              console.log(
                `  warning: param "${impact.param}" has no value — steps whose "when:" depends on it: ${impact.uncertainSteps.join(', ')}`,
              );
            }
            if (impact.skippedSteps.length === 0 && impact.uncertainSteps.length === 0) {
              console.log(`  warning: param "${impact.param}" has no value — no step depends on it`);
            }
          }
        };

        // The dry run stops HERE: after having validated exactly the same as a
        // real install (cron, PATH, params, doctor, foreign jobs) and before
        // the first effect. Not the job files, not `.params.local.json` even
        // with `--set`, not the scheduler: a dry run that leaves a persistent
        // trace stops being one, and this flag exists to be able to look before
        // touching. Comparing the generated plist against the one already
        // running is what catches a drifted artifact, and as a checklist item
        // it gets skipped.
        if (opts.dryRun) {
          // In launchd the plist comes out as is, as always; in the other backends,
          // each file is preceded by its path to tell which is which.
          for (const file of files) {
            if (backend.kind !== 'launchd') console.log(`# ${file.path}`);
            console.log(file.contents);
          }
          printInstallSummary(
            replacing
              ? `(--dry-run) would replace the job that already exists: ${label}`
              : `(--dry-run) would install ${label}`,
            ' (not written)',
          );
          return;
        }

        // The directory may not exist yet (first install on a clean machine):
        // without `recursive: true` the write fails with a raw ENOENT. Done
        // BEFORE `writeLocalParams` (see below) on purpose: if this fails,
        // nothing should be left written.
        // The log's directory too: systemd does not create it, and without it
        // the service fails to open its output before running anything.
        await mkdir(dirname(backend.logPath(home, name)), { recursive: true });
        for (const file of files) {
          await mkdir(dirname(file.path), { recursive: true });
          await writeFile(file.path, file.contents, 'utf8');
        }

        // Written AFTER the job on purpose: it used to be written first, so an
        // abort in between (e.g. the `mkdir` above failing on permissions) left
        // `.params.local.json` updated with no job installed — a half state,
        // worse than having done nothing.
        await writeLocalParams(ctx.root, name, overrides);

        const { code, stderr } = await backend.activate(label, files);
        if (code !== 0) {
          console.error(
            `${backend.label} could not load the job (code ${code}); ` +
              (files.length === 1 ? 'the job file is at ' : 'the job files are at ') +
              `${files.map((file) => file.path).join(' and ')}.`,
          );
          if (stderr) console.error(`  ${backend.label}: ${stderr}`);
          process.exitCode = EXIT_FAILURE;
          return;
        }

        printInstallSummary(
          replacing
            ? `${OK} replaced the job that already existed: ${label}`
            : `${OK} installed ${label}`,
          '',
        );
      });
    });
}
