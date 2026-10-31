import { SLICE_PASSES, type HamsterClock, type HamsterReading, type HamsterState } from '../types';
import { LIVE_SCHEDULE_URL, SQUEEKCHAIN_API_BASE } from './config';
import { createEmitter } from './emitter';
import { fetchNextLive } from './next-live';
import { parseRetryAfter, parseStatus, type Telemetry } from './telemetry';
import { documentVisibility, type ClockVisibility } from './visibility';

export type { ClockVisibility } from './visibility';

export interface HamsterClockOptions {
  readonly fetch?: typeof fetch;
  /** Wall clock in epoch ms. Pass the same clock to read(). */
  readonly now?: () => number;
  readonly random?: () => number;
  readonly visibility?: ClockVisibility;
  readonly statusUrl?: string;
  readonly scheduleUrl?: string | null;
}

const POLL_MS = 5_000;
const HIDDEN_POLL_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const FAILED_POLLS_TO_LOSE_SIGNAL = 2;
const SCHEDULE_POLL_MS = 60_000;
const SCHEDULE_RETRY_MS = 10 * 60_000;

/**
 * The API publishes a new measurement every 10s and we see it up to one 5s poll later, so a ramp this
 * long is still moving when the next one lands. Extrapolating past the last measurement instead would
 * overrun whenever he stops mid-interval, and that overrun could never be taken back: work may not
 * step backwards and must be exact once he is IDLE. So work never leads the counter, and it trails a
 * running hamster by about this long.
 */
const DISPLAY_LAG_MS = 15_000;
const CATCH_UP_MS = 1_500;
const TELEPORT_PASSES = SLICE_PASSES;

interface Ramp {
  readonly from: number;
  readonly to: number;
  readonly startAt: number;
  readonly durationMs: number;
}

const flatRamp = (work: number, at: number): Ramp => ({ from: work, to: work, startAt: at, durationMs: 0 });

function rampValue({ from, to, startAt, durationMs }: Ramp, now: number): number {
  if (now >= startAt + durationMs) return to;
  if (now <= startAt) return from;
  return from + (to - from) * ((now - startAt) / durationMs);
}

const isMoving = ({ core, hz, fresh }: Telemetry): boolean => core === 'ACTIVE' && hz > 0 && fresh;

function planRamp(from: number, telemetry: Telemetry, at: number): Ramp {
  const to = Math.max(from, telemetry.work);
  const gap = to - from;
  if (gap === 0 || gap > TELEPORT_PASSES) return flatRamp(to, at);
  const expectedGap = isMoving(telemetry) ? (telemetry.hz * DISPLAY_LAG_MS) / 1_000 : 0;
  return { from, to, startAt: at, durationMs: gap > 2 * expectedGap ? CATCH_UP_MS : DISPLAY_LAG_MS };
}

/** False until real telemetry has been accepted. The work on such a reading is a placeholder 0. */
export const hasTelemetry = (reading: HamsterReading): boolean => reading.observedAt > 0;

export function createHamsterClock(options: HamsterClockOptions = {}): HamsterClock {
  const fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const visibility = options.visibility ?? documentVisibility();
  const statusUrl = options.statusUrl ?? `${SQUEEKCHAIN_API_BASE}/v1/status`;
  const scheduleUrl = options.scheduleUrl === undefined ? LIVE_SCHEDULE_URL : options.scheduleUrl;
  const emitter = createEmitter<HamsterReading>();

  let latest: Telemetry | null = null;
  let ramp = flatRamp(0, 0);
  let floor = 0;
  let skewMs = 0;
  let linkDown = false;
  let failures = 0;
  let retryUntil = 0;
  let nextLive: number | null = null;
  let stopped = false;
  let polling = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let scheduleTimer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: AbortController | null = null;

  const workAt = (time: number): number => {
    floor = Math.max(floor, rampValue(ramp, time));
    return floor;
  };

  function adopt(telemetry: Telemetry, at: number): void {
    const moving = isMoving(telemetry);
    const start = moving ? Math.max(0, telemetry.work - (telemetry.hz * DISPLAY_LAG_MS) / 1_000) : telemetry.work;
    ramp = { from: start, to: telemetry.work, startAt: at, durationMs: moving ? DISPLAY_LAG_MS : 0 };
    floor = start;
    latest = telemetry;
  }

  function advance(telemetry: Telemetry, at: number): void {
    const current = workAt(at);
    latest = telemetry;
    const unchanged = Math.max(current, telemetry.work) === ramp.to;
    if (!unchanged || !isMoving(telemetry)) ramp = planRamp(current, telemetry, at);
  }

  /** Monotonic holds within an epoch only: a new epoch is a new counter, so the old count means nothing. */
  function reanchor(telemetry: Telemetry, at: number): void {
    ramp = flatRamp(telemetry.work, at);
    floor = telemetry.work;
    latest = telemetry;
  }

  function accept(telemetry: Telemetry, at: number): void {
    const held = latest;
    if (held === null) {
      adopt(telemetry, at);
      return;
    }
    const sameEpoch = telemetry.epoch === held.epoch;
    if (sameEpoch && telemetry.observedAt <= held.observedAt) return;
    if (telemetry.core === 'COUNTER_FAULT') latest = { ...telemetry, work: held.work, epoch: held.epoch };
    else if (sameEpoch) advance(telemetry, at);
    else reanchor(telemetry, at);
  }

  function stateAt(telemetry: Telemetry, time: number): HamsterState {
    const stale = time + skewMs - telemetry.observedAt > telemetry.staleAfterMs;
    if (linkDown || !telemetry.fresh || stale) return 'signal-lost';
    if (telemetry.core === 'COUNTER_FAULT') return 'fault';
    return telemetry.core === 'ACTIVE' ? 'running' : 'asleep';
  }

  function read(time: number): HamsterReading {
    const nextLiveAt = nextLive !== null && time < nextLive ? nextLive : null;
    if (latest === null) return { work: 0, hz: 0, rpm: 0, state: 'signal-lost', observedAt: 0, nextLiveAt };
    const state = stateAt(latest, time);
    const running = state === 'running';
    return {
      work: workAt(time),
      hz: running ? latest.hz : 0,
      rpm: running ? latest.rpm : 0,
      state,
      observedAt: latest.observedAt,
      nextLiveAt,
    };
  }

  async function requestStatus(): Promise<{ telemetry: Telemetry | null; retryAfterMs: number }> {
    const controller = new AbortController();
    inFlight = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchFn(statusUrl, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'), now());
      return { telemetry: response.ok ? parseStatus(await response.json()) : null, retryAfterMs };
    } catch {
      return { telemetry: null, retryAfterMs: 0 };
    } finally {
      clearTimeout(timeout);
      inFlight = null;
    }
  }

  function nextDelay(retryAfterMs: number): number {
    const base = visibility.isHidden() ? HIDDEN_POLL_MS : POLL_MS;
    const backoff = failures === 0 ? 0 : Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** (failures - 1) * (0.8 + random() * 0.4));
    return Math.max(base, backoff, retryAfterMs);
  }

  function arm(delayMs: number): void {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => void poll(), delayMs);
  }

  async function poll(): Promise<void> {
    polling = true;
    const { telemetry, retryAfterMs } = await requestStatus();
    polling = false;
    if (stopped) return;
    const at = now();
    failures = telemetry === null ? failures + 1 : 0;
    linkDown = failures >= FAILED_POLLS_TO_LOSE_SIGNAL;
    if (telemetry !== null) {
      if (telemetry.generatedAt !== null) skewMs = telemetry.generatedAt - at;
      accept(telemetry, at);
    }
    retryUntil = at + retryAfterMs;
    arm(nextDelay(retryAfterMs));
    emitter.emit(read(at));
  }

  async function pollSchedule(url: string): Promise<void> {
    const next = await fetchNextLive({ fetch: fetchFn, now, url });
    if (stopped) return;
    const changed = next !== nextLive;
    nextLive = next;
    scheduleTimer = setTimeout(() => void pollSchedule(url), next === null ? SCHEDULE_RETRY_MS : SCHEDULE_POLL_MS);
    if (changed) emitter.emit(read(now()));
  }

  const unwatch = visibility.subscribe(() => {
    if (!visibility.isHidden() && !polling) arm(Math.max(0, retryUntil - now()));
  });

  void poll();
  if (scheduleUrl !== null) void pollSchedule(scheduleUrl);

  return {
    read,
    subscribe: emitter.subscribe,
    stop() {
      stopped = true;
      clearTimeout(pollTimer);
      clearTimeout(scheduleTimer);
      inFlight?.abort();
      unwatch();
      emitter.clear();
    },
  };
}
