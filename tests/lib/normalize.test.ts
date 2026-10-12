import { describe, it, expect } from 'vitest';
import { normalizeText } from '@/lib/trademark/normalize';
import vectors from '../fixtures/normalization-vectors.json';

describe('normalizeText', () => {
  it.each(vectors)('normalizes "$input" to "$expected"', ({ input, expected }) => {
    expect(normalizeText(input)).toBe(expected);
  });

  it('lowercases all characters', () => {
    expect(normalizeText('HELLO WORLD')).toBe('hello world');
  });

  it('strips straight apostrophes', () => {
    expect(normalizeText("don't")).toBe('dont');
  });

  it('strips curly apostrophes', () => {
    expect(normalizeText('don\u2019t')).toBe('dont');
  });

  it('converts hyphens to spaces', () => {
    expect(normalizeText('t-shirt')).toBe('t shirt');
  });

  it('removes special characters but keeps alphanumeric', () => {
    expect(normalizeText('hello@world.com!')).toBe('hello world com');
  });

  it('collapses multiple spaces', () => {
    expect(normalizeText('a  b   c')).toBe('a b c');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeText('  hello  ')).toBe('hello');
  });

  it('handles empty string', () => {
    expect(normalizeText('')).toBe('');
  });

  it('preserves numbers', () => {
    expect(normalizeText('Apollo 13')).toBe('apollo 13');
  });

  it('replaces underscores with spaces', () => {
    expect(normalizeText('hello_world')).toBe('hello world');
  });

  it('handles multiple apostrophe types in one string', () => {
    expect(normalizeText("it's and it\u2019s")).toBe('its and its');
  });

  it('handles string with only special characters', () => {
    expect(normalizeText('!@#$%^&*()')).toBe('');
  });

  it('handles multiple hyphens', () => {
    expect(normalizeText('a--b---c')).toBe('a b c');
  });
});
