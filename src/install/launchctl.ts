/**
 * The only effects on launchd. Thin on purpose: everything that decides
 * anything lives in `launchd.ts`, which is pure.
 *
 * `PIPELINES_LAUNCHCTL_BIN` is the test seam — the suite points it at a fake
 * script that records its arguments, so no test loads or unloads a real job.
 * In production it is not set and `launchctl` from the PATH is used.
 */
export function launchctlBin(): string {
  return process.env.PIPELINES_LAUNCHCTL_BIN ?? 'launchctl';
}

function guiDomain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

export type LaunchctlResult = { code: number; stderr: string };

/**
 * `stderr` is always captured (it used to be discarded with `stderr: 'ignore'`):
 * when `bootstrap` fails is exactly when the operator most needs the
 * diagnosis, and an exit code alone says nothing about why.
 */
async function run(args: string[]): Promise<LaunchctlResult> {
  const proc = Bun.spawn([launchctlBin(), ...args], { stdout: 'ignore', stderr: 'pipe' });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code, stderr: stderr.trim() };
}

/**
 * Unloads the job if it was loaded. The exit code is returned but the caller
 * deliberately ignores it in `install`: "it wasn't loaded" is not an error
 * when what you are about to do right after is load it.
 */
export async function bootout(label: string): Promise<LaunchctlResult> {
  return run(['bootout', `${guiDomain()}/${label}`]);
}

export async function bootstrap(plistPath: string): Promise<LaunchctlResult> {
  return run(['bootstrap', guiDomain(), plistPath]);
}

/**
 * Captures `stdout` as well as `stderr`. A sibling of `run()`, not a
 * configurable version of it: both are four lines, and a boolean flag in the
 * signature would be harder to read than this duplication.
 */
async function runCapturing(args: string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn([launchctlBin(), ...args], { stdout: 'pipe', stderr: 'ignore' });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code, stdout };
}

/**
 * Is the job loaded in the user's domain? Only the exit code matters: 0 is
 * "loaded", anything else is "not there". The output of `print` is verbose and
 * its format is not a contract of anything — it is deliberately NOT parsed,
 * because what the dashboard needs to know about the plist is already in the file
 * on disk, which is stable.
 */
export async function printJob(label: string): Promise<{ code: number }> {
  const { code } = await runCapturing(['print', `${guiDomain()}/${label}`]);
  return { code };
}

/** Raw output of `print-disabled`; `parseDisabledLabels` (launchd.ts, pure) interprets it. */
export async function printDisabled(): Promise<{ code: number; stdout: string }> {
  return runCapturing(['print-disabled', guiDomain()]);
}
