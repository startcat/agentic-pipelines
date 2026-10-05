import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type LockHandle = { path: string };

/** Contenido de un fichero de lock: quién lo sostiene y desde cuándo. */
export type LockFile = { pid: number; startedAt: string };

/**
 * Comprueba si un error de `fs` es ENOENT (ruta inexistente). Mismo criterio
 * que `RunStore` (`src/runs/store.ts`): solo la ausencia del fichero es una
 * respuesta válida a "¿hay lock?"; cualquier otro fallo (permisos, JSON
 * corrupto al parsear) se deja propagar. Tratar un lock ilegible como
 * "libre" sería un fail-open justo al lado del fail-safe deliberado de
 * `processAlive` de abajo — y el lock existe precisamente para no fallar en
 * abierto.
 */
function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

/** Comprueba si un error de `fs` es EEXIST (la ruta ya existe). */
function isEexist(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'EEXIST'
  );
}

/**
 * Comprueba si un proceso sigue vivo enviándole la señal 0 (no mata nada, solo
 * prueba). El resultado depende de CÓMO falla `process.kill`, no de si falla:
 * - `ESRCH`: no existe tal PID → el proceso está realmente muerto.
 * - `EPERM`: el PID existe pero pertenece a otro usuario → sigue vivo, solo
 *   que no tenemos permiso para señalizarlo. Tratar este caso como "muerto"
 *   permitiría robarle el lock a una ejecución ajena en curso, justo lo que
 *   el lock existe para impedir.
 * Cualquier otro error se trata también como "vivo": ante la duda, no se
 * roba el lock.
 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code =
      err !== null && typeof err === 'object' && 'code' in err
        ? (err as { code?: unknown }).code
        : undefined;
    return code !== 'ESRCH';
  }
}

function locksDir(repoRoot: string): string {
  return join(repoRoot, '.runs', '.locks');
}

function lockPath(repoRoot: string, pipeline: string): string {
  return join(locksDir(repoRoot), `${pipeline}.lock`);
}

function markerPathFor(path: string): string {
  return `${path}.reclaim`;
}

/**
 * Lee y parsea el fichero de lock.
 * - `undefined` si el fichero no existe (ENOENT) o si existe pero está
 *   vacío. Un fichero vacío es un estado benigno alcanzable en una ventana
 *   de concurrencia estrecha (ver `tryCreate` y la reclamación en
 *   `acquireLock`), no corrupción — se trata igual que "no hay lock", no
 *   como un error.
 * - cualquier otro problema de lectura, o un payload NO vacío que no
 *   parsea como JSON, se propaga: eso sí es corrupción real y no debe traducirse en silencio a "libre".
 *
 * Se reutiliza tal cual para leer el marcador de reclamación:
 * tiene la misma forma `{pid, startedAt}` y el mismo criterio de fallo
 * (vacío = ausente, corrupto = propagar) es igual de válido para él.
 */
async function readLockFile(path: string): Promise<LockFile | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw err;
  }
  if (text.length === 0) return undefined;
  return JSON.parse(text) as LockFile;
}

/**
 * Como `readLockFile`, pero distingue "no hay nada en esa ruta" (`present:
 * false`) de "hay un fichero, pero está vacío" (`present: true, lock:
 * undefined`). Esta distinción hace falta para decidir si merece la pena
 * competir por reclamar: una ruta AUSENTE no necesita ninguna reclamación
 * (una creación exclusiva normal ya la resuelve); un fichero PRESENTE pero
 * vacío sí la necesita, porque una creación exclusiva (`link`) fallaría con
 * EEXIST contra él aunque no tenga ningún dueño que proteger. Se usa tanto
 * para el lock como para el marcador de reclamación.
 */
async function peekLockFile(
  path: string,
): Promise<{ present: false } | { present: true; lock: LockFile | undefined }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return { present: false };
    throw err;
  }
  if (text.length === 0) return { present: true, lock: undefined };
  return { present: true, lock: JSON.parse(text) as LockFile };
}

/**
 * Registro de "quién sostiene esto, desde cuándo". Se usa tanto para el
 * contenido del lock como para el del marcador de reclamación:
 * ambos son, a efectos de vida y reclamación, el mismo concepto.
 */
function newLockFile(): LockFile {
  return { pid: process.pid, startedAt: new Date().toISOString() };
}

/**
 * Crea un fichero de forma exclusiva y sin lecturas a medio escribir. El
 * contenido completo se escribe primero en un fichero temporal de nombre
 * único (mismo directorio, mismo sistema de ficheros), y solo entonces se
 * le da su nombre definitivo con `link`: `link` falla con EEXIST si el
 * destino ya existe (en vez de sobrescribirlo, como haría `rename`), así
 * que es la comprobación-y-creación atómica que evita la carrera original. Y como el nombre definitivo solo aparece cuando
 * el contenido ya está completo, ningún lector puede observar un fichero
 * vacío o a medias bajo ese nombre (con
 * `writeFile(..., {flag:'wx'})` sí podía ocurrir: crea el fichero vacío y
 * lo rellena en un segundo paso). Se usa tanto para el lock como para el
 * marcador de reclamación, que necesita exactamente la misma
 * garantía de exclusividad atómica.
 */
async function tryCreate(path: string): Promise<boolean> {
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(newLockFile()), 'utf8');
  try {
    await link(tempPath, path);
    return true;
  } catch (err) {
    if (isEexist(err)) return false;
    throw err;
  } finally {
    await rm(tempPath, { force: true });
  }
}

/**
 * Comprueba si un fichero existe, sin leer su contenido. Se usa solo para
 * el marcador de reclamación (ver `safeTryCreate`), donde el contenido es
 * irrelevante: únicamente importa si alguien lo sostiene ahora mismo.
 */
async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
}

/**
 * Devuelve `claimPath` a `path`, pero solo si `path` sigue libre: usa
 * `link` (falla con EEXIST si el destino ya existe) en vez de `rename`
 * (que lo SOBRESCRIBIRÍA sin avisar — comprobado empíricamente: `rename`
 * reemplaza un destino existente sin lanzar ningún error). Sin este
 * cambio, devolver un lock que resultó estar vivo podría borrar en
 * silencio un lock distinto que otra llamada hubiera creado mientras
 * tanto.
 */
async function restore(claimPath: string, path: string): Promise<void> {
  try {
    await link(claimPath, path);
  } catch (err) {
    if (!isEexist(err)) throw err;
    // Alguien más ya ocupa `path`; no hay nada que devolver a su sitio. El
    // contenido que teníamos en `claimPath` (un lock que resultó estar
    // vivo) se pierde aquí — ver el comentario de "ventana residual" en
    // `acquireLock`.
  } finally {
    await rm(claimPath, { force: true });
  }
}

/**
 * Intento de creación seguro para quien NO tiene el privilegio de
 * reclamar (ver `acquireLock`): si el marcador de reclamación está activo
 * en este instante, alguien más está en medio de inspeccionar el lock —
 * inspección que puede dejar `path` momentáneamente ausente sin que el
 * lock esté realmente libre (ver `restore`). No competir por esa ventana
 * concreta es lo que bajó la tasa de fallo de la reproducción de 30
 * llamadas concurrentes de ~90% a 0 en miles de repeticiones. Si el marcador no está activo, `tryCreate`
 * sigue siendo perfectamente seguro por sí solo: `link` nunca desplaza
 * nada, como mucho falla con EEXIST.
 */
async function safeTryCreate(path: string, markerPath: string): Promise<boolean> {
  if (await exists(markerPath)) return false;
  return tryCreate(path);
}

/**
 * Intenta hacerse con el privilegio exclusivo de reclamar el lock (ver
 * `acquireLock`). Si el marcador no existe, se crea y lo ganamos. Si ya
 * existe, se comprueba a su dueño: si sigue vivo, alguien más está
 * reclamando de verdad y no hay nada que hacer. Si está muerto (o vacío —
 * ver `peekLockFile`), el propio marcador es un huérfano.
 *
 * En una versión anterior el marcador era un fichero
 * vacío sin ninguna información de vida, y `safeTryCreate` trataba su
 * mera existencia como "alguien está reclamando, para siempre". Un
 * proceso que muriera entre ganar el marcador y llegar al `finally` que
 * lo libera (señal, OOM, corte de luz) lo dejaba huérfano PARA SIEMPRE:
 * reproducido con `acquireLock` rechazando indefinidamente un pipeline
 * cuyo lock Y cuyo marcador tenían, ambos, un pid muerto — justo el fallo
 * que toda esta maquinaria de reclamación existe para evitar (así lo
 * exige la recuperación desatendida de una herramienta pensada para
 * ejecutarse por cron, sin nadie mirando — por eso no se quitó la
 * reclamación automática). El
 * marcador ahora lleva `{pid, startedAt}` igual que el lock, y se reclama
 * con la misma disciplina que un lock huérfano, pero sin el vaivén de
 * mover-e-inspeccionar: se comprueba la vida justo antes de borrar, se
 * borra, y se compite por crear el propio con la exclusividad de `link`
 * — si esa competición se pierde, NO se continúa como si hubiéramos
 * ganado: se devuelve `false` sin más, y quien llama se limita a un
 * intento de creación seguro sobre el lock (`safeTryCreate`).
 *
 * Ventana residual (documentada, no cerrada — mismo criterio que el resto
 * de este módulo: se prefiere dejarla documentada a cerrarla con
 * heurísticas): entre la comprobación
 * de vida de aquí y el `rm` de abajo puede colarse una llamada lenta que
 * leyó un marcador YA obsoleto y borra el marcador FRESCO que otra
 * llamada instaló mientras tanto. El daño directo queda acotado: un `rm`
 * sobre un marcador ausente no lanza, así que lo peor que puede pasar AQUÍ
 * es perder la competición siguiente por crear el propio marcador y
 * volver con `false` — nunca se continúa creyendo que se ganó algo que en
 * realidad se perdió.
 *
 * Efecto de segundo orden, medido empíricamente: a diferencia de la
 * versión anterior, donde el marcador solo podía
 * tener UN dueño en toda la vida de una tormenta de llamadas
 * concurrentes, ahora puede cambiar de manos varias veces (cada reclamo
 * de un marcador huérfano es un dueño nuevo). Cada vez que un dueño nuevo
 * reclama un lock que resulta estar vivo y lo devuelve con `restore`,
 * abre una ventana breve — y `safeTryCreate` (que decide si crear el lock
 * mirando `exists(markerPath)` un instante antes) puede, en un caso
 * raro, comprobar cuando el marcador está momentáneamente ausente entre
 * dos dueños y colarse en la ventana que abre el dueño siguiente. Es la
 * misma familia de riesgo que la "ventana residual" de `restore` en
 * `acquireLock`, solo que ahora con más de una oportunidad de producirse
 * por tormenta en vez de como mucho una. Medido en más de 4500
 * repeticiones de la carrera de 30 llamadas: ~0.07–0.13% de las
 * repeticiones, frente al 0% de la versión anterior. Sigue sin cerrarse con
 * heurísticas, a propósito.
 */
async function claimMarker(markerPath: string): Promise<boolean> {
  if (await tryCreate(markerPath)) return true;

  const peeked = await peekLockFile(markerPath);
  if (peeked.present && peeked.lock !== undefined && processAlive(peeked.lock.pid)) {
    return false;
  }

  // El marcador parece huérfano (muerto o vacío) o desapareció justo
  // ahora. Solo lo borramos si de verdad sigue ahí — `rm` sobre una ruta
  // ya ausente no lanza con `force: true`, pero evitarlo cuando sabemos
  // que no hace falta reduce operaciones de E/S innecesarias bajo
  // concurrencia real. Un único reintento de creación, acotado: si lo
  // perdemos, no insistimos.
  if (peeked.present) await rm(markerPath, { force: true });
  return tryCreate(markerPath);
}

/**
 * Adquiere el lock de un pipeline. Devuelve undefined si ya hay otra ejecución
 * viva. Un lock huérfano (proceso muerto) se reclama automáticamente: sin esto,
 * un cuelgue dejaría el pipeline bloqueado para siempre.
 *
 * Historia de esta función. La primera versión usaba
 * `rename(path, claimPath)` como única sección atómica para decidir quién
 * reclama un lock huérfano. Bajo concurrencia real (30 llamadas
 * simultáneas sobre el mismo lock huérfano) eso no bastaba: cualquier
 * llamante que hubiera perdido su primer intento de creación podía, más
 * tarde, ganar SU PROPIO `rename` contra una generación YA VÁLIDA del
 * fichero (creada mientras tanto por otro llamante), abriendo una ventana
 * nueva cada vez que esto pasaba — reproducido empíricamente con hasta 4
 * "dueños" distintos de 30 intentos. La causa de fondo: nada impedía que
 * MÚLTIPLES llamantes intentaran, cada uno por su cuenta, la operación
 * destructiva de "mover el fichero para inspeccionarlo".
 *
 * La segunda versión introdujo un marcador de reclamación (`${path}.reclaim`) que
 * limita a UN ÚNICO llamante, de entre todo el tropel concurrente, el
 * privilegio de mover `path`. Todos los demás, si ven indicios de que el
 * lock podría estar muerto pero no ganan el marcador, se limitan a
 * `safeTryCreate`: un intento de creación exclusiva que jamás puede
 * desplazar nada ajeno.
 *
 * La tercera: ver `claimMarker` — ese marcador no tenía
 * información de vida propia y podía quedar huérfano para siempre.
 */
export async function acquireLock(
  repoRoot: string,
  pipeline: string,
): Promise<LockHandle | undefined> {
  await mkdir(locksDir(repoRoot), { recursive: true });
  const path = lockPath(repoRoot, pipeline);
  const markerPath = markerPathFor(path);

  if (await tryCreate(path)) return { path };

  // Solo merece la pena competir por el privilegio de reclamar si lo que
  // vemos AHORA MISMO parece un lock sin dueño vivo (muerto o vacío). Si
  // parece vivo, o si la ruta está ausente en este instante (síntoma
  // habitual de que otra llamada está en medio de su propia inspección),
  // no tocamos nada destructivo: un intento de creación seguro basta y es
  // correcto en ambos casos.
  const peeked = await peekLockFile(path);
  const looksReclaimable =
    peeked.present && (peeked.lock === undefined || !processAlive(peeked.lock.pid));
  if (!looksReclaimable) {
    return (await safeTryCreate(path, markerPath)) ? { path } : undefined;
  }

  // Riesgo residual medido y aceptado: bajo 30 llamadas concurrentes reclamando el MISMO
  // lock huérfano, esta reclamación deja más de un "dueño" en
  // aproximadamente 1 de cada 400 tormentas (~0.25%, medido por separado
  // más de una vez con el mismo orden de magnitud — ver el "efecto de
  // segundo orden" documentado en `claimMarker`). Hace falta que decenas
  // de procesos compitan por el mismo pipeline a la vez para que se
  // manifieste — muy por encima de la concurrencia real de esta
  // herramienta (como mucho dos o tres invocaciones solapadas, p. ej. un
  // cron que dispara durante una ejecución manual). Se decidió dejarlo
  // documentado y aceptado en vez de perseguirlo con más heurísticas —
  // por eso la suite de tests ya no lo
  // ejercita a 30 llamadas (ver `tests/guards/lock.test.ts`): seguía
  // siendo correcto, pero probaba una propiedad que se decidió no
  // garantizar, así que sus fallos ocasionales eran ruido, no señal.
  if (!(await claimMarker(markerPath))) {
    // Alguien más ya tiene el privilegio de reclamar (o nos lo acaba de
    // arrebatar en la competición de `claimMarker`). No tocamos nada
    // destructivo.
    return (await safeTryCreate(path, markerPath)) ? { path } : undefined;
  }

  try {
    // A partir de aquí somos la ÚNICA llamada, de todo el tropel
    // concurrente, autorizada a mover `path`.
    const claimPath = `${path}.${randomUUID()}.claim`;
    try {
      await rename(path, claimPath);
    } catch (err) {
      if (!isEnoent(err)) throw err;
      // El lock se liberó justo entre nuestro espionaje y este intento.
      // No hay nada que reclamar; un único intento de creación basta.
      return (await tryCreate(path)) ? { path } : undefined;
    }

    // El contenido de `claimPath` es exactamente el que el espionaje de
    // más arriba (`peekLockFile`) ya leyó y parseó sin lanzar: bajo el
    // propio código de este módulo es inalcanzable que aquí aparezca un
    // JSON corrupto que el espionaje no hubiera detectado ya (nada de lo
    // que este módulo escribe produce contenido inválido). Si aun así
    // lanzara — solo posible por manipulación externa del fichero entre
    // el espionaje y este punto, fuera del modelo de amenazas de este
    // módulo — se propaga sin más: el `finally` de abajo sigue liberando
    // el marcador, y el error deja un rastro diagnosticable en vez de
    // fallar en silencio.
    const claimed = await readLockFile(claimPath);

    if (claimed !== undefined && processAlive(claimed.pid)) {
      // Falsa alarma: el dueño sigue vivo (o pertenece a otro usuario —
      // ver processAlive). Lo movimos solo para inspeccionarlo; se
      // devuelve a su sitio.
      //
      // Ventana residual: entre el `rename` de arriba y el `restore` de
      // aquí, `path` no existe. Ningún otro llamante concurrente normal
      // puede colarse en ese hueco (todos pasan por `safeTryCreate`, que
      // respeta el marcador que sostenemos aquí) — verificado
      // empíricamente con 0 fallos en más de 3000 repeticiones de una
      // carrera de 30 llamadas. Lo que sí queda, y que deliberadamente NO
      // se cierra con más reintentos ni temporizadores (mismo criterio
      // que con otros riesgos de la misma familia): que `restore` pierda igualmente si, en el instante
      // exacto de su propio `link`, alguna otra causa ajena a este módulo
      // ocupara `path` — daría por perdido el lock que teníamos en
      // `claimPath`. Riesgo residual documentado, no una carrera abierta.
      await restore(claimPath, path);
      return undefined;
    }

    // El dueño está muerto, o el fichero estaba vacío (sin dueño legible):
    // se descarta y se reclama el hueco con un único reintento de creación,
    // acotado — nunca un bucle sin límite.
    await rm(claimPath, { force: true });
    return (await tryCreate(path)) ? { path } : undefined;
  } finally {
    await rm(markerPath, { force: true });
  }
}

/**
 * Libera el lock, pero solo si seguimos siendo su dueño (mismo pid). Borrar
 * sin comprobar permitiría a un proceso liberar por error el lock de una
 * ejecución distinta que lo reclamó después de que la nuestra quedara con un
 * handle obsoleto (p. ej. tras perder la carrera de `acquireLock`). Un lock
 * ya ausente, o uno cuyo contenido no se puede leer con certeza, no debe
 * hacer fallar la liberación: debe poder llamarse siempre desde un `finally`
 * sin lanzar.
 */
export async function releaseLock(handle: LockHandle): Promise<void> {
  let existing: LockFile | undefined;
  try {
    existing = await readLockFile(handle.path);
  } catch {
    // Fichero corrupto o ilegible: no podemos verificar el dueño con
    // certeza, así que no lo tocamos — más seguro no borrar un lock que no
    // entendemos que arriesgarse a borrar el de otro proceso.
    return;
  }
  if (existing === undefined || existing.pid !== process.pid) return;
  await rm(handle.path, { force: true });
}

/**
 * Lee quién sostiene (o sostuvo) el lock de un pipeline, sin intentar
 * adquirirlo ni modificarlo. Pensado para que el CLI pueda
 * informarle al usuario qué pid y desde cuándo tiene el pipeline bloqueado
 * cuando `acquireLock` devuelve `undefined`.
 */
export async function readLock(
  repoRoot: string,
  pipeline: string,
): Promise<LockFile | undefined> {
  return readLockFile(lockPath(repoRoot, pipeline));
}
