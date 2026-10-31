import { describe, expect, it } from 'vitest';
import { compile } from '../../lang';
import { HOUSE_ROM, PRESETS } from '../../machine/presets';
import { CELLS, COLS, createFrame, type Program } from '../../types';
import { BLUE_LUMINANCE, GOLD_LUMINANCE, createFlashGuard } from './flash-guard';
import { createPhosphor } from './phosphor';

const FRAME_MS = 1000 / 60;
const SECONDS = 8;

/**
 * WCAG 2.3.1 on a luminance series: a flash is a pair of opposing changes of at least 0.1. This
 * model has no bloom, and a real wall reads about twice as bright, so 0.045 here is 0.1 in Chrome.
 */
const FLASH_SWING = 0.045;

function worstFlashesInAnySecond(series: Float64Array): number {
  const reversals: number[] = [];
  let direction = 0;
  let extreme = series[0] as number;
  series.forEach((value, frame) => {
    if (direction >= 0 && value > extreme) {
      extreme = value;
      direction = 1;
    } else if (direction <= 0 && value < extreme) {
      extreme = value;
      direction = -1;
    } else if (Math.abs(value - extreme) >= FLASH_SWING) {
      reversals.push(frame);
      direction = value > extreme ? 1 : -1;
      extreme = value;
    }
  });
  const framesPerSecond = 1000 / FRAME_MS;
  return reversals.reduce(
    (worst, frame) => Math.max(worst, reversals.filter((other) => other >= frame && other < frame + framesPerSecond).length / 2),
    0,
  );
}

/** As the shader composites a cell: the round LED sits over the square tile. */
function luminanceOf(gold: number, blue: number): number {
  const disc = 0.59;
  const tile = 0.81;
  const lit = Math.min(1, gold / 0.2);
  const goldShare = (GOLD_LUMINANCE[Math.round(gold * 64)] as number) * disc * lit;
  const blueShare = (BLUE_LUMINANCE[Math.round(blue * 64)] as number) * (tile - disc * lit);
  return goldShare + blueShare;
}

interface Run {
  readonly wall: number;
  readonly worstRegion: number;
  readonly worstCell: number;
  readonly heldFrames: number;
}

/** The real path: real compiler, real phosphor, a frame every 16.7ms. Regions are 9 by 9 cells. */
function run(program: Program, cyclesPerSecond: number, seconds = SECONDS): Run {
  const phosphor = createPhosphor();
  const guard = createFlashGuard();
  const frame = createFrame();
  const targets = new Float32Array(CELLS);
  const frames = Math.round((seconds * 1000) / FRAME_MS);
  const cols = 8;
  const rows = 5;
  const wall = new Float64Array(frames);
  // Two grids, half a region apart, so a flash cannot hide across a region corner.
  const regions = Array.from({ length: cols * rows * 2 }, () => new Float64Array(frames));
  const cells = Array.from({ length: 8 }, () => new Float64Array(frames));
  let heldFrames = 0;

  for (let f = 0; f < frames; f++) {
    const now = f * FRAME_MS;
    program.render((now / 1000) * cyclesPerSecond, frame);
    for (let i = 0; i < CELLS; i++) targets[i] = (frame[i] as number) / 4;
    phosphor.step(targets, FRAME_MS);
    const shown = guard.apply(phosphor.heat, now);
    if (guard.isLimiting(now)) heldFrames += 1;

    let total = 0;
    for (let i = 0; i < CELLS; i++) {
      const value = luminanceOf(shown[i * 2] as number, shown[i * 2 + 1] as number);
      total += value;
      for (const [grid, offset] of [[0, 0], [1, 4]] as const) {
        const x = Math.floor(((i % COLS) + offset) / 9);
        const y = Math.floor((Math.floor(i / COLS) + offset) / 9);
        const region = x < cols && y < rows ? regions[grid * cols * rows + y * cols + x] : undefined;
        if (region) region[f] = (region[f] as number) + value / 81;
      }
    }
    wall[f] = total / CELLS;
    cells.forEach((cell, index) => {
      const i = 19 * COLS + 7 + index * 7;
      cell[f] = luminanceOf(shown[i * 2] as number, shown[i * 2 + 1] as number);
    });
  }
  return {
    wall: worstFlashesInAnySecond(wall),
    worstRegion: Math.max(...regions.map(worstFlashesInAnySecond)),
    worstCell: Math.max(...cells.map(worstFlashesInAnySecond)),
    heldFrames,
  };
}

function programOf(source: string): Program {
  const result = compile(source);
  if (!result.ok) throw new Error(`${source}: ${result.error.message}`);
  return result.program;
}

const HOSTILE: readonly (readonly [string, string])[] = [
  ['the reported strobe', 't*6%1<.5'],
  ['gold on black', 't*3%1<.5'],
  ['gold and blue swap', 't*3%1<.5?1:-1'],
  ['equal brightness colour swap', 't*3%1<.5?.75:-1'],
  ['rust, a saturated red', '(t*3%1<.5)*.25'],
  ['dim strobe just over the threshold', '(t*3%1<.5)*.3+.25'],
  ['a small disc', 'r<8&&t*3%1<.5'],
  ['a disc on a tile corner', 'hypot(x-32,y-16)<7&&t*3%1<.5'],
  ['a tiny disc', 'r<4&&t*3%1<.5'],
  ['two halves in counter phase', '(x<32)==(t*3%1<.5)'],
  ['a checkerboard reversing', '(x+y+floor(t*6))%2?1:-1'],
  ['a coarse checkerboard reversing', '(floor(x/4)+floor(y/4)+floor(t*6))%2?1:-1'],
  ['stripes reversing', '(floor(x/2)+floor(t*6))%2'],
  ['a smooth sine', 'sin(t*20)'],
  ['noise reseeded', 'hash(x,y+floor(t*12))*2-1'],
  ['a travelling flash', 'abs(x-t*40%64)<8'],
];

describe('flash guard', () => {
  const rates = [1, 2, 8, 32, 60];

  describe.each(HOSTILE)('%s', (_name, source) => {
    it.each(rates)('stays under 3 flashes in any second at %d cycles per second', (rate) => {
      const result = run(programOf(source), rate);
      expect(result.wall).toBeLessThanOrEqual(3);
      expect(result.worstRegion).toBeLessThanOrEqual(3);
    });
  });

  it('caps a reversing pattern on the cells themselves, where every mean stays flat', () => {
    expect(run(programOf('(x+y+floor(t*6))%2?1:-1'), 2).worstCell).toBeLessThan(3);
  });

  it('never holds back a slow sweep that is nowhere near flashing', () => {
    expect(run(programOf('abs(x-t*40%64)<8'), 2).heldFrames).toBe(0);
  });

  it('still lets a single jump through at once', () => {
    const guard = createFlashGuard();
    const heat = new Float32Array(CELLS * 2).fill(0);
    guard.apply(heat, 0);
    for (let i = 0; i < CELLS; i++) heat[i * 2] = 1;
    expect(guard.apply(heat, 16)[0]).toBe(1);
    expect(guard.isLimiting(16)).toBe(false);
  });

  it('returns to full brightness once a strobe stops', () => {
    const guard = createFlashGuard();
    const heat = new Float32Array(CELLS * 2);
    for (let f = 0; f < 120; f++) {
      heat.fill(f % 10 < 5 ? 1 : 0);
      guard.apply(heat, f * FRAME_MS);
    }
    heat.fill(1);
    let brightest = 0;
    for (let f = 120; f < 240; f++) brightest = guard.apply(heat, f * FRAME_MS)[0] as number;
    expect(brightest).toBe(1);
    expect(guard.isLimiting(240 * FRAME_MS)).toBe(false);
  });

  describe('legitimate programs are left alone', () => {
    const everything = [...PRESETS, ...HOUSE_ROM];
    const unique = [...new Map(everything.map((preset) => [preset.source, preset])).values()];

    it.each(unique.map((preset) => [preset.name, preset.source] as const))('%s at hamster speed', (_name, source) => {
      expect(run(programOf(source), 1.7).heldFrames).toBe(0);
    });
  });
});
