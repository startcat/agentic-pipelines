# agentic-pipelines reference

Exhaustive reference for the engine: the full `pipeline.yaml` contract, the
security model, the data repo configuration, the commands and what gets
persisted in `.runs/`. For the usage guide, step by step and with diagrams,
see the [README](../README.md).

## Contents

- [`pipeline.yaml` reference](#pipelineyaml-reference)
  - [Top-level fields](#top-level-fields)
  - [`params`](#params)
  - [`requires`](#requires)
  - [`mcp_servers`](#mcp_servers)
  - [`when` (start guards)](#when-start-guards)
  - [`triggers`](#triggers)
  - [`defaults`](#defaults)
  - [`notify`](#notify)
  - [`steps`: fields common to all types](#steps-fields-common-to-all-types)
  - [`shell` steps](#shell-steps)
  - [`agent` steps](#agent-steps)
  - [Step-level `when`](#step-level-when)
  - [`always`](#always)
  - [Interpolation](#interpolation)
- [The security model](#the-security-model)
- [`pipelines.yaml`: data repo configuration](#pipelinesyaml-data-repo-configuration)
- [Secrets](#secrets)
- [Command reference](#command-reference)
  - [`validate`: the five rules and `--file`](#validate-the-five-rules-and---file)
  - [Exit codes](#exit-codes)
- [`.runs/`: what is persisted](#runs-what-is-persisted)
- [Data repo layout](#data-repo-layout)
- [Requirements and environment](#requirements-and-environment)
- [Status and known limitations](#status-and-known-limitations)

## `pipeline.yaml` reference

Each pipeline lives in `pipelines/<name>/pipeline.yaml` inside the data repo.
The engine validates the whole file with Zod in `.strict()` mode: at the top
level, in every step, guard, `always` entry, `mcp_servers` entry, `notify`
and `defaults`, **an unknown key is an error**, not something silently
dropped.

### Top-level fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | kebab-case (`^[a-z0-9][a-z0-9-]*$`). Must match EXACTLY the name of the directory that contains it; if it doesn't, `validate`/`run` fail explicitly. Locks, throttle and run history are keyed by this name. |
| `description` | string | yes | Non-empty. |
| `version` | number | yes | Integer ≥ 1. Persisted in every `RunRecord` (`pipelineVersion`) so a `resume` knows which version the original attempt ran against. |
| `params` | map | no | See [`params`](#params). |
| `requires` | object | no | See [`requires`](#requires). |
| `mcp_servers` | map | no | See [`mcp_servers`](#mcp_servers). |
| `when` | list of guards | no | See [`when` (start guards)](#when-start-guards). |
| `triggers` | list | no | See [`triggers`](#triggers). |
| `defaults` | object | no | See [`defaults`](#defaults). |
| `notify` | object | no | See [`notify`](#notify). |
| `steps` | list | yes (at least 1) | See [`steps`](#steps-fields-common-to-all-types). |
| `always` | list | no | See [`always`](#always). |

### `params`

Declared params are the only way to parameterize a pipeline. Any other
variable value must go through here, never hardcoded in `run:`/`prompt`.

```yaml
params:
  docs_repo:
    description: Local path of the clone the pipeline works on.
    required: true
  admin_repo:
    description: Read-only path to the source-of-truth repo.
    required: true
  deploy_dispatch_url:
    description: workflow_dispatch URL. If omitted, the deploy step is skipped.
```

| Param field | Type | Required | Notes |
|---|---|---|---|
| `description` | string | yes | |
| `required` | boolean | no | If `true` and there is no value after resolving `default < local < --set`, `run` fails with a list of the missing params. |
| `default` | string \| number \| boolean | no | Always normalized to a string when resolved. |

Resolution precedence (`resolveParams`): `--set key=value` (CLI) >
`.params.local.json` (written by `pipelines install --set`; can also be
edited by hand) > the YAML `default`.

They are referenced in the rest of the pipeline as `{{params.docs_repo}}`.

### `requires`

Declares what the machine running the pipeline must have available.
`pipelines doctor <name>` checks each entry, and `run` won't proceed if
something blocking is missing.

```yaml
requires:
  agents: [docs-writer, docs-reviewer]
  bin: [git, jq, yarn]
  env:
    - DOCS_ADMIN_URL
    - DEPLOY_TOKEN
  net: [git.example.com]
  skills: []
```

| Field | Type | Check in `doctor` |
|---|---|---|
| `agents` | string[] | `agents/<name>.md` exists in the data repo. |
| `skills` | string[] | The skill is available in the user's Claude Code environment. |
| `bin` | string[] | The binary is on the `PATH`. |
| `env` | string[] | Secret names; see [Secrets](#secrets). `doctor` requires a minimum length of 8 characters (an entropy heuristic; it doesn't validate the content). |
| `net` | string[] | The host resolves via DNS. |

`env` here holds **names**, never plaintext values. The real value is
resolved at runtime from `.env` or the process environment (see
[Secrets](#secrets)).

### `mcp_servers`

Pipeline-level registry of stdio MCP servers that an `agent` step can
enable. Stdio only (no SSE/HTTP yet).

```yaml
mcp_servers:
  playwright:
    command: npx
    args: ["-y", "@playwright/mcp@0.0.79", "--headless", "--no-sandbox"]
    kind: playwright
```

| Field | Type | Required | Notes |
|---|---|---|---|
| map key | string | — | Server name, kebab-case. It becomes part of the `mcp__<name>__<tool>` prefix you write by hand in a step's `tools:`. |
| `command` | string | yes | Interpolable with `{{params.*}}` (never `{{secrets.*}}`). |
| `args` | string[] | no (`[]`) | Interpolable like `command`. |
| `env` | string[] | no (`[]`) | **Names** of the secrets this server needs, resolved against `requires.env`; never values in the YAML. |
| `kind` | `"playwright"` | no | See [The security model](#the-security-model). Without `kind:`, no tool from that server passes `validate`: tool governance is deny-by-default. Today only the `playwright` kind exists; adding another one requires extending the engine. |

An `agent` step enables the server by listing it in its own
`mcp_servers: [name]` (see [`agent` steps](#agent-steps)). The engine always
starts with `strictMcpConfig: true`: no "ambient" server already configured
on the machine (plugins, another project's `.mcp.json`) leaks into the
session.

### `when` (start guards)

List of pipeline-level guards. **All** of them must pass for the run to
start; if any fails, the run is recorded as `skipped` (not as a failure) and
`pipelines run` exits with code 0.

```yaml
when:
  - throttle: 46h
  - shell: 'git -C {{params.docs_repo}} diff --quiet'
  - changed:
      path: '{{params.docs_repo}}'
      since: last_success
  - between: '08:00-20:00'
```

Each entry declares **exactly one** of these four keys:

| Guard | Shape | Semantics |
|---|---|---|
| `throttle` | `"46h"` (shorthand) or `{ every: "46h", since: last_success \| last_attempt }` | Passes only if `every` has elapsed since the reference point. `since` defaults to `last_success`; `last_attempt` is the last run that EXECUTED something (`success` or `failed`). Skipped runs don't count, so a pipeline can't push its own window's anchor forward with its own skips and never come due. Duration: `\d+(s\|m\|h)`. |
| `changed` | `{ path: string, since: last_success \| last_attempt }` | Passes if `git log --since=<reference>` finds a commit in `path` since the reference run. Same `since` criterion as `throttle`. |
| `shell` | `string` | Passes if the command (run with `sh -c`, interpolated in a shell-safe way; see [Interpolation](#interpolation)) exits with code 0. |
| `between` | `"HH:MM-HH:MM"` | Passes if the current time falls inside the window (windows crossing midnight are supported, e.g. `22:00-06:00`). |

### `triggers`

```yaml
triggers:
  - cron: "0 3 * * *"
```

**The engine doesn't include a scheduler**: there is no background process
that reads `triggers.cron` and fires anything on its own. What it does have
is [`pipelines install`](#command-reference), which **translates** this
field into the system scheduler (launchd) and leaves the job loaded. It is
the single source of the cadence: the generated plist doesn't duplicate it,
it derives it.

Subset supported by the translation: `*`, fixed values and lists (`0,30`).
Ranges (`1-5`) and steps (`*/15`) are rejected with an explicit error:
launchd can't express them, and `install` prefers failing over installing
something that runs at a different time than the YAML says.

### `defaults`

Values every step inherits unless it declares them explicitly.

```yaml
defaults:
  on_error: stop
  retry: 0
  timeout: 15m
```

| Field | Type | Default |
|---|---|---|
| `on_error` | `stop \| continue` | `stop` |
| `retry` | number of attempts, or `{ attempts: number, on: transient \| any }` | `0` |
| `timeout` | duration (`\d+(s\|m\|h)`) | `15m` |

`retry.on: transient` (the default when `on` is omitted) only retries errors
the engine classifies as transient (rate limit, overload, server error,
network timeout); `any` retries any failure.

### `notify`

```yaml
notify:
  on: [success, failed]
  stale_after: 72h
  channel: email
```

| Field | Type | Notes |
|---|---|---|
| `on` | list of `success \| failed \| skipped` | Every path that closes a run notifies, including a skipped guard and a busy lock, so `skipped` really does fire. Beware of noise: a pipeline with `throttle` skips half the nights by design. For "it isn't running", `stale_after` is the better tool. |
| `stale_after` | duration (`72h`) | Optional. Notifies when the pipeline has gone that long **without a single successful run**, whatever the status of the current run. A pipeline that has never succeeded counts as stale from its first run. It warns on every run while that holds, and switches itself off as soon as the pipeline runs green again. |
| `channel` | string | Must exist as a key under `channels:` in `pipelines.yaml` (data repo); see [`pipelines.yaml`](#pipelinesyaml-data-repo-configuration). `validate` checks it. |

`stale_after` exists because `on:` can't tell a routine skip from a stalled
pipeline: in practice, a pipeline can spend many nights skipping because of a
broken guard without anyone noticing. Declaring a window somewhat larger
than the pipeline's `throttle` turns that silence into a warning.

### `steps`: fields common to all types

Every step, `shell` or `agent`, accepts these fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | kebab-case, unique within the pipeline (including `always`). |
| `type` | `shell \| agent` | no | Defaults to `agent` if omitted. |
| `cwd` | string | no | Interpolable. For `agent`, it defines the sandbox's write root; see [The security model](#the-security-model). |
| `inputs` | string[] | no (`[]`) | Extra dependencies, each in the form `<step>.<field>` (a field the other step declares in `outputs`). Together with the `{{step.field}}` references interpolated in the step's own fields, they define the edges of the execution graph; a reference in `run`/`prompt`/`when`/`cwd` already creates the edge, so `inputs` is only needed for a dependency that isn't interpolated anywhere. Declaration order in the YAML doesn't matter; only cycles are rejected. |
| `outputs` | map name → type | no | Output contract. Supported types: `string`, `number`, `boolean`, `string[]`, `number[]`, `boolean[]`. A step with `outputs:` MUST produce valid JSON with exactly those fields (see below, per type). |
| `when` | string | no | Expression over outputs of previous steps or params; see [Step-level `when`](#step-level-when). |
| `retry` | same as `defaults.retry` | no | Overrides the pipeline default for this step. |
| `on_error` | `stop \| continue` | no | Overrides the default. `continue` lets the graph carry on even if this step fails. |
| `timeout` | duration | no | Overrides the default. |
| `effects` | string[] | no (`[]`) | Free-form, documentary labels; they don't affect execution. |

### `shell` steps

```yaml
- id: build
  type: shell
  cwd: "{{params.docs_repo}}"
  when: "{{check-changes.has_changes}}"
  timeout: 10m
  run: |
    set -euo pipefail
    yarn build >&2
```

| Field | Type | Notes |
|---|---|---|
| `run` | string | Run with `sh -c`. **If the step declares `outputs:`, ALL of its stdout must be exactly the contract's JSON.** Any other output (`git merge`, `yarn build` talking on stdout) breaks parsing; redirect noise to stderr (`>&2`) or use `--quiet`. `{{...}}` references are replaced by safe environment variables before being handed to `sh` (never by raw text interpolated into the command), so the command itself can quote them freely. |

### `agent` steps

```yaml
- id: screenshots
  agent: docs-writer
  prompt: steps/screenshots.md
  cwd: "{{params.docs_repo}}"
  additional_dirs: ["{{params.admin_repo}}"]
  when: "{{detect-target.capture_target_slug}}"
  mcp_servers: [playwright]
  tools:
    - Read
    - Write
    - Edit
    - mcp__playwright__browser_navigate
    - mcp__playwright__browser_take_screenshot
  outputs:
    summary: string
```

`agent` steps run through the Claude Agent SDK and authenticate with an
Anthropic API key (`ANTHROPIC_API_KEY`), read from the data repo's `.env` or
from the environment (see
[Requirements and environment](#requirements-and-environment)).

| Field | Type | Required | Notes |
|---|---|---|---|
| `agent` | string | yes | Name of `agents/<agent>.md` in the data repo (YAML front matter + Markdown prompt). |
| `prompt` | string | yes | Path to this step's prompt `.md` file, relative to the pipeline directory. May contain `{{...}}` references; they are resolved against outputs of previous steps and params (and secrets, see [Interpolation](#interpolation)). |
| `tools` | string[] | no | Deny-by-default list: every native tool must be in the engine's internal table (`Read`, `Write`, `Edit`, `NotebookEdit`, `Glob`, `Grep`, `StructuredOutput`), and every `mcp__<server>__<suffix>` tool must have its server declared in this same step's `mcp_servers:`, with that server having a known `kind:` in the pipeline registry. Without `tools:`, the step gets the minimal default: `Read`, `Grep`, `Glob`. `Bash` and any other arbitrary-code-execution tool (`REPL`, `Workflow`, `Agent`, `EnterWorktree`, `ExitWorktree`, `browser_evaluate`, `browser_run_code_unsafe`) are **always forbidden** in an `agent` step; if you need to run commands, use a `type: shell` step. |
| `mcp_servers` | string[] | no (`[]`) | Names from the pipeline-level `mcp_servers` registry that this step enables. |
| `additional_dirs` | string[] | no (`[]`) | **Read-only** directories outside `cwd` that this step can reach. Interpolable only with `{{params.*}}`, never `{{secrets.*}}` (checked by `validate`). |
| `max_cost_usd` | number > 0 | no | Spending cap in USD for this particular step (mapped to the SDK's `maxBudgetUsd`). No cap if omitted. |

### Step-level `when`

Different from the pipeline-level `when:` (which is a list of structured
guards): at step level it is **a single text expression**, over outputs of
previous steps or params. Two forms are supported, nothing else:

```yaml
when: "{{detect-target.capture_target_slug}}"          # truthiness
when: "{{redact.status}} == \"skipped\""                # comparison
```

Comparison operators: `== != > >= < <=`. The ordering ones (`> >= < <=`)
require both sides to be numeric. A missing reference (e.g. the step it
depends on was skipped) is treated as **false**, not as an error, so a step
whose predecessor was skipped is skipped in cascade instead of blowing up.
Engine-style "truthiness": `undefined`, `null`, `false`, `0`, the empty
string and the empty array are false; everything else is true.

### `always`

Cleanup steps that always run when the run closes, success or failure.
Deliberately without `inputs`/`outputs`/`when`/`on_error`: they take no part
in the dependency graph or in the run's error policy.

```yaml
always:
  - id: close-session
    run: pkill -f "playwright-server" || true
```

| Field | Type | Required |
|---|---|---|
| `id` | string | yes (kebab-case, unique across the whole pipeline) |
| `run` | string | yes |
| `cwd` | string | no |
| `timeout` | duration | no (uses `defaults.timeout`) |

### Interpolation

`{{left.right}}` syntax in any text field of a step. Three sources:

- `{{params.name}}`: a resolved param.
- `{{secrets.NAME}}`: a secret, which must be declared in `requires.env`.
  **Only available in the `prompt` of an `agent` step.** In any other field (`cwd`, `run`, `shell:` guards,
  `additional_dirs`) a reference to `secrets.*` is an explicit validation
  error, so a secret never ends up in a shell command where it could leak
  into a log.
- `{{step.field}}`: an output of another step. The reference itself makes
  this step depend on that one, and `field` must be declared in the other
  step's `outputs:`.

A reference that doesn't resolve (nonexistent param, undeclared secret,
output of a step that didn't run) **fails explicitly**; it is never silently
replaced with an empty string.

Two different substitution mechanisms depending on the destination, for
safety:

- **An agent's prompt / non-executable fields**: direct text substitution.
- **Anything that ends up in `sh -c`** (`run:` of a `shell`/`always` step, a
  `shell:` guard): each reference is replaced by the name of a safe
  environment variable, and the real value is passed separately through the
  child process's `env`. `sh` never re-interprets the value as shell syntax,
  whatever characters it contains.

## The security model

An `agent` step runs with `permissionMode: 'bypassPermissions'`: an
unattended run has nobody to approve a permission prompt, so the SDK doesn't
ask anything. This means that **the real control over what a step can do is
not the SDK's `permissionMode`; it is the engine**:

1. **Deny-by-default `tools:`** (validated in `pipelines validate`, not just
   at runtime): every native tool must be in the engine's internal table of
   filesystem profiles; every MCP tool must belong to a server enabled by
   the step with a known `kind:`. A tool the engine doesn't recognize, or
   one that runs arbitrary code (`Bash`, `REPL`, `browser_evaluate`...),
   never passes `validate`.

2. **The engine's own `PreToolUse` hook, at runtime** (not the SDK's): before
   every tool call, the engine decides to allow or deny based on:
   - **`cwd`** is the only **write** root. Any attempt to write outside
     `cwd` (including a path with `..` trying to escape) is denied.
   - **`additional_dirs`** widens the **read** roots, never the write ones:
     a step can read a source-of-truth repo without being able to touch it.
   - Any tool without an entry in the internal table is denied by default,
     with the reason `tool desconocida para el motor: "<name>"`: fail closed
     in the face of the unknown, not open.
   - The hook never throws: any internal error becomes an explicit denial.

3. **`strictMcpConfig: true`**, always: no "ambient" MCP server already
   configured on the machine (plugins, another project's `.mcp.json`) joins
   the session without `mcp_servers:` knowing about it.

4. **`settingSources: []`**, always: the session loads no user or project
   `settings.json`, so there are no hooks foreign to the engine that could
   hang or alter an unattended run.

**Traceability**: every denial by the hook is persisted in
`StepRecord.denials` (visible with `pipelines show <name> <run-id> <step>`),
not just kept in memory during the run. If a step invokes a tool the engine
doesn't govern, even if the step ends successfully, `pipelines run`/`resume`
prints an on-screen warning naming exactly which tool and which step, so it
gets added to the engine's table before it turns into a confusing failure in
another run.

**`doctor`** adds one more layer: for each MCP server with a known `kind:`,
it starts the real server and compares, live, the `tools/list` it returns
against the engine's internal table. It detects tools that were added,
renamed or removed in an MCP package update before a real run discovers
them. This check (`mcp-schema`) is purely informational in `run` (it never
blocks a run), but it does block `doctor`.

## `pipelines.yaml`: data repo configuration

Lives at the root of the data repo (not the engine's). It can be empty
(`channels: {}`), but it must exist: it is the marker the engine uses to
locate the repo root by walking up directories.

```yaml
channels:
  email:
    type: shell
    env: [EMAIL_API_KEY]
    run: scripts/notify-email.sh
```

| Channel field | Type | Required | Notes |
|---|---|---|---|
| `type` | `"shell"` | yes | The only type supported today. |
| `run` | string | yes | Command to run. It receives through the environment `PIPELINES_NOTIFY_NAME`, `PIPELINES_NOTIFY_RUN_ID`, `PIPELINES_NOTIFY_STATUS`, `PIPELINES_NOTIFY_REASON` (the guard that skipped the run, or, if the run failed, the failed steps with their error, truncated to 500 characters), `PIPELINES_NOTIFY_STALE` (`1` or empty) and `PIPELINES_NOTIFY_LAST_SUCCESS` (ISO timestamp of the last successful run, empty if there was none), plus the secrets declared in `env:`. |
| `env` | string[] | no (`[]`) | Names of the secrets this channel needs; resolved only when the channel is actually invoked, never exposed to the pipeline that triggered the notification. |

`pipelines.yaml` also accepts a repo-level `defaults:` block (`on_error`,
`retry`, `timeout`, `notify`), the same shape as an individual pipeline's
`defaults:`, meant for values common to the whole repo. (It is currently not
applied automatically to pipelines: each `pipeline.yaml` still declares its
own.)

## Secrets

Never in plaintext in any YAML. A secret is declared by **name** in
`requires.env` (pipeline) or `channels.<x>.env` (notification channel), and
its **value** is resolved at runtime like this:

1. `.env` at the root of the data repo (`KEY=value` format, `#` comments,
   optional quotes). It takes precedence.
2. If it isn't there, the process's own environment (`process.env`).

`ANTHROPIC_API_KEY` is the one value you don't declare: the engine reads it
from `.env` (or the environment) by itself and passes it only to `agent`
steps (see [Requirements and environment](#requirements-and-environment)).

`.env` and `.params.local.json` are in the data repo's expected
`.gitignore`; they are never committed.

## Command reference

```
pipelines [--repo <path>] <command> [options]
```

`--repo` (optional, before the subcommand): path to the data repo or to any
of its subdirectories. If omitted, `PIPELINES_REPO` is used; if that isn't
set either, the engine looks for `pipelines.yaml` walking up from the
current directory.

| Command | Usage | What it does |
|---|---|---|
| `validate` | `pipelines validate [name]` | Validates the schema, the dependency graph (cycles), `{{...}}` references in prompts/`cwd`/`when` (including `when[].changed.path`)/`run`/`additional_dirs`, that `notify.channel` exists, and five fixed rules on the shell text; see [`validate`: the five rules and `--file`](#validate-the-five-rules-and---file) below. Without `name`, validates every pipeline in the repo. `--file <path>` validates a standalone YAML instead of an installed one. |
| `doctor` | `pipelines doctor <name>` | Checks that the current machine can run the pipeline: agents, binaries, MCP servers (real start-up + live schema drift), environment variables, network resolution, and the Anthropic API key when the pipeline has `agent` steps. |
| `install` | `pipelines install <name> [--set k=v] [--force] [--dry-run]` | Installs the pipeline as a launchd job from its `triggers.cron`. Writes the params to `.params.local.json` and a derived plist (with no values) to `~/Library/LaunchAgents/`. Computes the `PATH` from `requires.bin` and the `mcp_servers` `command`s, and checks that this `PATH` resolves everything needed (including `sh`) before writing anything. Warns about optional params without a value and the steps they affect. `--force` skips the cut-off for a red `doctor` or a suspicious foreign job, but still WARNS about both, never silently. `--dry-run` goes through those same validations, prints the plist it would write and exits without touching anything: not the plist, not `.params.local.json` even if it gets `--set`, not `launchctl`. A failing validation makes it fail all the same, so it is usable inside a script. |
| `uninstall` | `pipelines uninstall <name>` | Unloads the job (always, even if the plist no longer exists) and deletes its plist if it finds it. Doesn't touch `.params.local.json` or the logs. Idempotent. |
| `run` | `pipelines run <name> [--set key=value ...] [--force]` | Runs the pipeline now. `--set` is repeatable, to pass/override params. Evaluates `requires` (blocking) and the `when:` guards (a `skipped` is a success, not an error) before starting. Acquires an exclusive per-pipeline lock for the duration of the run. `--force` skips the `when:` guards (policy: "not today") but NOT `requires`, which measures whether this machine can run the pipeline; it warns on stderr and marks the run with `forced: true`, which `status` shows as `(guardas omitidas)`. A forced run doesn't prove the guards would have let it through, and it does anchor the `throttle` like any other run that executed. |
| `resume` | `pipelines resume <name> <run-id>` | Resumes a `failed` run from where it stopped, reusing its original params. |
| `status` | `pipelines status [name] [-n, --limit <n>]` | Lists the latest runs (5 by default) of one pipeline, or of all of them if the name is omitted: id, status, cost, skip reason if any. |
| `show` | `pipelines show <name> <run-id> [step]` | Dumps the full `RunRecord` as JSON, or the `StepRecord` of a specific step if given (including `denials` if the step had any tool denied). The `RunRecord` includes `notify` when the channel was invoked: channel, exit code, timestamp and the (redacted) tail of its output, also when the channel failed. The `error` of a failed shell step includes the last lines of its stderr. |
| `web` | `pipelines web [-p, --port <n>]` | Starts a local, read-only server over the repo and its runs: health dashboard (with the trigger axis and the work axis), a page per pipeline, run detail and its log, live while it runs. Listens only on `127.0.0.1`, with no flag to change it: exposing it to the network is a different design, with its own conversation about auth. Default port **7717**. |

**The plist freezes the path it was installed from.** `ProgramArguments`
holds the absolute path of `index.ts` as `import.meta.dir` sees it at
`install` time. If that happens inside a git worktree, the job ends up
pointing at THAT worktree, not at the main checkout. Deleting the worktree
later leaves the job pointing at a path that no longer exists, and the next
scheduled run will fail with no prior warning. Always install from the
checkout that is going to persist.

### `validate`: the five rules and `--file`

Besides schema, cycles and `{{...}}` references, `validate` applies five
fixed rules to each pipeline's shell text (`when[].shell` guards, `run:` of
a `shell` step, `run:` of an `always:` entry). There is no rule registry and
no configurable severity: adding a sixth means editing `src/lint/rules.ts`
directly. That is on purpose: the moment this accepts configuration, it
stops being a list of incidents and becomes a framework nobody maintains.
Each rule comes from a real failure:

- **R1: a `{{...}}` reference where bash doesn't expand `${…}`.** Inside
  single quotes, or in a heredoc with a quoted delimiter (`<<'EOF'`). The
  engine replaces each reference with `${__PIPELINES_REF_n}` and passes the
  real value through the child process's environment; in those two
  contexts bash doesn't expand that variable again, and the step receives
  the literal variable name instead of the value. Typical symptom: a path
  variable that silently arrives empty.
- **R2: `\s` inside a `grep -E` pattern.** It isn't POSIX ERE (it's a GNU
  extension) and macOS's grep doesn't accept it; you need `[[:space:]]`.
  In practice, a guard built on it can make a pipeline skip silently for
  days.
- **R3: a multi-line `run:` that doesn't open with `set -euo pipefail`.**
  Without it, a command that fails midway through a block leaves the step
  successful, and the real failure shows up later and somewhere else. Not
  required in `when:` guards: a guard is a one-line expression evaluated by
  its exit code, not a script.
- **R4: a pipeline with `triggers:` and `notify:` but without
  `notify.stale_after`.** Without it, a pipeline held back by a guard tells
  nobody: there is no error to notify, only absence.
- **R5: an assignment whose value is `$(… grep …)` with no `||` inside the
  substitution.** Under `set -e` (and `pipefail` if there is a pipe) the
  assignment takes the substitution's exit code, and `grep` exits with 1
  when it doesn't match, which is exactly the "there's no `ERROR:` in the
  text" case the fallback on the next line meant to handle, so the step
  dies before reaching it. Only assignments at the start of a line (with or
  without `export`/`local`/`readonly`): `if x=$(grep …)` is guarded by
  construction. An easy mistake to make repeatedly when writing or
  migrating pipelines, and one that review tends to catch before
  `validate` did.

`--file <path>` validates a standalone `pipeline.yaml` (a draft, before
installing it) instead of one already installed in `pipelines/<name>/`. It
frees the draft from three requirements of an installed pipeline:

- It doesn't require `name:` to match the name of a containing directory
  (a draft may not have one).
- Prompts are resolved relative to the file's own directory; a missing one
  is a **warning**, not an error (it's normal to have the YAML before the
  prompts), but then THAT prompt's references haven't been checked, and the
  warning says so explicitly instead of keeping quiet.
- `notify.channel` is checked only if a `pipelines.yaml` is found walking
  up from the file's directory; if none is found, that's also a warning,
  not an error.

No warning changes the exit code. `validate --file` always lists what it
couldn't check: a partial validation that doesn't say what it skipped makes
you believe everything is covered when it isn't.

`validate` (with or without `--file`) collects ALL the problems it finds
before failing, instead of stopping at the first one. Previously, a failure
in one reference prevented `notify.channel` from even being checked, and a
nonexistent channel stayed hidden until the next pass. The exit code and
what counts as a failure don't change because of this. Two checks are left
out of this collection and are still reported on their own: a cycle in the
dependency graph (`buildGraph`) and, outside `--file`, a missing agent
prompt. Both abort before the rest of the checks get to run.

`validate --file` checks that the YAML is correct and that its references
resolve; it doesn't execute anything. A `pipeline.yaml` can pass
`validate --file` without a single warning and still fail at 3 a.m. because
of something no static check can see, a `tail -n +4` that miscounts a blank
line, for example. The risk narrows; it doesn't close.

### Exit codes

Designed so that a cron job or script can act without parsing the on-screen
output:

| Code | Meaning |
|---|---|
| `0` | Success. Includes a run skipped by a guard: that's a normal outcome, not an error. |
| `1` | Generic failure: invalid `pipeline.yaml`, missing dependency (blocking `doctor`), missing required params, or a step that failed after exhausting its retries. |
| `2` | The lock file itself is corrupt or unreadable. |
| `3` | Another legitimate run of that pipeline is already in progress. |
| `130` / `143` | The process was interrupted (`SIGINT`/`SIGTERM`) while holding the lock. |

## `.runs/`: what is persisted

A gitignored directory at the root of the data repo, with one subdirectory
per pipeline and per run:

```
.runs/
  .locks/
    <pipeline>.lock
  <pipeline>/
    <run-id>/            # ISO 8601 with ':' and '.' replaced by '-'
      run.json
      <step-1>.log
      <step-2>.log
      ...
```

`run.json` (`RunRecord`):

| Field | Notes |
|---|---|
| `id`, `pipeline`, `pipelineVersion` | |
| `status` | `running \| success \| failed \| skipped` |
| `startedAt`, `finishedAt` | ISO 8601 |
| `params` | The resolved params this particular run ran with |
| `steps` | Map `id → StepRecord` |
| `totalCostUsd` | Sum of `costUsd` across all `agent` steps |
| `skipReason` | Present only if `status: skipped` |

`StepRecord` per step:

| Field | Notes |
|---|---|
| `status`, `startedAt`, `durationMs`, `attempts` | |
| `outputs` | Already validated against the step's `outputs:` contract |
| `costUsd`, `inputTokens`, `outputTokens`, `toolsUsed` | Only in `agent` steps |
| `error` | Failure message, if any |
| `skipReason` | If the step was skipped (step-level `when:` guard) |
| `denials` | List of tools denied by the sandboxing hook; see [The security model](#the-security-model) |

Each `<step>.log` holds the step's transcript, with any secret value already
replaced by `«redactado»` before it touches disk.

## Data repo layout

```
my-data-repo/
  pipelines.yaml              # channels: {}, and optionally defaults:
  .env                        # secrets, gitignored
  .params.local.json          # local params, gitignored (written by `install`)
  agents/
    <agent-name>.md           # YAML front matter + Markdown prompt
  pipelines/
    <pipeline-name>/
      pipeline.yaml
      steps/
        <step>.md             # prompts for `agent` steps, by convention
  scripts/
    <notify-channel>.sh       # scripts invoked from `channels.<x>.run`
  .runs/                      # gitignored, generated by the engine
  .gitignore                  # must include: .env, .params.local.json, .runs/
```

A typical pipeline, for reference: a `docs-review` pipeline that drafts and
audits documentation with two agents (`docs-writer` and `docs-reviewer`),
takes real screenshots through the Playwright MCP server, verifies the
changes, then builds, commits, pushes and conditionally deploys, sending an
email through the `email` channel when it finishes.

## Requirements and environment

- **Bun** (tested on 1.3.9): runtime and test runner (`bun test`).
- A compatible **Node** (tested on 22.22.2): some dependencies expect it on
  the `PATH` even though the engine runs on Bun.
- **`@anthropic-ai/claude-agent-sdk`** `^0.3.222`: `agent` steps.
- **`commander`**, **`yaml`**, **`zod`**: CLI, YAML parsing, schema
  validation.
- An **Anthropic API key** for `agent` steps, as `ANTHROPIC_API_KEY` in the
  data repo's `.env` (the only place a `launchd` run can read it from) or in
  the environment; the `.env` value wins. `doctor` and `run` check it as the
  `auth` check, only for pipelines that have `agent` steps. Only `agent`
  steps receive it: `shell` steps and notification channels never do.
- `git`, plus any binary a given pipeline declares in `requires.bin` (e.g.
  `yarn`, `jq`).

**Subprocess environment.** A `shell` step, a `shell:` guard and a
notification channel receive a narrow, fixed environment (`PATH`, `HOME`,
`SHELL`, `USER`, `TZ`, `TMPDIR` inherited, plus the declared secrets), never
the whole `process.env`. The locale is **pinned to `C.UTF-8`**, not
inherited: that way a pipeline behaves the same when launched by hand as
from `launchd`/cron, which don't export `LANG`. It matters more than it
seems: in the C locale, a regex `.` matches a byte, not a character, so any
pattern over accented text fails only under cron. `C.UTF-8` gives UTF-8
semantics in regexes while keeping bytewise collation, so no `sort` changes
order.

```bash
bun test             # full suite
bun x tsc --noEmit   # typecheck
```

## Status and known limitations

- **There is no `pipelines init`.** Creating a new data repo (its
  `pipelines.yaml`, `agents/`, `.env`) is still manual.
- **launchd only.** `install`/`uninstall` know nothing about systemd or
  crontab: the engine has only been run unattended on macOS.
- **stdio MCP servers only.** SSE/HTTP are not supported.
- **Only `kind: playwright` in `mcp_servers`.** Any other MCP package needs
  the engine's governance table extended first.
- **No dependency cache between runs**: each throwaway/execution
  environment is the responsibility of whoever prepares it (the engine
  doesn't install a target repo's dependencies, e.g. `yarn install`).
