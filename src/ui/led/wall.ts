import { CELLS, COLS, ROWS, type Frame } from '../../types';
import { createCanvasSurface } from './canvas2d';
import { createFlashGuard } from './flash-guard';
import { createGlSurface } from './gl';
import { createPhosphor } from './phosphor';
import type { LedSurface } from './surface';

export interface LedWallOptions {
  readonly transparent?: boolean;
  /** Forces the Canvas2D path. Exposed for QA through ?renderer=2d. */
  readonly forceCanvas2d?: boolean;
}

export interface LedWall {
  readonly kind: LedSurface['kind'];
  /** Fits the lattice inside the given CSS box and returns the size it took. */
  fit(cssWidth: number, cssHeight: number): { readonly width: number; readonly height: number };
  present(targets: Float32Array, dtMs: number, power: number): void;
  /** Keeps the phosphor and flash guard running while the wall itself is off screen. */
  advance(targets: Float32Array, dtMs: number): void;
  /** What is really lit, as levels. Anything small that mirrors the wall must read this, not raw frames. */
  copyLevels(out: Frame): void;
  isLimiting(): boolean;
  settle(targets: Float32Array): void;
  destroy(): void;
}

export function createLedWall(host: HTMLCanvasElement, options: LedWallOptions = {}): LedWall {
  let canvas = host;
  const transparent = options.transparent ?? false;
  const phosphor = createPhosphor();
  const guard = createFlashGuard();
  let shown = phosphor.heat;
  let clockMs = 0;
  let lastSize = { pitch: 0, width: 0, height: 0 };

  /** A canvas that ever held a WebGL context can never return a 2D one, so swap the element. */
  const flatSurface = (): LedSurface => {
    const next = document.createElement('canvas');
    next.className = canvas.className;
    next.setAttribute('role', canvas.getAttribute('role') ?? 'img');
    next.setAttribute('aria-label', canvas.getAttribute('aria-label') ?? '');
    next.style.cssText = canvas.style.cssText;
    canvas.replaceWith(next);
    canvas = next;
    const flat = createCanvasSurface(next, { transparent });
    if (!flat) throw new Error('No canvas context available');
    return flat;
  };

  const fallBack = (): void => {
    surface = flatSurface();
    surface.resize(lastSize.width, lastSize.height, lastSize.pitch);
  };

  const step = (targets: Float32Array, dtMs: number): void => {
    clockMs += dtMs;
    phosphor.step(targets, dtMs);
    shown = guard.apply(phosphor.heat, clockMs);
  };

  let surface: LedSurface =
    (options.forceCanvas2d ? null : createGlSurface(canvas, { transparent, onLost: fallBack })) ?? flatSurface();

  return {
    get kind() {
      return surface.kind;
    },
    fit(cssWidth, cssHeight) {
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const pitch = Math.max(2, Math.floor(Math.min((cssWidth * dpr) / COLS, (cssHeight * dpr) / ROWS)));
      const width = pitch * COLS;
      const height = pitch * ROWS;
      if (pitch !== lastSize.pitch) {
        lastSize = { pitch, width, height };
        surface.resize(width, height, pitch);
      }
      const size = { width: width / dpr, height: height / dpr };
      canvas.style.width = `${size.width}px`;
      canvas.style.height = `${size.height}px`;
      return size;
    },
    present(targets, dtMs, power) {
      step(targets, dtMs);
      surface.draw(shown, power);
    },
    advance: step,
    copyLevels(out) {
      for (let i = 0; i < CELLS; i++) {
        const gold = shown[i * 2] as number;
        const blue = shown[i * 2 + 1] as number;
        out[i] = gold >= blue ? Math.round(gold * 4) : -Math.round(blue * 4);
      }
    },
    isLimiting: () => guard.isLimiting(clockMs),
    settle(targets) {
      phosphor.settle(targets);
    },
    destroy() {
      surface.destroy();
    },
  };
}
