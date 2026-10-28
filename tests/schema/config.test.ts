import { describe, expect, test } from 'bun:test';
import { parseRepoConfig } from '../../src/schema/config.ts';

// config.ts got the key rename (onError -> on_error) but never the
// `.strict()` that its sibling `pipeline.ts` already had, so `pipelines.yaml`
// kept silently swallowing the same typo that on_error exists to catch.
describe('parseRepoConfig', () => {
  test('accepts on_error and exposes it as onError', () => {
    const config = parseRepoConfig('defaults:\n  on_error: continue\n');
    expect(config.defaults.onError).toBe('continue');
  });

  test('rejects the camelCase typo onError naming the key', () => {
    expect(() => parseRepoConfig('defaults:\n  onError: continue\n')).toThrow(/onError/);
  });

  test('rejects an unknown key at pipeline level naming it', () => {
    expect(() => parseRepoConfig('inventedKey: 1\n')).toThrow(/inventedKey/);
  });

  test('rejects an unknown key in defaults naming it', () => {
    expect(() => parseRepoConfig('defaults:\n  retires: 2\n')).toThrow(/retires/);
  });

  test('accepts defaults.notify.on with failed and exposes it as is', () => {
    const config = parseRepoConfig('defaults:\n  notify:\n    on: [failed, success]\n    channel: telegram\n');
    expect(config.defaults.notify).toEqual({ on: ['failed', 'success'], channel: 'telegram' });
  });

  // cli/context.ts depends on this: loadRepoContext accepts an empty
  // pipelines.yaml (touch pipelines.yaml is enough) because every field of
  // this schema has a default value.
  test('an empty config parses successfully', () => {
    const config = parseRepoConfig('');
    expect(config).toEqual({ channels: {}, defaults: {} });
  });

  test('a channel accepts an optional env: and exposes the declared names', () => {
    const config = parseRepoConfig(
      'channels:\n  email:\n    type: shell\n    run: scripts/notify.sh\n    env: [RESEND_API_KEY]\n',
    );
    expect(config.channels['email']).toEqual({
      type: 'shell',
      run: 'scripts/notify.sh',
      env: ['RESEND_API_KEY'],
    });
  });

  test('a channel without env: declared exposes an empty list', () => {
    const config = parseRepoConfig('channels:\n  telegram:\n    type: shell\n    run: relay.sh\n');
    expect(config.channels['telegram']!.env).toEqual([]);
  });

  test('rejects an unknown key inside a channel naming it', () => {
    expect(() =>
      parseRepoConfig('channels:\n  x:\n    type: shell\n    run: r.sh\n    secrets: [A]\n'),
    ).toThrow(/secrets/);
  });
});
