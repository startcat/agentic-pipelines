---
name: pipelines-status
description: Use when someone asks how the pipelines of an agentic-pipelines data repo are doing, or wants to stop or start one. For example "how are the pipelines doing?", "what failed?", "why did the weekly report fail?", "how much have I spent this month?", "what is installed?", "when does it run next?", "stop X", "start X". Triggers work in any language the person writes in. Reads the same overview as the dashboard, explains failures from the run's record and logs, and only installs or uninstalls with permission.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(pipelines validate *)
  - Bash(pipelines status *)
  - Bash(pipelines show *)
  - Bash(bun run ~/agentic-pipelines/src/cli/index.ts validate *)
  - Bash(bun run ~/agentic-pipelines/src/cli/index.ts status *)
  - Bash(bun run ~/agentic-pipelines/src/cli/index.ts show *)
---

# Pipelines status

Answer what is going on with the pipelines in a few lines, from the engine's own figures, and stop or start a pipeline only when the person says yes.

<!-- shared:locate -->
## Before anything else

Do these three things once per conversation, before reading or writing any pipeline.

**1. Find the CLI.** In this order, and then use the same one for every command:

1. `pipelines`, if `command -v pipelines` prints a path.
2. Otherwise `bun run ~/agentic-pipelines/src/cli/index.ts`, if that file exists. It is where the pipelines-starter README puts the engine.
3. Otherwise, ask where the engine is checked out and use `bun run <engine>/src/cli/index.ts`.

A shell alias does not count, even if `command -v` reports one or you see it in a dotfile: the shell Claude Code runs commands in does not always load it. Below, `pipelines` stands for whichever command you found.

`validate`, `status` and `show` are pre-approved in the first two forms. With `--repo`, or with the engine somewhere else, Claude Code asks each time; `bun link` in the engine's folder puts `pipelines` on the PATH once and for all.

**2. Find the data repo.** Run `pipelines status --json`. The CLI decides which data repo it is (the `--repo` flag, else `PIPELINES_REPO`, else the nearest `pipelines.yaml` walking up from the current folder), and the `repo` field of its output is that path. Do not guess it from folder names.

- If the command fails with `No data repo found`, there is no data repo here (the session may be in the engine's own checkout, for example). Do not create or change any file. Say so, and offer two ways on: clone the starter (`git clone https://github.com/startcat/pipelines-starter`, into a folder the person chooses, and open Claude Code there), or point at an existing data repo with `pipelines --repo <path> status --json`.
- If it fails with `unknown option '--json'`, the engine is older than this plugin. Say so, and that `git -C <engine> pull && bun install` updates it (`<engine>` is the folder from step 3; the person runs it, or you do after a yes). Until then, use plain `pipelines status` for this session: it lists the latest runs, but not the verdicts, the next runs or the spend, and it does not print the repo, so the data repo is the folder with the nearest `pipelines.yaml` walking up from the current one (or the `--repo` path, or `PIPELINES_REPO`, if one is set). Say which answers you cannot give with it.
- Before writing the first file, say which repo you are going to write in.

**3. Find the reference.** The `pipeline.yaml` format is documented in the engine's `docs/reference.md`. The engine is the folder three levels above the real path of `src/cli/index.ts`: `~/agentic-pipelines` for the second form above, and for the first, resolve the link with `realpath "$(command -v pipelines)"`. If `<engine>/docs/reference.md` is not there, fetch `https://raw.githubusercontent.com/startcat/agentic-pipelines/main/docs/reference.md` and say you are using the version on GitHub, which may be newer than the installed engine. Do not load the whole reference into the conversation: search it for the section you need and read that part. When the reference and your memory disagree, the reference and `pipelines validate` win.

**Ground rules, for everything this skill does:**

- Ask before `pipelines install`, `pipelines uninstall`, `pipelines run`, `pipelines resume` and any `--force`, every time, saying what the command will do. They schedule or unschedule a job, spend money on agent steps, or act outside the repo (a push, a comment, a message).
- `pipelines doctor` is not pre-approved: it starts the pipeline's MCP servers and checks the network, so Claude Code will ask the person before it runs.
- Never read, print or write `.env`, and never put a secret's value in any file or command. To know whether a secret is set, trust `pipelines doctor`. Say which variable is missing and that it goes in the data repo's `.env`; the person writes it.
- Never edit files the engine generates: the launchd plist, the systemd units, `.params.local.json`. Never call `launchctl` or `systemctl` yourself. A param of an installed pipeline changes with `pipelines install <name> --set key=value`.
- A param that is a path goes into `--set` as an absolute path: expand `~` to the home folder and resolve a relative path yourself, and say so. The engine saves the value as it is given, and a scheduled run uses it without expanding `~`, so `repo=~/docs` would break every run.
- Say times the way `pipelines status --json` labels them: `nextLabel` and `startedLabel`, in the machine's time zone (`timeZone`). The ISO fields are UTC and are not for saying.
- If the CLI cannot do what is asked (stop a run that is already running, pause for a few days), say so plainly instead of improvising with other tools.
- Answer in the language the person writes in.
<!-- /shared:locate -->

## The overview

`pipelines status --json` (or `pipelines status <name> --json` for one) gives the same verdicts, next runs and spend as the dashboard. Its fields:

- `summary`: `line` is the one-sentence answer, `sub` counts every category ("7 pipelines · 1 not triggered · 2 failing").
- `pipelines[]`: one entry each. A pipeline that cannot be read has only `name` and `error` (a folder without `pipeline.yaml`, a YAML that does not parse, a `run.json` cut short): say so and what to fix. The others have:
  - `verdict.line` and `verdict.tone` (`bad`, `warn`, `live`, `neutral`, `ok`);
  - `trigger`: `installed`, `drifted` (a job is loaded, but it no longer matches the YAML; with an empty `triggers` it is a job left behind after the schedule was removed, which still fires on the old cadence), `not-installed`, `disabled` or `no-trigger` (manual: no cron, and no job loaded);
  - `triggers`: the crons in the YAML, in the machine's time zone;
  - `work`: `working`, `failing`, `stuck`, `silent` or `never-worked`; `contradiction` is true when the job is loaded and nothing has run;
  - `lastRun`: `id`, `status`, `startedAt` (UTC) with `startedLabel` (local, as the dashboard says it: "today 07:00", "Mon 07:00"), `costUsd`, `forced` (guards skipped by hand) and `skipReason`, or `null`;
  - `next`: the next run as a UTC instant with `nextLabel` (local: "tomorrow 08:00"), or `null` with `nextReason`: `not-installed`, `disabled`, `manual` (no cron) or `unknown` (a job is loaded, but there is no cron it can be worked out from). Never make up a time for a `null`.
- `timeZone`: the machine's time zone, which crons and the labels are in. Say it when it may differ from the person's.
- `costs`: `month` (`label`, `total` in USD, `runs`, `withAgent`), `previous` (`label`, `total`) and `unreadableRuns`. It is always the whole repo's spend, even for one pipeline.

Answer with `summary.line` first, then one line per pipeline from worst to best (`bad`, `warn`, `live`, `neutral`, `ok`): its verdict, its last run (status and `startedLabel`) and its next run (`nextLabel`), or why there is none in words ("not installed", "manual"). Never say the ISO fields: they are UTC. Offer `pipelines web` to see it on the dashboard: the person starts it, because it is a server that keeps running.

"What is installed?" is the pipelines whose `trigger` is `installed` or `drifted`. For a `drifted` one, say that the scheduler is still running the old job and that `pipelines install <name>` (with permission) brings it in line; if its `triggers` is empty, the YAML no longer has a schedule and `pipelines uninstall <name>` (with permission) is what removes the old job.

## Why a run failed

1. Find the run: `lastRun.id` from the overview, or the run the person names. `pipelines show <name> <run-id>` prints its record: `status`, and per step `status`, `error`, `costUsd` and `denials`. `pipelines show <name> <run-id> <step>` prints one step.
2. Read the failed step's log, `.runs/<name>/<run-id>/<step>.log` in the data repo. It can be long: read its end first.
3. Name the cause, which is one of these:
   - **The machine is missing something** (`requires`): a secret, a binary, an agent, a host. The run never started, so there is no new run in `.runs/`; the job's log says what was missing (`~/Library/Logs/pipelines-<name>.log` on macOS, `~/.local/state/pipelines/logs/pipelines-<name>.log` on Linux; read its end). The fix is on the machine: say what is missing and where it goes, and propose `pipelines doctor <name>`.
   - **A guard held it back**: the run is `skipped`, not failed, and `skipReason` says which guard (`throttle`, `changed`, `shell`, `between`) or `already_running`. A `throttle` skip is normal. If a guard keeps skipping when it should not, the guard is the thing to change.
   - **The sandbox denied a tool**: the step has `denials` (a tool name and a reason, such as a write outside `cwd` or a tool the step was not given). Either the step needs that tool or folder (a change to `tools`, `cwd` or `additional_dirs`), or the prompt asked for something it should not do.
   - **The spending cap ran out**: the step's error mentions `error_max_budget_usd` or the budget, and its `costUsd` is about its `max_cost_usd`. Either raise the cap or give the agent less to do.
   - **A shell step failed**: the error says `exit code N` with the last lines of stderr, or `timed out after …`. The fix is in the command, or in what it depends on.
   - **The agent did not deliver its contract**: the error says `Contract not met` (a field missing or of the wrong type) or that the result is not valid JSON. The fix is usually in the step's prompt, which must ask for exactly the `outputs` fields.
   When a step has `denials` and also fails for another reason (often its `outputs` contract), the denial usually comes first: the agent could not do what it needed and then could not deliver. Name the denial as the cause.
4. Propose the fix. A change to the pipeline is the `edit-pipeline` skill. If it was a passing problem (a network error, a service down) and nothing needs to change, propose `pipelines resume <name> <run-id>`, which picks up from the failed step with the same params; it may spend money again, so only after a yes.

## Spend

Use `costs`: this month's total, the number of runs and how many had agent steps, and last month's total. Say that it only counts what the `agent` steps measure (shell steps and anything the pipeline pays for elsewhere are not in it), and, if `unreadableRuns` is not zero, that that many runs could not be read and are not in the sum. The dashboard's `/costs` page (`pipelines web`) has the same figures by pipeline and by day.

## Stop a pipeline

Stopping means taking it off the schedule, not cutting a run that is in progress (the CLI cannot do that; say so if that is what is asked).

1. Check `trigger` in `pipelines status <name> --json`. If the pipeline does not exist, say so and do nothing.
   - `installed` or `drifted`: a job is loaded on this machine, also when `triggers` is empty (a job left behind after the schedule was removed). Go to step 2.
   - `not-installed` or `no-trigger`: the scheduler has no job loaded for it on this machine. Say so, without claiming nothing runs it anywhere: it may be installed on another machine that shares this data repo, and `pipelines uninstall <name>` has to run there. If the person wants to make sure here anyway, `pipelines uninstall <name>` is harmless (it unloads and deletes whatever it finds, and does nothing otherwise): offer it, with permission.
   - `disabled`: the scheduler already does not fire it; offer to remove its job anyway.
2. Propose `pipelines uninstall <name>` and wait for a yes. Explain that it unloads and deletes the scheduled job only: the pipeline's files, its saved params and its run history stay, and `pipelines install <name>` puts it back.
3. Afterwards, `pipelines status <name> --json` should show `not-installed`.

## Start a pipeline

Starting means putting it on the schedule from its `triggers`.

1. If it has no `triggers`, there is nothing to schedule: say so, and offer `pipelines run <name>` (with permission) for one run now, or the `edit-pipeline` skill to give it a cadence. If it is already `installed`, say when it runs next.
2. `pipelines validate <name>` must pass. Then propose `pipelines doctor <name>`; what is red because of the machine is for the person to fix.
3. To see which params it still needs, propose `pipelines install <name> --dry-run` (it runs the same checks as an install, reads the saved params itself and writes nothing; it fails with `Missing required params` naming each one without a value). Then propose `pipelines install <name>`, with `--set key=value` only for those (paths absolute), and wait for a yes. Install from the engine checkout that is going to stay: the job keeps the path of the CLI it was installed with.
4. Afterwards, say when it runs next (`nextLabel` in `pipelines status <name> --json`).
