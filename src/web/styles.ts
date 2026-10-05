/**
 * La hoja de estilo del visor, como constante. Sin lógica y sin plantillas: es
 * texto. Vive fuera de `render.ts` porque pasa de quince líneas a unas ciento
 * cincuenta, y `render.ts` ya tiene bastante con el pintado.
 *
 * Dos reglas que no son decorativas:
 *
 * - **Si algo tiene color, es porque importa.** Todo lo demás es gris. Los tres
 *   acentos tranquilos (`--ok`, `--warn`, `--live`) comparten claridad y croma
 *   y solo cambian de tono; `--bad` rompe la regla A PROPÓSITO, porque es lo
 *   único de la página que exige levantarse.
 * - **Dos familias, las dos del sistema.** Monoespaciada para lo que es una
 *   cadena literal de la máquina (nombres, crons, comandos, rutas, cifras,
 *   ids); sans para lo que le decimos nosotros a la persona. Ninguna se
 *   descarga: el motor no tiene dependencias de frontend.
 *
 * Oscuro por defecto porque la escena incluye abrir esto a las tres de la
 * madrugada; el claro no es un modo degradado, es la mañana.
 *
 * OJO al escribir comentarios DENTRO de la hoja: es un template literal, así
 * que un backtick ahí dentro la cierra a media hoja. No da un error de
 * sintaxis legible — deja al parser dando vueltas y `bun test` se cuelga
 * girando al 99% de CPU. Para citar una propiedad CSS en un comentario de
 * dentro, escríbela a pelo.
 */
export const STYLES = `
  :root {
    color-scheme: dark light;
    --bg: oklch(0.17 0.012 265);
    --rule: oklch(0.31 0.016 265);
    --hair: oklch(0.255 0.014 265);
    --ink: oklch(0.93 0.008 265);
    --dim: oklch(0.72 0.014 265);
    --faint: oklch(0.56 0.014 265);
    --well: oklch(0.21 0.014 265);
    --ok: oklch(0.80 0.14 158);
    --warn: oklch(0.80 0.14 80);
    --live: oklch(0.80 0.14 240);
    --bad: oklch(0.66 0.19 27);
    --bad-ink: oklch(0.80 0.13 30);
    --bad-bg: oklch(0.24 0.055 25);
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: oklch(0.985 0.003 265);
      --rule: oklch(0.895 0.008 265);
      --hair: oklch(0.93 0.006 265);
      --ink: oklch(0.25 0.015 265);
      --dim: oklch(0.47 0.014 265);
      --faint: oklch(0.62 0.012 265);
      --well: oklch(0.955 0.005 265);
      --ok: oklch(0.55 0.14 158);
      --warn: oklch(0.58 0.13 72);
      --live: oklch(0.55 0.15 250);
      --bad: oklch(0.53 0.20 27);
      --bad-ink: oklch(0.46 0.20 27);
      --bad-bg: oklch(0.965 0.022 25);
    }
  }

  body { margin: 0; padding: 34px 40px 30px; background: var(--bg); color: var(--ink);
         font: 14px/1.5 var(--sans); }
  a { color: inherit; text-decoration-color: var(--faint); text-underline-offset: 3px; }
  a:hover { text-decoration-color: var(--ink); }
  code, pre { font-family: var(--mono); }

  .top { display: flex; align-items: baseline; justify-content: space-between; padding-bottom: 22px; }
  .wordmark { font-family: var(--mono); font-size: 15px; font-weight: 700; letter-spacing: .14em;
              color: var(--dim); text-decoration: none; }
  .wordmark:hover { color: var(--ink); }
  .crumb { font-family: var(--mono); font-size: 12.5px; letter-spacing: .06em; color: var(--faint); }
  .stamp { font-size: 12.5px; color: var(--faint); }

  .headline { font-size: 27px; font-weight: 600; letter-spacing: -.015em; line-height: 1.25; text-wrap: pretty; }
  .headline.bad { color: var(--bad-ink); }
  .headline.warn { color: var(--warn); }
  .subhead { font-size: 13.5px; color: var(--faint); padding: 4px 0 26px; }

  .row { display: grid; grid-template-columns: 13px minmax(0,1fr) auto; gap: 0 17px;
         align-items: start; padding: 18px 0 17px; border-top: 1px solid var(--rule); }
  .dot { width: 9px; height: 9px; border-radius: 50%; margin-top: 7px; justify-self: center; background: var(--faint); }
  .dot.ok { background: var(--ok); } .dot.warn { background: var(--warn); }
  .dot.bad { background: var(--bad); } .dot.live { background: var(--live); }
  .name { font-family: var(--mono); font-size: 16.5px; font-weight: 600; letter-spacing: -.01em; }
  .verdict { font-size: 15.5px; font-weight: 500; line-height: 1.45; padding-top: 5px; text-wrap: pretty; }
  .verdict.ok { color: var(--ok); } .verdict.warn { color: var(--warn); }
  .verdict.bad { color: var(--bad-ink); } .verdict.live { color: var(--live); }
  .axes { font-size: 12.5px; color: var(--faint); padding-top: 7px; }
  .axes b { font-weight: 500; color: var(--dim); }
  .desc { font-size: 12.5px; line-height: 1.5; color: var(--faint); padding-top: 9px; max-width: 62ch; text-wrap: pretty; }
  .right { text-align: right; display: flex; flex-direction: column; gap: 5px; align-items: flex-end; padding-top: 2px; }
  .when { font-size: 13.5px; color: var(--dim); white-space: nowrap; }
  .when em { font-style: normal; color: var(--ink); }
  .cost { font-family: var(--mono); font-size: 12.5px; color: var(--faint); font-variant-numeric: tabular-nums; }

  .alarmbox { background: var(--bad-bg); border-left: 3px solid var(--bad); padding: 20px 24px 22px; margin-top: 18px; }
  .alarmhead { font-size: 20px; font-weight: 650; color: var(--bad-ink); letter-spacing: -.01em; padding: 9px 0 2px; }
  .alarmbody { font-size: 13.5px; line-height: 1.6; color: var(--dim); padding-top: 12px; max-width: 68ch; text-wrap: pretty; }
  .alarmbody code { color: var(--ink); }
  .tail { font-family: var(--mono); font-size: 11.5px; line-height: 1.65; color: var(--dim);
          background: var(--well); border: 1px solid var(--rule); padding: 11px 13px; margin-top: 10px;
          overflow-x: auto; white-space: pre; }

  h1 { font-family: var(--mono); font-size: 24px; font-weight: 650; letter-spacing: -.015em; margin: 0; }
  h2 { font-size: 11.5px; font-weight: 600; letter-spacing: .11em; text-transform: uppercase;
       color: var(--faint); margin: 34px 0 0; padding-bottom: 11px; border-bottom: 1px solid var(--rule); }
  h2 i { font-style: normal; text-transform: none; letter-spacing: 0; font-weight: 400; opacity: .8; }

  .meta { display: flex; gap: 34px; padding: 20px 0 4px; font-size: 12.5px; flex-wrap: wrap; }
  .meta span { display: block; color: var(--faint); font-size: 11px; letter-spacing: .06em;
               text-transform: uppercase; padding-bottom: 4px; }
  .meta b { font-weight: 500; }
  .meta em { font-style: normal; color: var(--dim); }

  /* Multicolumna y no rejilla: una rejilla de dos columnas reparte por FILAS
     (1 y 2 lado a lado), y los pasos son una secuencia — se leen bajando. Con
     columns el reparto es por columnas y se equilibra solo, sin que el CSS
     tenga que saber cuántos pasos hay. */
  .steps { columns: 2; column-gap: 40px; padding-top: 6px; }
  .step { break-inside: avoid; display: grid; grid-template-columns: 26px 1fr auto; gap: 0 10px;
          align-items: baseline; padding: 7px 0; border-bottom: 1px solid var(--hair); font-size: 13px; }
  .num { font-family: var(--mono); font-size: 11.5px; color: var(--faint); text-align: right; font-variant-numeric: tabular-nums; }
  .sid { font-family: var(--mono); }
  .kind { font-family: var(--mono); font-size: 10.5px; letter-spacing: .07em; text-transform: uppercase;
          color: var(--faint); border: 1px solid var(--rule); padding: 1px 6px; }
  .kind.agent { color: var(--warn); border-color: var(--warn); }

  .guard, .param { display: grid; grid-template-columns: 150px 1fr; gap: 0 16px;
                   padding: 13px 0; border-bottom: 1px solid var(--hair); }
  .gname { font-family: var(--mono); font-size: 13px; color: var(--warn); }
  .pname { font-family: var(--mono); font-size: 13px; }
  .gsay { font-size: 13px; line-height: 1.5; color: var(--dim); text-wrap: pretty; }
  .cmd { font-family: var(--mono); font-size: 11.5px; line-height: 1.7; color: var(--dim);
         background: var(--well); border-left: 2px solid var(--rule); padding: 10px 13px; margin: 9px 0 0;
         overflow-x: auto; white-space: pre-wrap; word-break: break-word; }

  .run { display: grid; grid-template-columns: 92px 52px 116px 1fr 74px; gap: 0 14px;
         align-items: baseline; padding: 10px 0; border-bottom: 1px solid var(--hair); font-size: 13px; }
  .rday { font-family: var(--mono); font-size: 12.5px; color: var(--dim); font-variant-numeric: tabular-nums; }
  .rtime { font-family: var(--mono); font-size: 12.5px; color: var(--faint); font-variant-numeric: tabular-nums; }
  .rstate { font-size: 13px; font-weight: 500; }
  .rnote { font-size: 12px; color: var(--faint); }
  .rcost { font-family: var(--mono); font-size: 12.5px; color: var(--dim); text-align: right; font-variant-numeric: tabular-nums; }
  .chip { font-family: var(--mono); font-size: 10.5px; letter-spacing: .07em; text-transform: uppercase;
          color: var(--warn); border: 1px solid var(--warn); padding: 1px 6px; }

  .colapso { background: var(--well); border-left: 2px solid var(--warn); padding: 15px 18px 16px; margin: 10px 0; }
  .cchead { font-size: 14px; font-weight: 600; color: var(--warn); }
  .ccwhy { font-size: 12.5px; color: var(--dim); padding-top: 5px; }
  .ccwhy code { color: var(--faint); word-break: break-word; }
  .ccdates { display: flex; flex-wrap: wrap; gap: 0 14px; padding-top: 11px;
             font-family: var(--mono); font-size: 12px; color: var(--faint); }

  .bigline { font-size: 24px; font-weight: 620; letter-spacing: -.015em; line-height: 1.2; }
  .bigwhy { font-size: 14.5px; line-height: 1.5; color: var(--dim); padding-top: 9px; max-width: 70ch; text-wrap: pretty; }
  .st { display: grid; grid-template-columns: 22px 200px 74px minmax(0,1fr) 62px 62px;
        gap: 0 12px; align-items: center; padding: 9px 0 8px; border-bottom: 1px solid var(--hair); }
  .st.note { border-bottom: 0; padding: 0 0 9px; }
  .id { font-family: var(--mono); font-size: 13px; white-space: nowrap; }
  .state { font-size: 12.5px; font-weight: 500; }
  .bar { height: 6px; background: var(--well); }
  .bar i { display: block; height: 6px; background: var(--ok); }
  .bar i.bad { background: var(--bad); }
  .dur, .stcost { font-family: var(--mono); font-size: 12px; color: var(--dim); text-align: right;
                  font-variant-numeric: tabular-nums; }
  .subnote { grid-column: 4 / -1; font-size: 11.5px; color: var(--faint); line-height: 1.5; word-break: break-word; }
  .subnote.err { color: var(--bad-ink); }

  .denial { background: var(--well); border-left: 2px solid var(--rule); padding: 13px 16px; margin-top: 12px; }
  .dtop { font-family: var(--mono); font-size: 12.5px; }
  .dwhy { font-family: var(--mono); font-size: 11.5px; line-height: 1.65; color: var(--dim);
          padding-top: 7px; word-break: break-word; }

  pre#log { font-size: 11.5px; line-height: 1.65; color: var(--dim); background: var(--well);
            border: 1px solid var(--rule); padding: 13px 16px; overflow-x: auto; }

  .s-success, .ok { color: var(--ok); }
  .s-failed, .bad { color: var(--bad-ink); }
  .s-skipped, .warnc { color: var(--warn); }
  .s-running, .livec { color: var(--live); }

  .foot { padding-top: 26px; margin-top: 22px; border-top: 1px solid var(--rule);
          font-size: 11.5px; color: var(--faint); display: flex; gap: 22px; flex-wrap: wrap; }
`;
