/**
 * The viewer's stylesheet, as a constant. No logic and no templates: it is
 * text. It lives outside `render.ts` because it is a couple of hundred lines,
 * and `render.ts` already has enough on its plate with rendering.
 *
 * The look is the landing's: warm near-black, cream in the morning, one
 * terracotta accent. Three rules that are not decorative:
 *
 * - **If something has color, it is because it matters.** Everything else is
 *   the three warm grays (`--ink`, `--dim`, `--faint`). The accent marks where
 *   you are (section labels, the current nav item) and what went wrong; the
 *   calm states (`--ok`, `--warn`, `--live`) only ever paint a state.
 * - **Three families, each with one job.** Young Serif for the brand and the
 *   headline; Lexend for what we say to the person; Azeret Mono for what is a
 *   literal string from the machine (names, ids, crons, commands, paths,
 *   figures, uppercase labels). Which elements are monospace is decided in ONE
 *   rule below, not class by class, because the face comes with a duty: its
 *   "fi" ligature draws a dotless i ("docs-drift" reads "docs-drıft"), so
 *   every monospace element needs "liga" 0, and a list kept in two places
 *   drifts.
 * - **Nothing comes from the internet.** The three woff2 files (Latin subset,
 *   OFL, see fonts/OFL.txt) live next to this file and the server hands them
 *   out under /fonts/ from a fixed list. The engine has no frontend
 *   dependencies; a CDN font would make the viewer depend on the network to
 *   look right. Each family falls back to a system stack, so a missing file
 *   degrades the look, never the reading.
 *
 * Dark by default because the scene includes opening this at three in the
 * morning; light is not a degraded mode, it is the morning — the landing's
 * cream, with the amber and the blue darkened until they read at 4.5:1.
 *
 * CAREFUL when writing comments INSIDE the sheet: it is a template literal, so
 * a backtick in there closes it mid-sheet. It doesn't give a readable syntax
 * error — it leaves the parser spinning and `bun test` hangs at 99% CPU. To
 * quote a CSS property in a comment inside, write it bare.
 */
export const STYLES = `
  @font-face { font-family: "Young Serif"; src: url("/fonts/young-serif-400.woff2") format("woff2");
               font-weight: 400; font-style: normal; font-display: swap; }
  @font-face { font-family: "Lexend"; src: url("/fonts/lexend-var.woff2") format("woff2");
               font-weight: 100 900; font-style: normal; font-display: swap; }
  @font-face { font-family: "Azeret Mono"; src: url("/fonts/azeret-mono-var.woff2") format("woff2");
               font-weight: 100 900; font-style: normal; font-display: swap; }

  :root {
    color-scheme: dark light;
    --bg: #1c1916;
    --surface: #24201c;
    --well: #151210;
    --rule: #3a332c;
    --hair: #2d2823;
    --ink: #f3ece3;
    --dim: #bfb09c;
    --faint: #8f806e;
    --accent: #e26b41;
    --bad-ink: #f08a62;
    --bad-bg: #2a1f1a;
    --ok: #8dbe78;
    --warn: #e3b23c;
    --live: #9ab8d6;
    --empty: #2d2823;
    --lnum: #5c5246;
    --serif: "Young Serif", Georgia, serif;
    --sans: "Lexend", system-ui, -apple-system, "Segoe UI", sans-serif;
    --mono: "Azeret Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #faf6f1;
      --surface: #fffdf9;
      --well: #f3ece3;
      --rule: #d3c3ae;
      --hair: #e7dcce;
      --ink: #1a1714;
      --dim: #5c544c;
      --faint: #6e5d4a;
      --accent: #b4441f;
      --bad-ink: #9e3a19;
      --bad-bg: #f7e6dc;
      --ok: #3f6930;
      --warn: #8a6410;
      --live: #3f6a93;
      --empty: #e7dcce;
      --lnum: #a8977f;
    }
  }

  body { margin: 0; padding: 34px 40px 30px; background: var(--bg); color: var(--ink);
         font: 14px/1.5 var(--sans); }
  a { color: inherit; text-decoration: none; }
  a:hover { text-decoration: underline; text-decoration-color: var(--faint); text-underline-offset: 3px; }

  /* The ONE place that says what is monospace (see the header comment). A new
     class that shows a literal machine string joins this list; .mono is there
     for markup that has no class of its own. */
  code, pre, .mono, .crumb, .name, .cost, .tail, .alarmhead, h1, h2, .meta span,
  .num, .sid, .kind, .chip, .gname, .pname, .cmd, .rday, .rtime, .rcost, .ccdates,
  .id, .dur, .stcost, .subnote, .dtop, .dwhy, .clabel, .cbig, .cval, .cmlab, .caxis, .cprow, .rpipe,
  .sfig, .hintcode, .oname, .otype, .nstep {
    font-family: var(--mono); font-feature-settings: "liga" 0;
  }

  /* Header: the brand on the left, the nav on the right and a little lower,
     as on the landing. The headline starts right below its 60 px. */
  .top { display: flex; align-items: flex-start; justify-content: space-between; min-height: 60px; }
  .brand { display: flex; align-items: center; gap: 10px; font-family: var(--serif); font-size: 19px;
           line-height: 1; color: var(--ink); }
  .brand:hover { text-decoration: none; }
  .brand svg { display: block; width: 28px; height: 28px; border-radius: 8px; }
  .nav { display: flex; gap: 22px; margin-top: 13.5px; font-size: 13px; line-height: 20px; }
  .nav a { color: var(--faint); padding-bottom: 3px; border-bottom: 2px solid transparent; }
  .nav a:hover { color: var(--ink); text-decoration: none; }
  .nav a[aria-current="page"] { color: var(--ink); border-bottom-color: var(--accent); }

  .crumb { font-size: 12.5px; letter-spacing: .06em; color: var(--faint); padding-bottom: 8px; }
  .crumb a { color: var(--faint); }
  .crumb a.up { color: var(--dim); }
  .crumb .sep { color: var(--rule); margin: 0 6px; }

  .headline { font-family: var(--serif); font-size: 32px; font-weight: 400; letter-spacing: -.01em;
              line-height: 38px; text-wrap: pretty; }
  /* The healthy headline is ink, not green: green paints a row's state, and
     the bare .ok rule further down would otherwise take the headline too. */
  .headline.ok { color: var(--ink); }
  .headline.bad { color: var(--bad-ink); }
  .headline.warn { color: var(--warn); }
  .headline.neutral { color: var(--dim); }
  .subhead { font-size: 13.5px; line-height: 20px; color: var(--faint); padding: 4px 0 26px; }

  /* The month's spend, between the subtitle and the rows. It sits on the
     subtitle's bottom padding so the rows do not move down a whole line. */
  .spend { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 26px; margin: -12px 0 14px;
           padding: 3px 10px; background: var(--surface); border: 1px solid var(--rule);
           font-size: 13px; line-height: 20px; color: var(--faint); }
  .sfig { font-size: 15px; font-weight: 500; line-height: 23px; color: var(--ink); font-variant-numeric: tabular-nums; }
  .sfig.prev { color: var(--dim); }
  .sruns { flex: 1 1 auto; }
  .smore { color: var(--dim); white-space: nowrap; }

  /* An empty repo: where a pipeline lives and how to check one. */
  .hint { max-width: 640px; box-sizing: border-box; padding: 14px 16px; border: 1px solid var(--rule);
          display: flex; flex-direction: column; gap: 10px; margin-top: 24px; }
  .hint p { margin: 0; font-size: 13.5px; line-height: 21px; color: var(--dim); text-wrap: pretty; }
  .hint p.hintmore { color: var(--faint); }
  .hintcode { display: flex; flex-direction: column; gap: 3px; padding: 10px 12px; background: var(--well);
              font-size: 12.5px; line-height: 19px; color: var(--dim); overflow-x: auto; white-space: pre; }
  .hintcode .cmdline { color: var(--ink); }

  .row { display: grid; grid-template-columns: 13px minmax(0,1fr) auto; gap: 0 17px;
         align-items: start; padding: 19px 0 17px; border-top: 1px solid var(--rule); }
  .dot { width: 9px; height: 9px; border-radius: 50%; margin-top: 7px; justify-self: center; background: var(--faint); }
  .dot.ok { background: var(--ok); } .dot.warn { background: var(--warn); }
  .dot.bad { background: var(--accent); } .dot.live { background: var(--live); }
  .name { font-size: 15.5px; font-weight: 500; letter-spacing: -.01em; line-height: 23px; }
  .verdict { font-size: 15.5px; font-weight: 400; line-height: 22px; padding-top: 5px; text-wrap: pretty; }
  .verdict.ok { color: var(--ok); } .verdict.warn { color: var(--warn); }
  .verdict.bad { color: var(--bad-ink); } .verdict.live { color: var(--live); }
  /* A run in progress: one 4 px segment per declared step, 260 px in all. */
  .progress { display: flex; gap: 3px; width: 260px; max-width: 100%; padding-top: 7px; }
  .progress i { flex: 1 1 0; height: 4px; background: var(--empty); }
  .progress i.ok { background: var(--ok); } .progress i.bad { background: var(--accent); }
  .progress i.skip { background: var(--faint); } .progress i.live { background: var(--live); }
  .axes { font-size: 12.5px; line-height: 19px; color: var(--faint); padding-top: 7px; }
  .axes b { font-weight: 400; }
  .desc { font-size: 12.5px; line-height: 19px; color: var(--faint); padding-top: 9px; max-width: 470px; text-wrap: pretty; }
  .right { text-align: right; display: flex; flex-direction: column; gap: 5px; align-items: flex-end; padding-top: 2px; }
  .when { font-size: 13.5px; line-height: 20px; color: var(--dim); white-space: nowrap; }
  .when em { font-style: normal; }
  .next { font-size: 12.5px; line-height: 19px; color: var(--faint); white-space: nowrap; }
  .next.bad { color: var(--bad-ink); }
  .cost { font-size: 12.5px; line-height: 19px; color: var(--faint); font-variant-numeric: tabular-nums; }

  .alarmbox { background: var(--bad-bg); border-left: 3px solid var(--accent); padding: 18px 22px 20px; margin: 0 0 14px; }
  .row + .alarmbox { margin-top: 14px; }
  .alarmtop { display: flex; align-items: center; gap: 14px; }
  .alarmtop .dot { margin-top: 0; }
  .alarmhead { font-size: 11.5px; font-weight: 500; letter-spacing: .14em; text-transform: uppercase;
               color: var(--accent); padding-top: 10px; }
  .alarmbody { font-size: 13.5px; line-height: 21px; color: var(--dim); padding-top: 10px; max-width: 760px; text-wrap: pretty; }
  .alarmbody code { color: var(--ink); }
  .tail { font-size: 12.5px; line-height: 1.55; color: var(--dim); background: var(--well);
          padding: 12px 14px; margin: 10px 0 0; overflow-x: auto; white-space: pre; }

  h1 { font-size: 26px; font-weight: 500; letter-spacing: -.01em; line-height: 1.5; margin: 0; }
  h2 { font-size: 11.5px; font-weight: 500; letter-spacing: .14em; text-transform: uppercase;
       color: var(--accent); margin: 34px 0 0; padding-bottom: 11px; border-bottom: 1px solid var(--rule); }
  h2 i { font-style: normal; text-transform: none; }
  /* What a section holds, said once in its title line, quieter than the title. */
  h2 small { font-size: 11.5px; font-weight: 400; letter-spacing: .04em; text-transform: none;
             color: var(--faint); margin-left: 10px; }

  /* A run's title: when it started, and a quiet note if someone forced it. */
  .titleline { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 16px; padding-top: 6px; }
  .tkind { font-size: 13px; color: var(--faint); }

  .meta { display: flex; gap: 34px; padding: 20px 0 4px; font-size: 12.5px; line-height: 19px; flex-wrap: wrap; }
  .meta span { display: block; color: var(--faint); font-size: 11px; line-height: 17px; letter-spacing: .12em;
               text-transform: uppercase; padding-bottom: 4px; }
  .meta b { font-weight: 500; }
  .meta em { font-style: normal; color: var(--dim); }
  .meta em.warnc { color: var(--warn); }
  /* The spending cap: one line per agent step, each with its own bar. */
  .caps { display: flex; flex-direction: column; }
  .caprow { display: flex; align-items: center; gap: 8px; }
  .captrack { width: 80px; height: 4px; border-radius: 2px; background: var(--empty); }
  .captrack i { display: block; height: 4px; border-radius: 2px; background: var(--dim); }
  .captrack i.bad { background: var(--accent); }

  /* Multi-column and not a grid: a two-column grid distributes by ROWS
     (1 and 2 side by side), and the steps are a sequence — they read going
     down. With columns the split is by column and balances itself, without the
     CSS having to know how many steps there are. */
  .steps { columns: 2; column-gap: 40px; padding-top: 6px; }
  .step { break-inside: avoid; display: grid; grid-template-columns: 26px 1fr auto; gap: 0 10px;
          align-items: baseline; padding: 8px 0; border-bottom: 1px solid var(--hair); font-size: 13px; }
  .num { font-size: 11.5px; color: var(--faint); text-align: right; font-variant-numeric: tabular-nums; }
  .sid { font-size: 13px; }
  .kind { font-size: 10.5px; letter-spacing: .07em; text-transform: uppercase;
          color: var(--faint); border: 1px solid var(--rule); padding: 1px 6px; }
  .kind.agent { color: var(--warn); border-color: var(--warn); }

  .guard, .param { display: grid; grid-template-columns: 150px 1fr; gap: 0 16px;
                   padding: 13px 0; border-bottom: 1px solid var(--hair); }
  .gname { font-size: 13px; line-height: 20px; color: var(--warn); }
  .pname { font-size: 13px; line-height: 20px; }
  .gsay { font-size: 13px; line-height: 20px; color: var(--dim); text-wrap: pretty; }
  .cmd { font-size: 12px; line-height: 1.6; color: var(--dim);
         background: var(--well); border-left: 2px solid var(--rule); padding: 10px 13px; margin: 9px 0 0;
         overflow-x: auto; white-space: pre-wrap; word-break: break-word; }

  .run { display: grid; grid-template-columns: 92px 52px 116px 1fr 74px; gap: 0 14px;
         align-items: baseline; padding: 10px 0; border-bottom: 1px solid var(--hair); font-size: 13px; }
  .rday { font-size: 12.5px; color: var(--dim); font-variant-numeric: tabular-nums; }
  .rtime { font-size: 12.5px; color: var(--faint); font-variant-numeric: tabular-nums; }
  .rstate { font-size: 13px; font-weight: 500; }
  .rnote { font-size: 12px; color: var(--faint); }
  .rcost { font-size: 12.5px; color: var(--dim); text-align: right; font-variant-numeric: tabular-nums; }
  .chip { font-size: 10.5px; letter-spacing: .07em; text-transform: uppercase;
          color: var(--warn); border: 1px solid var(--warn); padding: 1px 6px; }

  .colapso { background: var(--surface); border-left: 2px solid var(--warn); padding: 15px 18px 16px; margin: 10px 0; }
  .cchead { font-size: 14px; font-weight: 500; color: var(--warn); }
  .ccwhy { font-size: 12.5px; color: var(--dim); padding-top: 5px; }
  .ccwhy code { color: var(--faint); word-break: break-word; }
  .ccdates { display: flex; flex-wrap: wrap; gap: 0 14px; padding-top: 11px; font-size: 12px; color: var(--faint); }

  .bigline { font-size: 15.5px; font-weight: 400; line-height: 22px; padding-top: 8px; text-wrap: pretty; }
  .bigline code { font-size: 14.5px; }
  .bigwhy { font-size: 14px; line-height: 1.5; color: var(--dim); padding-top: 9px; max-width: 70ch; text-wrap: pretty; }
  /* One step per row; its note (error, skip reason or tools) on a second line
     under the id, inside the same row so the rule runs below both. */
  .st { display: grid; grid-template-columns: 14px 190px 80px minmax(0,1fr) 70px 56px;
        gap: 4px 14px; align-items: center; padding: 11px 0; border-bottom: 1px solid var(--hair); }
  .id { font-size: 13px; white-space: nowrap; display: flex; align-items: center; gap: 10px; }
  .id .kind { padding: 0 6px; }
  .state { font-size: 13px; font-weight: 500; }
  .bar { height: 6px; border-radius: 3px; background: var(--empty); }
  .bar i { display: block; height: 6px; border-radius: 3px; background: var(--faint); }
  .bar i.max { background: var(--dim); }
  .bar i.bad { background: var(--accent); }
  .dur, .stcost { font-size: 12.5px; color: var(--dim); text-align: right; font-variant-numeric: tabular-nums; }
  .stcost { color: var(--ink); }
  .subnote { grid-column: 2 / -1; font-size: 12px; color: var(--faint); line-height: 1.5; word-break: break-word; }
  .subnote.err { color: var(--bad-ink); }

  .denial { background: var(--bad-bg); border-left: 2px solid var(--accent); padding: 12px 16px; margin-top: 12px; }
  .dtop { font-size: 12.5px; }
  .dsep { color: var(--faint); margin: 0 8px; }
  .dtool { color: var(--bad-ink); }
  .dsrc { color: var(--faint); }
  .dwhy { font-size: 12px; line-height: 1.6; color: var(--dim); padding-top: 7px; word-break: break-word; }

  /* What an agent step handed on: the key and its type, then the value. */
  .out { display: grid; grid-template-columns: 180px minmax(0,1fr); gap: 0 16px; align-items: baseline;
         padding: 12px 0; border-bottom: 1px solid var(--hair); }
  .okey { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .oname { font-size: 13px; overflow-wrap: anywhere; }
  .otype { font-size: 11px; color: var(--faint); white-space: nowrap; }
  .oval { font-size: 13px; line-height: 20px; color: var(--dim); white-space: pre-wrap; overflow-wrap: anywhere; }

  /* A step's page. Under its state, the way to the steps either side; the
     end that has none is drawn in the line colour, there but not a way. */
  .stepnav { display: flex; flex-wrap: wrap; gap: 6px 28px; padding-top: 24px; font-size: 12.5px; line-height: 19px; }
  .stepnav a, .stepnav .none { display: inline-flex; align-items: baseline; gap: 6px; }
  .stepnav .lbl, .stepnav .arr { color: var(--faint); }
  .stepnav .arr { font-size: 13px; }
  .stepnav .nstep { color: var(--dim); }
  .stepnav .none, .stepnav .none .arr { color: var(--rule); }
  h2.logh { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; margin-top: 28px; padding-bottom: 9px; }
  h2.logh small { margin-left: 0; }
  .rawlink { margin-left: auto; font-family: var(--sans); font-feature-settings: normal; font-size: 12.5px;
             font-weight: 400; letter-spacing: 0; text-transform: none; color: var(--dim); white-space: nowrap; }
  .logtail { font-size: 12.5px; color: var(--faint); margin: 10px 0; }
  /* The log: one span per line, numbered by a counter and not by the markup,
     so a selection copies the log without its gutter. The server resets the
     counter to the line before the first one shown (a truncated log starts
     mid-file) and sets the gutter width in ch for the largest number. */
  .log { margin: 0; padding: 14px 18px; background: var(--well); border-bottom: 1px solid var(--hair);
         font-size: 12.5px; line-height: 18px; color: var(--dim); overflow-x: auto; white-space: pre; }
  .log > span { display: block; }
  .log > span::before { counter-increment: ln; content: counter(ln); display: inline-block; width: var(--lnw, 3ch);
                        margin-right: 18px; text-align: right; font-size: 12px; color: var(--lnum);
                        -webkit-user-select: none; user-select: none; }
  .log > .warn { color: var(--warn); }
  .log > .bad { color: var(--bad-ink); }
  .log:empty { display: none; }
  .lognone { font-size: 13px; color: var(--faint); margin: 12px 0 0; }
  .log:not(:empty) + .lognone { display: none; }

  .s-success, .ok { color: var(--ok); }
  .s-failed, .bad { color: var(--bad-ink); }
  .s-skipped { color: var(--faint); }
  .warnc { color: var(--warn); }
  .s-running { color: var(--live); }

  /* Costs. The bars are divs sized in %, no SVG: the tokens paint them in
     both themes. The past is the calm gray, the present month the accent,
     what is still to come the empty track. */
  h1.ctitle { font-family: var(--serif); font-size: 34px; font-weight: 400; letter-spacing: -.01em; line-height: 51px; }
  .cfigs { display: flex; flex-wrap: wrap; gap: 24px 44px; padding: 22px 0 6px; }
  .cfig { display: flex; flex-direction: column; align-items: flex-start; gap: 5px; }
  .clabel { font-size: 11px; line-height: 17px; letter-spacing: .12em; text-transform: uppercase;
            color: var(--faint); padding-bottom: 5px; }
  .cbig { font-size: 30px; font-weight: 500; letter-spacing: -.02em; line-height: 45px; color: var(--ink);
          font-variant-numeric: tabular-nums; }
  .cval { font-size: 20px; font-weight: 500; letter-spacing: -.02em; line-height: 30px; color: var(--dim);
          font-variant-numeric: tabular-nums; }
  .csub { font-size: 12px; line-height: 18px; color: var(--faint); padding-top: 4px; }
  .cmonths { display: flex; align-items: flex-end; gap: 10px; padding-top: 10px; }
  .cm { width: 34px; display: flex; flex-direction: column; align-items: center; gap: 6.5px; }
  .cmbar { height: 52px; width: 100%; display: flex; align-items: flex-end; }
  .cmbar i { display: block; width: 100%; min-height: 2px; background: var(--rule); }
  .cm.now .cmbar i { background: var(--accent); }
  .cmlab { font-size: 10.5px; line-height: 16px; color: var(--faint); }
  .cm.now .cmlab { color: var(--ink); }

  .cdays { display: flex; gap: 4px; height: 150px; padding-top: 18px; }
  .cday { flex: 1 1 0; min-width: 0; display: flex; align-items: flex-end; }
  .cday i { display: block; width: 100%; background: var(--dim); }
  .cday.today i { outline: 1px solid var(--ink); }
  .cday.future i { height: 6px; background: var(--empty); }
  .caxis { display: flex; gap: 4px; padding-top: 7px; font-size: 10.5px; line-height: 16px; color: var(--faint); }
  .caxis span { flex: 1 1 0; min-width: 0; text-align: center; white-space: nowrap; }
  .clegend { display: flex; flex-wrap: wrap; gap: 4px 20px; padding-top: 12px; font-size: 12px; line-height: 18px; color: var(--faint); }

  .cprow { display: grid; grid-template-columns: 200px minmax(0,1fr) 70px 90px 80px; gap: 0 16px;
           align-items: center; padding: 11px 0; border-bottom: 1px solid var(--hair); }
  .cphead { padding: 11px 0; font-size: 11px; line-height: 17px; letter-spacing: .12em; text-transform: uppercase;
            color: var(--faint); }
  .cphead span:nth-child(n+3) { text-align: right; }
  .cpname { font-size: 13px; line-height: 20px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cptrack { display: block; height: 8px; background: var(--empty); }
  .cptrack i { display: block; height: 8px; background: var(--accent); }
  .cpnum { font-size: 12.5px; line-height: 19px; color: var(--dim); text-align: right; font-variant-numeric: tabular-nums; }
  .cptotal { font-size: 13px; line-height: 20px; color: var(--ink); text-align: right; font-variant-numeric: tabular-nums; }
  .cprow.zero .cpname, .cprow.zero .cpper, .cprow.zero .cptotal { color: var(--faint); }
  .rpipe { font-size: 12px; color: var(--faint); }
  .cnone { font-size: 13px; color: var(--faint); margin: 12px 0 0; }
  .cnote { font-size: 12.5px; line-height: 20px; color: var(--faint); max-width: 600px; margin: 34px 0 0; text-wrap: pretty; }

  .foot { padding-top: 27px; margin-top: 22px; border-top: 1px solid var(--rule);
          font-size: 11.5px; line-height: 17px; color: var(--faint); display: flex; gap: 22px; flex-wrap: wrap; }
`;
