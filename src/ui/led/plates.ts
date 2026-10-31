import { COLS } from '../../types';
import { utcClock } from '../format';
import { FONT_MINI, textWidth } from './font';
import { centred, type PlateLine } from './scene';

export function haltedLines(nextLiveAt: number | null, cycle: number): readonly PlateLine[] {
  const footer = nextLiveAt === null ? `HELD AT ${Math.floor(cycle)}` : `LIVE ${utcClock(nextLiveAt)} UTC`;
  return [
    { text: 'HALTED', font: 'plaque', tone: 'pale', x: 2, y: 1, block: { tone: 'navy', width: 45, height: 13 } },
    { text: 'CLOCK ASLEEP', font: 'mini', tone: 'gold', x: 2, y: 16 },
    { text: 'GRAB THE CRANK', font: 'mini', tone: 'pale', x: 2, y: 23 },
    { text: footer, font: 'mini', tone: 'rust', x: Math.min(2, COLS - textWidth(FONT_MINI, footer)), y: 29 },
  ];
}

export function lostLines(everSeen: boolean): readonly PlateLine[] {
  const [first, second] = everSeen ? ['TELEMETRY LOST', 'LAST CYCLE HELD'] : ['NO TELEMETRY', 'THE CRANK WORKS'];
  return [
    { text: 'NO SIGNAL', font: 'banner', tone: 'gold', x: centred('banner', 'NO SIGNAL'), y: 6 },
    { text: first, font: 'mini', tone: 'gold', x: centred('mini', first), y: 20 },
    { text: second, font: 'mini', tone: 'ember', x: centred('mini', second), y: 27 },
  ];
}

export const FAULT_LINES: readonly PlateLine[] = [
  { text: 'FAULT', font: 'banner', tone: 'cream', x: centred('banner', 'FAULT'), y: 6 },
  { text: 'COUNTER FAULT', font: 'mini', tone: 'gold', x: centred('mini', 'COUNTER FAULT'), y: 20 },
  { text: 'CLOCK UNTRUSTED', font: 'mini', tone: 'ember', x: centred('mini', 'CLOCK UNTRUSTED'), y: 27 },
];

export const REDACTED_LINES: readonly PlateLine[] = [
  { text: 'REDACTED', font: 'banner', tone: 'ember', x: centred('banner', 'REDACTED'), y: 14 },
];

export const ACQUIRING_LINES: readonly PlateLine[] = [
  { text: 'ACQUIRING SIGNAL', font: 'mini', tone: 'ember', x: centred('mini', 'ACQUIRING SIGNAL'), y: 15 },
];
