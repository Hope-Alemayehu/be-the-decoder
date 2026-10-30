// Exact minimum-weight matching by bitmask DP over the defects, where each
// defect is paired with another defect or matched to its nearest boundary.

import { LEFT, RIGHT, emptyFlips, horizontalEdge, verticalEdge } from './lattice.js';

export const MAX_DEFECTS = 20;

const TO_BOUNDARY = -1;

export function pairWeight(a, b) {
  return Math.abs(a.r - b.r) + Math.abs(a.c - b.c);
}

export function boundaryWeight(d, defect) {
  return Math.min(defect.c + 1, d - 1 - defect.c);
}

function nearestBoundary(d, defect) {
  return defect.c + 1 <= d - 1 - defect.c ? LEFT : RIGHT;
}

function lowestBit(mask) {
  return 31 - Math.clz32(mask & -mask);
}

// Solves the matching. Returns the total weight, the matched pairs as [i, j]
// defect indices, and the defect indices matched to a boundary.
export function matchDefects(d, defects) {
  const k = defects.length;
  if (k > MAX_DEFECTS) throw new RangeError(`Too many defects: ${k}`);

  const size = 1 << k;
  const dp = new Int32Array(size);
  const choice = new Int8Array(size);

  for (let mask = 1; mask < size; mask++) {
    const i = lowestBit(mask);
    const rest = mask ^ (1 << i);

    let best = dp[rest] + boundaryWeight(d, defects[i]);
    let pick = TO_BOUNDARY;
    for (let others = rest; others; others &= others - 1) {
      const j = lowestBit(others);
      const cost = dp[rest ^ (1 << j)] + pairWeight(defects[i], defects[j]);
      // Ties go to pairing: it gives a lower logical error rate than boundaries.
      if (cost <= best) {
        best = cost;
        pick = j;
      }
    }
    dp[mask] = best;
    choice[mask] = pick;
  }

  const pairs = [];
  const toBoundary = [];
  for (let mask = size - 1; mask; ) {
    const i = lowestBit(mask);
    const pick = choice[mask];
    mask ^= 1 << i;
    if (pick === TO_BOUNDARY) {
      toBoundary.push(i);
    } else {
      pairs.push([i, pick]);
      mask ^= 1 << pick;
    }
  }

  return { cost: dp[size - 1], pairs, toBoundary };
}

// L-shaped path between two checks: horizontal first, then vertical.
export function pairPath(lattice, a, b) {
  const path = [];
  for (let c = Math.min(a.c, b.c); c < Math.max(a.c, b.c); c++) {
    path.push(horizontalEdge(lattice, a.r, c + 1));
  }
  for (let r = Math.min(a.r, b.r); r < Math.max(a.r, b.r); r++) {
    path.push(verticalEdge(lattice, r, b.c));
  }
  return path;
}

// Straight horizontal path from a check to the given boundary.
export function boundaryPath(lattice, defect, side) {
  const path = [];
  const firstEdge = side === LEFT ? 0 : defect.c + 1;
  const lastEdge = side === LEFT ? defect.c : lattice.d - 1;
  for (let k = firstEdge; k <= lastEdge; k++) {
    path.push(horizontalEdge(lattice, defect.r, k));
  }
  return path;
}

// Returns the minimum-weight correction for the defects, XORing all paths.
export function decode(lattice, defects) {
  const { cost, pairs, toBoundary } = matchDefects(lattice.d, defects);
  const correction = emptyFlips(lattice);

  const flipPath = (path) => {
    for (const id of path) correction[id] ^= 1;
  };
  for (const [i, j] of pairs) flipPath(pairPath(lattice, defects[i], defects[j]));
  for (const i of toBoundary) {
    flipPath(boundaryPath(lattice, defects[i], nearestBoundary(lattice.d, defects[i])));
  }

  return { cost, correction };
}
