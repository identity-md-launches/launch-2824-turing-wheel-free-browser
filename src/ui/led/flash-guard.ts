import { CELLS, COLS, ROWS } from '../../types';
import { BLUE_STOPS, GOLD_STOPS, ramp, type Rgb } from './palette';

/**
 * Anyone can queue a program that plays on every screen, so the wall must not be able to strobe.
 * This sits between the phosphor and the surface: frames and covers stay pure, only what lights up
 * is limited. It counts on its own output, so the bound holds however the input behaves.
 *
 * WCAG 2.3.1 allows 3 flashes in any second, over 25% of a 10 degree field. That is about 9 by 9
 * cells on a 1024 wide wall, so a whole-wall mean cannot see it: tiles are that size, and the wall
 * is one more tier on top. Each phosphor counts apart, so gold and blue swapping at equal brightness
 * spends one rise of each per cycle. Rust is a saturated red, so SWING sits below its full-tile 0.086.
 */
const TILE_CELLS = 8;
const TILE_COLS = Math.ceil(COLS / TILE_CELLS);
const TILE_ROWS = Math.ceil(ROWS / TILE_CELLS);
const TILES = TILE_COLS * TILE_ROWS;
const WALL_TRACKERS = TILES * 2;
const TRACKERS = WALL_TRACKERS + 2;

export const SWING = 0.06;
export const MAX_RISES = 2;
/**
 * Just over a second, so frame rounding cannot land a third rise inside a real one. Two rises in
 * this window still clears Program Counter's bar at 1.9 Hz, the fastest a hamster has been modelled.
 */
export const WINDOW_MS = 1050;

/**
 * Reversing patterns keep every mean flat, so cells are limited too. A pulse is a cell's light
 * falling and rising again by CELL_PULSE or more, counted rather than summed: a fast flip never
 * swings fully through the phosphor, but it is still a flip. Lighting up from dark costs nothing.
 * A tile past the burst updates at most twice a second, which cannot flash faster at any amplitude,
 * until a second of calm.
 */
const CELL_PULSE = 0.08;
const CELL_PULSES_PER_SECOND = 2;
/** Just over one whole pulse: a slow sweep lights a tile at once, but the leak drains it between. */
const CELL_PULSE_BURST = 1.1;
const THROTTLED_UPDATE_MS = 500;
const THROTTLE_CALM_MS = 1000;
const MOVING = 0.002;
const LIMITING_HOLD_MS = 600;

const LUT_STEPS = 64;

function linear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function luminanceTable(stops: readonly Rgb[]): Float64Array {
  return Float64Array.from({ length: LUT_STEPS + 1 }, (_, step) => luminance(ramp(stops, step / LUT_STEPS)));
}

export const GOLD_LUMINANCE = luminanceTable(GOLD_STOPS);
export const BLUE_LUMINANCE = luminanceTable(BLUE_STOPS);

const TILE_OF = Uint8Array.from({ length: CELLS }, (_, i) =>
  Math.floor(Math.floor(i / COLS) / TILE_CELLS) * TILE_COLS + Math.floor((i % COLS) / TILE_CELLS),
);

const CELLS_IN_TILE = TILE_OF.reduce((counts, tile) => {
  counts[tile] = (counts[tile] as number) + 1;
  return counts;
}, new Float64Array(TILES));

export interface FlashGuard {
  /** True for a moment after anything was held back, so the page can say why the wall looks odd. */
  isLimiting(nowMs: number): boolean;
  /** Takes interleaved gold and blue heat. Returns what is safe to draw. */
  apply(heat: Float32Array, nowMs: number): Float32Array;
}

export function createFlashGuard(): FlashGuard {
  const shown = new Float32Array(CELLS * 2);
  const low = new Float64Array(TRACKERS);
  const high = new Float64Array(TRACKERS);
  const rising = new Uint8Array(TRACKERS);
  const stamps = new Float64Array(TRACKERS * MAX_RISES).fill(Number.NEGATIVE_INFINITY);
  const cursor = new Uint8Array(TRACKERS);
  const shownMean = new Float64Array(TILES * 2);
  const want = new Float64Array(TILES * 2);
  const flux = new Float64Array(TILES);
  const pulseBucket = new Float64Array(TILES);
  const held = new Uint8Array(TILES);
  const throttledUntil = new Float64Array(TILES).fill(Number.NEGATIVE_INFINITY);
  const updatedAt = new Float64Array(TILES).fill(Number.NEGATIVE_INFINITY);
  const light = new Float32Array(CELLS);
  const fallen = new Float32Array(CELLS);
  const risen = new Float32Array(CELLS);
  let last = 0;
  let lastHeldAt = Number.NEGATIVE_INFINITY;

  const hasBudget = (tracker: number, now: number): boolean => {
    for (let slot = 0; slot < MAX_RISES; slot++) {
      if (now - (stamps[tracker * MAX_RISES + slot] as number) >= WINDOW_MS) return true;
    }
    return false;
  };

  const hasHeldNeighbour = (tile: number): boolean => {
    const col = tile % TILE_COLS;
    const row = Math.floor(tile / TILE_COLS);
    for (let y = Math.max(0, row - 1); y <= Math.min(TILE_ROWS - 1, row + 1); y++) {
      for (let x = Math.max(0, col - 1); x <= Math.min(TILE_COLS - 1, col + 1); x++) {
        if (held[y * TILE_COLS + x] === 1) return true;
      }
    }
    return false;
  };

  const wouldRise = (tracker: number, value: number): boolean =>
    rising[tracker] === 0 && value > (low[tracker] as number) + SWING;

  /** A flash is opposing changes, so only a rise out of a fall spends budget. */
  const observe = (tracker: number, value: number, now: number): void => {
    if (rising[tracker] === 1) {
      if (value < (high[tracker] as number) - SWING) {
        rising[tracker] = 0;
        low[tracker] = value;
      } else if (value > (high[tracker] as number)) {
        high[tracker] = value;
      }
      return;
    }
    if (value < (low[tracker] as number)) {
      low[tracker] = value;
    } else if (value > (low[tracker] as number) + SWING) {
      rising[tracker] = 1;
      high[tracker] = value;
      stamps[tracker * MAX_RISES + (cursor[tracker] as number)] = now;
      cursor[tracker] = ((cursor[tracker] as number) + 1) % MAX_RISES;
    }
  };

  return {
    isLimiting: (now) => now - lastHeldAt < LIMITING_HOLD_MS,
    apply(heat, now) {
      const leak = (Math.max(0, now - last) / 1000) * CELL_PULSES_PER_SECOND;
      last = now;
      want.fill(0);
      flux.fill(0);

      for (let i = 0; i < CELLS; i++) {
        const tile = TILE_OF[i] as number;
        const gold = heat[i * 2] as number;
        const blue = heat[i * 2 + 1] as number;
        want[tile * 2] = (want[tile * 2] as number) + (GOLD_LUMINANCE[Math.round(gold * LUT_STEPS)] as number);
        want[tile * 2 + 1] = (want[tile * 2 + 1] as number) + (BLUE_LUMINANCE[Math.round(blue * LUT_STEPS)] as number);
        const rise = Math.max(0, gold - (shown[i * 2] as number)) + Math.max(0, blue - (shown[i * 2 + 1] as number));
        flux[tile] = (flux[tile] as number) + rise;
      }

      let wallGold = 0;
      let wallBlue = 0;
      for (let tile = 0; tile < TILES; tile++) {
        wallGold += want[tile * 2] as number;
        wallBlue += want[tile * 2 + 1] as number;
        const cells = CELLS_IN_TILE[tile] as number;
        want[tile * 2] = (want[tile * 2] as number) / cells;
        want[tile * 2 + 1] = (want[tile * 2 + 1] as number) / cells;
        flux[tile] = (flux[tile] as number) / cells;
        pulseBucket[tile] = Math.max(0, (pulseBucket[tile] as number) - leak);
      }
      wallGold /= CELLS;
      wallBlue /= CELLS;

      const wallBlocked =
        (wouldRise(WALL_TRACKERS, wallGold) && !hasBudget(WALL_TRACKERS, now)) ||
        (wouldRise(WALL_TRACKERS + 1, wallBlue) && !hasBudget(WALL_TRACKERS + 1, now));

      for (let tile = 0; tile < TILES; tile++) {
        const moving = (flux[tile] as number) > MOVING;
        const throttling = now < (throttledUntil[tile] as number);
        if ((pulseBucket[tile] as number) > (throttling ? CELL_PULSE_BURST / 4 : CELL_PULSE_BURST)) {
          throttledUntil[tile] = now + THROTTLE_CALM_MS;
        }
        const blocked =
          (wouldRise(tile * 2, want[tile * 2] as number) && !hasBudget(tile * 2, now)) ||
          (wouldRise(tile * 2 + 1, want[tile * 2 + 1] as number) && !hasBudget(tile * 2 + 1, now)) ||
          (moving && now < (throttledUntil[tile] as number) && now - (updatedAt[tile] as number) < THROTTLED_UPDATE_MS) ||
          (moving && wallBlocked);
        held[tile] = blocked ? 1 : 0;
        if (blocked) lastHeldAt = now;
      }

      // A flash across a tile corner runs out of budget one tile at a time, and those tiles would
      // then alternate and add up to more than any of them allows. Holding the neighbours keeps it whole.
      for (let tile = 0; tile < TILES; tile++) {
        if (held[tile] === 0 && (flux[tile] as number) > MOVING && hasHeldNeighbour(tile)) held[tile] = 2;
      }

      for (let tile = 0; tile < TILES; tile++) {
        if (held[tile] === 0 && (flux[tile] as number) > MOVING) updatedAt[tile] = now;
      }

      for (let i = 0; i < CELLS; i++) {
        const tile = TILE_OF[i] as number;
        if (held[tile] !== 0) continue;
        const gold = heat[i * 2] as number;
        const blue = heat[i * 2 + 1] as number;
        shown[i * 2] = gold;
        shown[i * 2 + 1] = blue;
        const next = Math.max(
          GOLD_LUMINANCE[Math.round(gold * LUT_STEPS)] as number,
          BLUE_LUMINANCE[Math.round(blue * LUT_STEPS)] as number,
        );
        const change = next - (light[i] as number);
        light[i] = next;
        if (change < 0) {
          fallen[i] = (fallen[i] as number) - change;
          risen[i] = Math.max(0, (risen[i] as number) + change);
          continue;
        }
        risen[i] = (risen[i] as number) + change;
        if ((risen[i] as number) >= CELL_PULSE && (fallen[i] as number) >= CELL_PULSE) {
          pulseBucket[tile] = (pulseBucket[tile] as number) + 1 / (CELLS_IN_TILE[tile] as number);
          fallen[i] = 0;
          risen[i] = 0;
        }
      }

      let shownGold = 0;
      let shownBlue = 0;
      for (let tile = 0; tile < TILES; tile++) {
        if (held[tile] === 0) {
          shownMean[tile * 2] = want[tile * 2] as number;
          shownMean[tile * 2 + 1] = want[tile * 2 + 1] as number;
          observe(tile * 2, want[tile * 2] as number, now);
          observe(tile * 2 + 1, want[tile * 2 + 1] as number, now);
        }
        const cells = CELLS_IN_TILE[tile] as number;
        shownGold += (shownMean[tile * 2] as number) * cells;
        shownBlue += (shownMean[tile * 2 + 1] as number) * cells;
      }
      observe(WALL_TRACKERS, shownGold / CELLS, now);
      observe(WALL_TRACKERS + 1, shownBlue / CELLS, now);
      return shown;
    },
  };
}
