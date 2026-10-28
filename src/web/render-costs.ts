/**
 * The costs page (`/costs`), drawn from a `CostReport` already computed by
 * `costs.ts`. Same rules as `render.ts`: no logic of its own beyond layout,
 * and everything interpolated goes through `escapeHtml`.
 *
 * The bars are plain `div`s sized in %: no SVG and no client script, so the
 * page is as static as the rest of the viewer and the tokens of the sheet
 * (dark and light) paint them without a second palette.
 */
import type { CostReport, CostRun } from './costs.ts';
import { formatWhen, MONTHS, usd } from './format.ts';
import { escapeHtml, statusClass } from './render.ts';

/** Share of `max` as a CSS percentage. Zero when there is nothing to compare against. */
const pct = (value: number, max: number): string => `${max > 0 ? ((value / max) * 100).toFixed(1) : '0'}%`;

function figures(report: CostReport): string {
  const { month, previous, lastSix } = report;
  const maxMonth = Math.max(0, ...lastSix.map((m) => m.total));
  const bars = lastSix
    .map(
      (m) => `<div class="cm${m.current ? ' now' : ''}" title="${escapeHtml(`${m.label} · ${usd(m.total)}`)}">
        <span class="cmbar"><i style="height:${pct(m.total, maxMonth)}"></i></span>
        <span class="cmlab">${escapeHtml(m.label)}</span>
      </div>`,
    )
    .join('');
  return `<div class="cfigs">
    <div class="cfig">
      <span class="clabel">${escapeHtml(month.label)}, to date</span>
      <span class="cbig">${escapeHtml(usd(month.total))}</span>
      <span class="csub">${escapeHtml(`${month.day} of ${month.days} days`)}</span>
    </div>
    ${
      month.projected === undefined
        ? ''
        : `<div class="cfig">
      <span class="clabel">At this pace, by month end</span>
      <span class="cval">~${escapeHtml(usd(month.projected))}</span>
    </div>`
    }
    <div class="cfig">
      <span class="clabel">${escapeHtml(previous.label)}</span>
      <span class="cval">${escapeHtml(usd(previous.total))}</span>
    </div>
    <div class="cfig">
      <span class="clabel">Last 6 months</span>
      <div class="cmonths">${bars}</div>
    </div>
  </div>`;
}

function byDay(report: CostReport, now: Date): string {
  const { month, byDay: days, heavyWeekday } = report;
  const max = Math.max(0, ...days.map((d) => d.total));
  const short = MONTHS[now.getMonth()]!;
  const bars = days
    .map((d) => {
      if (d.future) return '<div class="cday future"><i></i></div>';
      const cls = d.day === month.day ? 'cday today' : 'cday';
      return `<div class="${cls}" title="${escapeHtml(`${short} ${d.day} · ${usd(d.total)}`)}"><i style="height:${pct(d.total, max)}"></i></div>`;
    })
    .join('');
  // One cell per day, so each label sits under its own bar; only the ticks
  // carry text. A Set because today can be one of the fixed ticks.
  const ticks = new Set([1, 5, 12, 19, 26, month.day, month.days]);
  const axis = days.map((d) => (ticks.has(d.day) ? `<span>${escapeHtml(d.day)}</span>` : '<span></span>')).join('');
  return `<h2>By day <i>— ${escapeHtml(month.label)}</i></h2>
  <div class="cdays">${bars}</div>
  <div class="caxis">${axis}</div>
  <div class="clegend">
    <span>cost of the day</span>
    <span>still to come</span>
    ${heavyWeekday ? `<span>${escapeHtml(`${heavyWeekday.weekday}s weigh more: ${heavyWeekday.pipeline}`)}</span>` : ''}
  </div>`;
}

function byPipeline(report: CostReport): string {
  const max = Math.max(0, ...report.byPipeline.map((p) => p.total));
  const rows = report.byPipeline
    .map(
      (p) => `<div class="cprow${p.total > 0 ? '' : ' zero'}">
      <span class="cpname">${escapeHtml(p.name)}</span>
      <span class="cptrack"><i style="width:${pct(p.total, max)}"></i></span>
      <span class="cpnum">${escapeHtml(p.runs)}</span>
      <span class="cpnum cpper">${p.perRun === undefined ? '—' : escapeHtml(usd(p.perRun))}</span>
      <span class="cptotal">${escapeHtml(usd(p.total))}</span>
    </div>`,
    )
    .join('');
  return `<h2>By pipeline <i>— ${escapeHtml(report.month.label)}</i></h2>
  <div class="cprow cphead"><span>Pipeline</span><span></span><span>Runs</span><span>Per run</span><span>Total</span></div>
  ${rows}`;
}

/** "Oct 5" rather than `formatWhen`'s "today"/"Mon": the list is the month's, read as dates. */
function priciestRow(run: CostRun, now: Date): string {
  const d = new Date(run.startedAt);
  const href = `/p/${encodeURIComponent(run.pipeline)}/runs/${encodeURIComponent(run.id)}`;
  return `<div class="run">
    <span class="rday"><a href="${escapeHtml(href)}">${escapeHtml(`${MONTHS[d.getMonth()]} ${d.getDate()}`)}</a></span>
    <span class="rtime">${escapeHtml(formatWhen(run.startedAt, now).time)}</span>
    <span class="rstate ${statusClass(run.status)}">${escapeHtml(run.status)}</span>
    <span class="rpipe">${escapeHtml(run.pipeline)}</span>
    <span class="rcost">${escapeHtml(usd(run.costUsd))}</span>
  </div>`;
}

/**
 * `unreadable` names the pipelines with a run that couldn't be read (a
 * truncated `run.json`): that run is left out of the sums, the rest of the
 * pipeline's runs still count, and the page says so instead of passing the
 * missing one off as $0.00.
 */
export function renderCostsPage(report: CostReport, now: Date, unreadable: string[] = []): string {
  const label = escapeHtml(report.month.label);
  const priciest =
    report.priciest.length > 0
      ? report.priciest.map((run) => priciestRow(run, now)).join('')
      : `<p class="cnone">No run cost anything in ${label} yet.</p>`;
  return `<h1 class="ctitle">Costs</h1>
  ${figures(report)}
  ${byDay(report, now)}
  ${byPipeline(report)}
  <h2>Most expensive runs <i>— ${label}</i></h2>
  ${priciest}
  <p class="cnote">Only what agent steps measure counts here: the SDK reports their cost. A shell step that
  calls claude -p, or anything covered by a Claude Code subscription, doesn't show up.
  Shell-only pipelines show $0.00 because they cost nothing.${
    unreadable.length > 0
      ? ` Some runs are not counted, because they could not be read: ${unreadable.map((n) => `<code>${escapeHtml(n)}</code>`).join(', ')}.`
      : ''
  }</p>`;
}
