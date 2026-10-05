/**
 * Traducción a lenguaje humano de lo que el motor guarda en crudo. Módulo PURO
 * a propósito, igual que `health/evaluate.ts`: sin E/S y sin reloj propio — el
 * instante entra como parámetro. Así la tabla de casos se ejecuta entera sin
 * levantar un servidor ni depender de la hora de la máquina.
 *
 * Nada de aquí decide NADA sobre salud: solo cambia de vocabulario.
 */
import { cronToCalendarIntervals } from '../install/launchd.ts';

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

const dosDigitos = (n: number): string => String(n).padStart(2, '0');

/**
 * Días naturales entre dos instantes, en hora LOCAL. No `(a - b) / 86400000`:
 * esa cuenta llama "hoy" a algo de hace 23 h que ya es de ayer, y "ayer" a algo
 * de hace 25 h que es de anteayer. Quien mira el panel piensa en noches, no en
 * múltiplos de veinticuatro horas.
 */
function diasNaturales(desde: Date, hasta: Date): number {
  const a = new Date(desde.getFullYear(), desde.getMonth(), desde.getDate());
  const b = new Date(hasta.getFullYear(), hasta.getMonth(), hasta.getDate());
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

export function cuando(iso: string | undefined, now: Date): { day: string; time: string } {
  if (iso === undefined) return { day: '—', time: '' };
  const d = new Date(iso);
  // `run.json` se lee con un `as` y sin validar (RunStore.readRun), así que una
  // fecha corrupta llega hasta aquí. `Invalid Date` formatea como "NaN:NaN".
  if (Number.isNaN(d.getTime())) return { day: '—', time: '' };

  const time = `${dosDigitos(d.getHours())}:${dosDigitos(d.getMinutes())}`;
  const dias = diasNaturales(d, now);
  if (dias === 0) return { day: 'hoy', time };
  if (dias === 1) return { day: 'ayer', time };
  if (dias < 7) return { day: DIAS[d.getDay()]!, time };
  return { day: `${d.getDate()} ${MESES[d.getMonth()]}`, time };
}

export function duracion(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

export function dinero(usd: number | undefined): string {
  if (usd === undefined || usd === 0) return '';
  return `$${usd.toFixed(2)}`;
}

/**
 * La cadencia en palabras. Se apoya en `cronToCalendarIntervals` en vez de
 * volver a interpretar cron: en este proyecto cron lo lee UN solo sitio, y
 * duplicar ese parser aquí es exactamente cómo se acaba con dos verdades sobre
 * cuándo dispara un pipeline.
 *
 * Solo traduce las formas que se leen de un vistazo. Cualquier otra —varios
 * triggers, un día del mes, un cron que el traductor no soporta— se devuelve
 * CRUDA: una frase inventada sobre cuándo corre algo es peor que la cadena
 * original, porque la cadena original al menos es verdad.
 */
export function describeCron(crons: readonly string[]): string {
  if (crons.length === 0) return 'ninguna, es manual';
  if (crons.length > 1) return crons.join(' · ');

  const cron = crons[0]!;
  let intervals;
  try {
    intervals = cronToCalendarIntervals(cron);
  } catch {
    return cron;
  }
  if (intervals.length !== 1) return cron;

  const { Minute, Hour, Day, Month, Weekday } = intervals[0]!;
  if (Minute === undefined || Hour === undefined) return cron;
  if (Day !== undefined || Month !== undefined) return cron;

  const hora = `${Hour}:${dosDigitos(Minute)}`;
  if (Weekday !== undefined) return `cada ${DIAS[Weekday % 7]!} a las ${hora}`;
  // Antes de las seis no es "cada día": es de madrugada, y quien abre el panel
  // por la mañana piensa en esa pasada como "la de anoche".
  return Hour < 6 ? `cada noche a las ${hora}` : `cada día a las ${hora}`;
}
