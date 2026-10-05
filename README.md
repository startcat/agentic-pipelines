# agentic-pipelines

An engine for agentic pipelines that run unattended. You declare a pipeline in
YAML as a graph of steps: plain `shell` steps, and `agent` steps that hand the
work to an AI agent (through the Claude Agent SDK) inside a filesystem sandbox
enforced by the engine itself, not by the SDK. `launchd` fires each pipeline
on schedule, the engine runs it, stores every run on disk, and notifies you
when it finishes.

This repository is **the engine**. It ships no pipelines of its own: yours
live in a separate **data repo** that you create, and the engine loads it at
run time by locating its `pipelines.yaml`.

This README is the user guide. The exhaustive reference for `pipeline.yaml`,
the commands and what gets persisted is in [`docs/reference.md`](docs/reference.md).

> **Status.** Version 0.1.0. **macOS only for now**: scheduling is done through
> `launchd`, and there is no systemd or crontab backend yet. CLI messages and
> code comments are currently in Spanish; the documentation is in English.

## Table of contents

- [How it fits together](#how-it-fits-together)
- [What happens during a run](#what-happens-during-a-run)
- [What an `agent` step does](#what-an-agent-step-does)
- [Installation](#installation)
- [Your first pipeline in ten minutes](#your-first-pipeline-in-ten-minutes)
- [Operating day to day](#operating-day-to-day)
- [Putting a pipeline on a schedule](#putting-a-pipeline-on-a-schedule)
- [Writing pipelines that survive the night](#writing-pipelines-that-survive-the-night)
- [Developing the engine](#developing-the-engine)
- [Further reading](#further-reading)
- [License](#license)

## How it fits together

[![agentic-pipelines architecture](docs/diagramas/arquitectura.svg)](docs/diagramas/arquitectura.html)

*Interactive version: [`docs/diagramas/arquitectura.html`](docs/diagramas/arquitectura.html)
(open locally; it has zoom, search and guided views).*

There are three separate places involved, and it pays to keep them apart in
your head:

| Place | What it holds | Who changes it |
|---|---|---|
| **The engine** (this repo) | Schema, runner, CLI, filesystem guard, linter | Whoever adds a capability to the engine |
| **The data repo** (yours) | One directory per pipeline with its `pipeline.yaml`, the prompts for its `agent` steps, the agents, and the notification channel scripts | Whoever adds or changes a pipeline |
| **Outside both** | The `launchd` plists, each pipeline's workspaces, the `.runs/` history | The engine, when installing and running |

The third one is what you won't see by reading code, and it's where to look
when something doesn't add up. See [Operating day to day](#operating-day-to-day).

The engine assumes nothing about what a pipeline does: it only knows how to
execute the contract that `pipeline.yaml` describes. Each step declares its
`inputs` and `outputs`, the engine builds the graph, validates every output
against its contract before passing it to the next step, and a set of guards
decides whether the run starts at all.

## What happens during a run

[![Lifecycle of a run](docs/diagramas/ciclo-de-un-run.svg)](docs/diagramas/ciclo-de-un-run.html)

*Interactive version: [`docs/diagramas/ciclo-de-un-run.html`](docs/diagramas/ciclo-de-un-run.html).*

1. **Trigger.** `launchd` at the cron time, or someone running `pipelines run`.
2. **Preflight.** Three checks, in this order:
   - `requires` checks whether **this machine** can run the pipeline
     (binaries, agents, secrets, network). If anything is missing, the run
     fails.
   - The per-pipeline **lock**. If a run is already in progress, the command
     exits with code 3.
   - The `when` guards check whether **today is the day** (`throttle`,
     `changed`, `shell`, `between`). If any of them doesn't pass, the run ends
     as `skipped`, with exit code 0. That's not an error: it's the normal
     outcome on half the nights of a pipeline with a `throttle`.
3. **Steps.** In the order the graph dictates. A `shell` step runs with
   `sh -c` in a narrow, fixed environment; an `agent` step opens a governed
   session (see the next section). A step with `outputs:` must write exactly
   the JSON of its contract to stdout.
4. **Wrap-up.** The steps under `always:` run every time, on success or
   failure. Then the `notify` channel receives the result, if `notify.on`
   includes it or if the pipeline has gone too long without a success
   (`stale_after`).
5. **Result.** A `success` anchors the `throttle` of the next run. A `failed`
   run stores the last lines of the failing step's stderr in that step's
   `error`, and can be resumed with `pipelines resume <name> <run-id>`.

Everything lands in `.runs/<pipeline>/<run-id>/` inside the data repo: a
`run.json` with the full record and one `<step>.log` per step, with secrets
already redacted.

## What an `agent` step does

[![Anatomy of an agent step](docs/diagramas/paso-agent.svg)](docs/diagramas/paso-agent.html)

*Interactive version: [`docs/diagramas/paso-agent.html`](docs/diagramas/paso-agent.html).*

An `agent` step runs with nobody around to approve permissions, so the SDK
runs in `bypassPermissions` mode. **The real control belongs to the engine**,
not the SDK:

- `tools:` is a closed list, deny by default. `Bash` and any form of
  arbitrary code execution are always forbidden. If a step needs to run
  commands, it should be a `shell` step.
- A custom `PreToolUse` hook rules on every call: `cwd` is the only
  **write** root; `additional_dirs` widens **read** access only. Every denial
  is recorded in the run.
- `strictMcpConfig: true` and `settingSources: []`: no MCP server and no
  ambient `settings.json` from the machine leaks into the session. Only the
  `mcp_servers` the step declares.
- The agent's `outputs` are validated against the step's contract just like
  a `shell` step's; `max_cost_usd` stops the step if it goes over budget.

Full details in [The security model](docs/reference.md#the-security-model).

## Installation

You need **Bun** (tested with 1.3.9), a compatible **Node** on the `PATH`,
`git`, and an authenticated Claude Code session on any machine that will run
`agent` steps. Full list in [Requirements and environment](docs/reference.md#requirements-and-environment).

```bash
git clone https://github.com/startcat/agentic-pipelines.git
cd agentic-pipelines
bun install
bun run src/cli/index.ts --help
```

There's no build step: the CLI runs directly on Bun. To have it available as
`pipelines` on your `PATH`, link the binary declared in `package.json` with
your package manager, or create an alias:

```bash
alias pipelines="bun run /path/to/agentic-pipelines/src/cli/index.ts"
```

Always install from the checkout you intend to keep: the `launchd` plists
freeze the absolute path of `index.ts` at the moment you run
`pipelines install`.

## Your first pipeline in ten minutes

A data repo is a directory with a `pipelines.yaml` at its root. Let's create
one with two pipelines: one that's shell only, and one that adds an `agent`
step. Both examples in this section have been checked against the real CLI.

### 1. A minimal data repo

```bash
mkdir -p my-pipelines/pipelines/hello-world my-pipelines/agents
cd my-pipelines
echo 'channels: {}' > pipelines.yaml
printf '.env\n.params.local.json\n.runs/\n' > .gitignore
```

`pipelines.yaml` can be almost empty, but it has to exist: it's the marker the
engine uses to find the repo root by walking up directories. The three
entries in `.gitignore` are files the engine generates or reads, and they
must never be committed.

Once it grows, a data repo looks like this:

```
my-pipelines/
  pipelines.yaml              # channels, and optionally defaults
  .env                        # secrets (gitignored)
  .params.local.json          # local params, written by `install` (gitignored)
  agents/
    <agent-name>.md           # YAML front matter + Markdown prompt
  pipelines/
    <pipeline-name>/
      pipeline.yaml
      steps/
        <step>.md             # prompts for `agent` steps, by convention
  scripts/
    <notify-channel>.sh       # scripts invoked by `channels.<x>.run`
  .runs/                      # generated by the engine (gitignored)
  .gitignore                  # must include .env, .params.local.json, .runs/
```

### 2. A shell-only pipeline

`pipelines/hello-world/pipeline.yaml`:

```yaml
name: hello-world
description: Minimal example pipeline, shell only.
version: 1

params:
  name:
    description: Who to greet.
    default: world

requires:
  bin: [jq]

steps:
  - id: greet
    type: shell
    run: |
      set -euo pipefail
      echo "greeting {{params.name}}" >&2
      jq -n --arg n "{{params.name}}" '{message: ("hello, " + $n)}'
    outputs:
      message: string

  - id: count
    type: shell
    inputs: [greet.message]
    run: |
      set -euo pipefail
      n=$(printf '%s' "{{greet.message}}" | wc -c | tr -d ' ')
      jq -n --arg n "$n" '{chars: ($n | tonumber)}'
    outputs:
      chars: number
```

Notice three things that are conventions in every pipeline:

- **`name` matches the directory name.** If it doesn't, `validate` fails.
- **A step with `outputs:` writes only its contract's JSON to stdout.**
  Everything else goes to stderr with `>&2`. Here `jq -n` builds the JSON.
- **`{{...}}` is the only way to pass values between steps and from
  `params`.** In a `run:` block the engine doesn't do text interpolation: it
  replaces each reference with a safe environment variable, so the value is
  never reinterpreted as shell syntax.

Now, from any subdirectory of the data repo:

```bash
pipelines validate               # schema, graph, references and the lint rules
pipelines doctor hello-world     # can this machine run it?
pipelines run hello-world --set name=Dani
pipelines status hello-world
pipelines show hello-world <run-id>
```

`run` prints one line per step and then the final status with the run id:

```
  ✓ greet                success
  ✓ count                success

success — 2026-10-05T15-57-44-383Z
```

`show` dumps the full `run.json`: you'll see `outputs.message: "hello, Dani"`
on the first step and `outputs.chars: 11` on the second.

### 3. Adding an `agent` step

An agent is a Markdown file with front matter in `agents/`. This is the
minimal one, `agents/summarizer.md`:

```markdown
---
description: Example agent that answers with a minimal JSON object.
---

You are an example agent. Reply with exactly the JSON the step asks for,
with no extra text.
```

The prompt for each `agent` step lives next to the pipeline, by convention
under `steps/`. `pipelines/hello-agent/steps/summarize.md`:

```markdown
Read the file `notes.txt` in your working directory and return a JSON object
with a `summary` field (one sentence) and a `lines` field (the number of
lines in the file).
```

And `pipelines/hello-agent/pipeline.yaml`:

```yaml
name: hello-agent
description: A shell step that prepares data and an agent step that summarizes it.
version: 1

params:
  workdir:
    description: The agent's working directory. It is the only write root.
    required: true

requires:
  agents: [summarizer]
  bin: [jq]

steps:
  - id: prepare
    type: shell
    run: |
      set -euo pipefail
      mkdir -p "{{params.workdir}}"
      printf 'one\ntwo\nthree\n' > "{{params.workdir}}/notes.txt"
      jq -n '{ready: true}'
    outputs:
      ready: boolean

  - id: summarize
    agent: summarizer
    prompt: steps/summarize.md
    cwd: "{{params.workdir}}"
    inputs: [prepare.ready]
    tools: [Read]
    max_cost_usd: 0.5
    outputs:
      summary: string
      lines: number
```

What changes compared to a `shell` step:

- `agent:` and `prompt:` instead of `run:`. `agent` is the implicit type.
- `cwd` is the sandbox's write root. The engine **does not create it**, which
  is why the previous step does.
- `tools: [Read]` is everything the agent is allowed to do. Without `tools:`
  it gets `Read`, `Grep` and `Glob`.
- `max_cost_usd` caps the spend of this particular step.

```bash
pipelines validate hello-agent
pipelines doctor hello-agent          # also checks the agent and the Claude Code session
pipelines run hello-agent --set workdir=/tmp/hello-agent
```

With this you have the building blocks of any real pipeline. The next leap is
declaring `triggers`, `when` and `notify`, which is what the rest of this
guide is about. The full contract for every field is in the
[`pipeline.yaml` reference](docs/reference.md#pipelineyaml-reference).

## Operating day to day

### Checking how things are going

```bash
pipelines status                     # latest runs of every pipeline
pipelines status nightly-report -n 10
pipelines show nightly-report <run-id>           # the full run.json
pipelines show nightly-report <run-id> collect   # a single step, with its denials if any
pipelines web                        # local read-only dashboard at http://127.0.0.1:7717
```

The `RunRecord` includes a `notify` entry whenever the channel was invoked:
the channel, its exit code, the timestamp and the tail of its output. That
way you can confirm the email really went out without opening your inbox.

### Reading a `skipped`

A `skipped` caused by a `throttle` is normal and expected: a `docs-review`
pipeline with a 46 h throttle on a nightly cron skips most nights by design.
What you should look at is `skipReason` in `run.json`, or the reason column in
`status`.

A pipeline can go on skipping silently for weeks because of a broken guard,
and the data repo will look exactly as if it were working. It has happened to
us. That's why every pipeline with `triggers` and `notify` must declare
`notify.stale_after` (the linter enforces it, rule R4): it turns that silence
into an email. Note that `stale_after` covers the silence of a pipeline that
DOES run and then skips or fails; it does NOT cover a `launchd` job that has
stopped firing, because with no run there's nothing to evaluate. For that,
today you only have `pipelines web` (its health panel) or `launchctl print`.

### Reading a `failed`

`pipelines show <name> <run-id>` tells you which step failed and, in its
`error`, the exit code plus the last lines of stderr. Your notification
channel receives the same information in `PIPELINES_NOTIFY_REASON`, so the
failure email can carry it. If the failure was an external hiccup, resume
from the failed step with the original params:

```bash
pipelines resume <name> <run-id>
```

Keep in mind that a `failed` isn't always a fault of the engine or of the
pipeline. A `repo-audit` pipeline, for example, might have its final
`verdict` step exit with 1 on purpose when it finds problems: the red run
**is** the alert.

### Where everything lives

| What | Where | Notes |
|---|---|---|
| Run history | `.runs/` in the data repo | Gitignored. One subdirectory per pipeline and per run. |
| Locks | `.runs/.locks/<pipeline>.lock` | If a run died holding the lock, `run` exits with 3 until it's cleared. |
| Installed params | `.params.local.json` in the data repo | Gitignored. Written by `install --set`. |
| Secrets | `.env` in the data repo | Gitignored. Only names go in the YAML, never values. |
| Workspaces | By convention, `~/Library/Application Support/pipelines/workspaces/<pipeline>/` (passed in through a param) | Each pipeline's own clones. **Pipelines shouldn't work in the operator's checkouts**: to see what they produce, `git fetch` in your checkout. |
| Scheduled jobs | `~/Library/LaunchAgents/cat.start.pipelines.<name>.plist` | Derived from `triggers.cron`. No param values inside. |
| `launchd` logs | The path set in the plist (`StandardOutPath` / `StandardErrorPath`), by default `~/Library/Logs/pipelines-<name>.log` | What happened **before** the engine got as far as writing to `.runs/`. |

### Checking state under `launchd`

```bash
launchctl print gui/$(id -u) | grep cat.start.pipelines   # loaded jobs and their last exit code
launchctl print-disabled gui/$(id -u)                     # which ones are disabled
```

To check how a pipeline behaves under cron, fire the real plist instead of
imitating its environment with `env -i`: `launchd` provides `USER`,
`LOGNAME`, `SHELL` and `TMPDIR`, and a hand-made imitation doesn't. A loaded
job can be triggered right now with:

```bash
launchctl kickstart -k gui/$(id -u)/cat.start.pipelines.<name>
```

This runs the real pipeline, guards included: if the `throttle` hasn't
expired, you'll see a `skipped`, which is information too. (From the CLI,
`pipelines run <name> --force` skips the `when` guards, but not the preflight
checks.)

## Putting a pipeline on a schedule

The engine **has no scheduler**. `pipelines install` translates
`triggers.cron` into a `launchd` plist and loads it. The YAML is the single
source of truth for the cadence: the plist doesn't duplicate it, it derives
from it.

Here is a scheduled pipeline that reports on a repository every night, only
when there's something new, and notifies through a channel called `email`:

```yaml
name: nightly-report
description: Summarizes the day's commits in a repository and emails the result.
version: 1

params:
  repo:
    description: Path to the repository to report on.
    required: true

requires:
  bin: [git, jq]

triggers:
  - cron: "0 3 * * *"

when:
  - throttle: 20h
  - changed:
      path: "{{params.repo}}"
      since: last_success

notify:
  on: [failed]
  stale_after: 72h
  channel: email

steps:
  - id: collect
    type: shell
    run: |
      set -euo pipefail
      n=$(git -C "{{params.repo}}" log --since=24.hours --oneline | wc -l | tr -d ' ')
      jq -n --arg n "$n" '{commits: ($n | tonumber)}'
    outputs:
      commits: number
```

The channel is declared once, in the data repo's `pipelines.yaml`. Its script
receives the run's name, id, status and reason through `PIPELINES_NOTIFY_*`
environment variables, plus the secrets listed under `env:`:

```yaml
channels:
  email:
    type: shell
    env: [SMTP_PASSWORD]
    run: scripts/notify-email.sh
```

### Installing

```bash
pipelines doctor <name>
pipelines install <name> --set key=value --dry-run   # prints the plist, touches nothing
pipelines install <name> --set key=value
launchctl print gui/$(id -u)/cat.start.pipelines.<name>
```

`install` writes the params to `.params.local.json`, generates the plist with
no values inside, computes the `PATH` from `requires.bin` and from the
`command` of any `mcp_servers`, and checks that this `PATH` resolves
everything before writing anything. It stops if `doctor` is red or if it
detects someone else's job that seems to do the same thing; `--force`
overrides the stop, but still warns.

Only the subset of cron that `launchd` can express is translated: `*`, fixed
values and lists (`0,30`). Ranges and steps (`*/15`) are rejected with an
explicit error.

### Taking over from an old cron job

When a pipeline replaces a script that was already running on its own, **the
handover is manual, and `launchctl disable` is not optional**. A `bootout`
only unloads the job from the current session: without `disable`, the old job
comes back at the next boot and the work gets done twice.

```bash
launchctl bootout gui/$(id -u)/<old-label>
launchctl disable gui/$(id -u)/<old-label>
launchctl print-disabled gui/$(id -u) | grep <old-label>    # must say "disabled"
```

If you have anything that watches your list of scheduled jobs, remove the old
label from it too, or it will report a "missing" job that you retired on
purpose.

Don't count on `pipelines install` to catch this collision for you. It runs
two scans. The first compares the paths in the params against the contents of
the other plists, but since each pipeline has its own workspace it usually
shares no path with the script it replaces. The second looks for other
enabled jobs whose label ends in `.<name>`, so it only helps if the old job
happens to be named like the pipeline. The collision in a migration is
semantic, and beyond those two checks there's no safety net: it's up to the
operator to disable the old job and confirm it with `print-disabled`.

Leave the old script and plist on disk until the new pipeline has run green
for a few nights: they're your way back.

### Uninstalling

```bash
pipelines uninstall <name>     # unloads the job and deletes its plist; keeps .params.local.json and the logs
```

## Writing pipelines that survive the night

On top of the schema and the references, `pipelines validate` applies five
fixed rules to the shell text. Each one comes from a real incident, and the
list is deliberately not configurable:

| Rule | What it catches | Why |
|---|---|---|
| R1 | A `{{...}}` inside single quotes or a `<<'EOF'` heredoc | Bash doesn't expand the engine's safe variable there, and the step gets an empty value. |
| R2 | `\s` in a `grep -E` pattern | It isn't POSIX, and macOS `grep` doesn't accept it. Use `[[:space:]]`. This one cost ten silent nights. |
| R3 | A multi-line `run:` that doesn't start with `set -euo pipefail` | Without it, a command that fails halfway leaves the step marked as successful. |
| R4 | `triggers:` and `notify:` without `notify.stale_after` | A pipeline held back by a guard has no error to report, only absence. |
| R5 | An assignment `x=$(… grep …)` without `\|\|` inside the substitution | Under `set -e`, a `grep` with no matches kills the step before it reaches the fallback. |

`pipelines validate --file <path>` validates a draft before it exists under
`pipelines/<name>/`. Details in
[`validate`: the five rules and `--file`](docs/reference.md#validate-the-five-rules-and---file).

Beyond the linter, these are the conventions every pipeline should follow:

- **Every variable value goes through `params`.** Nothing hardcoded in a
  `run:` or in a prompt.
- **Secrets by name only** (`requires.env`), with the value in `.env`. A
  `{{secrets.*}}` reference may only appear in the prompt of an `agent` step;
  in a `run:` it's a validation error.
- **What the agent claims, a `shell` step verifies.** An agent saying it
  saved a screenshot doesn't prove the file exists: follow the agent step
  with a `shell` step that checks it.
- **A `when:` guard doesn't clean anything up.** It's evaluated before any
  step runs; if it depends on state that only a step clears, the pipeline
  blocks itself forever. Cleanup belongs inside a step.
- **Use `always:` for anything ephemeral**: closing browsers, emptying work
  directories, deleting temporary clones.
- **Make `stale_after` somewhat longer than the `throttle`**, so that silence
  raises an alert.
- A step whose predecessor was skipped is skipped in cascade: a missing
  reference in a step-level `when:` counts as false, not as an error.

## Developing the engine

```bash
bun test              # the full suite
bun x tsc --noEmit    # typecheck
```

`src/` is organized by responsibility: `schema/` (Zod, strict mode),
`graph/` (dependencies and cycles), `guards/` (`when`), `runner/`
(orchestration, `shell` and `agent` steps, the filesystem guard), `lint/`
(the five rules), `install/` (launchd), `notify/`, `runs/` (persistence),
`web/` (the dashboard) and `cli/`. Every lint rule and every engine
capability started life as a failing test.

The diagrams in this guide are generated with
[archify](https://github.com/tt-a1i/archify) from the JSON sources in
[`docs/diagramas/`](docs/diagramas/). The SVG embedded in this README is
exported from the interactive viewer itself (Export → SVG) and saved next to
the HTML.

## Further reading

- [`docs/reference.md`](docs/reference.md): the full contract of
  `pipeline.yaml`, the security model, `pipelines.yaml`, secrets, every
  command, exit codes, `.runs/` and known limitations.

## License

MIT. See [LICENSE](LICENSE).

Built by [Start.cat](https://start.cat), a software studio in Barcelona.
