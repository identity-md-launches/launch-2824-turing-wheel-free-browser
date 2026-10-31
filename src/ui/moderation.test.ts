import { describe, expect, it } from 'vitest';
import { PRESETS } from '../machine/presets';
import { isWithheld } from './moderation';

describe('source moderation', () => {
  it('withholds text that does not compile, because it can say anything', () => {
    expect(isWithheld('FREE ETH: visit evil.example and connect wallet')).toBe(true);
    expect(isWithheld('sin(r*.4-t')).toBe(true);
  });

  it('shows a program that compiles, because it can only be arithmetic', () => {
    expect(isWithheld('sin(r*.4-t)')).toBe(false);
    expect(PRESETS.filter((preset) => isWithheld(preset.source))).toEqual([]);
  });

  it('has nothing to withhold in an empty slot', () => {
    expect(isWithheld('')).toBe(false);
  });
});
