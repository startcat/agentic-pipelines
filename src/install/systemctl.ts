/**
 * The only effects on systemd. Thin on purpose: what decides anything lives in
 * `systemd.ts` (pure) and in the backend.
 *
 * `PIPELINES_SYSTEMCTL_BIN`, `PIPELINES_LOGINCTL_BIN` and `PIPELINES_TIMEDATECTL_BIN` are the test seams:
 * the suite points them at fake scripts, so no test touches the real systemd.
 * In production they are not set.
 */
export function systemctlBin(): string {
  return process.env.PIPELINES_SYSTEMCTL_BIN ?? 'systemctl';
}

export function loginctlBin(): string {
  return process.env.PIPELINES_LOGINCTL_BIN ?? 'loginctl';
}

export function timedatectlBin(): string {
  return process.env.PIPELINES_TIMEDATECTL_BIN ?? 'timedatectl';
}

export type SystemctlResult = { code: number; stdout: string; stderr: string };

async function run(bin: string, args: string[]): Promise<SystemctlResult> {
  try {
    const proc = Bun.spawn([bin, ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } catch (err) {
    // Binary missing or not executable: never a loose exception.
    return {
      code: 127,
      stdout: '',
      stderr: `Could not run "${bin}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** `systemctl --user <args>`. Always against the user manager. */
export async function systemctlUser(args: string[]): Promise<SystemctlResult> {
  return run(systemctlBin(), ['--user', ...args]);
}

/** Time zone according to `timedatectl`; `null` if the binary fails or returns nothing. */
export async function timedatectlTimezone(): Promise<string | null> {
  const { code, stdout } = await run(timedatectlBin(), ['show', '-p', 'Timezone', '--value']);
  const tz = stdout.trim();
  return code === 0 && tz.length > 0 ? tz : null;
}

/** Does the user have "linger" enabled? `null` if `loginctl` fails. */
export async function lingerEnabled(user: string): Promise<boolean | null> {
  const { code, stdout } = await run(loginctlBin(), ['show-user', user, '-p', 'Linger', '--value']);
  if (code !== 0) return null;
  return stdout.trim() === 'yes';
}

/** If the error is the absence of the user bus, the message that explains how to fix it. */
export function userBusError(stderr: string): string | null {
  if (stderr.includes('Failed to connect to bus') || stderr.includes('$DBUS_SESSION_BUS_ADDRESS')) {
    return 'There is no systemd user session in this process (XDG_RUNTIME_DIR or the user bus is missing). Log in over ssh as the user itself, not with sudo -u.';
  }
  return null;
}
