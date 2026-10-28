/**
 * launchd behind `SchedulerBackend`: joins the pure module (`launchd.ts`) with
 * the effects (`launchctl.ts`) and the `~/Library` paths. It is what
 * `install`, `uninstall` and the dashboard used to do on their own, gathered
 * in one place and without changing a byte of the plist (the golden test pins
 * it).
 */
import { homedir } from 'node:os';
import { readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { SchedulerBackend } from './backend.ts';
import { bootout, bootstrap, printDisabled, printJob } from './launchctl.ts';
import { buildPlistSpec, logPathFor, parseDisabledLabels, renderPlist } from './launchd.ts';

function launchAgentsDir(home: string): string {
  return join(home, 'Library', 'LaunchAgents');
}

function plistPathFor(home: string, label: string): string {
  return join(launchAgentsDir(home), `${label}.plist`);
}

async function readIfExists(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  return (await file.exists()) ? file.text() : undefined;
}

/**
 * The user's LaunchAgents plists, with their raw contents, for the collision
 * scan. A missing directory is not an error: it means no user job is
 * installed.
 */
async function readLaunchAgents(): Promise<{ label: string; contents: string }[]> {
  const dir = launchAgentsDir(homedir());
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const agents: { label: string; contents: string }[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.plist')) continue;
    try {
      const contents = await readFile(join(dir, entry), 'utf8');
      agents.push({ label: entry.slice(0, -'.plist'.length), contents });
    } catch {
      // An unreadable plist (permissions) must not bring the installation
      // down: it only means this safety net doesn't cover it.
    }
  }
  return agents;
}

export const launchdBackend: SchedulerBackend = {
  kind: 'launchd',
  label: 'launchd',

  jobFiles(input) {
    const spec = buildPlistSpec(input);
    return [{ path: plistPathFor(input.home, spec.label), contents: renderPlist(spec) }];
  },

  jobPaths: (label, home) => [plistPathFor(home, label)],

  logPath: logPathFor,

  readUserJobs: readLaunchAgents,

  async disabledLabels(labels) {
    const disabled = new Set(parseDisabledLabels((await printDisabled()).stdout));
    return labels.filter((label) => disabled.has(label));
  },

  async preInstallChecks() {
    return [];
  },

  // The prior bootout may legitimately fail ("it wasn't loaded"): its code
  // is ignored on purpose. Same label = replacement, not a duplicate.
  async activate(label, files) {
    await bootout(label);
    return bootstrap(files[0]!.path);
  },

  // Never `launchctl disable`: it leaves a persistent override in the user's
  // domain that would bite on a reinstall months later. `bootout` is already
  // idempotent, so it is called even if the plist doesn't exist: the job may
  // still be loaded even if someone deleted it by hand.
  async deactivate(label) {
    await bootout(label);
    await unlink(plistPathFor(homedir(), label)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
    return {};
  },

  async facts(label, home) {
    const [job, disabled] = await Promise.all([printJob(label), printDisabled()]);
    return {
      loaded: job.code === 0,
      disabled: parseDisabledLabels(disabled.stdout).includes(label),
      artifactOnDisk: await readIfExists(plistPathFor(home, label)),
    };
  },

  retireHint() {
    return 'Remove them with "launchctl bootout" AND "launchctl disable" — without the disable they come back at the next boot.';
  },
};
