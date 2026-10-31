import { HIDDEN_PROGRAM_IDS } from '../chain/config';
import { compile } from '../lang';

/**
 * Anyone can put any 140 printable bytes on-chain, and the contract cannot be moderated. A program
 * that compiles can only hold numbers, variable names and function names, so it cannot say anything.
 * One that does not compile can say "connect your wallet here", so its text is never shown.
 */
export const SOURCE_WITHHELD = 'SOURCE WITHHELD: DOES NOT COMPILE';
export const PROGRAM_HIDDEN = 'REDACTED';

/** Runs in place of a hidden program, which keeps its slice on the schedule but none of its pixels. */
export const HIDDEN_SOURCE = '0';

export const isHidden = (programId: number): boolean => HIDDEN_PROGRAM_IDS.has(programId);

export const isWithheld = (source: string): boolean => source.length > 0 && !compile(source).ok;
