import { hasTelemetry } from '../chain/clock';
import { compile, segfaultProgram } from '../lang';
import { resolveSlot } from '../machine/schedule';
import {
  CELLS,
  createFrame,
  type Frame,
  type HamsterClock,
  type HamsterReading,
  type Preset,
  type Program,
  type QueuedProgram,
  type Slot,
} from '../types';
import { utcClock } from './format';
import { HIDDEN_SOURCE, isHidden, isWithheld } from './moderation';
import { ACQUIRING_LINES, FAULT_LINES, REDACTED_LINES, haltedLines, lostLines } from './led/plates';
import {
  applyStatic,
  applyWakeWave,
  buildPlate,
  drawIdleWheel,
  frameToTargets,
  stampPlate,
  type Plate,
} from './led/scene';
import type { LedWall } from './led/wall';

export type ClockSource = 'hamster' | 'crank' | 'bench' | 'replay';
export type Scene = 'live' | 'halted' | 'lost' | 'fault' | 'acquiring';

export interface DisplayInfo {
  readonly source: ClockSource;
  /** What the wall is showing. */
  readonly scene: Scene;
  /** What the hamster is doing, whichever clock drives the wall. */
  readonly hamsterScene: Scene;
  readonly reading: HamsterReading | null;
  readonly hz: number;
  readonly cycle: number;
  readonly t: number;
  readonly slot: Slot | null;
  readonly title: string;
  readonly byline: string;
  /** The text of whatever is on the wall. Empty when withheld or hidden, so nothing can leak it. */
  readonly text: string;
  readonly segfault: boolean;
  /** A stranger's source that does not compile. Your own broken code stays visible to you. */
  readonly withheld: boolean;
  readonly hidden: boolean;
}

export interface MachineOptions {
  readonly wall: LedWall;
  readonly house: readonly Preset[];
  readonly reduced: boolean;
  /** Runs first each frame, so the crank is integrated before the wall samples it. */
  beforeFrame(dtMs: number, now: number): void;
  afterFrame(frame: Frame, info: DisplayInfo, dtMs: number, now: number): void;
  onWake(): void;
  onHalt(): void;
  onCycle(): void;
}

export interface Machine {
  readonly info: DisplayInfo;
  frame(): Frame;
  setClock(clock: HamsterClock): void;
  setQueue(programs: readonly QueuedProgram[]): void;
  setOnScreen(visible: boolean): void;
  select(source: ClockSource): void;
  engageCrank(): void;
  turnCrank(deltaCycles: number): void;
  /** Written every frame: the wheel keeps slowing after the last turn it reports. */
  setCrankRate(hz: number): void;
  setEditorProgram(program: Program, text: string): void;
  setBenchRate(hz: number): void;
  replay(program: Program, text: string, label: string, t: number): void;
  scrub(t: number): void;
  stop(): void;
}

const WAKE_MS = 1250;
const HALT_WIPE_MS = 320;
const CRANK_IDLE_MS = 45000;
const HELD_GAIN = 0.11;
const ACQUIRE_GRACE_MS = 9000;
/** The heartbeat is a brightness pulse per cycle, so it must stop where cycles could read as flashes. */
const BEAT_MAX_HZ = 3;

const REDACTED_PLATE = buildPlate(REDACTED_LINES);

const cache = new Map<string, Program>();

export function programFor(source: string): Program {
  const hit = cache.get(source);
  if (hit) return hit;
  const result = compile(source);
  const program = result.ok ? result.program : segfaultProgram;
  if (cache.size > 96) cache.clear();
  cache.set(source, program);
  return program;
}

function sceneOf(reading: HamsterReading | null, sinceStart: number): Scene {
  // An API that is down from the first request must read as lost, not as loading forever.
  if (!reading || reading.observedAt === 0) return sinceStart < ACQUIRE_GRACE_MS ? 'acquiring' : 'lost';
  switch (reading.state) {
    case 'running':
      return 'live';
    case 'asleep':
      return 'halted';
    case 'fault':
      return 'fault';
    case 'signal-lost':
      return 'lost';
  }
}

function titleOf(slot: Slot): string {
  return slot.kind === 'queued' ? `PROGRAM #${slot.program.id}` : slot.name;
}

function textOf(slot: Slot): string {
  return slot.kind === 'queued' ? slot.program.source : slot.source;
}

function isHiddenSlot(slot: Slot | null): boolean {
  return slot?.kind === 'queued' && isHidden(slot.program.id);
}

export function createMachine(options: MachineOptions): Machine {
  const { wall, house, reduced } = options;
  const frame = createFrame();
  const targets = new Float32Array(CELLS);

  let clock: HamsterClock | null = null;
  let queue: readonly QueuedProgram[] = [];
  let source: ClockSource = 'hamster';
  let crankReturn: ClockSource = 'hamster';
  let onScreen = true;
  let running = true;

  let shownProgram: Program | null = null;
  let shownT = Number.NaN;
  let renderedProgram: Program | null = null;
  let renderedT = Number.NaN;

  let crankProgram: Program | null = null;
  let crankT = 0;
  let crankHz = 0;
  let crankLabel = '';
  let crankByline = '';
  let crankText = '';
  let crankWithheld = false;
  let crankHidden = false;
  let lastCrankAt = 0;

  let editorProgram: Program | null = null;
  let editorText = '';
  let benchT = 0;
  let benchHz = 2;

  let replayProgram: Program | null = null;
  let replayLabel = '';
  let replayText = '';
  let replayT = 0;
  let brokenText = '';
  let broken = false;

  let lastScene: Scene = 'acquiring';
  let sceneChangedAt = performance.now();
  let wakeAt = Number.NEGATIVE_INFINITY;
  let lastWhole = Number.NaN;
  let plateKey = '';
  let plate: Plate = buildPlate(ACQUIRING_LINES);
  const startedAt = performance.now();
  let last = startedAt;
  let raf = 0;
  let info: DisplayInfo = {
    source, scene: 'acquiring', hamsterScene: 'acquiring', reading: null, hz: 0, cycle: 0, t: 0,
    slot: null, title: '', byline: '', text: '', segfault: false, withheld: false, hidden: false,
  };

  const choosePlate = (scene: Scene, reading: HamsterReading | null): void => {
    const nextLive = reading?.nextLiveAt ?? null;
    const work = Math.floor(reading?.work ?? 0);
    const everSeen = reading !== null && hasTelemetry(reading);
    const key = `${scene}:${everSeen}:${nextLive === null ? work : utcClock(nextLive)}`;
    if (key === plateKey) return;
    plateKey = key;
    if (scene === 'halted') plate = buildPlate(haltedLines(nextLive, work));
    if (scene === 'lost') plate = buildPlate(lostLines(everSeen));
    if (scene === 'fault') plate = buildPlate(FAULT_LINES);
    if (scene === 'acquiring') plate = buildPlate(ACQUIRING_LINES);
  };

  const compose = (scene: Scene, hidden: boolean, now: number): void => {
    const sinceChange = now - sceneChangedAt;
    if (hidden && scene === 'live') {
      targets.fill(0);
      stampPlate(REDACTED_PLATE, 1, targets);
      return;
    }
    if (scene === 'live') {
      const wake = (now - wakeAt) / WAKE_MS;
      if (!reduced && wake >= 0 && wake < 1) applyWakeWave(frame, wake, HELD_GAIN, targets);
      else frameToTargets(frame, 1, targets);
      return;
    }
    const reveal = reduced ? 1 : Math.min(1, sinceChange / HALT_WIPE_MS);
    if (scene === 'halted') {
      const breath = reduced ? 0 : Math.sin(now / 2300) * 0.05;
      frameToTargets(frame, HELD_GAIN + breath, targets);
      stampPlate(plate, reveal, targets);
      const rock = reduced ? 0 : Math.sin(now / 1700) * 0.2;
      drawIdleWheel(55, 7, 5.5, rock, targets);
      return;
    }
    if (scene === 'lost') {
      applyStatic(Math.floor(now / 170), targets);
      stampPlate(plate, reveal, targets);
      return;
    }
    if (scene === 'fault') frameToTargets(frame, 0.14, targets);
    else targets.fill(0);
    stampPlate(plate, reveal, targets);
  };

  const tick = (now: number): void => {
    if (!running) return;
    raf = requestAnimationFrame(tick);
    if (document.hidden) {
      last = now;
      return;
    }
    const dt = Math.min(now - last, 100);
    last = now;
    options.beforeFrame(dt, now);

    const reading = clock ? clock.read(Date.now()) : null;
    const hamsterScene = sceneOf(reading, now - startedAt);
    if (hamsterScene !== lastScene) {
      if (hamsterScene === 'live') {
        wakeAt = source === 'hamster' ? now : Number.NEGATIVE_INFINITY;
        options.onWake();
      } else if (lastScene === 'live') {
        options.onHalt();
      }
      lastScene = hamsterScene;
      sceneChangedAt = now;
    }

    if (source === 'crank' && now - lastCrankAt > CRANK_IDLE_MS) source = crankReturn;

    // Work is a placeholder 0 until real telemetry lands, so the schedule must not run from it.
    const slot = reading && hasTelemetry(reading) ? resolveSlot(reading.work, queue, house) : null;
    const slotHidden = isHiddenSlot(slot);
    let program = slot ? programFor(slotHidden ? HIDDEN_SOURCE : textOf(slot)) : null;
    let t = slot?.t ?? 0;
    let hz = reading?.hz ?? 0;
    let cycle = reading?.work ?? 0;
    let title = slot ? titleOf(slot) : '';
    let byline = !slot
      ? ''
      : slot.kind === 'queued'
        ? `BY ${slot.program.author.slice(0, 6)}...${slot.program.author.slice(-4)}`
        : 'HOUSE ROM';
    let text = slot && !slotHidden ? textOf(slot) : '';
    let hidden = slotHidden;
    let scene: Scene = hamsterScene;

    if (source === 'crank') {
      program = crankProgram;
      t = crankT;
      hz = crankHz;
      cycle = crankT;
      title = crankLabel;
      byline = crankByline;
      text = crankText;
      hidden = crankHidden;
      scene = 'live';
    } else if (source === 'bench') {
      benchT += (dt / 1000) * benchHz;
      program = editorProgram;
      t = benchT;
      hz = benchHz;
      cycle = benchT;
      title = 'YOUR PROGRAM';
      byline = 'LOCAL TO THIS SCREEN';
      text = editorText;
      hidden = false;
      scene = 'live';
    } else if (source === 'replay') {
      program = replayProgram;
      t = replayT;
      hz = 0;
      cycle = replayT;
      title = replayLabel;
      byline = 'REPLAYED LOCALLY';
      text = replayText;
      hidden = false;
      scene = 'live';
    }

    if (text !== brokenText) {
      brokenText = text;
      broken = isWithheld(text);
    }
    const withheld = source === 'crank' ? crankWithheld : source !== 'bench' && broken;

    if (reduced) t = Math.floor(t);
    shownProgram = program;
    shownT = t;

    const whole = Math.floor(t);
    if (whole !== lastWhole) {
      const clocked = (source === 'hamster' && scene === 'live') || (source === 'bench' && benchHz <= 12);
      if (clocked && !Number.isNaN(lastWhole)) options.onCycle();
      lastWhole = whole;
    }

    if (program && (program !== renderedProgram || t !== renderedT)) {
      program.render(t, frame);
      renderedProgram = program;
      renderedT = t;
    }

    choosePlate(scene, reading);
    compose(scene, hidden, now);
    if (onScreen) {
      const wake = (now - wakeAt) / WAKE_MS;
      const surge = !reduced && scene === 'live' && wake >= 0 && wake < 1 ? 0.2 * Math.exp(-wake * 4.5) : 0;
      const beat = !reduced && scene === 'live' && hz > 0.15 && hz <= BEAT_MAX_HZ
        ? 0.03 * Math.exp(-(t - whole) * 7)
        : 0;
      wall.present(targets, dt, 1 + surge + beat);
    } else {
      wall.advance(targets, dt);
    }

    info = {
      source, scene, hamsterScene, reading, hz, cycle, t, slot, title, byline,
      text: withheld ? '' : text,
      segfault: broken || withheld,
      withheld,
      hidden,
    };
    options.afterFrame(frame, info, dt, now);
  };

  raf = requestAnimationFrame(tick);

  return {
    get info() {
      return info;
    },
    frame: () => frame,
    setClock(next) {
      clock = next;
    },
    setQueue(programs) {
      queue = programs;
    },
    setOnScreen(visible) {
      onScreen = visible;
    },
    select(next) {
      if (next === 'crank') {
        this.engageCrank();
        return;
      }
      if (next === 'replay' && !replayProgram) return;
      source = next;
    },
    engageCrank() {
      lastCrankAt = performance.now();
      if (source === 'crank') return;
      crankReturn = source === 'replay' ? 'hamster' : source;
      // Read the bench directly: an edit in this same tick has not reached the wall yet.
      const fromBench = source === 'bench';
      crankProgram = (fromBench ? editorProgram : shownProgram) ?? programFor(editorText);
      crankT = Number.isNaN(shownT) ? 0 : shownT;
      crankLabel = fromBench ? 'YOUR PROGRAM' : info.title || 'YOUR PROGRAM';
      crankByline = fromBench ? 'LOCAL TO THIS SCREEN' : info.byline || 'LOCAL TO THIS SCREEN';
      crankText = fromBench ? editorText : info.text;
      crankWithheld = !fromBench && info.withheld;
      crankHidden = !fromBench && info.hidden;
      source = 'crank';
    },
    turnCrank(delta) {
      lastCrankAt = performance.now();
      crankT += delta;
    },
    setCrankRate(hz) {
      crankHz = hz;
    },
    setEditorProgram(program, text) {
      editorProgram = program;
      editorText = text;
      if (source === 'crank') {
        crankProgram = program;
        crankLabel = 'YOUR PROGRAM';
        crankByline = 'LOCAL TO THIS SCREEN';
        crankText = text;
        crankWithheld = false;
        crankHidden = false;
        lastCrankAt = performance.now();
        return;
      }
      source = 'bench';
    },
    setBenchRate(hz) {
      benchHz = hz;
    },
    replay(program, text, label, t) {
      replayProgram = program;
      replayText = text;
      replayLabel = label;
      replayT = t;
      source = 'replay';
    },
    scrub(t) {
      replayT = t;
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
    },
  };
}
