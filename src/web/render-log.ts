/**
 * A step's page: where it sits in its run, how it ended, and its log line by
 * line. Pure like `render.ts`: the server reads the log
 * and the YAML, this only draws them.
 */
import type { RunRecord } from '../runs/types.ts';
import { formatBytes, formatDuration } from './format.ts';
import { escapeHtml, GLYPH, lineTone, lookup, renderCrumb, renderKindChip, statusClass } from './render.ts';

/**
 * Cap of a log's HTML view, in characters. Above it the page draws only the
 * tail; the whole of it is always one click away as plain text (`?raw=1`).
 */
export const MAX_LOG_CHARS = 200_000;

export type StepLogInput = {
  pipeline: string;
  run: RunRecord;
  stepId: string;
  /** `shell` or `agent`, from the current YAML; absent when it can't be read. */
  type?: string;
  /** The run's steps in the order they are declared (see the server's route). */
  order: string[];
  /** The WHOLE log, as the step wrote it; empty when it left none. */
  text: string;
  /** Whether it is over `MAX_LOG_CHARS`, so the page shows only its tail. */
  truncated: boolean;
};

/**
 * The lines of a log. A final newline closes the last line, it doesn't open
 * an empty one ("a\n" is one line, as `wc -l` and an editor count it); a last
 * line without it is still a line. A trailing `\r` is dropped: a CRLF log
 * would otherwise carry an invisible character on every line.
 */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((line) => line.replace(/\r$/, ''));
}

/** The newlines in `text` up to `end`, counted without splitting it: a big agent log is not copied line by line just to be counted. */
function newlines(text: string, end = text.length): number {
  let count = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < end; i = text.indexOf('\n', i + 1)) count++;
  return count;
}

/** What `splitLines(text).length` would be, without building the array. */
const lineCount = (text: string): number => (text === '' ? 0 : newlines(text) + (text.endsWith('\n') ? 0 : 1));

const plural = (n: number, word: string): string => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

/**
 * What the step's record says, read defensively: `run.json` is parsed with an
 * `as` and no validation, so a step can be anything — this page keeps its
 * title and its log even when the record has nothing usable.
 */
function stepState(record: unknown): { line: string; why: string } | undefined {
  if (typeof record !== 'object' || record === null) return undefined;
  const { status, durationMs, error, skipReason } = record as Record<string, unknown>;
  if (typeof status !== 'string') return undefined;
  const glyph = lookup(GLYPH, status) ?? '';
  // A skipped step never ran, so it has no duration worth saying.
  const took = status !== 'skipped' && typeof durationMs === 'number' && Number.isFinite(durationMs)
    ? ` · ${formatDuration(durationMs)}`
    : '';
  const why = status === 'failed' ? error : status === 'skipped' ? skipReason : undefined;
  return {
    line: `<div class="bigline ${statusClass(status)}">${escapeHtml(`${glyph ? `${glyph} ` : ''}${status}${took}`)}</div>`,
    why: typeof why === 'string' && why !== '' ? `<div class="bigwhy">${escapeHtml(why)}</div>` : '',
  };
}

/**
 * "← previous · next →" between the steps of the run. The end that has no
 * step is said and not linked ("previous: none"), in the line colour, so the
 * row keeps its shape on the first and the last step.
 */
function renderStepNav(order: string[], index: number, stepHref: (id: string) => string): string {
  const prev = index > 0 ? order[index - 1] : undefined;
  const next = index >= 0 && index < order.length - 1 ? order[index + 1] : undefined;
  const before = prev !== undefined
    ? `<a href="${escapeHtml(stepHref(prev))}"><span class="arr">←</span> <span class="lbl">previous:</span> <span class="nstep">${escapeHtml(prev)}</span></a>`
    : '<span class="none"><span class="arr">←</span> previous: none</span>';
  const after = next !== undefined
    ? `<a href="${escapeHtml(stepHref(next))}"><span class="lbl">next:</span> <span class="nstep">${escapeHtml(next)}</span> <span class="arr">→</span></a>`
    : '<span class="none">next: none <span class="arr">→</span></span>';
  return `<nav class="stepnav" aria-label="Steps of this run">${before}${after}</nav>`;
}

/**
 * The log, one `<span>` per line inside `#log`. The numbers are not in the
 * markup: a CSS counter draws them (styles.ts, `.log`), so a selection copies
 * the log and not the gutter, and the lines the live client appends later
 * are numbered without it knowing where it is.
 *
 * Truncated, the tail starts at a line boundary and the counter starts at
 * that line's real number, so "line 1,234" here is line 1,234 of the raw log.
 * Nothing goes between the spans: inside a `<pre>` any newline there would
 * be drawn as a blank line.
 */
function renderLogBody(text: string, truncated: boolean, open: boolean): string {
  let shown = text;
  let skipped = 0;
  if (truncated && text.length > MAX_LOG_CHARS) {
    const cut = text.length - MAX_LOG_CHARS;
    // Start after the first newline at or past the cut: a half line would be
    // numbered as if it were whole. (A tail with no newline at all is one
    // huge line, drawn from the cut.)
    const boundary = text.indexOf('\n', cut - 1);
    const start = boundary === -1 || boundary === text.length - 1 ? cut : boundary + 1;
    // The newlines before the start: the lines wholly left out, so the first
    // line shown is numbered as itself even when it is a cut-off piece.
    skipped = newlines(text, start);
    shown = text.slice(start);
  }
  const shownLines = splitLines(shown);
  const lines = shownLines
    .map((line) => {
      const tone = lineTone(line);
      return `<span${tone ? ` class="${tone}"` : ''}>${escapeHtml(line)}</span>`;
    })
    .join('');
  // Wide enough for the last number the log will show; at least three
  // digits, so a short log doesn't hug the edge.
  const digits = Math.max(3, String(skipped + shownLines.length).length);
  return `<pre id="log" class="log" style="counter-reset: ln ${skipped}; --lnw: ${digits}ch" data-open="${open ? '1' : '0'}">${lines}</pre>`;
}

export function renderStepLogPage(input: StepLogInput): string {
  const { pipeline, run, stepId, type, order, text, truncated } = input;
  const runHref = `/p/${encodeURIComponent(pipeline)}/runs/${encodeURIComponent(run.id)}`;
  const stepHref = (id: string): string => `${runHref}/${encodeURIComponent(id)}`;
  const index = order.indexOf(stepId);
  const steps: unknown = run.steps;
  const record = typeof steps === 'object' && steps !== null && Object.hasOwn(steps, stepId)
    ? (steps as Record<string, unknown>)[stepId]
    : undefined;
  const state = stepState(record);

  const totalLines = lineCount(text);
  const bytes = Buffer.byteLength(text, 'utf8');
  const open = text !== '' && !text.endsWith('\n');
  const none = run.status === 'running' ? 'Nothing written yet.' : 'This step left no log.';

  return `${renderCrumb([
    { label: 'Overview', href: '/' },
    { label: pipeline, href: `/p/${encodeURIComponent(pipeline)}` },
    { label: run.id, href: runHref },
    { label: stepId },
  ])}
    <div class="titleline"><h1>${escapeHtml(stepId)}</h1>${type ? renderKindChip(type) : ''}${
      index >= 0 ? `<span class="tkind">step ${index + 1} of ${order.length}</span>` : ''
    }</div>
    ${state ? `${state.line}${state.why}` : ''}
    ${renderStepNav(order, index, stepHref)}
    <h2 class="logh">Log<small>stdout and stderr, as the step wrote them · <span id="logcount" data-lines="${totalLines}" data-bytes="${bytes}">${escapeHtml(
      `${plural(totalLines, 'line')} · ${formatBytes(bytes)}`,
    )}</span></small><a class="rawlink" href="${escapeHtml(`${stepHref(stepId)}?raw=1`)}">Full log as plain text ↗</a></h2>
    ${truncated ? '<p class="logtail">Showing the tail. The lines before it are in the full log.</p>' : ''}
    ${renderLogBody(text, truncated, open)}
    ${text === '' ? `<p class="lognone">${none}</p>` : ''}`;
}
