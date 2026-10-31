import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HamsterClock, HamsterReading } from '../types';
import { createHamsterClock, hasTelemetry, type ClockVisibility } from './clock';
import { EPOCH_A, EPOCH_B, T0, jsonResponse, statusBody, type MeasurementFixture } from './test-helpers';

const STATUS_URL = 'https://api.test/v1/status';
const SCHEDULE_URL = 'https://media.test/live/schedule.json';

type Responder = (url: string, init?: RequestInit) => Promise<Response>;

function harness(respond: Responder, options: { scheduleUrl?: string | null; visibility?: ClockVisibility; now?: () => number } = {}) {
  const calls: { url: string; at: number; init: RequestInit | undefined }[] = [];
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), at: Date.now(), init });
    return respond(String(input), init);
  }) as typeof fetch;
  const clock = createHamsterClock({
    fetch: fetchFn,
    statusUrl: STATUS_URL,
    scheduleUrl: options.scheduleUrl ?? null,
    random: () => 0.5,
    ...(options.visibility ? { visibility: options.visibility } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  clocks.push(clock);
  const statusCalls = () => calls.filter((call) => call.url === STATUS_URL);
  return { clock, calls, statusCalls };
}

function serving(fixture: () => MeasurementFixture): Responder {
  return async () => jsonResponse(statusBody(fixture()));
}

function readNow(clock: HamsterClock): HamsterReading {
  return clock.read(Date.now());
}

const land = () => vi.advanceTimersByTimeAsync(0);
const clocks: HamsterClock[] = [];

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});

afterEach(() => {
  clocks.splice(0).forEach((clock) => clock.stop());
  vi.useRealTimers();
});

describe('asleep', () => {
  it('reads the exact counter and does not drift between polls', async () => {
    const { clock } = harness(serving(() => ({ cumulativeWorkUnits: '58518', coreStatus: 'IDLE' })));
    await land();
    expect(readNow(clock)).toMatchObject({ work: 58518, hz: 0, rpm: 0, state: 'asleep' });

    await vi.advanceTimersByTimeAsync(47_300);
    expect(readNow(clock).work).toBe(58518);
  });

  it('freezes on IDLE even when rpm has not decayed to zero yet', async () => {
    const { clock } = harness(
      serving(() => ({ cumulativeWorkUnits: '500', coreStatus: 'IDLE', rpmMilli: 42_000 })),
    );
    await land();
    expect(readNow(clock)).toMatchObject({ work: 500, hz: 0, rpm: 0, state: 'asleep' });
  });

  it('settles fast after he stops even when rpm has not decayed yet', async () => {
    let fixture: MeasurementFixture = { cumulativeWorkUnits: '1000', coreStatus: 'ACTIVE', rpmMilli: 60_000 };
    const { clock } = harness(serving(() => fixture));
    await land();
    fixture = { cumulativeWorkUnits: '1014', coreStatus: 'IDLE', rpmMilli: 60_000 };
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(readNow(clock).work).toBe(1014);
  });

  it('lands exactly on the counter after he stops, without overrunning it', async () => {
    let fixture: MeasurementFixture = { cumulativeWorkUnits: '1000', coreStatus: 'ACTIVE', rpmMilli: 60_000 };
    const { clock } = harness(serving(() => fixture));
    await land();
    await vi.advanceTimersByTimeAsync(10_000);
    fixture = { cumulativeWorkUnits: '1010', coreStatus: 'ACTIVE', rpmMilli: 60_000 };
    await vi.advanceTimersByTimeAsync(10_000);
    fixture = { cumulativeWorkUnits: '1012', coreStatus: 'IDLE', rpmMilli: 0 };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(readNow(clock).state).toBe('asleep');
    expect(readNow(clock).work).toBeLessThanOrEqual(1012);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(readNow(clock).work).toBe(1012);
  });
});

describe('running', () => {
  it('converts rpmMilli into passes per second and rpm', async () => {
    const { clock } = harness(serving(() => ({ coreStatus: 'ACTIVE', rpmMilli: 90_000 })));
    await land();
    expect(readNow(clock)).toMatchObject({ hz: 1.5, rpm: 90, state: 'running' });
  });

  it('never steps back when the wall clock does', async () => {
    const { clock } = harness(serving(() => ({ cumulativeWorkUnits: '1000', coreStatus: 'ACTIVE', rpmMilli: 60_000 })));
    await land();
    const later = clock.read(T0 + 8_000).work;
    expect(clock.read(T0 + 3_000).work).toBe(later);
  });

  it('accepts numbers delivered as strings', async () => {
    const { clock } = harness(
      serving(() => ({
        coreStatus: 'ACTIVE',
        rpmMilli: '30000',
        staleAfterSeconds: '120',
        cumulativeWorkUnits: '77',
      })),
    );
    await land();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(readNow(clock)).toMatchObject({ work: 77, hz: 0.5, rpm: 30, state: 'running' });
  });

  it('does not sit frozen on the first reading while he is running', async () => {
    const { clock } = harness(
      serving(() => ({ cumulativeWorkUnits: '1000', coreStatus: 'ACTIVE', rpmMilli: 60_000 })),
    );
    await land();
    const before = readNow(clock).work;
    await vi.advanceTimersByTimeAsync(4_000);
    const after = readNow(clock).work;
    expect(after).toBeGreaterThan(before + 2);
    expect(after).toBeLessThanOrEqual(1000);
  });

  it('runs smoothly and monotonically and never leads the measured counter', async () => {
    const speedHz = 1;
    const workAt = (time: number) => 1000 + Math.floor(((time - T0) / 1000) * speedHz);
    const measuredAt = (time: number) => time - (time - T0) % 10_000;
    let measured = 0;
    const { clock } = harness(async () => {
      const observedAt = measuredAt(Date.now());
      measured = workAt(observedAt);
      return jsonResponse(
        statusBody({
          observedAt,
          cumulativeWorkUnits: String(measured),
          coreStatus: 'ACTIVE',
          rpmMilli: 60_000,
        }),
      );
    });
    await land();

    let previous = readNow(clock).work;
    let previousSecond = previous;
    for (let elapsed = 100; elapsed <= 120_000; elapsed += 100) {
      await vi.advanceTimersByTimeAsync(100);
      const { work } = readNow(clock);
      expect(work).toBeGreaterThanOrEqual(previous);
      expect(work).toBeLessThanOrEqual(measured);
      previous = work;
      if (elapsed % 1000 === 0) {
        if (elapsed > 30_000) expect(work - previousSecond, `stalled at ${elapsed}`).toBeGreaterThan(0.4);
        previousSecond = work;
      }
    }
    expect(previous).toBeGreaterThan(workAt(T0 + 120_000) - 25);
  });
});

describe('polls that disagree with the interpolation', () => {
  it('holds rather than stepping back when a poll lands behind, then resumes', async () => {
    let fixture: MeasurementFixture = { cumulativeWorkUnits: '1000', coreStatus: 'IDLE' };
    const { clock } = harness(serving(() => fixture));
    await land();

    fixture = { cumulativeWorkUnits: '990', coreStatus: 'IDLE' };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(readNow(clock).work).toBe(1000);

    fixture = { cumulativeWorkUnits: '1003', coreStatus: 'IDLE' };
    await vi.advanceTimersByTimeAsync(7_000);
    expect(readNow(clock).work).toBe(1003);
  });

  it('ignores a response older than the telemetry it already holds', async () => {
    const newest = T0;
    let fixture: MeasurementFixture = { observedAt: newest, cumulativeWorkUnits: '1000', coreStatus: 'ACTIVE', rpmMilli: 60_000 };
    const { clock } = harness(serving(() => fixture));
    await land();

    fixture = { observedAt: newest - 10_000, cumulativeWorkUnits: '990', coreStatus: 'IDLE', rpmMilli: 0 };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(readNow(clock).state).toBe('running');
    expect(readNow(clock).observedAt).toBe(newest);
  });

  it('eases quickly to a poll far ahead instead of teleporting', async () => {
    let fixture: MeasurementFixture = { cumulativeWorkUnits: '1000', coreStatus: 'ACTIVE', rpmMilli: 60_000 };
    const { clock } = harness(serving(() => fixture));
    await land();
    fixture = { cumulativeWorkUnits: '1200', coreStatus: 'ACTIVE', rpmMilli: 60_000 };
    await vi.advanceTimersByTimeAsync(5_000);

    const landed = readNow(clock).work;
    expect(landed).toBeLessThan(1100);
    await vi.advanceTimersByTimeAsync(500);
    const midway = readNow(clock).work;
    expect(midway).toBeGreaterThan(landed + 20);
    expect(midway).toBeLessThan(1200);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(readNow(clock).work).toBe(1200);
  });

  it('teleports when the gap is more than a slice', async () => {
    let fixture: MeasurementFixture = { cumulativeWorkUnits: '1000', coreStatus: 'IDLE' };
    const { clock } = harness(serving(() => fixture));
    await land();
    fixture = { cumulativeWorkUnits: '50000', coreStatus: 'IDLE' };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(readNow(clock).work).toBe(50000);
  });

  it('re-anchors exactly on a new counter epoch, even downwards', async () => {
    let fixture: MeasurementFixture = { counterEpoch: EPOCH_A, cumulativeWorkUnits: '58518', coreStatus: 'IDLE' };
    const { clock } = harness(serving(() => fixture));
    await land();

    fixture = { counterEpoch: EPOCH_B, cumulativeWorkUnits: '12', coreStatus: 'IDLE' };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(readNow(clock).work).toBe(12);

    fixture = { counterEpoch: EPOCH_B, cumulativeWorkUnits: '15', coreStatus: 'IDLE' };
    await vi.advanceTimersByTimeAsync(7_000);
    expect(readNow(clock).work).toBe(15);
  });

  it('accepts a lower counter on a new epoch even when its timestamp looks older', async () => {
    let fixture: MeasurementFixture = { counterEpoch: EPOCH_A, observedAt: T0, cumulativeWorkUnits: '900', coreStatus: 'IDLE' };
    const { clock } = harness(serving(() => fixture));
    await land();
    fixture = { counterEpoch: EPOCH_B, observedAt: T0 - 1_000, cumulativeWorkUnits: '5', coreStatus: 'IDLE' };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(readNow(clock).work).toBe(5);
  });
});

describe('losing the signal', () => {
  it('reads as no telemetry when the API is down at first load, then recovers', async () => {
    let down = true;
    const { clock } = harness(async () => {
      if (down) throw new TypeError('Failed to fetch');
      return jsonResponse(statusBody({ cumulativeWorkUnits: '321', coreStatus: 'IDLE' }));
    });
    await land();
    const reading = readNow(clock);
    expect(reading).toEqual({ work: 0, hz: 0, rpm: 0, state: 'signal-lost', observedAt: 0, nextLiveAt: null });
    expect(hasTelemetry(reading)).toBe(false);

    down = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readNow(clock)).toMatchObject({ work: 321, state: 'asleep' });
    expect(hasTelemetry(readNow(clock))).toBe(true);
  });

  it.each<[string, Responder]>([
    ['the network fails', async () => { throw new TypeError('Failed to fetch'); }],
    ['the API answers 500', async () => jsonResponse({ error: 'boom' }, { status: 500 })],
    ['the body is not JSON', async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => { throw new SyntaxError('bad'); } }) as unknown as Response],
    ['measurement is null', async () => jsonResponse({ ...statusBody(), measurement: null })],
    ['work is not a number', async () => jsonResponse(statusBody({ cumulativeWorkUnits: 'lots' }))],
    ['coreStatus is unknown', async () => jsonResponse(statusBody({ coreStatus: 'NAPPING' }))],
    ['rpm is negative', async () => jsonResponse(statusBody({ rpmMilli: -5 }))],
    ['rpm is fractional', async () => jsonResponse(statusBody({ rpmMilli: 1.5 }))],
  ])('keeps the last work value and reports signal-lost when %s', async (_name, failure) => {
    let respond: Responder = serving(() => ({ observedAt: T0, cumulativeWorkUnits: '700', coreStatus: 'ACTIVE', rpmMilli: 60_000 }));
    const { clock } = harness((url, init) => respond(url, init));
    await land();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(readNow(clock).state).toBe('running');

    respond = failure;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(readNow(clock)).toMatchObject({ work: 700, hz: 0, rpm: 0, state: 'signal-lost', observedAt: T0 });
  });

  it('rides out one failed poll while the data is still good', async () => {
    let respond: Responder = serving(() => ({ cumulativeWorkUnits: '700', coreStatus: 'ACTIVE', rpmMilli: 60_000 }));
    const { clock } = harness((url, init) => respond(url, init));
    await land();

    respond = async () => {
      throw new TypeError('Failed to fetch');
    };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(readNow(clock)).toMatchObject({ state: 'running', hz: 1, rpm: 60 });
  });

  it('counts failures in a row, so scattered blips never lose the signal', async () => {
    const good = serving(() => ({ coreStatus: 'IDLE' }));
    const bad: Responder = async () => jsonResponse({ error: 'boom' }, { status: 500 });
    let respond = good;
    const { clock } = harness((url, init) => respond(url, init));
    await land();

    const states = [];
    for (const next of [bad, good, bad, good, bad]) {
      respond = next;
      await vi.advanceTimersByTimeAsync(5_000);
      states.push(readNow(clock).state);
    }
    expect(states).toEqual(['asleep', 'asleep', 'asleep', 'asleep', 'asleep']);
  });

  it('still reads as no telemetry after one failure at first load', async () => {
    const { clock } = harness(async () => jsonResponse({ error: 'boom' }, { status: 500 }));
    await land();
    expect(readNow(clock).state).toBe('signal-lost');
    expect(hasTelemetry(readNow(clock))).toBe(false);
  });

  it.each(['stale', 'degraded'])('treats freshness %s as signal-lost and keeps the real counter', async (freshness) => {
    const { clock } = harness(serving(() => ({ freshness, cumulativeWorkUnits: '640', coreStatus: 'ACTIVE', rpmMilli: 60_000 })));
    await land();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(readNow(clock)).toMatchObject({ work: 640, hz: 0, state: 'signal-lost' });
  });

  it('treats old data as signal-lost even when the API still says online', async () => {
    const { clock } = harness(serving(() => ({ observedAt: Date.now() - 121_000, coreStatus: 'IDLE' })));
    await land();
    expect(readNow(clock).state).toBe('signal-lost');
  });

  it('judges staleness by server time, so a wrong local clock does not lose the signal', async () => {
    const hourFast = () => Date.now() + 3_600_000;
    const { clock } = harness(serving(() => ({ coreStatus: 'IDLE' })), { now: hourFast });
    await land();
    expect(clock.read(hourFast()).state).toBe('asleep');
  });

  it('goes stale on its own when no poll lands for longer than staleAfterSeconds', async () => {
    const { clock } = harness(
      async () => jsonResponse(statusBody({ coreStatus: 'IDLE' }), { headers: { 'Retry-After': '300' } }),
    );
    await land();
    expect(clock.read(T0 + 119_000).state).toBe('asleep');
    expect(clock.read(T0 + 121_000).state).toBe('signal-lost');
  });

  it('gives up on a hung request and keeps polling', async () => {
    let hang = true;
    const { clock, statusCalls } = harness(
      (_url, init) =>
        hang
          ? new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
            })
          : Promise.resolve(jsonResponse(statusBody({ cumulativeWorkUnits: '11', coreStatus: 'IDLE' }))),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(readNow(clock).state).toBe('signal-lost');
    expect(statusCalls().length).toBeGreaterThan(1);

    hang = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readNow(clock)).toMatchObject({ work: 11, state: 'asleep' });
  });

  it('reports a counter fault and holds the last trusted count', async () => {
    let fixture: MeasurementFixture = { cumulativeWorkUnits: '800', coreStatus: 'IDLE' };
    const { clock } = harness(serving(() => fixture));
    await land();

    fixture = { cumulativeWorkUnits: '999999', coreStatus: 'COUNTER_FAULT' };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(readNow(clock)).toMatchObject({ work: 800, hz: 0, state: 'fault' });

    fixture = { cumulativeWorkUnits: '802', coreStatus: 'IDLE' };
    await vi.advanceTimersByTimeAsync(7_000);
    expect(readNow(clock)).toMatchObject({ work: 802, state: 'asleep' });
  });

  it('does not trust the count of a fault that arrives under a new epoch', async () => {
    let fixture: MeasurementFixture = { counterEpoch: EPOCH_A, cumulativeWorkUnits: '800', coreStatus: 'IDLE' };
    const { clock } = harness(serving(() => fixture));
    await land();

    fixture = { counterEpoch: EPOCH_B, cumulativeWorkUnits: '3', coreStatus: 'COUNTER_FAULT' };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(readNow(clock)).toMatchObject({ work: 800, state: 'fault' });

    fixture = { counterEpoch: EPOCH_B, cumulativeWorkUnits: '4', coreStatus: 'IDLE' };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(readNow(clock)).toMatchObject({ work: 4, state: 'asleep' });
  });

  it('shows the reported count when the very first reading is a fault', async () => {
    const { clock } = harness(serving(() => ({ cumulativeWorkUnits: '555', coreStatus: 'COUNTER_FAULT' })));
    await land();
    expect(readNow(clock)).toMatchObject({ work: 555, state: 'fault' });
    expect(hasTelemetry(readNow(clock))).toBe(true);
  });

  it.each(['simulated', 'replay', 'derived'])('refuses %s telemetry on the production clock', async (provenance) => {
    let fixture: MeasurementFixture = { cumulativeWorkUnits: '50', coreStatus: 'IDLE' };
    const { clock } = harness(serving(() => fixture));
    await land();

    fixture = { provenance, cumulativeWorkUnits: '6000', coreStatus: 'ACTIVE', rpmMilli: 60_000 };
    await vi.advanceTimersByTimeAsync(12_000);
    expect(readNow(clock)).toMatchObject({ work: 50, hz: 0, state: 'signal-lost' });
  });
});

describe('polling', () => {
  it('polls every five seconds while visible', async () => {
    const { statusCalls } = harness(serving(() => ({ coreStatus: 'IDLE' })));
    await land();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(statusCalls().map((call) => call.at - T0)).toEqual([0, 5_000, 10_000, 15_000, 20_000]);
  });

  it('sends nothing that would force a CORS preflight on every poll', async () => {
    const { statusCalls } = harness(serving(() => ({ coreStatus: 'IDLE' })));
    await land();
    const headers = new Headers(statusCalls()[0]?.init?.headers);
    expect([...headers.keys()]).toEqual(['accept']);
  });

  it('honours Retry-After in seconds and resumes afterwards', async () => {
    let limited = true;
    const { statusCalls } = harness(async () =>
      limited
        ? jsonResponse({}, { status: 429, headers: { 'Retry-After': '30' } })
        : jsonResponse(statusBody({ coreStatus: 'IDLE' })),
    );
    await land();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(statusCalls()).toHaveLength(1);

    limited = false;
    await vi.advanceTimersByTimeAsync(1);
    expect(statusCalls()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(statusCalls()).toHaveLength(3);
  });

  it('honours Retry-After as an HTTP date', async () => {
    const until = new Date(T0 + 45_000).toUTCString();
    let limited = true;
    const { statusCalls } = harness(async () =>
      limited
        ? jsonResponse({}, { status: 503, headers: { 'Retry-After': until } })
        : jsonResponse(statusBody({ coreStatus: 'IDLE' })),
    );
    await land();
    limited = false;
    await vi.advanceTimersByTimeAsync(44_999);
    expect(statusCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(statusCalls()).toHaveLength(2);
  });

  it('honours Retry-After on a successful response without losing the signal', async () => {
    const { clock, statusCalls } = harness(async () =>
      jsonResponse(statusBody({ coreStatus: 'IDLE' }), { headers: { 'Retry-After': '20' } }),
    );
    await land();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(statusCalls()).toHaveLength(1);
    expect(readNow(clock).state).toBe('asleep');
  });

  it('survives an absurd Retry-After instead of going dark until reload', async () => {
    let limited = true;
    const { statusCalls } = harness(async () =>
      limited
        ? jsonResponse({}, { status: 429, headers: { 'Retry-After': '86400' } })
        : jsonResponse(statusBody({ coreStatus: 'IDLE' })),
    );
    await land();
    limited = false;
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(statusCalls().length).toBeGreaterThan(1);
  });

  it('backs off while the API keeps failing and snaps back after a success', async () => {
    let failing = true;
    const { statusCalls } = harness(async () => {
      if (failing) throw new TypeError('Failed to fetch');
      return jsonResponse(statusBody({ coreStatus: 'IDLE' }));
    });
    await land();
    await vi.advanceTimersByTimeAsync(180_000);
    const attempts = statusCalls().map((call) => call.at);
    const gaps = attempts.slice(1).map((at, index) => at - (attempts[index] ?? 0));
    expect(gaps[0]).toBeGreaterThanOrEqual(5_000);
    expect(gaps[1]).toBeGreaterThan(gaps[0] ?? 0);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(60_000);
    expect(attempts.length).toBeLessThan(10);

    failing = false;
    await vi.advanceTimersByTimeAsync(60_000);
    const healthy = statusCalls().length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(statusCalls()).toHaveLength(healthy + 1);
  });

  it('slows right down while the tab is hidden', async () => {
    let hidden = true;
    const { statusCalls } = harness(serving(() => ({ coreStatus: 'IDLE' })), {
      visibility: { isHidden: () => hidden, subscribe: () => () => {} },
    });
    await land();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(statusCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(statusCalls()).toHaveLength(2);
    hidden = false;
  });

  it('polls at once when the tab comes back', async () => {
    let hidden = true;
    let wake = () => {};
    const { statusCalls } = harness(serving(() => ({ coreStatus: 'IDLE' })), {
      visibility: {
        isHidden: () => hidden,
        subscribe: (listener) => {
          wake = listener;
          return () => {};
        },
      },
    });
    await land();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(statusCalls()).toHaveLength(1);

    hidden = false;
    wake();
    await land();
    expect(statusCalls()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(statusCalls()).toHaveLength(3);
  });

  it('does not let a tab switch jump a Retry-After', async () => {
    let wake = () => {};
    const { statusCalls } = harness(
      async () => jsonResponse({}, { status: 429, headers: { 'Retry-After': '30' } }),
      {
        visibility: {
          isHidden: () => false,
          subscribe: (listener) => {
            wake = listener;
            return () => {};
          },
        },
      },
    );
    await land();
    await vi.advanceTimersByTimeAsync(10_000);
    wake();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(statusCalls()).toHaveLength(1);
  });
});

describe('subscribe and stop', () => {
  it('pushes a reading after each poll until unsubscribed', async () => {
    const { clock } = harness(serving(() => ({ cumulativeWorkUnits: '42', coreStatus: 'IDLE' })));
    const readings: HamsterReading[] = [];
    const unsubscribe = clock.subscribe((reading) => readings.push(reading));
    await land();
    expect(readings[0]).toMatchObject({ work: 42, state: 'asleep' });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(readings).toHaveLength(2);
    unsubscribe();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(readings).toHaveLength(2);
  });

  it('keeps polling and serves other listeners when one listener throws', async () => {
    const { clock, statusCalls } = harness(serving(() => ({ cumulativeWorkUnits: '7', coreStatus: 'IDLE' })));
    const readings: HamsterReading[] = [];
    clock.subscribe(() => {
      throw new Error('broken subscriber');
    });
    clock.subscribe((reading) => readings.push(reading));
    await land();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(statusCalls()).toHaveLength(2);
    expect(readings).toHaveLength(2);
  });

  it('stops polling and ignores a request already in flight', async () => {
    let finish = (_response: Response) => {};
    const { clock, statusCalls } = harness(
      () => new Promise<Response>((resolve) => {
        finish = resolve;
      }),
    );
    const readings: HamsterReading[] = [];
    clock.subscribe((reading) => readings.push(reading));
    await land();
    clock.stop();
    finish(jsonResponse(statusBody({ cumulativeWorkUnits: '9', coreStatus: 'IDLE' })));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(statusCalls()).toHaveLength(1);
    expect(readings).toHaveLength(0);
    expect(readNow(clock).work).toBe(0);
  });
});

describe('nextLiveAt', () => {
  const START = T0 + 2 * 60 * 60_000 + 41 * 60_000;
  const schedule = (startAt: number) => ({
    schemaVersion: 1,
    occurrence: {
      earlyStartAt: new Date(startAt - 30 * 60_000).toISOString(),
      startAt: new Date(startAt).toISOString(),
      endAt: new Date(startAt + 3 * 60 * 60_000).toISOString(),
    },
    observedAt: new Date(T0).toISOString(),
  });
  const routed = (scheduleResponse: () => Response): Responder => async (url) =>
    url === SCHEDULE_URL ? scheduleResponse() : jsonResponse(statusBody({ coreStatus: 'IDLE' }));

  it('surfaces the published start time', async () => {
    const { clock } = harness(routed(() => jsonResponse(schedule(START))), { scheduleUrl: SCHEDULE_URL });
    await land();
    expect(readNow(clock).nextLiveAt).toBe(START);
  });

  it('drops the time the moment it has passed', async () => {
    const { clock } = harness(routed(() => jsonResponse(schedule(START))), { scheduleUrl: SCHEDULE_URL });
    await land();
    expect(clock.read(START - 1).nextLiveAt).toBe(START);
    expect(clock.read(START).nextLiveAt).toBeNull();
  });

  it('is null and leaves telemetry alone when the schedule is unavailable', async () => {
    const { clock } = harness(routed(() => jsonResponse(null, { status: 404 })), { scheduleUrl: SCHEDULE_URL });
    await land();
    expect(readNow(clock)).toMatchObject({ state: 'asleep', nextLiveAt: null });
  });

  it('asks rarely while the schedule is unavailable', async () => {
    const { calls } = harness(routed(() => jsonResponse(null, { status: 404 })), { scheduleUrl: SCHEDULE_URL });
    await land();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(calls.filter((call) => call.url === SCHEDULE_URL).length).toBeLessThanOrEqual(4);
  });

  it('asks every minute once the schedule is being published', async () => {
    const { calls } = harness(routed(() => jsonResponse(schedule(START))), { scheduleUrl: SCHEDULE_URL });
    await land();
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(calls.filter((call) => call.url === SCHEDULE_URL)).toHaveLength(4);
  });

  it('picks up a schedule published later', async () => {
    let published = false;
    const { clock } = harness(
      routed(() => (published ? jsonResponse(schedule(START)) : jsonResponse(null, { status: 404 }))),
      { scheduleUrl: SCHEDULE_URL },
    );
    await land();
    published = true;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(readNow(clock).nextLiveAt).toBe(START);
  });

  it('makes no schedule request when no URL is configured', async () => {
    const { calls } = harness(routed(() => jsonResponse(schedule(START))), { scheduleUrl: null });
    await land();
    expect(calls.every((call) => call.url === STATUS_URL)).toBe(true);
  });
});

it('does not expose a reading that claims telemetry before any poll has landed', () => {
  vi.useFakeTimers({ now: T0 });
  const { clock } = harness(() => new Promise<Response>(() => {}));
  expect(hasTelemetry(readNow(clock))).toBe(false);
});
