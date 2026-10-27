/**
 * Los únicos efectos sobre systemd. Fino a propósito: lo que decide algo vive
 * en `systemd.ts` (puro) y en el backend.
 *
 * `PIPELINES_SYSTEMCTL_BIN`, `PIPELINES_LOGINCTL_BIN` y `PIPELINES_TIMEDATECTL_BIN` son los seams de test:
 * la suite apunta a scripts de mentira, de modo que ningún test toca el
 * systemd real. En producción no se definen.
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
    // Binario ausente o no ejecutable: nunca una excepción suelta.
    return {
      code: 127,
      stdout: '',
      stderr: `No se pudo ejecutar "${bin}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** `systemctl --user <args>`. Siempre contra el gestor del usuario. */
export async function systemctlUser(args: string[]): Promise<SystemctlResult> {
  return run(systemctlBin(), ['--user', ...args]);
}

/** Zona horaria según `timedatectl`; `null` si el binario falla o no devuelve nada. */
export async function timedatectlTimezone(): Promise<string | null> {
  const { code, stdout } = await run(timedatectlBin(), ['show', '-p', 'Timezone', '--value']);
  const tz = stdout.trim();
  return code === 0 && tz.length > 0 ? tz : null;
}

/** ¿Tiene el usuario "linger" activo? `null` si `loginctl` falla. */
export async function lingerEnabled(user: string): Promise<boolean | null> {
  const { code, stdout } = await run(loginctlBin(), ['show-user', user, '-p', 'Linger', '--value']);
  if (code !== 0) return null;
  return stdout.trim() === 'yes';
}

/** Si el error es la ausencia del bus de usuario, el mensaje que explica cómo arreglarlo. */
export function userBusError(stderr: string): string | null {
  if (stderr.includes('Failed to connect to bus') || stderr.includes('$DBUS_SESSION_BUS_ADDRESS')) {
    return 'No hay sesión de systemd de usuario en este proceso (falta XDG_RUNTIME_DIR o el bus de usuario). Entra por ssh como el propio usuario, no con sudo -u.';
  }
  return null;
}
