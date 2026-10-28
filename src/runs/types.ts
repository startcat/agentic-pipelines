export type RunStatus = 'running' | 'success' | 'failed' | 'skipped';
export type StepStatus = 'success' | 'failed' | 'skipped';

/**
 * A denial from the `PreToolUse` hook of an `agent` step (`runner/agent.ts`,
 * `buildDenials`), persisted as part of its `StepRecord` so that the
 * detective layer of the filesystem sandbox is visible via
 * `pipelines show`, not only in memory during the run.
 *
 * Defined here (not in `runner/agent.ts`) so that `runner/agent.ts` can
 * import this type without creating a cycle: `runner/agent.ts` already
 * depends on `runs/store.ts` (for `redactSecrets`), which in turn depends on
 * this file — if `Denial` lived in `runner/agent.ts` and imported something
 * back from `runs/types.ts`, or if this file imported from
 * `runner/agent.ts`, the cycle `runs/types.ts` -> `runner/agent.ts` ->
 * `runs/store.ts` -> `runs/types.ts` would close. `runs/types.ts` imports
 * nothing today (it is a leaf of the module graph) — same pattern
 * `notify/dispatch.ts` already uses, which imports `RunRecord` directly from
 * this file instead of through `runs/store.ts`.
 */
export type Denial = {
  toolName: string;
  toolUseId: string;
  reason?: string;
  /** 'hook-log': only the hook recorded it. 'sdk-result': only permission_denials
   *  recorded it (a sign that something other than the hook itself denied — or
   *  that the hook failed open without its log capturing it). 'both': both
   *  sources agree, the normal case of a real denial by the hook. */
  source: 'hook-log' | 'sdk-result' | 'both';
};

export type StepRecord = {
  id: string;
  status: StepStatus;
  startedAt: string;
  durationMs: number;
  /** Outputs validated against the contract. Empty if the step declares none. */
  outputs: Record<string, unknown>;
  effects: string[];
  /** Attempts used, including the first. */
  attempts: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  toolsUsed?: string[];
  error?: string;
  /** Reason for the skip, when status is 'skipped'. */
  skipReason?: string;
  /** Denials from the PreToolUse hook of an agent step — see `Denial`. */
  denials?: Denial[];
};

/**
 * Trace of a run's `notify:` channel: which channel was invoked, what code it
 * exited with, when, and the tail of its output (stdout+stderr, redacted with
 * the channel's secrets). The engine used to discard that output (`stdout:
 * 'ignore'`) and an email send left no proof of having happened — the bash
 * script it replaces did write `notify sent (200) id=…`. Uncovered while
 * migrating a real pipeline.
 */
export type NotifyRecord = {
  channel: string;
  code: number;
  at: string;
  log: string;
};

export type RunRecord = {
  id: string;
  pipeline: string;
  pipelineVersion: number;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  params: Record<string, string>;
  steps: Record<string, StepRecord>;
  totalCostUsd?: number;
  skipReason?: string;
  /**
   * The run was launched with `run --force`, skipping the evaluation of `when:`.
   * Only present when true: a normal run doesn't carry the field.
   *
   * It is persisted because a forced run does NOT prove the guards would have
   * let it through, and without the mark the `.runs/` history can't tell "it
   * ran because it was due" from "it ran because someone insisted" — exactly
   * the kind of ambiguity this project pays dearly for when it reads its own
   * past.
   */
  forced?: boolean;
  /** Trace of the notify channel, if it was invoked — see `NotifyRecord`. */
  notify?: NotifyRecord;
};
