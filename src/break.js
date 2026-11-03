// Break the decoder: the player places errors and wins by making MWPM fail.
// Puzzles and rules only, no DOM access.

import {
  buildLattice,
  countFlips,
  emptyFlips,
  findDefects,
  horizontalEdge,
  isLogicalError,
  logicalChain,
  verticalEdge,
  xorFlips,
} from './lattice.js';
import { decode } from './decoder.js';
import { MAX_STARS, makeRound } from './game.js';

export const BREAK_PROGRESS_KEY = 'be-the-decoder.break-progress';
export const BREAK_TIERS = [
  { label: 'Learn', size: 3 },
  { label: 'Shields', size: 6 },
  { label: 'Sabotage', size: 3 },
];

const lattices = new Map();

function latticeFor(d) {
  if (!lattices.has(d)) lattices.set(d, buildLattice(d));
  return lattices.get(d);
}

// Builds a puzzle with edge helpers for its distance: h(r, k) is horizontal edge
// k of row r, v(r, c) the vertical edge below check (r, c), and column(k) every
// row's horizontal edge k.
function puzzle(d, build) {
  const lattice = latticeFor(d);
  const h = (r, k) => horizontalEdge(lattice, r, k);
  const v = (r, c) => verticalEdge(lattice, r, c);
  const column = (k) => Array.from({ length: d }, (_, r) => h(r, k));
  const { shielded = [], fixed = [], ...rest } = build({ h, v, column });
  return { d, shielded, fixed, ...rest };
}

// par is the fewest errors that make MWPM fail, and solution is one way to do it.
// The tests check both by brute force.
export const BREAK_LEVELS = [
  puzzle(3, () => ({
    title: 'Fool the decoder',
    goal: 'Place errors so that MWPM, fixing what it sees, ends up joining the two boundaries.',
    par: 2,
    solution: [0, 1],
  })),
  puzzle(5, () => ({
    title: 'Scale up',
    goal: 'A bigger code takes more errors to fool. How few can do it?',
    par: 3,
    solution: [0, 1, 2],
  })),
  puzzle(7, () => ({
    title: 'Distance seven',
    goal: 'Can you spot the pattern from the last two levels?',
    par: 4,
    solution: [0, 1, 2, 3],
  })),
  puzzle(3, ({ column }) => ({
    title: 'No straight shots',
    goal: 'Dotted lines are shielded: no error can land there. The middle of every row is blocked.',
    shielded: column(1),
    par: 2,
    solution: [0, 2],
  })),
  puzzle(5, ({ column }) => ({
    title: 'One-sided attack',
    goal: 'The whole left edge is shielded. Do you need to touch both boundaries?',
    shielded: column(0),
    par: 3,
    solution: [1, 2, 3],
  })),
  puzzle(5, ({ column }) => ({
    title: 'Split rows',
    goal: 'The middle of every row is shielded.',
    shielded: column(2),
    par: 3,
    solution: [0, 1, 3],
  })),
  puzzle(5, ({ h }) => ({
    title: 'Staircase',
    goal: 'One edge in every row is shielded, each in a different place.',
    shielded: [h(0, 0), h(1, 1), h(2, 2), h(3, 3), h(4, 4)],
    par: 3,
    solution: [1, 2, 3],
  })),
  puzzle(7, ({ column }) => ({
    title: 'Middle wall',
    goal: 'A wall of shields runs down the middle.',
    shielded: column(3),
    par: 4,
    solution: [0, 1, 2, 4],
  })),
  puzzle(7, ({ column }) => ({
    title: 'Floating chain',
    goal: 'Both boundary edges are shielded on every row, so your errors cannot touch a boundary at all.',
    shielded: [...column(0), ...column(6)],
    par: 4,
    solution: [1, 2, 3, 4],
  })),
  puzzle(5, ({ h }) => ({
    title: 'Finish the job',
    goal: 'Solid red lines are errors already in place. Add as few as you can.',
    fixed: [h(2, 0), h(2, 1)],
    par: 1,
    solution: [7],
  })),
  puzzle(7, ({ h, v }) => ({
    title: 'Find the weak spot',
    goal: 'Several errors are already in place, but MWPM can fix them. Find where it is closest to failing.',
    fixed: [h(1, 1), h(1, 2), v(3, 4), h(5, 4), h(5, 5)],
    par: 2,
    solution: [0, 10],
  })),
  puzzle(7, ({ h }) => ({
    title: 'Under siege',
    goal: 'Two errors already run in from the right, but the row beyond them is shielded.',
    fixed: [h(3, 6), h(3, 5)],
    shielded: [h(3, 4), h(3, 3), h(2, 4), h(4, 4)],
    par: 2,
    solution: [14, 15],
  })),
];

export const BREAK_LEVEL_COUNT = BREAK_LEVELS.length;

export function breakRound(level) {
  const { d, shielded, fixed } = BREAK_LEVELS[level - 1];
  const lattice = latticeFor(d);
  const errors = emptyFlips(lattice);
  for (const id of fixed) errors[id] = 1;
  return makeRound(lattice, errors, { locked: [...shielded, ...fixed] });
}

// The player's errors are the round's correction; the fixed ones are its errors.
export function placedCount(round) {
  return countFlips(round.correction);
}

export function canRun(round) {
  return !round.result && placedCount(round) > 0;
}

// Whether MWPM fails on these errors, and how. Shared by the game and the tests.
export function attack(lattice, board) {
  const mwpm = decode(lattice, findDefects(lattice, board));
  const residual = xorFlips(board, mwpm.correction);
  const broke = isLogicalError(lattice, residual);
  return {
    broke,
    mwpmWeight: mwpm.cost,
    mwpmCorrection: mwpm.correction,
    mwpmMatches: mwpm.matches,
    chain: broke ? logicalChain(lattice, residual) : [],
  };
}

export function runDecoder(round) {
  const board = xorFlips(round.errors, round.correction);
  round.result = { ...attack(round.lattice, board), board, placed: placedCount(round) };
  return round.result;
}

// Three stars at par, two at one over, one for any break.
export function breakStars(result, par) {
  if (!result.broke) return 0;
  return Math.max(1, MAX_STARS - Math.max(0, result.placed - par));
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// Explains the outcome. When MWPM sent a defect to the wrong boundary, says how
// far each boundary looked from where MWPM stood.
export function breakVerdict(round, par) {
  const { result, lattice } = round;
  if (!result.broke) {
    const more = result.placed < par ? ` It always survives fewer than ${plural(par, 'error')} here.` : '';
    return `MWPM survived: its fix (green) plus your errors leave no chain between the boundaries.${more}`;
  }
  const misled = result.mwpmMatches.find((match) => match.defects.length === 1
    && match.path.some((id) => result.chain.includes(id)));
  if (!misled) return 'MWPM joined the defects the shortest way it could, and that completed a chain between the boundaries.';
  const { c } = misled.defects[0];
  const left = c + 1;
  const right = lattice.d - 1 - c;
  return `MWPM saw a defect ${plural(left, 'step')} from the left and ${plural(right, 'step')} from the right,`
    + ` so it went ${left < right ? 'left' : 'right'} and completed the chain.`;
}
