import { describe, expect, it } from 'vitest';
import { COLS, ROWS } from '../../types';
import { FONT_BANNER, FONT_MINI, FONT_PLAQUE, textWidth, type LedFont } from './font';
import { ACQUIRING_LINES, FAULT_LINES, REDACTED_LINES, haltedLines, lostLines } from './plates';
import type { PlateLine } from './scene';

const FONTS: Record<PlateLine['font'], LedFont> = { mini: FONT_MINI, banner: FONT_BANNER, plaque: FONT_PLAQUE };

const PLATES: readonly (readonly [string, readonly PlateLine[]])[] = [
  ['halted', haltedLines(null, 58518)],
  ['halted on an eight digit cycle count', haltedLines(null, 99_999_999)],
  ['halted with a schedule', haltedLines(Date.UTC(2026, 9, 31, 21, 0), 58518)],
  ['lost', lostLines(true)],
  ['never seen', lostLines(false)],
  ['fault', FAULT_LINES],
  ['acquiring', ACQUIRING_LINES],
  ['redacted', REDACTED_LINES],
];

describe('led plates', () => {
  // The plaque face holds only the letters it spells, and a missing glyph renders as a silent gap.
  it.each(PLATES)('%s has a glyph for every character', (_name, lines) => {
    for (const line of lines) {
      for (const char of line.text) expect(FONTS[line.font].glyphs[char], `${line.text}: ${char}`).toBeDefined();
    }
  });

  it.each(PLATES)('%s stays on the wall', (_name, lines) => {
    for (const line of lines) {
      const font = FONTS[line.font];
      const width = textWidth(font, line.text);
      expect(line.x, line.text).toBeGreaterThanOrEqual(0);
      expect(line.x + (line.block?.width ?? width), line.text).toBeLessThanOrEqual(COLS);
      expect(line.y + (line.block?.height ?? font.height), line.text).toBeLessThanOrEqual(ROWS);
      if (line.block) expect(width, line.text).toBeLessThanOrEqual(line.block.width);
    }
  });
});
