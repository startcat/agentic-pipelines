---
name: new-pipeline
description: Use when someone wants a new pipeline in an agentic-pipelines data repo, described in their own words. For example "I want a pipeline that reviews stale PRs and tells me", "automate the weekly report", "every Monday, do this", "create a pipeline", "schedule an agent that…", or the same in any other language ("quiero una pipeline que…", "automatiza…", "cada lunes haz…"). Interviews the person one question at a time, writes pipeline.yaml and its prompts, validates until green, and only runs or installs it with permission.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(pipelines validate *)
  - Bash(pipelines status *)
  - Bash(pipelines show *)
---

# New pipeline

Turn what someone describes in their own words into a pipeline that `pipelines validate` accepts, that they understand, and that only runs or gets scheduled when they say so.

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

## 1. Listen

If the person has not described the pipeline yet, ask for it in their words: what should happen, how often, and what they want to get out of it. Then look at the data repo (the `repo` path from `pipelines status --json`) so you can reuse what is there instead of inventing it:

- `pipelines/*/pipeline.yaml`: the pipelines it already has, and how they are written.
- `agents/*.md`: the agents an `agent` step can name.
- `pipelines.yaml`: the `channels` that `notify` can use.

## 2. Ask what is missing, one question per message

Ask only what changes the result, one question per message, and put your proposal in each question so the person can just say yes ("Mondays at 07:00, machine time — does that work?"). Skip whatever the description or the repo already answers. Do not ask more than about six questions before the summary: for anything still open, choose the safe default and say so in the summary.

In this order:

1. **When.** Cadence and time, in the machine's time zone (a `triggers` cron; ranges like `1-5` and steps like `*/15` are not supported). If the machine is asleep at that time, the scheduler runs it on wake; if it was off, a missed run is only caught up when the pipeline has a `throttle` guard. Propose `throttle` (a minimum gap between runs) or `changed` (only when a folder has new commits) when repeating the work would waste money or send the same notice twice.
2. **What it needs.** Binaries (`requires.bin`), secrets (`requires.env`, the names only, never the values; a name can depend on a param, like `QA_{{params.app}}_TOKEN`), MCP servers (`mcp_servers`) and hosts it must reach (`requires.net`).
3. **Where it works.** A clone of its own for the pipeline, or an existing folder it only reads. For an `agent` step, `cwd` is the only place it can write and `additional_dirs` are folders it can only read.
4. **What the agent may and may not do.** The `tools` it gets (without `tools` it gets `Read`, `Grep`, `Glob`; `Bash` is never allowed, a `shell` step runs commands instead), and whether it may push, comment or publish. Propose the minimum. An MCP server the engine does not know goes in `mcp_servers` with `kind: declared` and an `allow` list of the tools a step may use.
5. **How much it may spend.** `max_cost_usd` for each `agent` step, with a figure you propose for the task (a short summary is cents, an agent that reads a whole repo is more).
6. **What it delivers.** The `outputs` contract of each step and where the result ends up: a report, a commit, a message.
7. **When it tells someone.** `notify.on` (`failed`, `success`, `skipped`) on one of the repo's channels, and `stale_after`, so that days without a successful run raise a notice. `validate` asks for `stale_after` when the pipeline has `triggers` and `notify`.
8. **If it fails.** `retry` for transient errors, or whether a `pipelines resume` by hand is enough.
9. **Params or fixed values.** Whatever changes per machine or per person (paths, a repo, an environment) goes in `params`, never hardcoded in a `run` or a prompt.

## 3. Summarize and confirm

In one paragraph: what it will do, when, with which permissions (what it reads, what it writes, what it may send out) and the most it can cost per run. Wait for a yes before writing anything.

## 4. Write the files

Always in the data repo's layout, under the `repo` path:

- `pipelines/<name>/pipeline.yaml`, where `<name>` is kebab-case and equals the `name` field.
- `pipelines/<name>/steps/<step>.md`: the prompt of each `agent` step.
- `agents/<agent>.md`, only if no existing agent fits: YAML front matter with a `description`, and the agent's instructions as the body.

A complete example, to adapt rather than copy:

```yaml
name: stale-prs
description: Every Monday, lists the pull requests nobody has touched for a week and sends a short summary.
version: 1
params:
  repo_dir:
    description: Local clone of the repository whose pull requests are reviewed.
    required: true
requires:
  bin: [gh, jq]
  agents: [reviewer]
  net: [github.com]
when:
  - throttle: 144h
triggers:
  - cron: "0 7 * * 1"
notify:
  on: [failed, success]
  stale_after: 360h
  channel: email
steps:
  - id: list-prs
    type: shell
    cwd: "{{params.repo_dir}}"
    timeout: 2m
    run: |
      set -euo pipefail
      gh pr list --state open --json number,title,author,updatedAt,url \
        | jq -c '[.[] | select(.updatedAt < (now - 7 * 86400 | todate))] | {count: length, prs: tojson}'
    outputs:
      count: number
      prs: string
  - id: summarize
    agent: reviewer
    prompt: steps/summarize.md
    when: "{{list-prs.count}}"
    cwd: "{{params.repo_dir}}"
    tools: [Read, Grep, Glob]
    max_cost_usd: 0.5
    outputs:
      summary: string
```

Its `steps/summarize.md` would use `{{list-prs.prs}}` and ask for a JSON object with `summary`. Things worth copying from it: a `shell` step with `outputs` prints only the contract's JSON on stdout (noise goes to `>&2`); a multi-line `run` starts with `set -euo pipefail`; `{{...}}` references never go inside single quotes; the agent step is skipped when there is nothing to do.

## 5. Validate until green

Run `pipelines validate <name>` and fix every problem it reports, explaining each fix in a sentence. Repeat until it passes. The pipeline is not done, not run, not installed and not committed while `validate` is red. For a draft outside `pipelines/<name>/`, `pipelines validate --file <path>` checks it where it is.

Then propose `pipelines doctor <name>` (with `--set key=value` for params the secrets' names depend on). What is red because of the machine (a secret not in `.env`, a binary not installed, a host that does not resolve) is for the person to fix: say what is missing and where it goes, and do not try to fix it yourself.

## 6. Try it, with permission

Propose `pipelines run <name>` (with `--set key=value` for required params), saying the most it can cost (the sum of the `max_cost_usd` of its agent steps) and what it will do outside the repo (a push, a comment, a message on a channel). Only run it after a yes. If it fails, find the cause as the `pipelines-status` skill does (`pipelines show <name> <run-id>` and the failed step's log in `.runs/<name>/<run-id>/<step>.log`), go back to step 4, and validate again.

## 7. Install it, with permission

If it has `triggers`, propose `pipelines install <name>` (with `--set key=value` for its params; they are saved for scheduled runs), offering `pipelines install <name> --dry-run` first if the person wants to see what it will write. Only install after a yes. Install from the engine checkout that is going to stay: the job keeps the path of the CLI it was installed with. Afterwards, say when it will run next (the `next` field of `pipelines status <name> --json`) and that `pipelines web` shows it on the dashboard (the person starts it; it is a server that keeps running).

## 8. Remember git

The pipeline is a change to the data repo. Propose a commit with the new files (never `.env`, `.params.local.json` or `.runs/`), and push only if the person asks.
