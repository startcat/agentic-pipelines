/**
 * HTML rendered on the server. No templates, no dependencies and no domain
 * logic: who is healthy is decided by `health/evaluate.ts`; here we only render.
 */
import type { Health } from '../health/evaluate.ts';
import type { RunRecord } from '../runs/store.ts';
import type { StepRecord } from '../runs/types.ts';
import type { Guard, Pipeline } from '../schema/pipeline.ts';
import { BRAND_FAVICON, BRAND_ICON_SVG } from './brand.ts';
import { STYLES } from './styles.ts';
import { formatWhen, describeCron, money, formatDuration, formatNext, formatFull, formatClock, usd } from './format.ts';
import type { Spend } from './costs.ts';
import type { NextRun } from './schedule.ts';
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
 * How a log line is toned, decided once: a line whose trimmed start is
 * `warning`/`warn` reads amber, `error`/`fatal` the bad tone, anything else
 * plain. The step page draws it on the server and the live client applies the
 * same rules to the lines that arrive later — `SSE_CLIENT` is handed these
 * very regexes, so the two can't drift apart.
 */
export const LOG_TONES: readonly { tone: string; re: RegExp }[] = [
  { tone: 'warn', re: /^(warning|warn)\b:?/i },
  { tone: 'bad', re: /^(error|fatal)\b:?/i },
];

export function lineTone(line: string): string {
  const start = line.trimStart();
  return LOG_TONES.find(({ re }) => re.test(start))?.tone ?? '';
}

/**
 * A value as a JavaScript literal inside a `<script>`. `JSON.stringify` alone
 * leaves `<` as is, so a `</script>` inside a step id would close the block;
 * as `\u003c` it is the same string to the parser and inert to the HTML.
 */
const scriptLiteral = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');

/**
 * The step page's half of the live client: the `log` event's delta, appended
 * to `#log` one element per line, with the same tone classes the server
 * draws. A delta can end mid-line (the step flushed half a line); `#log`
 * carries `data-open="1"` while its last line is unfinished, and the next
 * delta's first piece is added to that line instead of starting a new one.
 * Lines are written with `textContent` and never `innerHTML`: the log is
 * whatever the step printed, and nothing in it may become markup.
 *
 * `#logcount` is the "N lines · size" above the log; it keeps counting as the
 * lines arrive (the byte formatting is `formatBytes`, repeated here).
 */
const LOG_CLIENT = (stepId: string): string => `
    if (payload.stepId !== ${scriptLiteral(stepId)}) return;
    const tones = ${scriptLiteral(LOG_TONES.map(({ tone, re }) => [tone, re.source, re.flags]))}
      .map(([tone, source, flags]) => [tone, new RegExp(source, flags)]);
    const toneOf = line => {
      const start = line.trimStart();
      const hit = tones.find(([, re]) => re.test(start));
      return hit ? hit[0] : '';
    };
    const delta = String(payload.delta);
    const parts = delta.split('\\n').map(part => part.replace(/\\r$/, ''));
    let from = 0;
    const last = el.lastElementChild;
    if (el.dataset.open === '1' && last) {
      last.textContent += parts[0];
      last.className = toneOf(last.textContent);
      from = 1;
    }
    let added = 0;
    for (let i = from; i < parts.length; i += 1) {
      if (i === parts.length - 1 && parts[i] === '') break;
      const line = document.createElement('span');
      line.textContent = parts[i];
      line.className = toneOf(parts[i]);
      el.append(line);
      added += 1;
    }
    el.dataset.open = parts[parts.length - 1] === '' ? '0' : '1';
    const count = document.getElementById('logcount');
    if (count) {
      const lines = Number(count.dataset.lines) + added;
      const bytes = Number(count.dataset.bytes) + new TextEncoder().encode(delta).length;
      count.dataset.lines = String(lines);
      count.dataset.bytes = String(bytes);
      const size = bytes < 1024 ? bytes + ' B'
        : bytes < 1048576 ? (bytes / 1024).toFixed(1) + ' KB'
        : (bytes / 1048576).toFixed(1) + ' MB';
      count.textContent = lines.toLocaleString('en-US') + (lines === 1 ? ' line' : ' lines') + ' · ' + size;
    }`;

/**
 * The live client, shared by the two pages that use it. It renders nothing
 * for the run's page: the server sends fragments already assembled. The
 * step's page gets a `log` handler as well (`LOG_CLIENT`).
 *
 * The `log` event sends `{ stepId, delta }` (see `sseEvent` in server.ts)
 * because a run stream can have several steps: without the id, a step's page
 * would have no way to tell its own delta from that of any other step also
 * running. `stepId` is the id of the step THIS PAGE SHOWS — the server passes
 * it in (`layout()`), it is never inferred from the URL in the browser. Only a
 * step's page receives it; the run's page has no `#log`, so there the handler
 * is not part of the emitted script.
 */
const SSE_CLIENT = (url: string, stepId?: string): string => `
<script>
  const es = new EventSource(${scriptLiteral(url)});
  es.addEventListener('panel', e => {
    const el = document.getElementById('live');
    if (el) el.innerHTML = JSON.parse(e.data);
  });${stepId !== undefined ? `
  es.addEventListener('log', e => {
    const el = document.getElementById('log');
    if (!el) return;
    const payload = JSON.parse(e.data);${LOG_CLIENT(stepId)}
  });` : ''}
  es.addEventListener('done', () => es.close());
</script>`;

/**
 * What every page carries around its body: the header (brand and nav) and the
 * footer (where the viewer listens, the repo it reads and the scheduler it
 * asks). The server resolves all of it — the renderer is pure, same as with
 * `HealthRow.scheduler` — so a test can draw a footer for `/home/u/repo`
 * without touching the disk or the platform.
 *
 * `nav` is the section the page belongs to; with none, no nav item is marked.
 * `scheduler` is a label ready to print: the server already turned "this
 * platform has no scheduler" into a dash.
 */
export type Chrome = {
  nav?: 'overview' | 'costs';
  port: number;
  repoRoot: string;
  home: string;
  scheduler: string;
};

/**
 * The repo root as a person says it: `~/repo` instead of `/Users/dani/repo`.
 * Only on a whole-segment boundary — `/home/user2` is not inside `/home/u` —
 * and never with an empty or `/` home, which would turn every path into `~`.
 */
function homeRelative(path: string, home: string): string {
  const base = home.replace(/\/+$/, '');
  if (base === '') return path;
  if (path === base) return '~';
  if (path.startsWith(`${base}/`)) return `~${path.slice(base.length)}`;
  return path;
}

const NAV: { key: NonNullable<Chrome['nav']>; href: string; label: string }[] = [
  { key: 'overview', href: '/', label: 'Overview' },
  { key: 'costs', href: '/costs', label: 'Costs' },
];

export function layout(
  title: string,
  body: string,
  chrome: Chrome,
  opts: { sse?: string; stepId?: string } = {},
): string {
  // `aria-current` and not a class: it is what a screen reader announces, and
  // the stylesheet keys the accent underline on the same attribute, so the
  // look and the semantics cannot disagree.
  const nav = NAV.map(
    (item) =>
      `<a href="${item.href}"${chrome.nav === item.key ? ' aria-current="page"' : ''}>${item.label}</a>`,
  ).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="${escapeHtml(BRAND_FAVICON)}">
<style>${STYLES}</style>
</head><body>
<header class="top">
  <a class="brand" href="/"><span aria-hidden="true">${BRAND_ICON_SVG}</span>agentic-pipelines</a>
  <nav class="nav">${nav}</nav>
</header>
<main>
${body}
</main>
<footer class="foot">
  <span>127.0.0.1:${escapeHtml(chrome.port)} · read-only</span>
  <span>${escapeHtml(homeRelative(chrome.repoRoot, chrome.home))}</span>
  <span>${escapeHtml(chrome.scheduler)}</span>
</footer>
${opts.sse ? SSE_CLIENT(opts.sse, opts.stepId) : ''}
</body></html>`;
}

export type HealthRow =
  | {
      name: string;
      description: string;
      health: Health;
      /**
       * Declared step ids, in the YAML's order: the "N of M steps" of a live
       * run and one segment each in its progress bar.
       */
      steps: string[];
      /** When it runs next, already worked out by the server from the trigger axis and the cron. */
      next: NextRun;
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

export type { Spend };

/**
 * A lookup in one of the fixed word tables below by a value read from
 * `run.json`. Own keys only: `TABLE["constructor"]` is a function from the
 * prototype, and it would be printed as the class or the label.
 */
export const lookup = (table: Record<string, string>, key: unknown): string | undefined => {
  const k = String(key);
  return Object.hasOwn(table, k) ? table[k] : undefined;
};

type HealthyRow = Extract<HealthRow, { health: Health }>;

/** The contradiction row: the only one on the page that takes the full
 *  width. The tail of the job's log is the only trace of an engine that dies
 *  before writing `run.json`. */
function renderAlarm(row: HealthyRow, line: string): string {
  const tail = row.jobLogTail
    ? `<div class="alarmbody">Last lines of its log:</div>
       <pre class="tail">${escapeHtml(row.jobLogTail)}</pre>`
    : `<div class="alarmbody">Its log
         (<code>${escapeHtml(row.scheduler.logPath)}</code>) is empty or does not exist:
         the job never even started.</div>`;
  return `<div class="alarmbox">
    <div class="alarmtop"><span class="dot bad"></span><span class="name"><a href="/p/${encodeURIComponent(row.name)}">${escapeHtml(row.name)}</a></span></div>
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
 * One segment per DECLARED step, in the YAML's order. A step only enters
 * `run.steps` once it has finished (there is no "running" step status), so
 * the recorded ones take their own colour, the first one not recorded yet is
 * the one running, and the rest are still to come. A recorded step with a
 * status this map doesn't know is drawn muted, like a skip: it did not run to
 * success, and painting it as pending would be a lie about the order.
 */
const SEGMENT: Record<string, string> = { success: 'ok', failed: 'bad', skipped: 'skip' };

function renderProgress(steps: readonly string[], run: RunRecord): string {
  // `run.json` is read with an `as` and no validation (`RunStore.readRun`):
  // `steps` is a promise of its type, not a guarantee.
  const recorded: Record<string, { status?: unknown }> =
    typeof run.steps === 'object' && run.steps !== null ? run.steps : {};
  let liveTaken = false;
  const segments = steps.map((id) => {
    if (Object.hasOwn(recorded, id)) return lookup(SEGMENT, recorded[id]?.status) ?? 'skip';
    if (liveTaken) return 'empty';
    liveTaken = true;
    return 'live';
  });
  return `<div class="progress" aria-hidden="true">${segments.map((cls) => `<i class="${cls}"></i>`).join('')}</div>`;
}

/**
 * The second line of the right column: how long a run in progress has been
 * going, or when the next one is. The first is the only thing on the
 * dashboard that moves with the second, and only while something runs.
 */
function renderNext(row: HealthyRow, now: Date): string {
  const last = row.health.lastRun;
  if (last?.status === 'running') {
    const started = new Date(last.startedAt).getTime();
    const since = Number.isNaN(started) ? '' : ` · ${formatDuration(now.getTime() - started)}`;
    return `<div class="next">running${escapeHtml(since)}</div>`;
  }
  switch (row.next.kind) {
    case 'none':
      return '<div class="next bad">no next run</div>';
    case 'manual':
      return '<div class="next">run by hand</div>';
    case 'at': {
      const at = new Date(row.next.at);
      if (Number.isNaN(at.getTime())) return '<div class="next">next · —</div>';
      return `<div class="next" title="${escapeHtml(formatFull(at))}">next · ${escapeHtml(formatNext(at, now))}</div>`;
    }
  }
}

function renderSpend(spend: Spend): string {
  const { month, previous } = spend;
  // A run.json that can't be read has a cost nobody knows: the figure says it
  // leaves it out rather than understating in silence.
  const left = spend.unreadable ? ` · ${spend.unreadable} unreadable, not counted` : '';
  const runs = `${month.runs} ${month.runs === 1 ? 'run' : 'runs'} · ${month.withAgent} with an agent${left}`;
  return `<div class="spend">
    <span>${escapeHtml(month.label)}, to date</span>
    <span class="sfig">${escapeHtml(usd(month.total))}</span>
    <span>${escapeHtml(previous.label)}</span>
    <span class="sfig prev">${escapeHtml(usd(previous.total))}</span>
    <span class="sruns">${escapeHtml(runs)}</span>
    <a class="smore" href="/costs">See costs →</a>
  </div>`;
}

/** What an empty repo shows instead of rows: where a pipeline lives and how to check one. */
const EMPTY_HINT = `<div class="hint">
    <p>Each pipeline lives in its own folder with a pipeline.yaml. Write one, check it, and it
      shows up here on the next refresh:</p>
    <div class="hintcode"><span>pipelines/&lt;name&gt;/pipeline.yaml</span><span class="cmdline">$ pipelines validate &lt;name&gt;</span></div>
    <p class="hintmore">Or start from the ready-made pipelines of pipelines-starter.</p>
  </div>`;

/**
 * The dashboard. What this function returns is EXACTLY what goes inside
 * `#live`, headline included: `SSE_CLIENT` replaces that whole node, so
 * anything taken out of here is born stale and stays frozen in the state it had
 * when the tab was opened.
 *
 * `now` comes in as a parameter because `formatWhen()` is pure and has no
 * clock: same split as `health/evaluate.ts`.
 *
 * `spend` is the strip under the headline. It lives in here for the same
 * reason as the headline: a run that finishes while the tab is open changes
 * the month's figure. It is not drawn on an empty repo — there is nothing yet
 * to spend on, and the page's job there is to say how to write the first one.
 */
export function renderHealthPanel(rows: HealthRow[], now: Date, spend?: Spend): string {
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

      const v = verdict(row.health, row.steps.length, row.scheduler.label);
      if (row.health.contradiction) return renderAlarm(row, v.line);

      const last = row.health.lastRun;
      const { day, time } = formatWhen(last?.startedAt, now);
      const cost = money(last?.totalCostUsd);
      return `<div class="row">
        <span class="dot ${escapeHtml(v.tone)}"></span>
        <div>
          <div class="name"><a href="/p/${encodeURIComponent(row.name)}">${escapeHtml(row.name)}</a></div>
          <div class="verdict ${escapeHtml(v.tone)}">${escapeHtml(v.line)}</div>
          ${last?.status === 'running' ? renderProgress(row.steps, last) : ''}
          <div class="axes">trigger <b>${escapeHtml(v.trigger)}</b> · work <b>${escapeHtml(v.work)}</b></div>
          <div class="desc">${escapeHtml(row.description)}</div>
        </div>
        <div class="right">
          <div class="when">${escapeHtml(day)}${time ? ` · <em>${escapeHtml(time)}</em>` : ''}</div>
          ${renderNext(row, now)}
          ${cost ? `<div class="cost">${escapeHtml(cost)}</div>` : ''}
        </div>
      </div>`;
    })
    .join('\n');

  // No clock in the subtitle, on purpose. `createHealthStream` compares the
  // HTML with the previous tick's (`rendered === last`) so as not to re-emit
  // when nothing has changed; with the time inside, the fragment changed every
  // minute and the dashboard was always re-emitted — losing the only signal
  // that tells "something happened" from "everything is the same". The right
  // column keeps that promise too: "next · tomorrow 08:00" moves with the day,
  // not with the second; only a run in progress counts seconds.
  const head = `<div class="headline ${escapeHtml(summary.tone)}">${escapeHtml(summary.line)}</div>
    ${summary.sub ? `<div class="subhead">${escapeHtml(summary.sub)}</div>` : ''}`;
  if (rows.length === 0) return `${head}
    ${EMPTY_HINT}`;
  return `${head}
    ${spend ? renderSpend(spend) : ''}
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
    <span class="rstate ${statusClass(run.status)}">${escapeHtml(lookup(RUN_STATE, run.status) ?? run.status)}</span>
    <span class="rnote">${note}</span>
    <span class="rcost">${escapeHtml(money(run.totalCostUsd))}</span>
  </div>`;
}


/** One step of a breadcrumb: with `href` it is a way back, without it the page you are on. */
export type Crumb = { label: string; href?: string };

/**
 * The trail above a page's title: "Overview / docs-drift / <run id>". The
 * separators are drawn in the line colour, so the names carry the reading;
 * the way back to a pipeline reads a step brighter than the way back home,
 * and the page you are on is not a link.
 */
export function renderCrumb(items: Crumb[]): string {
  const parts = items.map((item, i) => {
    const label = escapeHtml(item.label);
    if (item.href === undefined) return `<span>${label}</span>`;
    return `<a href="${escapeHtml(item.href)}"${i > 0 ? ' class="up"' : ''}>${label}</a>`;
  });
  return `<div class="crumb">${parts.join('<span class="sep">/</span>')}</div>`;
}

/**
 * What the pipeline page says next to CADENCE that the YAML can't: when it
 * fires next, what it has cost this month and how much each agent step may
 * spend. The server works it out (the cron walk and the month's sum are its
 * reads); the renderer only prints it.
 *
 * `next` is absent when there is nothing to promise. Why is told by the
 * trigger axis, the same one `nextRun` decides by: a job nobody loaded fires
 * nothing, a pipeline without a cron is run by hand, and a loaded cron that
 * can't be walked is a dash — an invented time is worse than none.
 */
export type PipelineExtra = {
  next?: Date;
  monthLabel: string;
  monthTotal: number;
  monthRuns: number;
  /**
   * Why the scheduler could not be asked (a platform without one). The page is
   * still drawn; the verdict says this instead, and the trigger and NEXT are
   * dashes: the server had to evaluate with made-up facts, and printing what
   * they imply ("not installed", "no next run") would be inventing.
   */
  schedulerError?: string;
  /** Runs whose `run.json` could not be read, with the reason. */
  unreadable?: UnreadableRun[];
};

/** A run that is on disk but can't be drawn. No `id` when the folder itself could not be listed. */
export type UnreadableRun = { id?: string; reason: string };

function renderNextMeta(next: Date | undefined, trigger: Health['trigger'], schedulerError?: string): string {
  if (schedulerError !== undefined) return '<b>—</b>';
  if (next !== undefined && !Number.isNaN(next.getTime())) return `<b>${escapeHtml(formatFull(next))}</b>`;
  if (trigger === 'no-trigger') return '<b>run by hand</b>';
  if (trigger === 'not-installed' || trigger === 'disabled') return '<b class="bad">no next run</b>';
  return '<b>—</b>';
}

/**
 * Each agent step's ceiling, as the YAML declares it. An agent step with no
 * `max_cost_usd` is said in amber: nothing stops it from spending, and that
 * is worth seeing before it happens. A pipeline without agent steps has no
 * spend to cap, so the field is not drawn at all.
 */
function renderCapsMeta(pipeline: Pipeline): string {
  const agents = pipeline.steps.flatMap((step) => (step.type === 'agent' ? [step] : []));
  if (agents.length === 0) return '';
  const lines = agents.map((step) =>
    step.maxCostUsd === undefined
      ? `<em class="mono warnc">${escapeHtml(step.id)}: no cap</em>`
      : `<em class="mono">${escapeHtml(step.id)} ≤ ${escapeHtml(usd(step.maxCostUsd))}</em>`,
  );
  return `<div class="caps"><span>Spending cap</span>${lines.join('')}</div>`;
}

export function renderPipelinePage(
  pipeline: Pipeline,
  runs: RunRecord[],
  health: Health,
  now: Date,
  schedulerLabel: string,
  extra: PipelineExtra,
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

  const monthRuns = `· ${extra.monthRuns} ${extra.monthRuns === 1 ? 'run' : 'runs'}`;
  const schedulerError = extra.schedulerError;
  const line = schedulerError !== undefined ? `Could not ask the scheduler: ${schedulerError}` : v.line;
  const tone = schedulerError !== undefined ? 'bad' : v.tone;
  // One line, however many: the history below is still what was readable,
  // and each broken file is named so it can be found and fixed.
  const unreadable = extra.unreadable ?? [];
  const broken = unreadable.length === 0
    ? ''
    : `<div class="bigwhy warnc">${unreadable.length} ${unreadable.length === 1 ? 'run' : 'runs'} could not be read: ${unreadable
        .map((u) => escapeHtml(u.id !== undefined ? `${u.id}: ${u.reason}` : u.reason))
        .join(' · ')}</div>`;
  return `
    ${renderCrumb([{ label: 'Overview', href: '/' }, { label: pipeline.name }])}
    <h1>${escapeHtml(pipeline.name)}</h1>
    <div class="verdict ${escapeHtml(tone)}">${escapeHtml(line)}</div>
    <div class="desc">${escapeHtml(pipeline.description)}</div>
    <div class="meta">
      <div><span>Trigger</span><b>${escapeHtml(schedulerError !== undefined ? '—' : v.trigger)}</b></div>
      <div><span>Work</span><b>${escapeHtml(v.work)}</b></div>
      <div><span>Cadence</span><em>${escapeHtml(describeCron(pipeline.triggers.map((t) => t.cron)))}</em></div>
      <div><span>Next</span>${renderNextMeta(extra.next, health.trigger, schedulerError)}</div>
      <div><span>${escapeHtml(extra.monthLabel)}</span><b class="mono">${escapeHtml(usd(extra.monthTotal))}</b> <em>${escapeHtml(monthRuns)}</em></div>
      ${renderCapsMeta(pipeline)}
    </div>
    <h2>Steps <i>— ${pipeline.steps.length}${withAgent > 0 ? `, ${withAgent} with an agent` : ''}</i></h2>
    <div class="steps">${steps}</div>
    <h2>Guards <i>— checked before each run</i></h2>
    ${guards || empty('None: nothing can stop it from running.')}
    <h2>Params</h2>
    ${params || empty('None.')}
    <h2>Runs <i>— ${runs.length}</i></h2>
    ${broken}
    ${history}`;
}

/**
 * What a run's page knows from the pipeline's CURRENT `pipeline.yaml`, which
 * `run.json` does not store: each step's type (for the SHELL/AGENT chip and
 * for which steps' outputs to show), each agent step's `max_cost_usd`, and
 * how many steps are declared (so a run in progress reads "2 of 4"). The
 * server loads it inside a `try`: a YAML that no longer parses leaves the page
 * without chips and caps, never without the run.
 */
export type RunInfo = { types: Record<string, string>; caps: Record<string, number>; totalSteps?: number };

/** A step's SHELL/AGENT chip; the agent one in amber, since it is the one that spends. */
export function renderKindChip(type: string): string {
  return `<span class="kind${type === 'agent' ? ' agent' : ''}">${escapeHtml(type)}</span>`;
}

export const GLYPH: Record<string, string> = { success: '✓', failed: '✕', skipped: '–', running: '▸' };

/**
 * The run in one sentence. A success with denials says so in the same breath:
 * the sandbox refusing something and the run still finishing is the normal
 * case of the detective layer, not a failure, but it is not "nothing
 * happened" either.
 */
function runSentence(run: RunRecord, steps: StepRecord[], denials: number): string {
  const glyph = escapeHtml(lookup(GLYPH, run.status) ?? '');
  switch (run.status) {
    case 'success': {
      if (denials === 0) return `${glyph} Success.`;
      const what = denials === 1 ? 'one action' : `${denials} actions`;
      return `${glyph} Success. The sandbox blocked ${what} and the run still finished.`;
    }
    case 'failed': {
      const failure = steps.find((step) => step.status === 'failed');
      return failure ? `${glyph} Failed at <code>${escapeHtml(failure.id)}</code>.` : `${glyph} Failed.`;
    }
    case 'skipped':
      return `${glyph} Skipped.`;
    case 'running':
      return `${glyph} Running.`;
    default:
      return `${escapeHtml(run.status)}.`;
  }
}

/**
 * Wall-clock time from `startedAt` to `finishedAt` when the run carries both:
 * it includes what happens between steps (guards, notify), which the sum of
 * the steps leaves out. Without them — a run still going, or an old
 * `run.json` — the sum of the steps. Never `now - startedAt`: this fragment
 * is compared tick to tick by the stream, and a figure that moved every second
 * would re-send it every second for nothing.
 */
function runDuration(run: RunRecord, steps: StepRecord[]): number {
  const start = Date.parse(String(run.startedAt));
  const end = Date.parse(String(run.finishedAt));
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return end - start;
  return steps.reduce((acc, step) => acc + step.durationMs, 0);
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * The steps of a run as this page can draw them. `run.json` is read with an
 * `as` and no validation (`RunStore.readRun`), so a hand-edited or
 * half-migrated file can have `steps` missing or null, a step that is not an
 * object, or `denials`/`toolsUsed` that are not arrays. Each of those is
 * treated as empty here, once, so the rest of the page can trust the shape —
 * same stance as `renderProgress`.
 */
function stepsOfRun(run: RunRecord): StepRecord[] {
  const raw: unknown = run.steps;
  if (typeof raw !== 'object' || raw === null) return [];
  return Object.values(raw)
    .filter((step: unknown): step is StepRecord => typeof step === 'object' && step !== null)
    .map((step) => ({
      ...step,
      durationMs: isNumber(step.durationMs) ? step.durationMs : 0,
      // A denial that is not an object (`[null]`) can't be drawn: it is dropped
      // here rather than read as `d.toolName` further down.
      denials: Array.isArray(step.denials)
        ? step.denials.filter((d: unknown) => typeof d === 'object' && d !== null)
        : [],
      ...(Array.isArray(step.toolsUsed) ? { toolsUsed: step.toolsUsed } : { toolsUsed: undefined }),
    }));
}

/**
 * Each agent step against its ceiling: "review $0.36 of $1.00" and a short
 * bar (a div, not a span: every span inside .meta is drawn as a label). Before the step has measured anything it says the ceiling alone, as
 * the pipeline page does; an agent step without a ceiling is said in amber.
 * The order is the YAML's (`info.types` is built walking it).
 */
function renderRunCaps(steps: StepRecord[], info: RunInfo | undefined): string {
  if (info === undefined) return '';
  const agents = Object.keys(info.types).filter((id) => info.types[id] === 'agent');
  if (agents.length === 0) return '';
  const lines = agents.map((id) => {
    const cap = Object.hasOwn(info.caps, id) ? info.caps[id] : undefined;
    if (cap === undefined) return `<div class="caprow"><em class="mono warnc">${escapeHtml(id)}: no cap</em></div>`;
    const cost = steps.find((step) => step.id === id)?.costUsd;
    // A ceiling of zero can't be a scale: the bar would be NaN wide.
    if (!isNumber(cost) || cap <= 0) {
      return `<div class="caprow"><em class="mono">${escapeHtml(id)} ≤ ${escapeHtml(usd(cap))}</em></div>`;
    }
    const pct = Math.min(100, (cost / cap) * 100).toFixed(1);
    return `<div class="caprow">
        <em class="mono">${escapeHtml(id)} ${escapeHtml(usd(cost))} of ${escapeHtml(usd(cap))}</em>
        <div class="captrack" aria-hidden="true"><i class="${cost > cap ? 'bad' : ''}" style="width: ${escapeHtml(pct)}%"></i></div>
      </div>`;
  });
  return `<div class="caps"><span>Spending cap</span>${lines.join('')}</div>`;
}

/**
 * The type of an output, read off the value: `run.json` stores the value, not
 * the contract it was checked against, and the contract in today's YAML may
 * have changed since. The names are the contract's own (`OUTPUT_TYPES`);
 * anything else is an `object`.
 */
function outputType(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return typeof value;
  if (Array.isArray(value)) {
    // Empty, it has no element to tell the type by: saying string[] would be a guess.
    if (value.length === 0) return 'array';
    for (const kind of ['string', 'number', 'boolean']) {
      if (value.every((item) => typeof item === kind)) return `${kind}[]`;
    }
  }
  return 'object';
}

function outputValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length === 0) return '';
  if (Array.isArray(value) && outputType(value) !== 'object') return value.map(String).join(' · ');
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? '';
}

/**
 * What each agent step handed to the next ones. Only agent steps: a shell
 * step's outputs are the lines it printed, already in its log, while an
 * agent's are the structured answer — the part of its work that is not
 * anywhere else on the page. The step's type comes from the current YAML;
 * a step the YAML doesn't know (renamed, or the YAML no longer parses) counts
 * as an agent if it measured a cost, which only agent steps do.
 */
function renderOutputs(steps: StepRecord[], info: RunInfo | undefined): string {
  return steps
    .filter((step) => {
      const known = info !== undefined && Object.hasOwn(info.types, step.id);
      return known ? info.types[step.id] === 'agent' : isNumber(step.costUsd);
    })
    .flatMap((step) => {
      const outputs: unknown = step.outputs;
      if (typeof outputs !== 'object' || outputs === null) return [];
      const entries = Object.entries(outputs);
      if (entries.length === 0) return [];
      const rows = entries
        .map(
          ([key, value]) => `<div class="out">
          <div class="okey"><span class="oname">${escapeHtml(key)}</span><span class="otype">${escapeHtml(outputType(value))}</span></div>
          <div class="oval">${escapeHtml(outputValue(value)) || '—'}</div>
        </div>`,
        )
        .join('');
      return [`<h2>Outputs <i>— ${escapeHtml(step.id)}</i><small>what the step handed to the next ones</small></h2>${rows}`];
    })
    .join('');
}

/**
 * What goes inside `#live` on a run's page: the verdict, the meta, the steps,
 * the denials and the outputs. All of them change while the run is running,
 * so all of them have to be here — `SSE_CLIENT` does `el.innerHTML = ...` on
 * that container, and what is left outside freezes in the state it had when
 * the tab was opened. The header used to live outside: a run that finished
 * while you were looking kept saying "running" until you reloaded.
 *
 * For the same reason this function does NOT return the page: if it returned
 * the title and the `<div id="live">`, the client would nest a copy inside
 * itself on every tick. It always starts with `<div class="bigline`, and a
 * test pins that shape. The title above it (the run's date, and "forced") is
 * fixed for the run's whole life, so it lives in `renderRunPage`.
 *
 * `step.durationMs` and `step.attempts` go through `escapeHtml` like everything
 * else even though their type says `number`: `JSON.parse(...) as RunRecord`
 * (`RunStore.readRun`) validates nothing, so that type is a promise, not a
 * guarantee.
 */
export function renderRunLive(run: RunRecord, info?: RunInfo): string {
  const steps = stepsOfRun(run);

  // The longest step sets the scale. The `|| 1` is not excess defense: a
  // just-started run has every step at 0 ms, and without it each bar would come
  // out with `width: NaN%`.
  const longest = Math.max(...steps.map((step) => step.durationMs), 0) || 1;
  const skipped = steps.filter((step) => step.status === 'skipped').length;
  const denialCount = steps.reduce((acc, step) => acc + (step.denials?.length ?? 0), 0);

  const rows = steps
    .map((step, i) => {
      const pct = ((step.durationMs / longest) * 100).toFixed(1);
      const href = `/p/${encodeURIComponent(run.pipeline)}/runs/${encodeURIComponent(run.id)}/${encodeURIComponent(step.id)}`;
      const type = info !== undefined && Object.hasOwn(info.types, step.id) ? info.types[step.id] : undefined;
      const chip = type ? ` ${renderKindChip(type)}` : '';
      // A single secondary line per step, and only if there is something to say:
      // the error wins over the skip reason, and the tools only show up when the
      // step has neither of the two.
      const note = step.error ?? step.skipReason ?? step.toolsUsed?.join(' · ') ?? '';
      const bar = step.status === 'failed' ? 'bad' : step.durationMs === longest ? 'max' : '';
      return `<div class="st">
        <span class="num">${i + 1}</span>
        <span class="id"><a href="${href}">${escapeHtml(step.id)}</a>${chip}</span>
        <span class="state ${statusClass(step.status)}">${escapeHtml(lookup(RUN_STATE, step.status) ?? step.status)}</span>
        <span class="bar"><i class="${bar}" style="width: ${escapeHtml(pct)}%"></i></span>
        <span class="dur">${escapeHtml(formatDuration(step.durationMs))}</span>
        <span class="stcost">${escapeHtml(money(step.costUsd))}</span>
        ${note ? `<span class="subnote${step.error ? ' err' : ''}">${escapeHtml(note)}</span>` : ''}
      </div>`;
    })
    .join('');

  // The `reason` is the useful part: it says WHY the sandbox didn't let the
  // tool through. It used to print only `redact: Read (both)` and the reason was discarded.
  const denials = steps
    .flatMap((step) => (step.denials ?? []).map((d) => ({ step, d })))
    .map(
      ({ step, d }) => `<div class="denial">
        <div class="dtop">${escapeHtml(step.id)}<span class="dsep">·</span><span class="dtool">${escapeHtml(d.toolName)}</span><span class="dsep">·</span><span class="dsrc">${escapeHtml(d.source)}</span></div>
        ${d.reason ? `<div class="dwhy">${escapeHtml(d.reason)}</div>` : ''}
      </div>`,
    )
    .join('');

  const started = new Date(String(run.startedAt));
  const startedAt = Number.isNaN(started.getTime()) ? '—' : formatClock(started);
  // A run in progress counts against what the YAML declares ("2 of 4"): the
  // steps still to come are not in `run.steps` yet.
  const total = info?.totalSteps;
  const count = run.status === 'running' && total !== undefined && total > steps.length
    ? `${steps.length} of ${total}`
    : `${steps.length}`;
  const stepsMeta = `${count}${skipped > 0 ? ` · ${skipped} skipped` : ''}`;

  return `<div class="bigline ${statusClass(run.status)}">${runSentence(run, steps, denialCount)}</div>
    ${run.skipReason ? `<div class="bigwhy">${escapeHtml(run.skipReason)}</div>` : ''}
    <div class="meta">
      <div><span>Started</span><b class="mono">${escapeHtml(startedAt)}</b></div>
      <div><span>Duration</span><b class="mono">${escapeHtml(formatDuration(runDuration(run, steps)))}</b></div>
      <div><span>Cost</span><b class="mono">${escapeHtml(money(run.totalCostUsd) || '—')}</b></div>
      <div><span>Steps</span><b>${escapeHtml(stepsMeta)}</b></div>
      ${renderRunCaps(steps, info)}
    </div>
    <h2>Steps <i>— ${steps.length}</i><small>the bar is the duration against the longest step</small></h2>
    ${rows}
    ${denials ? `<h2>Sandbox denials <i>— ${denialCount}</i><small>what the engine refused an agent; the run went on</small></h2>${denials}` : ''}
    ${renderOutputs(steps, info)}`;
}

/**
 * The run's page: the trail, the title (when it started, and whether someone
 * forced it past its guards) and the live part. There is no "scheduled run"
 * next to the title: `run.json` doesn't record where a run came from, only
 * `forced`.
 */
export function renderRunPage(name: string, run: RunRecord, info?: RunInfo): string {
  const started = new Date(String(run.startedAt));
  const title = Number.isNaN(started.getTime()) ? run.id : formatFull(started);
  return `${renderCrumb([
    { label: 'Overview', href: '/' },
    { label: name, href: `/p/${encodeURIComponent(name)}` },
    { label: run.id },
  ])}
    <div class="titleline"><h1>${escapeHtml(title)}</h1>${run.forced ? '<span class="tkind">forced — guards skipped</span>' : ''}</div>
    <div id="live">${renderRunLive(run, info)}</div>`;
}

/**
 * The run's page when its `run.json` is on disk but can't be read: the same
 * trail, and what went wrong, instead of the server's raw error. The id is
 * the directory's name, found by lookup — it is shown escaped, never used.
 */
export function renderUnreadableRun(name: string, id: string, reason: string): string {
  return `${renderCrumb([
    { label: 'Overview', href: '/' },
    { label: name, href: `/p/${encodeURIComponent(name)}` },
    { label: id },
  ])}
    <div class="titleline"><h1>This run could not be read.</h1></div>
    <div class="bigline s-failed">Its run.json is there, but it could not be read as a run.</div>
    <div class="bigwhy"><code>${escapeHtml(reason)}</code></div>`;
}
