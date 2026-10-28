import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// `.strict()`: a channel has three fields — `type` and `run`, required, plus
// `env`, optional with `.default([])`. A typo in `type` or `run` would fail
// anyway as "Required" naming the right field, but a typo in `env` (e.g.
// `enviroment: [...]`) would NOT fail that way without `.strict()`: the
// unknown key would be dropped silently and the real `env` would stay `[]`
// without warning. `.strict()` is here the main defense against that
// optional-field case, not just a leftover catch-all over the two required
// ones — for the same reason as the rest of this file: no unknown key
// must disappear silently.
const channelSchema = z
  .object({
    type: z.literal('shell'),
    run: z.string(),
    /**
     * Names of secrets this channel needs, never values — same pattern as
     * a pipeline's `requires.env` and `mcp_servers.<x>.env`. Resolved
     * against the data repo's `.env` only when the channel is actually
     * invoked (`dispatchNotify`), never exposed to the pipeline that
     * triggered the notify.
     */
    env: z.array(z.string()).default([]),
  })
  .strict();

// The YAML key is `on_error` ("defaults: { on_error: stop, ... }"),
// consistent with the rest of the format, already snake_case: `stale_count`,
// `pr_url`, `last_success`. The internal field is exposed as `onError`
// because identifiers are English camelCase (convention across the whole
// code); `parseRepoConfig` does that mapping explicitly below, like
// `parsePipeline` in `schema/pipeline.ts`.
//
// `.strict()` on `repoConfigSchema`, on the `defaults` object and on the two
// nested shapes (`retry` in its object branch, `notify`): without it, Zod
// drops any unknown key silently — which is exactly the defect `on_error`
// uncovered, and which without `.strict()` would stay open for any other
// key or typo (`onError`, `retries`, `notifi`, an invented root-level key).
// `pipeline.ts` already applies the same treatment to its
// `pipelineSchema`/`defaultsSchema`/steps; this matches it here, in the
// sibling that validates `pipelines.yaml`.
const repoConfigSchema = z
  .object({
    channels: z.record(channelSchema).default({}),
    defaults: z
      .object({
        on_error: z.enum(['stop', 'continue']).optional(),
        retry: z
          .union([
            z.number(),
            z.object({ attempts: z.number(), on: z.enum(['transient', 'any']) }).strict(),
          ])
          .optional(),
        timeout: z.string().optional(),
        // Same shape as `pipelineSchema.notify` in `schema/pipeline.ts`,
        // including `stale_after` — see the comment there.
        notify: z
          .object({
            on: z.array(z.enum(['failed', 'success', 'skipped'])),
            stale_after: z.string().regex(/^\d+(s|m|h)$/, 'must be a number followed by s, m or h (e.g. 72h)').optional(),
            channel: z.string(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

type RawRepoConfig = z.infer<typeof repoConfigSchema>;

export type RepoConfig = {
  channels: RawRepoConfig['channels'];
  defaults: {
    onError?: 'stop' | 'continue';
    retry?: RawRepoConfig['defaults']['retry'];
    timeout?: string;
    notify?: RawRepoConfig['defaults']['notify'];
  };
};

/** Parses `pipelines.yaml`, the shared configuration of the data repo. */
export function parseRepoConfig(yamlText: string): RepoConfig {
  const result = repoConfigSchema.safeParse(parseYaml(yamlText) ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid pipelines.yaml:\n  - ${issues.join('\n  - ')}`);
  }
  const { channels, defaults } = result.data;
  return {
    channels,
    defaults: {
      onError: defaults.on_error,
      retry: defaults.retry,
      timeout: defaults.timeout,
      notify: defaults.notify,
    },
  };
}
