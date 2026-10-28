import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildGraph } from '../graph/build.ts';
import { evaluateWhen } from '../expr/evaluate.ts';
import type { InterpolationScope } from '../params/resolve.ts';
import { RunStore, redactSecrets, type RunRecord, type StepRecord } from '../runs/store.ts';
import type { Pipeline, Step } from '../schema/pipeline.ts';
import { parseDuration } from '../guards/evaluate.ts';
import { runAgentStep, type AgentOutcome } from './agent.ts';
import { runShellStep } from './shell.ts';

export type RunOptions = {
  pipeline: Pipeline;
  repoRoot: string;
  store: RunStore;
  params: Record<string, string>;
  /** Values of the secrets declared in requires.env. */
  secrets: Record<string, string>;
  /** Claude credential from the data repo's `.env`, only for `agent` steps. */
  agentAuth?: Record<string, string>;
  /** Previous run to resume. Its successful steps are not re-run. */
  resumeFrom?: RunRecord;
  /** The run was launched with `run --force`: it is noted in the record. */
  forced?: boolean;
  /** Injectable for tests; defaults to the real agent runner. */
  agentRunner?: typeof runAgentStep;
  /** Injectable for tests: avoids real waits between retries. */
  sleepFn?: (ms: number) => Promise<void>;
};

const PIPELINE_DIR = 'pipelines';

/** Wait with exponential backoff: 1s, 2s, 4s... */
function backoffMs(attempt: number): number {
  return 1000 * 2 ** (attempt - 1);
}

async function executeOnce(
  step: Step,
  options: RunOptions,
  scope: InterpolationScope,
  pipelineDir: string,
): Promise<AgentOutcome> {
  const ctx = {
    scope,
    secrets: options.secrets,
    defaultCwd: pipelineDir,
    timeoutMs: parseDuration(step.timeout),
  };

  if (step.type === 'shell') return runShellStep(step, ctx);

  const promptText = await readFile(join(pipelineDir, step.prompt), 'utf8');
  const runner = options.agentRunner ?? runAgentStep;
  return runner(step, {
    ...ctx,
    repoRoot: options.repoRoot,
    promptText,
    mcpServers: options.pipeline.mcpServers,
    agentAuth: options.agentAuth,
  });
}

/**
 * Runs one attempt of a step, catching any exception that may escape before
 * a `StepOutcome` exists. `interpolate()` (params/resolve.ts) deliberately
 * throws if a `{{...}}` reference cannot be resolved, and both
 * `runShellStep` and `runAgentStep` call it without catching it — that is a
 * decision of those modules, not an oversight: turning that exception into a
 * step failure (instead of aborting the WHOLE run uncaught) is this
 * orchestrator's responsibility. The message is redacted just in case: it is
 * text this module composes from an exception, not an `outcome` a runner has
 * already redacted.
 */
async function attempt(
  step: Step,
  options: RunOptions,
  scope: InterpolationScope,
  pipelineDir: string,
): Promise<AgentOutcome> {
  const started = Date.now();
  try {
    return await executeOnce(step, options, scope, pipelineDir);
  } catch (err) {
    const secretValues = Object.values(options.secrets);
    return {
      ok: false,
      error: redactSecrets((err as Error).message, secretValues),
      transient: false,
      log: '',
      durationMs: Date.now() - started,
    };
  }
}

/**
 * Runs a pipeline step by step.
 *
 * State is persisted after each step, never only at the end: if the process
 * dies midway, `resumeFrom` can resume exactly where it left off.
 */
export async function runPipeline(options: RunOptions): Promise<RunRecord> {
  const { pipeline, store } = options;

  if (options.resumeFrom && options.resumeFrom.pipelineVersion !== pipeline.version) {
    throw new Error(
      `Cannot resume: the run is from version ${options.resumeFrom.pipelineVersion} ` +
        `and the pipeline is at version ${pipeline.version}. Start a new one.`,
    );
  }

  const graph = buildGraph(pipeline);
  const byId = new Map(pipeline.steps.map((s) => [s.id, s]));

  // A step's default cwd is the pipeline's own directory (where pipeline.yaml
  // and the .md prompts live). In real use it already exists because the
  // pipeline was loaded from there; it is created here too because this
  // module's tests build the Pipeline in memory (parsePipeline over a
  // string) without that directory ever existing on disk, and `Bun.spawn`
  // fails if its `cwd` does not exist.
  const pipelineDir = join(options.repoRoot, PIPELINE_DIR, pipeline.name);
  await mkdir(pipelineDir, { recursive: true });

  // Do not reuse the `steps` object of `resumeFrom` as is: this run will
  // write to `run.steps` as it advances, and doing so on the same reference
  // would also mutate the RunRecord the caller keeps.
  const run: RunRecord = options.resumeFrom
    ? { ...options.resumeFrom, status: 'running', steps: { ...options.resumeFrom.steps } }
    : await store.createRun(
        pipeline.name,
        pipeline.version,
        options.params,
        new Date(),
        options.forced ?? false,
      );

  const scope: InterpolationScope = { params: options.params, steps: {} };
  for (const [id, record] of Object.entries(run.steps)) {
    // Only the outputs of what already completed successfully are imported.
    // The `failed`/`skipped` steps of the previous run are NOT marked as
    // blocked here: in this run they get a real chance to run (that is why
    // there is no `continue` for them further down), and their failure or
    // skip result —and that of their dependents— is recomputed from scratch
    // in this same run. Seeding it with the previous attempt's state would
    // leave a step that now succeeds marked as "failed" for its dependents,
    // just because it was in an earlier attempt.
    if (record.status === 'success') scope.steps[id] = record.outputs;
  }

  // Skip cascade: id of a blocked step -> id of the step that blocks it.
  // It is built forward with `graph.dependents` (never re-derived from
  // `graph.dependencies`) right when each step resolves as `skipped` or
  // `failed`, so it is transitive by construction: if "a" blocks "b", as
  // soon as "b" is marked `skipped` this same mechanism propagates the skip
  // to the dependents of "b" (e.g. "c"), attributing each skip to its
  // nearest blocker.
  const cascaded = new Map<string, string>();
  function propagateSkip(id: string): void {
    for (const dependent of graph.dependents.get(id) ?? []) {
      if (!cascaded.has(dependent)) cascaded.set(dependent, id);
    }
  }

  /**
   * Writes the `StepRecord` of a skipped step and propagates the cascade to
   * its dependents. Single write point for the two skip reasons (blocked by
   * cascade, `when` false): both produce exactly the same `StepRecord`, only
   * the `skipReason` text changes.
   */
  async function skipStep(id: string, startedAt: string, reason: string): Promise<void> {
    await store.writeStep(run, {
      id,
      status: 'skipped',
      startedAt,
      durationMs: 0,
      outputs: {},
      effects: [],
      attempts: 0,
      skipReason: reason,
    });
    propagateSkip(id);
  }

  // Different from "there was some failure": only a failure whose policy was
  // NOT on_error: continue counts. Since on_error: continue is the only thing
  // that lets the loop go on after a failure (on_error: stop, the default,
  // cuts with `break`), this used to collapse "there was some failure" and
  // "there was an explicitly tolerated failure" into the same result — it
  // broke the throttle anchor (since: last_success) for any pipeline that
  // used on_error: continue on purpose.
  let sawHardFailure = false;

  for (const id of graph.order) {
    if (run.steps[id]?.status === 'success') continue;

    const step = byId.get(id)!;
    const startedAt = new Date().toISOString();

    const blocker = cascaded.get(id);
    if (blocker) {
      await skipStep(id, startedAt, `step "${blocker}" produced no output`);
      continue;
    }

    if (step.when && !evaluateWhen(step.when, scope)) {
      await skipStep(id, startedAt, `when: ${step.when}`);
      continue;
    }

    let outcome = await attempt(step, options, scope, pipelineDir);
    let attempts = 1;

    while (
      !outcome.ok &&
      attempts <= step.retry.attempts &&
      (step.retry.on === 'any' || outcome.transient)
    ) {
      await (options.sleepFn ?? Bun.sleep)(backoffMs(attempts));
      outcome = await attempt(step, options, scope, pipelineDir);
      attempts += 1;
    }

    const record: StepRecord = {
      id,
      status: outcome.ok ? 'success' : 'failed',
      startedAt,
      durationMs: outcome.durationMs,
      outputs: outcome.ok ? outcome.outputs : {},
      effects: step.effects,
      attempts,
      costUsd: outcome.costUsd,
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens,
      toolsUsed: outcome.toolsUsed,
      error: outcome.ok ? undefined : outcome.error,
      // Present only for `agent` steps (the PreToolUse hook of
      // `runAgentStep`); `undefined` for `shell` steps, which have no hook.
      // Persisting it here is what makes the filesystem sandbox's detective
      // layer visible via `pipelines show` — without it,
      // `AgentOutcome.denials` was computed correctly but lost between the
      // return value of `runAgentStep` and `.runs/`.
      denials: outcome.denials,
    };

    await store.writeStep(run, record);
    // `outcome.log` already arrives redacted from the runner itself (shell.ts
    // and agent.ts redact on every return path): it is NOT redacted a second
    // time here. A second filter invites relaxing the first.
    await store.writeStepLog(run, id, outcome.log);

    if (outcome.ok) {
      scope.steps[id] = outcome.outputs;
      continue;
    }

    if (step.onError !== 'continue') sawHardFailure = true;
    propagateSkip(id);
    if (step.onError === 'stop') break;
  }

  // `always:` runs whenever we get here — that is, after the pipeline guards
  // have already let `runPipeline` start (if a guard skips the whole run,
  // cli/index.ts never calls this function, so there is no side effect to
  // clean up). Each step is recorded like any other, but its result NEVER
  // touches `sawHardFailure`: it is diagnostic information, not part of the
  // run's success/failure contract.
  for (const step of pipeline.always) {
    const startedAt = new Date().toISOString();
    const outcome = await attempt(step, options, scope, pipelineDir);
    await store.writeStep(run, {
      id: step.id,
      status: outcome.ok ? 'success' : 'failed',
      startedAt,
      durationMs: outcome.durationMs,
      outputs: outcome.ok ? outcome.outputs : {},
      effects: [],
      attempts: 1,
      costUsd: outcome.costUsd,
      error: outcome.ok ? undefined : outcome.error,
    });
    await store.writeStepLog(run, step.id, outcome.log);
  }

  await store.finishRun(run, sawHardFailure ? 'failed' : 'success');
  return run;
}
