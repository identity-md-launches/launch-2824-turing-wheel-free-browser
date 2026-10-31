import {
  COLS,
  ROWS,
  SLICE_PASSES,
  createFrame,
  type Frame,
  type Preset,
  type Program,
  type QueuedProgram,
} from '../../types';
import { helpTip, panelBar, segmented, type Segmented } from '../chrome';
import { h, setText } from '../dom';
import { cycles, shortAddress } from '../format';
import { createFramePainter, type ThumbHandle, type ThumbPool } from '../led/thumbs';
import { BLUE_STOPS, GOLD_STOPS, css, type Rgb } from '../led/palette';
import { PROGRAM_HIDDEN, SOURCE_WITHHELD, isHidden, isWithheld } from '../moderation';
import { history, upcoming, type SliceView } from './slices';

type Tab = 'next' | 'past';

const CARD_COUNT = 8;
const TAPE_PAST = 3;
const TAPE_NEXT = 9;
const FILM_FRAMES = 14;

export interface QueueEvents {
  onReplay(slice: SliceView, t: number): void;
  onScrub(t: number): void;
  onLeaveReplay(): void;
  onSqueek(programId: number): void;
}

/** closed: no contract. reading: first read pending. unreachable: an empty list means unknown, not empty. */
export type QueueSync = 'closed' | 'reading' | 'unreachable' | 'live';

export interface QueuePanel {
  readonly element: HTMLElement;
  setSync(sync: QueueSync): void;
  setPrograms(programs: readonly QueuedProgram[]): void;
  /** Tick with the true hamster work count, whatever clock the wall is on. */
  update(work: number, known: boolean): void;
  setReplayActive(active: boolean): void;
  setSqueeked(programId: number): void;
  setSqueeking(programId: number, busy: boolean): void;
  /** What the contract says this wallet has squeeked, replacing anything known before. */
  setSqueekedIds(programIds: ReadonlySet<number>): void;
  /** Keeps the chosen frame in view while the wall is scrolled away. */
  monitor(frame: Frame): void;
}

interface Card {
  readonly element: HTMLElement;
  readonly eta: HTMLElement;
  /** Null for a hidden program, which gets no pixels at all. */
  readonly thumb: ThumbHandle | null;
  readonly slice: SliceView;
}

/** The reader keeps a program's object while nothing about it changed, squeeks included. */
function unchanged(before: SliceView, after: SliceView): boolean {
  if (before.end !== after.end) return false;
  const was = before.slot.kind === 'queued' ? before.slot.program : null;
  const now = after.slot.kind === 'queued' ? after.slot.program : null;
  return was === now;
}

function paintFilm(canvas: HTMLCanvasElement, program: Program): void {
  canvas.width = COLS * FILM_FRAMES;
  canvas.height = ROWS;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return;
  const image = ctx.createImageData(canvas.width, canvas.height);
  const frame = createFrame();
  const color = (level: number): Rgb | null => {
    if (level === 0) return null;
    const stops = level > 0 ? GOLD_STOPS : BLUE_STOPS;
    return stops[Math.abs(level) - 1] ?? null;
  };
  for (let f = 0; f < FILM_FRAMES; f++) {
    program.render((f / (FILM_FRAMES - 1)) * (SLICE_PASSES - 1), frame);
    for (let i = 0; i < frame.length; i++) {
      const rgb = color(frame[i] as number);
      const x = (i % COLS) + f * COLS;
      const y = Math.floor(i / COLS);
      const at = (y * canvas.width + x) * 4;
      image.data[at] = rgb?.[0] ?? 8;
      image.data[at + 1] = rgb?.[1] ?? 8;
      image.data[at + 2] = rgb?.[2] ?? 10;
      image.data[at + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  ctx.fillStyle = css([11, 11, 13]);
  for (let f = 1; f < FILM_FRAMES; f++) ctx.fillRect(f * COLS, 0, 1, ROWS);
}

export function createQueuePanel(
  house: readonly Preset[],
  pool: ThumbPool,
  programOf: (source: string) => Program,
  events: QueueEvents,
): QueuePanel {
  let sync: QueueSync = 'reading';
  let tab: Tab = 'next';
  let programs: readonly QueuedProgram[] = [];
  let cards = new Map<string, Card>();
  let order = '';
  let work = 0;
  let known = false;
  let squeeked: ReadonlySet<number> = new Set<number>();
  const squeeking = new Set<number>();

  const summary = h('span', { class: 'bar__sub' }, 'READING SEPOLIA');
  const tabs: Segmented<Tab> = segmented<Tab>(
    'Queue view',
    [
      { value: 'next', text: 'Up next' },
      { value: 'past', text: 'Past' },
    ],
    'next',
    (value) => {
      tab = value;
      tabs.set(value);
      order = '';
      refresh();
    },
  );

  const tape = h('div', { class: 'tape__row', 'aria-hidden': 'true' });
  const tapePanel = h(
    'div',
    { class: 'tape', hidden: true },
    tape,
    h(
      'div',
      { class: 'tape__legend', 'aria-hidden': 'true' },
      h('span', {}, h('i', { 'data-swatch': 'now' }), 'Now'),
      h('span', {}, h('i', { 'data-swatch': 'queued' }), 'Queued'),
      h('span', {}, h('i', { 'data-swatch': 'house' }), 'House ROM'),
      h('span', {}, h('i', { 'data-swatch': 'past' }), 'Past'),
    ),
  );
  let tapeKey = '';
  let tapeNow: HTMLElement | null = null;
  const track = h('div', { class: 'track', role: 'list', tabIndex: 0, 'aria-label': 'Slices' });
  const notice = h('p', { class: 'queue__notice' }, '');

  const film = h('canvas', { class: 'film__strip', 'aria-hidden': 'true' });
  const preview = h('canvas', { class: 'film__preview', role: 'img', 'aria-label': 'Frame at the replay position' });
  const previewPainter = createFramePainter(preview);
  const scrub = h('input', {
    class: 'film__range',
    name: 'replay-position',
    type: 'range',
    min: '0',
    max: String(SLICE_PASSES - 1),
    step: '0.1',
    value: '0',
    'aria-label': 'Replay position in cycles',
  });
  const filmTime = h('b', {}, `0 / ${SLICE_PASSES}`);
  const filmName = h('span', { class: 'film__name' }, '');
  const leave = h('button', { class: 'btn btn--small', type: 'button', onClick: () => events.onLeaveReplay() }, 'Back to live');
  const filmPanel = h(
    'div',
    { class: 'film', hidden: true },
    h('div', { class: 'film__head' }, h('span', { class: 'lamp', 'data-tone': 'blue', 'aria-hidden': 'true' }), filmName, filmTime, leave),
    h('div', { class: 'film__body' }, preview, h('div', { class: 'film__stack' }, film, scrub)),
  );

  scrub.addEventListener('input', () => {
    const t = Number(scrub.value);
    setText(filmTime, `${Math.floor(t)} / ${SLICE_PASSES}`);
    events.onScrub(t);
  });

  const openReplay = (slice: SliceView, label: string): void => {
    const program = programOf(slice.source);
    paintFilm(film, program);
    scrub.value = '0';
    setText(filmTime, `0 / ${SLICE_PASSES}`);
    setText(filmName, label);
    filmPanel.hidden = false;
    events.onReplay(slice, 0);
  };

  const buildCard = (slice: SliceView, position: number): Card => {
    const { slot } = slice;
    const live = position === 0 && tab === 'next';
    const hidden = slot.kind === 'queued' && isHidden(slot.program.id);
    const withheld = !hidden && slot.kind === 'queued' && isWithheld(slice.source);
    const canvas = hidden ? null : h('canvas', { class: 'card__led', 'aria-hidden': 'true' });
    const thumb = canvas ? pool.add(canvas, programOf(slice.source), 2.4) : null;
    const eta = h('span', { class: 'card__eta' }, '');
    const title = slot.kind === 'queued' ? `#${slot.program.id}` : slot.name;
    const byline = slot.kind === 'queued' ? shortAddress(slot.program.author) : 'HOUSE ROM';
    const label = slot.kind === 'queued' ? `PROGRAM #${slot.program.id}` : `HOUSE ROM: ${slot.name}`;

    const actions: HTMLElement[] = [];
    if (slot.kind === 'queued' && !hidden) {
      const id = slot.program.id;
      actions.push(
        h(
          'button',
          {
            class: 'btn btn--small btn--squeek',
            type: 'button',
            disabled: squeeked.has(id) || squeeking.has(id),
            'aria-label': `Squeek program ${id}, ${slot.program.squeeks} squeeks so far`,
            onClick: () => events.onSqueek(id),
          },
          squeeking.has(id)
            ? 'Waiting for block'
            : squeeked.has(id)
              ? `Squeeked ${slot.program.squeeks}`
              : `Squeek ${slot.program.squeeks}`,
        ),
      );
    }
    if (tab === 'past' && !hidden) {
      actions.push(
        h('button', { class: 'btn btn--small', type: 'button', onClick: () => openReplay(slice, label) }, 'Replay'),
      );
    }

    const element = h(
      'article',
      { class: 'card', role: 'listitem', 'data-kind': slot.kind, 'data-live': live ? 'true' : 'false' },
      h('div', { class: 'card__screen', 'data-redacted': hidden ? 'true' : 'false' }, canvas ?? PROGRAM_HIDDEN),
      h(
        'div',
        { class: 'card__body' },
        h(
          'div',
          { class: 'card__row' },
          h('span', { class: 'card__tag' }, live ? 'NOW' : slot.kind === 'queued' ? 'QUEUED' : 'HOUSE'),
          eta,
        ),
        h('h3', { class: 'card__title' }, title),
        h('p', { class: 'card__by' }, byline),
        hidden ? null : withheld
          ? h('p', { class: 'card__source' }, SOURCE_WITHHELD)
          : h('code', { class: 'card__source', title: slice.source }, slice.source),
        actions.length > 0 ? h('div', { class: 'card__actions' }, ...actions) : null,
      ),
    );
    return { element, eta, thumb, slice };
  };

  const etaText = (slice: SliceView, position: number): string => {
    if (tab === 'past') return `ENDED ${cycles(Math.max(0, work - slice.end))} AGO`;
    if (position === 0) return `${cycles(Math.max(0, slice.end - work))} LEFT`;
    return `IN ${cycles(Math.max(0, slice.start - work))} CYCLES`;
  };

  /** Every slice at its true length, so a house slice cut short by a program looks cut short. */
  const paintTape = (): void => {
    const slices = [
      ...[...history(work, programs, house, TAPE_PAST)].reverse(),
      ...upcoming(work, programs, house, TAPE_NEXT),
    ];
    const key = slices.map((slice) => `${slice.key}:${slice.end}`).join(',');
    if (key !== tapeKey) {
      tapeKey = key;
      tapeNow = null;
      tape.replaceChildren(
        ...slices.map((slice) => {
          const when = slice.end <= work ? 'past' : slice.start <= work ? 'now' : 'next';
          const segment = h('i', { class: 'tape__seg', 'data-kind': slice.slot.kind, 'data-when': when });
          segment.style.flexGrow = String(slice.end - slice.start);
          if (when === 'now') tapeNow = segment;
          return segment;
        }),
      );
    }
    const current = slices.find((slice) => slice.start <= work && slice.end > work);
    if (current) tapeNow?.style.setProperty('--p', ((work - current.start) / (current.end - current.start)).toFixed(3));
    tapePanel.hidden = false;
  };

  const syncLabel = (count: string): string =>
    ({ closed: 'QUEUE OPENS SOON', reading: 'READING SEPOLIA', unreachable: 'QUEUE UNREACHABLE', live: count })[sync];

  function refresh(): void {
    if (!known) {
      setText(summary, syncLabel('READING SEPOLIA'));
      setText(notice, 'Waiting for the wheel count. The schedule is worked out from it.');
      notice.hidden = false;
      return;
    }
    paintTape();
    const slices = tab === 'next'
      ? upcoming(work, programs, house, CARD_COUNT)
      : history(work, programs, house, CARD_COUNT);

    const nextOrder = slices.map((slice) => slice.key).join(',');
    if (nextOrder !== order) {
      order = nextOrder;
      const nextCards = new Map<string, Card>();
      slices.forEach((slice, position) => {
        const card = cards.get(slice.key);
        if (card && unchanged(card.slice, slice) && position !== 0 && tab === 'next') {
          nextCards.set(slice.key, card);
        } else {
          card?.thumb?.remove();
          nextCards.set(slice.key, buildCard(slice, position));
        }
      });
      for (const [key, card] of cards) {
        if (!nextCards.has(key)) card.thumb?.remove();
      }
      cards = nextCards;
      track.replaceChildren(...[...cards.values()].map((card) => card.element));
    }
    slices.forEach((slice, position) => {
      const card = cards.get(slice.key);
      if (card) setText(card.eta, etaText(slice, position));
    });

    const waiting = programs.filter((program) => program.endWork > work).length;
    const count = waiting === 1 ? '1 PROGRAM WAITING' : `${waiting} PROGRAMS WAITING`;
    const live = waiting === 0 && tab === 'next' ? 'Nothing queued. House ROM has the wheel until somebody claims it.' : '';
    const notes: Record<QueueSync, string> = {
      closed: 'The contract is not deployed yet. Until it is, House ROM owns every slice. Run and Crank work now.',
      reading: '',
      unreachable: 'Cannot reach Sepolia, so the queue is unknown, not empty. These are House ROM slices assuming nothing is queued.',
      live,
    };
    setText(summary, syncLabel(count));
    setText(notice, notes[sync]);
    notice.hidden = notes[sync] === '';
  }

  const { bar } = panelBar(
    'The Queue',
    'blue',
    summary,
    h('span', { class: 'bar__spacer' }),
    tabs.element,
    helpTip(
      'About the queue',
      'Each program owns the next 512 wheel passes. ETA is in cycles because that is the only honest unit: the hamster keeps his own hours. Every frame is pure, so any past slice can be scrubbed.',
    ),
  );

  const element = h(
    'section',
    { class: 'panel queue', id: 'queue', 'aria-label': 'The Queue' },
    bar,
    notice,
    tapePanel,
    track,
    filmPanel,
  );

  /** Button state lives in the cards, so a change to it needs new ones. */
  const rebuild = (): void => {
    for (const card of cards.values()) card.thumb?.remove();
    cards = new Map();
    order = '';
    refresh();
  };

  let lastTick = 0;

  return {
    element,
    setSync(next) {
      if (next === sync) return;
      sync = next;
      refresh();
    },
    setPrograms(next) {
      programs = next;
      order = '';
      refresh();
    },
    update(nextWork, nextKnown) {
      const now = performance.now();
      if (now - lastTick < 400 && nextKnown === known) return;
      lastTick = now;
      work = nextWork;
      known = nextKnown;
      refresh();
    },
    monitor(frame) {
      if (!filmPanel.hidden) previewPainter.paint(frame);
    },
    setReplayActive(active) {
      if (!active) filmPanel.hidden = true;
    },
    setSqueeked(id) {
      squeeked = new Set([...squeeked, id]);
      rebuild();
    },
    setSqueeking(id, busy) {
      if (busy) squeeking.add(id);
      else squeeking.delete(id);
      rebuild();
    },
    setSqueekedIds(ids) {
      squeeked = ids;
      rebuild();
    },
  };
}
