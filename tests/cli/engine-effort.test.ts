import { describe, expect, it } from 'vitest';
import { effortFor } from '../../cli/lib/engines.mjs';

describe('effortFor', () => {
  it('clamps an unsupported global effort to high for gpt-5 models', () => {
    expect(effortFor('gpt-5.5', { model: 'gpt-6-sol', effort: 'max' })).toBe('high');
    expect(effortFor(undefined, { model: 'gpt-5.5', effort: 'max' })).toBe('high');
  });
  it('leaves supported efforts and newer models alone', () => {
    expect(effortFor('gpt-5.5', { effort: 'xhigh' })).toBeUndefined();
    expect(effortFor('gpt-6-sol', { effort: 'max' })).toBeUndefined();
    expect(effortFor(undefined, {})).toBeUndefined();
  });
});
