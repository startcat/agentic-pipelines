import { existsSync } from 'node:fs';
import { shellArgv } from './interpreter.ts';
import { interpolate, interpolateForShell, type InterpolationScope } from '../params/resolve.ts';
import type { OutputType, ShellStep } from '../schema/pipeline.ts';
import { redactSecrets } from '../runs/store.ts';

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractError';
  }
}

export type StepContext = {
  scope: InterpolationScope;
  /** Only the secrets declared in the pipeline's `requires.env`. */
  secrets: Record<string, string>;
  defaultCwd: string;
  timeoutMs: number;
};

/**
 * Process variables a step needs to work. Everything else is dropped:
 * without this list, the interpreter (`sh` on macOS, `bash` on Linux) would
 * not even find its own binaries; with the whole `process.env`, a step would
 * see credentials of neighboring pipelines.
 */
const BASE_ENV_KEYS = ['PATH', 'HOME', 'SHELL', 'USER', 'TZ', 'TMPDIR'];

/**
 * Locale of EVERY subprocess the engine starts, fixed instead of inherited
 * — `LANG`/`LC_ALL` left `BASE_ENV_KEYS` on purpose, they were not forgotten.
 *
 * Inheriting it made a pipeline behave differently depending on who launched
 * it: a terminal exports `LANG` (UTF-8), a launchd plist only declares `PATH`
 * and `HOME`, so under cron the subprocesses fell back to the C locale. In C,
 * the `.` of a regular expression matches ONE BYTE, and an accented character
 * in UTF-8 is two — a pattern that matches by hand fails under cron, silently.
 * It really happened: a `shell:` guard in a real pipeline with `.ltima
 * revisió` skipped the pipeline ten nights in a row.
 *
 * `C.UTF-8` and not `en_US.UTF-8` because it gives the two halves that are
 * needed: UTF-8 character semantics in regexes, and bytewise collation like
 * the C locale's — so fixing it does not reorder any `sort` of a pipeline
 * that already runs under cron today. Same criterion as `settingSources: []`
 * and `strictMcpConfig: true`: the engine does not inherit the machine's
 * configuration.
 *
 * Portability note: `C.UTF-8` exists on macOS (verified with `locale -a`) and
 * on glibc >= 2.35; on an older distro this constant would need a review.
 */
const FIXED_LOCALE_ENV = { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };

/** Environment of the child process: minimal base, fixed locale and the declared secrets. */
export function composeEnv(secrets: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BASE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...FIXED_LOCALE_ENV, ...secrets };
}

/**
 * Authentication and network variables the Agent SDK subprocess needs (the
 * Claude Code CLI that `query()` starts), verified against the installed
 * bundle itself (`@anthropic-ai/claude-agent-sdk/sdk.mjs`): all eight appear
 * there literally. The SDK's `Options.env` REPLACES the whole subprocess
 * environment, it does not merge it with `process.env` (`sdk.d.ts`
 * ~1436-1441) — without this, an agent step on a machine authenticated via
 * `ANTHROPIC_API_KEY` would always fail to authenticate, even though
 * `doctor` gave the green light by seeing that same variable in THIS process.
 *
 * Why this list differs from `BASE_ENV_KEYS`/`composeEnv` instead of reusing
 * it as is: `composeEnv` is correct for the shell interpreter in
 * `runShellStep`, which runs the `run:` from the pipeline's own YAML — an
 * untrusted payload, so the list must not be loosened there. The SDK
 * subprocess, on the other hand, is OUR own process (the CLI we start), and
 * it needs the credential it authenticates against the API with. The real
 * tension, and why the list is still narrow and not a raw `...process.env`:
 * the `Bash` of an agent step inherits this same environment, so widening it
 * here would be the same leak `composeEnv` avoids for the shell interpreter,
 * just through a different vector.
 */
const AGENT_AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CONFIG_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
];

/**
 * Environment of the Agent SDK subprocess: the same minimal base and the
 * same fixed locale as `composeEnv`, plus the authentication/network
 * variables of `AGENT_AUTH_ENV_KEYS`, plus the credential from the data
 * repo's `.env` (`agentAuth`, which wins over the one in the environment:
 * under launchd the environment does not carry it), plus the declared
 * secrets. Secrets are applied last so that, if a pipeline declared a secret
 * with the same name as one of these variables, the declared value wins —
 * just as `composeEnv` already does.
 */
export function composeAgentEnv(
  secrets: Record<string, string>,
  agentAuth: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [...BASE_ENV_KEYS, ...AGENT_AUTH_ENV_KEYS]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...FIXED_LOCALE_ENV, ...agentAuth, ...secrets };
}

export type StepOutcome =
  | { ok: true; outputs: Record<string, unknown>; log: string; durationMs: number }
  | { ok: false; error: string; transient: boolean; log: string; durationMs: number };

function matchesType(value: unknown, type: OutputType): boolean {
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  const element = type.slice(0, -2) as 'string' | 'number' | 'boolean';
  return Array.isArray(value) && value.every((v) => matchesType(v, element));
}

/** Readable name of the received type, in the same vocabulary as `OutputType`. */
function describeReceivedType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    const elementTypes = new Set(value.map((v) => typeof v));
    const [onlyType] = elementTypes;
    if (elementTypes.size === 1 && (onlyType === 'string' || onlyType === 'number' || onlyType === 'boolean')) {
      return `${onlyType}[]`;
    }
    return 'array';
  }
  return typeof value;
}

/**
 * Excerpt of the received value, or `''` if there is nothing to add, decided
 * by CONCEPT — not by whether the field name or the shape of the value
 * "smell" like a secret (that heuristic was removed: it let a credential in
 * the middle of a sentence through under an innocent-looking field name, e.g.
 * `summary: "Payment created with key sk_live_..."`, which did fit in the
 * 40-character excerpt).
 *
 * The rule is by type:
 * - `string`: NEVER its content, only how many characters it has. It is the
 *   only type that can carry arbitrary text — a URL with credentials, a JWT,
 *   a key in the middle of a sentence — so it is the only one that must
 *   always be hidden, with no exception and no heuristic.
 * - `number` / `boolean`: the whole value. Neither can carry text, so there
 *   is nothing to hide.
 * - `null`: nothing to add — the type already says it all.
 * - `array` / `object`: at most the shape (length, or the count of top-level
 *   keys), never the values — any of them could be the dangerous string
 *   above.
 */
function excerptOf(value: unknown): string {
  if (typeof value === 'string') {
    return ` (${value.length} characters)`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return ` (${value})`;
  }
  if (value === null) {
    return '';
  }
  if (Array.isArray(value)) {
    return ` (length ${value.length})`;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  // Only the NUMBER of keys: a key can be the secret itself (a map indexed by
  // token or by email), and listing them all has no upper bound.
  return keys.length === 1 ? ' (1 key)' : ` (${keys.length} keys)`;
}

/**
 * Validates an output against the `outputs` contract and drops what is not
 * declared. Dropping instead of propagating keeps the contract honest: a
 * later step can only depend on what the YAML declares.
 *
 * The message of each type violation names the step, the field, the expected
 * type, the received type and a bounded excerpt of the value. Before this,
 * every type violation reached the email as the same generic "Contract not
 * met", without saying what failed.
 */
export function validateOutputs(
  raw: unknown,
  contract: Record<string, OutputType>,
  stepId: string,
): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ContractError(
      `Contract not met in "${stepId}": the output must be a JSON object; received ${Array.isArray(raw) ? 'an array' : typeof raw}`,
    );
  }
  const source = raw as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const issues: string[] = [];

  for (const [name, type] of Object.entries(contract)) {
    if (!(name in source)) {
      issues.push(`missing field "${name}" (${type})`);
      continue;
    }
    const value = source[name];
    if (!matchesType(value, type)) {
      issues.push(`${name} expected ${type}, received ${describeReceivedType(value)}${excerptOf(value)}`);
      continue;
    }
    result[name] = value;
  }

  if (issues.length > 0) {
    throw new ContractError(`Contract not met in "${stepId}": ${issues.join('; ')}`);
  }
  return result;
}

/**
 * Does any of the secrets appear literally inside `text`? Exported (along
 * with `redactOutputValues`) so `agent.ts` reuses it instead of keeping a
 * second copy: it is security logic that runs when redacting `outputs`, so a
 * single implementation prevents one runner from being left with a weaker
 * rule than the other if it is ever tightened here.
 */
export function containsSecret(text: string, secrets: string[]): boolean {
  return secrets.some((secret) => secret !== '' && text.includes(secret));
}

export type OutputRedactionResult =
  | { ok: true; outputs: Record<string, unknown> }
  | { ok: false; violatingFields: string[] };

/**
 * Redacts the secret values that may appear inside `outputs`. `outputs` is
 * validated against the process's raw `stdout` (not against `log`, which is
 * already redacted), so a step that echoes its own secret into a declared
 * field would reach this point intact if it were not handled separately.
 *
 * `string` fields (and the `string` elements of an array) are replaced in
 * place with REDACTION, just as in `log`/`error`. `number`/`boolean` fields
 * (and their array forms) do not allow that replacement without breaking the
 * type the contract itself declared — a number cannot be "[redacted]" — so if
 * they contain a secret they are reported as a violating field: the caller
 * must turn the result into a step failure instead of letting the raw value
 * through.
 *
 * Exported for the same reason as `containsSecret`: `agent.ts` reuses it
 * instead of duplicating it, so the rule of what is redacted and what fails
 * the step lives in one place for both runners.
 */
export function redactOutputValues(
  outputs: Record<string, unknown>,
  secrets: string[],
): OutputRedactionResult {
  const result: Record<string, unknown> = {};
  const violatingFields: string[] = [];

  for (const [key, value] of Object.entries(outputs)) {
    if (typeof value === 'string') {
      result[key] = redactSecrets(value, secrets);
    } else if (Array.isArray(value)) {
      if (value.every((v) => typeof v === 'string')) {
        result[key] = value.map((v) => redactSecrets(v as string, secrets));
      } else if (value.some((v) => containsSecret(String(v), secrets))) {
        violatingFields.push(key);
      } else {
        result[key] = value;
      }
    } else if (containsSecret(String(value), secrets)) {
      violatingFields.push(key);
    } else {
      result[key] = value;
    }
  }

  if (violatingFields.length > 0) return { ok: false, violatingFields };
  return { ok: true, outputs: result };
}

/**
 * Redacts the secret values of a StepOutcome before it leaves this function.
 * This is the only point in the engine where a secret value exists in the
 * clear (it has to be passed to the child process), so it is also the only
 * point where it must be guaranteed not to survive the output: from here on
 * the outcome is written to `.runs/` and printed by the CLI. `log`, `error`
 * and the text values inside `outputs` are redacted — `log` alone is not
 * enough, because `outputs` is built from the unredacted `stdout` (see
 * `redactOutputValues`).
 *
 * If `outputs` carries a secret in a `number`/`boolean` field that cannot be
 * redacted in place, the outcome is turned right here into a step failure
 * (contract not met) instead of returning the raw value. All the secret
 * logic lives in this single function: no other place in `runShellStep`
 * decides whether something is redacted or rejected.
 */
function redactOutcome(outcome: StepOutcome, secrets: Record<string, string>): StepOutcome {
  const values = Object.values(secrets);
  if (outcome.ok) {
    const redacted = redactOutputValues(outcome.outputs, values);
    if (!redacted.ok) {
      const issues = redacted.violatingFields.map(
        (field) => `field "${field}" contains a secret value`,
      );
      return {
        ok: false,
        error: redactSecrets(`Contract not met: ${issues.join('; ')}`, values),
        transient: false,
        log: redactSecrets(outcome.log, values),
        durationMs: outcome.durationMs,
      };
    }
    return {
      ...outcome,
      outputs: redacted.outputs,
      log: redactSecrets(outcome.log, values),
    };
  }
  return {
    ...outcome,
    log: redactSecrets(outcome.log, values),
    error: redactSecrets(outcome.error, values),
  };
}

/**
 * Message for a `Bun.spawn` that did not even start.
 *
 * The usual case —and the one that motivated splitting it out— is a `cwd`
 * that does not exist: `posix_spawn` fails with ENOENT and Bun reports it
 * naming the executable (`posix_spawn \'sh\'`; on Linux, `bash`), not the
 * directory. The raw message then says it cannot find the interpreter, which
 * is where it always was, and sends whoever reads it looking for a PATH
 * problem that does not exist. It really happened on 2026-08-31, validating
 * the notify channel: that text is what travels in the email of a nightly
 * failure, so it is the first thing seen and the last that should lie.
 *
 * `cwdExists` is passed in instead of checked here so the decision is pure
 * and can be tested without touching the disk.
 */
export function launchFailureMessage(cwd: string, cause: string, cwdExists: boolean): string {
  if (!cwdExists) {
    return `the working directory does not exist: ${cwd} (the system reported: ${cause})`;
  }
  return `could not launch the command: ${cause}`;
}

/**
 * Runs a `shell` step. If the step declares `outputs`, its stdout is parsed
 * as JSON and validated; otherwise, stdout is only recorded in the log.
 */
/** Lines of stderr that fit in the `error` of a failed step. */
const STDERR_TAIL_LINES = 5;
const STDERR_TAIL_MAX_CHARS = 400;

/**
 * The last non-empty lines of stderr, on a single line separated by " / ",
 * with a character cap. Five lines are enough for the reason behind a
 * hand-written `exit 1` (an `echo ... >&2` before exiting); the full log
 * stays in the step's file.
 */
export function stderrTail(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  const tail = lines.slice(-STDERR_TAIL_LINES).join(' / ');
  return tail.length > STDERR_TAIL_MAX_CHARS ? `${tail.slice(0, STDERR_TAIL_MAX_CHARS)}…` : tail;
}

/**
 * Margin between killing the process group with `SIGTERM` and finishing it
 * off with `SIGKILL` if it is still alive. It bounds the wait on the step's
 * pipes: without it, a child that traps `SIGTERM` (really seen with `claude`
 * hung on the network) would leave `runShellStep` waiting indefinitely for it
 * to close its inherited copy of stdout/stderr, turning the pipeline's
 * `timeout` into a decoration.
 */
const KILL_ESCALATION_GRACE_MS = 300;

/**
 * Kills the step's process GROUP, not just the interpreter heading it.
 *
 * A bare `proc.kill()` only sends the signal to the interpreter's PID: if the
 * step's `run:` starts something in the background (`caffeinate -i claude -p
 * ... &`, the headless pattern of `aeacc-nightly`/`hub-maintenance`), that
 * child inherits the stdout/stderr pipe and stays alive after the interpreter
 * is killed, so the engine keeps waiting for IT to close its copy of the fd —
 * the pipeline's `timeout` interrupts nothing, it just takes as long as the
 * orphan takes.
 *
 * The group exists because `runShellStep` starts the interpreter with
 * `detached: true` (`setsid`, `pid === pgid`): killing with a negative PID
 * reaches the whole group, background orphans included, because they inherit
 * the same `pgid` unless they call `setpgid` themselves. If the group no
 * longer exists (the process died on its own in between), `process.kill`
 * throws and it is ignored here: there is nothing to kill.
 */
function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group no longer exists (the process ended on its own) or never
    // started as a group leader (spawn failed before setsid).
  }
}

export async function runShellStep(
  step: ShellStep,
  ctx: StepContext,
): Promise<StepOutcome> {
  const started = Date.now();
  const { command, env: refEnv } = interpolateForShell(step.run, ctx.scope);
  const cwd = step.cwd ? interpolate(step.cwd, ctx.scope) : ctx.defaultCwd;

  let stdout = '';
  let stderr = '';
  let exitCode: number;
  let timedOut = false;

  // The timeout is applied by killing the process, not with AbortSignal: it
  // is the uniform behavior across all Bun versions and leaves the stdout
  // produced up to that point available for the log.
  //
  // The type is annotated explicitly with the same literals ('ignore',
  // 'pipe', 'pipe') passed to `Bun.spawn` below: `ReturnType<typeof
  // Bun.spawn>` does not work here because `Bun.spawn` is a generic function
  // and, without arguments to instantiate its parameters, `ReturnType` leaves
  // them unresolved at their default values — `proc.stdout`/`proc.stderr`
  // end up typed as `number | ReadableStream | undefined` instead of
  // `ReadableStream`, which does not compile further down.
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  try {
    proc = Bun.spawn(shellArgv(command), {
      cwd,
      env: { ...composeEnv(ctx.secrets), ...refEnv },
      stdout: 'pipe',
      stderr: 'pipe',
      // `setsid()`: the interpreter is born as the leader of its own group
      // (pid === pgid), so killing the whole group (see `killProcessGroup`)
      // is possible even if the step starts children in the background.
      detached: true,
    });
  } catch (err) {
    return redactOutcome(
      {
        ok: false,
        error: launchFailureMessage(cwd, (err as Error).message, existsSync(cwd)),
        transient: false,
        log: '',
        durationMs: Date.now() - started,
      },
      ctx.secrets,
    );
  }

  let escalation: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessGroup(proc.pid, 'SIGTERM');
    escalation = setTimeout(() => killProcessGroup(proc.pid, 'SIGKILL'), KILL_ESCALATION_GRACE_MS);
  }, ctx.timeoutMs);

  [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  exitCode = await proc.exited;
  clearTimeout(timer);
  clearTimeout(escalation);

  const durationMs = Date.now() - started;
  const log = stdout + stderr;

  if (timedOut) {
    return redactOutcome(
      { ok: false, error: `timed out after ${ctx.timeoutMs} ms`, transient: true, log, durationMs },
      ctx.secrets,
    );
  }

  if (exitCode !== 0) {
    // The error carries the stderr tail, not just the code: `failureReason`
    // (notify/dispatch.ts) puts it in the email, and "verdict: exit code 1"
    // without the lines the step wrote to stderr forced going to look at the
    // log by hand (it happened in a trial run when migrating a real pipeline).
    const tail = stderrTail(stderr);
    return redactOutcome(
      {
        ok: false,
        error: tail ? `exit code ${exitCode} — ${tail}` : `exit code ${exitCode}`,
        transient: false,
        log,
        durationMs,
      },
      ctx.secrets,
    );
  }

  if (!step.outputs) return redactOutcome({ ok: true, outputs: {}, log, durationMs }, ctx.secrets);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return redactOutcome(
      {
        ok: false,
        error: 'the step declares outputs but its stdout is not valid JSON',
        transient: false,
        log,
        durationMs,
      },
      ctx.secrets,
    );
  }

  try {
    return redactOutcome(
      { ok: true, outputs: validateOutputs(parsed, step.outputs, step.id), log, durationMs },
      ctx.secrets,
    );
  } catch (err) {
    return redactOutcome(
      { ok: false, error: (err as Error).message, transient: false, log, durationMs },
      ctx.secrets,
    );
  }
}
