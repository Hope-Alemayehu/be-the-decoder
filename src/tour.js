// Script for the guided tour. Each step can start a new puzzle, ask the player to
// flip edges or press Submit, and explain the result once that is done. No DOM
// access, so the tests can check the script against the real game rules.

import { buildLattice, horizontalEdge, verticalEdge } from './lattice.js';

export const TOUR_DISTANCE = 3;

const lattice = buildLattice(TOUR_DISTANCE);
const h = (r, k) => horizontalEdge(lattice, r, k);
const v = (r, c) => verticalEdge(lattice, r, c);

export const TOUR_STEPS = [
  {
    title: 'Welcome, decoder',
    puzzle: { errors: [], visible: true },
    body: [
      'This grid is a small quantum memory. Each line is a qubit storing data, each dot is a check that watches the lines touching it, and the bars at the sides are boundaries.',
      'Errors flip qubits, but you can never look at the qubits directly. All you get is what the checks report, and your job is to work out what went wrong.',
    ],
  },
  {
    title: 'An error hits',
    puzzle: { errors: [h(1, 1)], visible: true },
    body: [
      'A bit-flip error just hit the red line. In a real round it would be hidden. It is shown here so you can see cause and effect.',
      'Why did two dots light up? A check lights up when an odd number of its lines are flipped. Each of these dots touches the red line once, so each sees one flip. A lit dot is called a defect.',
    ],
  },
  {
    title: 'Fix it',
    body: ['Click the glowing line to flip that qubit back.'],
    flip: [h(1, 1)],
    why: [
      'Flipping a qubit twice cancels out, so the error is gone. Both checks now see an even number of flips, so their defects go dark.',
    ],
  },
  {
    title: 'Why only one dot?',
    puzzle: { errors: [h(0, 0)], visible: true },
    body: [
      'This error touches the left boundary. One end reaches a check, which lights up. The other end reaches the boundary, which has no check, so nothing reports it.',
      'Click the glowing line to join the defect to the boundary.',
    ],
    flip: [h(0, 0)],
    why: [
      'A defect on its own means a chain ended at a boundary. Joining it to that boundary clears it.',
    ],
  },
  {
    title: 'Chains hide their middle',
    puzzle: { errors: [h(0, 1), v(0, 1)], visible: true },
    body: [
      'Now two errors sit end to end. Why are there still only two defects? The dot where they meet touches two flipped lines. Two is even, so it stays dark.',
      'Only the ends of a chain light up, so in a real round you cannot see the path it took.',
    ],
  },
  {
    title: 'Any route can work',
    body: [
      'You do not need to find the exact errors. Click the two glowing lines to join the defects by a different route.',
    ],
    flip: [v(0, 0), h(1, 1)],
    why: [
      'Your route and the errors now form a closed loop. Every dot on a loop touches two flipped lines, so nothing lights up, and a loop never joins the two boundaries.',
      'It does no harm, so this fix is just as good as the exact one.',
    ],
  },
  {
    title: 'Now without hints',
    puzzle: { errors: [h(1, 0), h(1, 1)], visible: false },
    body: [
      'This is what a real round looks like: one defect and no sign of the errors.',
      'The nearest boundary is one line away, on the right. Click the glowing line to join it.',
    ],
    flip: [h(1, 2)],
    why: [
      'The defect is gone and the board is clear. A clear board does not prove you are safe, though. That depends on what the errors really were.',
    ],
  },
  {
    title: 'Submit your answer',
    body: ['Press Submit to check your fix against the hidden errors.'],
    submit: true,
    why: [
      'The errors were the two red lines on the left, not one on the right. Together with your fix they form a chain from boundary to boundary, highlighted in purple.',
      'No check can see that chain, because it has no ends to light up. It silently changes the stored data, and that is a logical error.',
    ],
  },
  {
    title: 'Was that a mistake?',
    body: [
      'No. One error is far more likely than two, so the short fix was the right bet. The MWPM decoder made the same bet, shown by the dashed green line, and it lost too.',
      'MWPM always picks the fix with the fewest flips. It is very good, but it cannot see hidden errors any more than you can, so sometimes even the best play loses.',
    ],
  },
  {
    title: 'You are ready',
    body: [
      'In each round, find the defects, pair up the ones that are close, send lonely ones to the nearest boundary, and keep your fix short.',
      'To save clicks, click a defect and then another dot or a boundary bar, and the whole path flips at once. Undo takes back a move, and Hint shows one path MWPM would draw.',
      'The reveal shows the real errors and tells you whether a loss was bad luck or a mistake. If you are stuck, Give up skips to the reveal but counts as a loss. Beat level 1 to unlock level 2.',
    ],
  },
];
