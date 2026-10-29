---
name: edit-pipeline
description: Use when someone wants to change an existing pipeline in an agentic-pipelines data repo. For example "change the time of the weekly report", "move it to 08:00", "also send me the summary", "remove the build step", "raise the spending cap", "set the repo param to ~/docs", or the same in any other language ("cambia la hora de…", "que también…", "quita el paso…", "sube el tope de gasto"). Makes the smallest change, validates it, and keeps an installed pipeline's scheduled job in step with the YAML, asking before reinstalling.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(pipelines validate *)
  - Bash(pipelines status *)
  - Bash(pipelines show *)
---

# Edit a pipeline

Change what the person asks for and nothing else, leave the pipeline valid, and leave its installation agreeing with the YAML.

<!-- shared:locate -->
## Before anything else

Do these three things once per conversation, before reading or writing any pipeline.

**1. Find the CLI.** In this order, and then use the same one for every command:

1. `pipelines`, if `command -v pipelines` prints a path.
2. Otherwise `bun run ~/agentic-pipelines/src/cli/index.ts`, if that file exists. It is where the pipelines-starter README puts the engine.
3. Otherwise, ask where the engine is checked out and use `bun run <engine>/src/cli/index.ts`.

A shell alias does not count, even if `command -v` reports one or you see it in a dotfile: the shell Claude Code runs commands in does not always load it. Below, `pipelines` stands for whichever command you found.

**2. Find the data repo.** Run `pipelines status --json`. The CLI decides which data repo it is (the `--repo` flag, else `PIPELINES_REPO`, else the nearest `pipelines.yaml` walking up from the current folder), and the `repo` field of its output is that path. Do not guess it from folder names.

- If the command fails with `No data repo found`, there is no data repo here (the session may be in the engine's own checkout, for example). Do not create or change any file. Say so, and offer two ways on: clone the starter (`git clone https://github.com/startcat/pipelines-starter`, into a folder the person chooses, and open Claude Code there), or point at an existing data repo with `pipelines --repo <path> status --json`.
- Before writing the first file, say which repo you are going to write in.

**3. Find the reference.** The `pipeline.yaml` format is documented in the engine's `docs/reference.md`. The engine is the folder three levels above the real path of `src/cli/index.ts`: `~/agentic-pipelines` for the second form above, and for the first, resolve the link with `realpath "$(command -v pipelines)"`. If `<engine>/docs/reference.md` is not there, fetch `https://raw.githubusercontent.com/startcat/agentic-pipelines/main/docs/reference.md` and say you are using the version on GitHub, which may be newer than the installed engine. Do not load the whole reference into the conversation: search it for the section you need and read that part. When the reference and your memory disagree, the reference and `pipelines validate` win.

**Ground rules, for everything this skill does:**

- Ask before `pipelines install`, `pipelines uninstall`, `pipelines run`, `pipelines resume` and any `--force`, every time, saying what the command will do. They schedule or unschedule a job, spend money on agent steps, or act outside the repo (a push, a comment, a message).
- `pipelines doctor` is not pre-approved: it starts the pipeline's MCP servers and checks the network, so Claude Code will ask the person before it runs.
- Never read, print or write `.env`, and never put a secret's value in any file or command. To know whether a secret is set, trust `pipelines doctor`. Say which variable is missing and that it goes in the data repo's `.env`; the person writes it.
- Never edit files the engine generates: the launchd plist, the systemd units, `.params.local.json`. Never call `launchctl` or `systemctl` yourself. A param of an installed pipeline changes with `pipelines install <name> --set key=value`.
- If the CLI cannot do what is asked (stop a run that is already running, pause for a few days), say so plainly instead of improvising with other tools.
- Answer in the language the person writes in.
<!-- /shared:locate -->

## 1. Find the pipeline and read it

The pipelines are the folders under `pipelines/` in the data repo (`pipelines status --json` lists them). If more than one could be the one meant, ask which. Read its `pipeline.yaml` and the files the change touches: the step prompts in `steps/`, the agents in `agents/` it names, the channels in `pipelines.yaml`.

Note its `trigger` in `pipelines status <name> --json` before changing anything: `installed` or `drifted` means a scheduled job exists for it.

## 2. Make the smallest change

Change only what was asked. Keep the file's style, order and comments.

Show the diff and wait for a yes before going on when the change touches what the pipeline is allowed to do or spend:

- the `tools` of an `agent` step, or the `mcp_servers` it enables (and a server's `allow` list);
- `max_cost_usd`;
- `cwd` or `additional_dirs` (where an agent can write, and what it can read);
- anything that acts outside the repo: a push, a comment, a message, a deploy.

A cadence goes in `triggers` as a cron (`"0 8 * * 1"` is Mondays at 08:00, machine time; ranges and `*/n` steps are not supported). A new secret goes in `requires.env` by name only; its value is for the person to put in `.env`. If the pipeline has `triggers` and `notify`, it keeps its `notify.stale_after`.

## 3. Validate

Run `pipelines validate <name>` and fix what it reports, explaining each fix in a sentence, until it passes. Do not leave a pipeline red: if a fix needs a decision from the person, ask, and say that the pipeline will fail validation until it is made. If the change adds a secret, a binary or an MCP server, propose `pipelines doctor <name>` so the person sees what this machine is missing.

## 4. Keep the installation coherent

The scheduler runs a job generated from the YAML at install time. Changing the YAML does not change that job.

- If the pipeline is installed (`trigger` was `installed` or `drifted`) and the change touched `triggers`, `requires.bin`, `mcp_servers` or a `throttle` guard, the job is now out of date: the dashboard marks it `drifted` and the scheduler keeps running the old one (at the old time, with the old `PATH`). Run `pipelines status <name> --json` again; whatever its `trigger` says, propose `pipelines install <name>` and explain why. Reinstall only after a yes. `pipelines install <name> --dry-run` shows what it would write.
- Other changes (a prompt, a step's `run`, `outputs`, `notify`) are read at every run and need no reinstall.
- A param of an installed pipeline changes with `pipelines install <name> --set key=value`, after a yes: it saves the value for scheduled runs, keeping the pipeline's other params, and reinstalls the job. Never edit `.params.local.json` by hand. For a pipeline without `triggers` (there is nothing to install), the value is passed on each run with `pipelines run <name> --set key=value`, or, if it is the same for everyone, it becomes the param's `default` in the YAML.
- If a scheduled job should stop, that is the `pipelines-status` skill: `pipelines uninstall <name>`, with permission.

## 5. Try it, if what an agent does has changed

If the change affects what an `agent` step does (its prompt, its tools, its inputs), propose a test run with `pipelines run <name>`, saying the most it can cost (the `max_cost_usd` of its agent steps) and what it will do outside the repo. Only after a yes. If it fails, read `pipelines show <name> <run-id>` and the failed step's log in `.runs/<name>/<run-id>/<step>.log`, fix, and validate again.

Finally, propose a commit with the changed files (never `.env`, `.params.local.json` or `.runs/`), and push only if the person asks.
