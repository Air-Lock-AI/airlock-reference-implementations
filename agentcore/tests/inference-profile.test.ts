import { describe, expect, it } from 'vitest';

import { applyInferenceProfilePrefix, deriveInferenceProfilePrefix } from '../src/lib/run-agent.ts';

describe('deriveInferenceProfilePrefix', () => {
  it.each([
    ['us-east-1', 'us.'],
    ['us-west-2', 'us.'],
    ['eu-west-1', 'eu.'],
    ['eu-central-1', 'eu.'],
    ['ap-southeast-2', 'apac.'],
    ['ap-northeast-1', 'apac.'],
    ['sa-east-1', 'global.'],
    ['af-south-1', 'global.'],
  ])('%s → %s', (region, expected) => {
    expect(deriveInferenceProfilePrefix(region)).toBe(expected);
  });
});

describe('applyInferenceProfilePrefix', () => {
  it('prepends the prefix when none is present', () => {
    expect(applyInferenceProfilePrefix('anthropic.claude-haiku-4-5-20251001-v1:0', 'eu.')).toBe(
      'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
    );
  });

  it('leaves an already-prefixed id unchanged', () => {
    expect(applyInferenceProfilePrefix('us.anthropic.claude-sonnet-4-6', 'eu.')).toBe(
      'us.anthropic.claude-sonnet-4-6',
    );
    expect(applyInferenceProfilePrefix('global.anthropic.claude-opus-4-7', 'us.')).toBe(
      'global.anthropic.claude-opus-4-7',
    );
  });
});
