import { describe, it, expect } from 'vitest';
import { classifyConfidence } from '@/lib/trademark/confidence';

describe('classifyConfidence', () => {
  it('returns "low" for single-word marks < 5 chars', () => {
    expect(classifyConfidence('ace')).toBe('low');
    expect(classifyConfidence('sun')).toBe('low');
    expect(classifyConfidence('red')).toBe('low');
    expect(classifyConfidence('max')).toBe('low');
  });

  it('returns "high" for single-word marks >= 5 chars', () => {
    expect(classifyConfidence('hello')).toBe('high');
    expect(classifyConfidence('mountain')).toBe('high');
    expect(classifyConfidence('apple')).toBe('high');
  });

  it('returns "high" for multi-word marks regardless of length', () => {
    expect(classifyConfidence('cat dad')).toBe('high');
    expect(classifyConfidence('ab cd')).toBe('high');
  });

  it('returns "low" for exactly 4 chars single word', () => {
    expect(classifyConfidence('test')).toBe('low');
    expect(classifyConfidence('cool')).toBe('low');
  });

  it('returns "high" for exactly 5 chars single word', () => {
    expect(classifyConfidence('world')).toBe('high');
  });
});
