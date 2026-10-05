/**
 * Los únicos efectos sobre launchd. Fino a propósito: todo lo que decide algo
 * vive en `launchd.ts`, que es puro.
 *
 * `PIPELINES_LAUNCHCTL_BIN` es el seam de test — la suite apunta a un script
 * de mentira que registra sus argumentos, de modo que ningún test carga ni
 * descarga un job de verdad. En producción no se define y se usa `launchctl`
 * del PATH.
 */
export function launchctlBin(): string {
  return process.env.PIPELINES_LAUNCHCTL_BIN ?? 'launchctl';
}

function guiDomain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

export type LaunchctlResult = { code: number; stderr: string };

/**
 * `stderr` se captura siempre (antes se descartaba con `stderr: 'ignore'`):
 * cuando `bootstrap` falla es justo el caso en que el operador más necesita
 * el diagnóstico, y un código de salida solo no dice nada de por qué.
 */
async function run(args: string[]): Promise<LaunchctlResult> {
  const proc = Bun.spawn([launchctlBin(), ...args], { stdout: 'ignore', stderr: 'pipe' });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code, stderr: stderr.trim() };
}

/**
 * Descarga el job si estaba cargado. El código de salida se devuelve pero el
 * llamante lo ignora a propósito en `install`: "no estaba cargado" no es un
 * error cuando lo que vas a hacer justo después es cargarlo.
 */
export async function bootout(label: string): Promise<LaunchctlResult> {
  return run(['bootout', `${guiDomain()}/${label}`]);
}

export async function bootstrap(plistPath: string): Promise<LaunchctlResult> {
  return run(['bootstrap', guiDomain(), plistPath]);
}

/**
 * Captura `stdout` además de `stderr`. Hermana de `run()`, no una versión
 * configurable de ella: las dos son cuatro líneas, y un flag booleano en la
 * firma sería más difícil de leer que esta duplicación.
 */
async function runCapturing(args: string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn([launchctlBin(), ...args], { stdout: 'pipe', stderr: 'ignore' });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code, stdout };
}

/**
 * ¿Está el job cargado en el dominio del usuario? Solo interesa el código de
 * salida: 0 es "cargado", cualquier otro es "no está". La salida de `print`
 * es prolija y su formato no es contrato de nada — a propósito NO se parsea,
 * porque lo que el visor necesita saber del plist ya está en el fichero de
 * disco, que sí es estable.
 */
export async function printJob(label: string): Promise<{ code: number }> {
  const { code } = await runCapturing(['print', `${guiDomain()}/${label}`]);
  return { code };
}

/** Salida cruda de `print-disabled`; la interpreta `parseDisabledLabels` (launchd.ts, puro). */
export async function printDisabled(): Promise<{ code: number; stdout: string }> {
  return runCapturing(['print-disabled', guiDomain()]);
}
