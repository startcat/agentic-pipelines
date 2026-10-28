/**
 * HTML rendered on the server. No templates, no dependencies and no domain
 * logic: who is healthy is decided by `health/evaluate.ts`; here we only render.
 */
import type { Health } from '../health/evaluate.ts';
import type { RunRecord } from '../runs/store.ts';
import type { Guard, Pipeline } from '../schema/pipeline.ts';
import { STYLES } from './styles.ts';
import { formatWhen, describeCron, money, formatDuration } from './format.ts';
import { groupHistory } from './skips.ts';
import { panelSummary, verdict } from './verdict.ts';

/**
 * The ONLY escaping helper in the project. Everything that
 * is interpolated goes through here. It accepts `unknown` on purpose: forcing a
 * conversion at every call site is exactly what makes someone interpolate
 * directly one day and skip the escaping.
 */
export function escapeHtml(text: unknown): string {
  if (text === undefined || text === null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function statusClass(status: string): string {
  return `s-${status.replace(/[^a-z-]/g, '')}`;
}

/**
 * The live client, shared by the two pages that use it. It renders nothing: the
 * server sends fragments already assembled.
 *
 * The `log` event sends `{ stepId, delta }` (see `sseEvent` in server.ts)
 * because a run stream can have several steps: without the id, a step's page
 * would have no way to tell its own delta from that of any other step also
 * running. `stepId` is the id of the step THIS PAGE SHOWS — the server passes
 * it in (`layout()`), it is never inferred from the URL in the browser. Only a
 * step's page receives it; the run's page doesn't, so there the comparison is
 * not part of the emitted script.
 */
const SSE_CLIENT = (url: string, stepId?: string): string => `
<script>
  const es = new EventSource(${JSON.stringify(url)});
  es.addEventListener('panel', e => {
    const el = document.getElementById('live');
    if (el) el.innerHTML = JSON.parse(e.data);
  });
  es.addEventListener('log', e => {
    const el = document.getElementById('log');
    if (!el) return;
    const payload = JSON.parse(e.data);
    ${stepId !== undefined ? `if (payload.stepId !== ${JSON.stringify(stepId)}) return;` : ''}
    el.append(payload.delta);
  });
  es.addEventListener('done', () => es.close());
</script>`;

export function layout(
  title: string,
  body: string,
  opts: { sse?: string; stepId?: string } = {},
): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head><body>
<div class="top"><a class="wordmark" href="/">PIPELINES</a></div>
${body}
${opts.sse ? SSE_CLIENT(opts.sse, opts.stepId) : ''}
</body></html>`;
}

export type HealthRow =
  | {
      name: string;
      description: string;
      health: Health;
      /** Declared steps of the pipeline, for the "N of M steps" of a live run. */
      totalSteps: number;
      /** This machine's scheduler, already resolved by the server: the renderer is pure. */
      scheduler: { label: string; logPath: string };
      /** Tail of the scheduled job's log. Only filled in the contradiction case. */
      jobLogTail?: string;
    }
  | {
      name: string;
      /**
       * `loadPipeline` and `store.listRuns` are ordinary I/O that throws under
       * normal conditions: a half-authored directory with no
       * `pipeline.yaml`, or a `run.json` truncated mid-write. A broken
       * pipeline can't take down the dashboard for the others — it is drawn as
       * an error row, with the reason, instead of disappearing.
       */
      error: string;
    };

/** The contradiction row: the only one on the page that takes the full
 *  width. The tail of the job's log is the only trace of an engine that dies
 *  before writing `run.json`. */
function renderAlarm(row: Extract<HealthRow, { health: Health }>, line: string): string {
  const tail = row.jobLogTail
    ? `<div class="alarmbody">Last lines of its log:</div>
       <pre class="tail">${escapeHtml(row.jobLogTail)}</pre>`
    : `<div class="alarmbody">Its log
         (<code>${escapeHtml(row.scheduler.logPath)}</code>) is empty or does not exist:
         the job never even started.</div>`;
  return `<div class="alarmbox">
    <div class="name"><a href="/p/${encodeURIComponent(row.name)}">${escapeHtml(row.name)}</a></div>
    <div class="alarmhead">${escapeHtml(line)}</div>
    <div class="alarmbody">
      ${escapeHtml(row.scheduler.label)} says it triggers this pipeline and there is not a single run in the window. It never
      started: machine asleep at trigger time, a <code>bun</code> on the PATH that no longer
      exists, or the engine dying before writing <code>run.json</code>.
    </div>
    ${tail}
  </div>`;
}

/**
 * The dashboard. What this function returns is EXACTLY what goes inside
 * `#live`, headline included: `SSE_CLIENT` replaces that whole node, so
 * anything taken out of here is born stale and stays frozen in the state it had
 * when the tab was opened.
 *
 * `now` comes in as a parameter because `formatWhen()` is pure and has no
 * clock: same split as `health/evaluate.ts`.
 */
export function renderHealthPanel(rows: HealthRow[], now: Date): string {
  const healthy = rows.flatMap((row) => ('error' in row ? [] : [row.health]));
  const broken = rows.length - healthy.length;
  const summary = panelSummary(healthy, broken);

  const body = rows
    .map((row) => {
      if ('error' in row) {
        return `<div class="row">
          <span class="dot warn"></span>
          <div>
            <div class="name">${escapeHtml(row.name)}</div>
            <div class="verdict">Could not be read: ${escapeHtml(row.error)}</div>
          </div>
          <div class="right"><div class="when">—</div></div>
        </div>`;
      }

      const v = verdict(row.health, row.totalSteps, row.scheduler.label);
      if (row.health.contradiction) return renderAlarm(row, v.line);

      const last = row.health.lastRun;
      const { day, time } = formatWhen(last?.startedAt, now);
      return `<div class="row">
        <span class="dot ${escapeHtml(v.tone)}"></span>
        <div>
          <div class="name"><a href="/p/${encodeURIComponent(row.name)}">${escapeHtml(row.name)}</a></div>
          <div class="verdict ${escapeHtml(v.tone)}">${escapeHtml(v.line)}</div>
          <div class="axes">trigger <b>${escapeHtml(v.trigger)}</b> · work <b>${escapeHtml(v.work)}</b></div>
          <div class="desc">${escapeHtml(row.description)}</div>
        </div>
        <div class="right">
          <div class="when">${escapeHtml(day)}${time ? ` · <em>${escapeHtml(time)}</em>` : ''}</div>
          <div class="cost">${escapeHtml(money(last?.totalCostUsd))}</div>
        </div>
      </div>`;
    })
    .join('\n');

  // No clock in the subtitle, on purpose. `createHealthStream` compares the
  // HTML with the previous tick's (`rendered === last`) so as not to re-emit
  // when nothing has changed; with the time inside, the fragment changed every
  // minute and the dashboard was always re-emitted — losing the only signal
  // that tells "something happened" from "everything is the same".
  return `<div class="headline ${escapeHtml(summary.tone)}">${escapeHtml(summary.line)}</div>
    <div class="subhead">${escapeHtml(summary.sub)}</div>
    ${body}`;
}

/**
 * A `when:` guard said in plain words, not in its escaped JSON. The four
 * branches of the schema have a known shape (`schema/pipeline.ts`), so all
 * four can be told; the `default` exists so that a pipeline.yaml from a future
 * version of the schema doesn't leave a silent hole.
 */
function renderGuard(guard: Guard): string {
  const row = (name: string, says: string): string => `<div class="guard">
    <div class="gname">${escapeHtml(name)}</div>
    <div class="gsay">${says}</div>
  </div>`;

  if ('throttle' in guard) {
    return row('throttle', `Doesn't run if the last run was less than
      <b>${escapeHtml(guard.throttle)}</b> ago.`);
  }
  if ('shell' in guard) {
    return row('shell', `Runs only if this command returns 0.
      <pre class="cmd">${escapeHtml(guard.shell)}</pre>`);
  }
  if ('changed' in guard) {
    const since = guard.changed.since === 'last_attempt' ? 'the last attempt' : 'the last successful run';
    return row('changed', `Runs only if something changed in
      <code>${escapeHtml(guard.changed.path)}</code> since ${escapeHtml(since)}.`);
  }
  if ('between' in guard) {
    return row('between', `Runs only between <b>${escapeHtml(guard.between)}</b>.`);
  }
  return row('guard', `<pre class="cmd">${escapeHtml(JSON.stringify(guard))}</pre>`);
}

const RUN_STATE: Record<string, string> = {
  success: 'success', failed: 'failed', skipped: 'skipped', running: 'running',
};

/** A history row. The skip reason is drawn here, escaped: it comes from a
 *  file and carries `<`, `>` and quotes. */
function renderRunRow(pipeline: string, run: RunRecord, now: Date): string {
  const { day, time } = formatWhen(run.startedAt, now);
  const href = `/p/${encodeURIComponent(pipeline)}/runs/${encodeURIComponent(run.id)}`;
  const note = [
    run.forced ? '<span class="chip">forced</span>' : '',
    run.skipReason ? escapeHtml(run.skipReason) : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `<div class="run">
    <span class="rday"><a href="${href}">${escapeHtml(day)}</a></span>
    <span class="rtime">${escapeHtml(time)}</span>
    <span class="rstate ${statusClass(run.status)}">${escapeHtml(RUN_STATE[run.status] ?? run.status)}</span>
    <span class="rnote">${note}</span>
    <span class="rcost">${escapeHtml(money(run.totalCostUsd))}</span>
  </div>`;
}

export function renderPipelinePage(
  pipeline: Pipeline,
  runs: RunRecord[],
  health: Health,
  now: Date,
  schedulerLabel: string,
): string {
  const v = verdict(health, pipeline.steps.length, schedulerLabel);
  const withAgent = pipeline.steps.filter((step) => step.type === 'agent').length;

  const steps = pipeline.steps
    .map(
      (step, i) => `<div class="step">
        <span class="num">${i + 1}</span>
        <span class="sid"><code>${escapeHtml(step.id)}</code></span>
        <span class="kind${step.type === 'agent' ? ' agent' : ''}">${escapeHtml(step.type)}</span>
      </div>`,
    )
    .join('');

  const guards = pipeline.when.map(renderGuard).join('');

  const params = Object.entries(pipeline.params)
    .map(
      ([key, spec]) => `<div class="param">
        <div class="pname">${escapeHtml(key)}</div>
        <div class="gsay">${escapeHtml(spec.description)}</div>
      </div>`,
    )
    .join('');

  // Eight paragraphs with the same two-hundred-character grep were noise: the
  // FACT is "eight nights, same guard", and it is said once. The block's dates
  // are still links, so no run becomes unreachable.
  const history = groupHistory(runs)
    .map((segment) => {
      if (segment.kind === 'run') return renderRunRow(pipeline.name, segment.run, now);
      const dates = segment.runs
        .map((run) => {
          const { day, time } = formatWhen(run.startedAt, now);
          const href = `/p/${encodeURIComponent(pipeline.name)}/runs/${encodeURIComponent(run.id)}`;
          return `<a href="${href}">${escapeHtml(day)}${time ? ` ${escapeHtml(time)}` : ''}</a>`;
        })
        .join('');
      const n = segment.runs.length;
      return `<div class="colapso">
        <div class="cchead">${n} skipped nights in a row</div>
        <div class="ccwhy">Same guard all ${n} times:
          <code>${escapeHtml(segment.guard)}</code></div>
        <div class="ccdates">${dates}</div>
      </div>`;
    })
    .join('');

  const empty = (what: string): string =>
    `<div class="param"><div class="pname">—</div><div class="gsay">${what}</div></div>`;

  return `
    <h1>${escapeHtml(pipeline.name)}</h1>
    <div class="verdict ${escapeHtml(v.tone)}">${escapeHtml(v.line)}</div>
    <div class="desc">${escapeHtml(pipeline.description)}</div>
    <div class="meta">
      <div><span>Trigger</span><b>${escapeHtml(v.trigger)}</b></div>
      <div><span>Work</span><b>${escapeHtml(v.work)}</b></div>
      <div><span>Cadence</span><em>${escapeHtml(describeCron(pipeline.triggers.map((t) => t.cron)))}</em></div>
    </div>
    <h2>Steps <i>— ${pipeline.steps.length}${withAgent > 0 ? `, ${withAgent} agent` : ''}</i></h2>
    <div class="steps">${steps}</div>
    <h2>Guards <i>— checked before each run</i></h2>
    ${guards || empty('None: nothing can stop it from running.')}
    <h2>Params</h2>
    ${params || empty('None.')}
    <h2>Runs <i>— ${runs.length}</i></h2>
    ${history}`;
}

/**
 * What goes inside `#live` on a run's page: the header, the steps and the
 * denials. All three change while the run is running, so all three have to be
 * here — `SSE_CLIENT` does `el.innerHTML = ...` on that container, and what is
 * left outside freezes in the state it had when the tab was opened. The header
 * used to live outside: a run that finished while you were looking kept saying
 * "running" until you reloaded.
 *
 * For the same reason this function does NOT return the page: if it returned
 * the title and the `<div id="live">`, the client would nest a copy inside
 * itself on every tick. It always starts with `<div class="bigline`, and a
 * test pins that shape.
 *
 * `step.durationMs` and `step.attempts` go through `escapeHtml` like everything
 * else even though their type says `number`: `JSON.parse(...) as RunRecord`
 * (`RunStore.readRun`) validates nothing, so that type is a promise, not a
 * guarantee.
 */
export function renderRunLive(run: RunRecord): string {
  const steps = Object.values(run.steps);
  const GLYPH: Record<string, string> = { success: '✓', failed: '✕', skipped: '–', running: '▸' };

  // The longest step sets the scale. The `|| 1` is not excess defense: a
  // just-started run has every step at 0 ms, and without it each bar would come
  // out with `width: NaN%`.
  const longest = Math.max(...steps.map((step) => step.durationMs), 0) || 1;
  const total = steps.reduce((acc, step) => acc + step.durationMs, 0);
  const failure = steps.find((step) => step.status === 'failed');

  const rows = steps
    .map((step, i) => {
      const pct = ((step.durationMs / longest) * 100).toFixed(1);
      const href = `/p/${encodeURIComponent(run.pipeline)}/runs/${encodeURIComponent(run.id)}/${encodeURIComponent(step.id)}`;
      // A single secondary line per step, and only if there is something to say:
      // the error wins over the skip reason, and the tools only show up when the
      // step has neither of the two.
      const note = step.error ?? step.skipReason ?? step.toolsUsed?.join(' · ') ?? '';
      const subnote = note
        ? `<div class="st note"><span></span><span></span><span></span>
             <span class="subnote${step.error ? ' err' : ''}">${escapeHtml(note)}</span></div>`
        : '';
      return `<div class="st">
        <span class="num">${i + 1}</span>
        <span class="id"><a href="${href}">${escapeHtml(step.id)}</a></span>
        <span class="state ${statusClass(step.status)}">${escapeHtml(RUN_STATE[step.status] ?? step.status)}</span>
        <span class="bar"><i class="${step.status === 'failed' ? 'bad' : ''}" style="width: ${escapeHtml(pct)}%"></i></span>
        <span class="dur">${escapeHtml(formatDuration(step.durationMs))}</span>
        <span class="stcost">${escapeHtml(money(step.costUsd))}</span>
      </div>${subnote}`;
    })
    .join('');

  // The `reason` is the useful part: it says WHY the sandbox didn't let the
  // tool through. It used to print only `redact: Read (both)` and the reason was discarded.
  const denials = steps
    .flatMap((step) => (step.denials ?? []).map((d) => ({ step, d })))
    .map(
      ({ step, d }) => `<div class="denial">
        <div class="dtop">${escapeHtml(step.id)} · ${escapeHtml(d.toolName)} · ${escapeHtml(d.source)}</div>
        ${d.reason ? `<div class="dwhy">${escapeHtml(d.reason)}</div>` : ''}
      </div>`,
    )
    .join('');

  const atStep = failure ? ` at <code>${escapeHtml(failure.id)}</code>` : '';
  return `<div class="bigline ${statusClass(run.status)}">${escapeHtml(GLYPH[run.status] ?? '')} ${escapeHtml(RUN_STATE[run.status] ?? run.status)}${atStep}</div>
    <div class="meta">
      <div><span>Duration</span><b>${escapeHtml(formatDuration(total))}</b></div>
      <div><span>Cost</span><b>${escapeHtml(money(run.totalCostUsd) || '—')}</b></div>
      <div><span>Steps</span><b>${steps.length}</b></div>
      ${run.forced ? '<div><span>Guards</span><b>skipped — forced</b></div>' : ''}
    </div>
    ${run.skipReason ? `<div class="bigwhy">${escapeHtml(run.skipReason)}</div>` : ''}
    <h2>Steps of this run <i>— the bar is the duration against the longest step</i></h2>
    ${rows}
    ${denials ? `<h2>Sandbox denials</h2>${denials}` : ''}`;
}

export function renderRunPage(name: string, run: RunRecord): string {
  return `<div class="crumb"><a href="/p/${encodeURIComponent(name)}">${escapeHtml(name)}</a> / ${escapeHtml(run.id)}</div>
    <div id="live">${renderRunLive(run)}</div>`;
}
