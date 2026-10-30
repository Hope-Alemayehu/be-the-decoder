// Matching graph of an unrotated planar surface code, bit-flip errors only.
// Check nodes are vertices and data qubits are edges. Sets of flipped edges are
// Uint8Arrays indexed by edge id, holding 0 or 1.

export const LEFT = -1;
export const RIGHT = -2;

export function buildLattice(d) {
  const rows = d;
  const cols = d - 1;
  const numChecks = rows * cols;
  const edges = [];

  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < d; k++) {
      edges.push({
        id: edges.length,
        kind: 'h',
        r,
        k,
        a: k === 0 ? LEFT : r * cols + k - 1,
        b: k === d - 1 ? RIGHT : r * cols + k,
      });
    }
  }
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols; c++) {
      edges.push({
        id: edges.length,
        kind: 'v',
        r,
        c,
        a: r * cols + c,
        b: (r + 1) * cols + c,
      });
    }
  }

  const checkEdges = Array.from({ length: numChecks }, () => []);
  for (const edge of edges) {
    if (edge.a >= 0) checkEdges[edge.a].push(edge.id);
    if (edge.b >= 0) checkEdges[edge.b].push(edge.id);
  }

  const leftEdges = edges.filter((edge) => edge.a === LEFT).map((edge) => edge.id);

  return { d, rows, cols, numChecks, edges, checkEdges, leftEdges };
}

// Horizontal edge k of row r. k = 0 touches the left boundary and k = d - 1 the
// right one, so the edge between (r, c) and (r, c + 1) is k = c + 1.
export function horizontalEdge(lattice, r, k) {
  return r * lattice.d + k;
}

// Vertical edge between (r, c) and (r + 1, c).
export function verticalEdge(lattice, r, c) {
  return lattice.d * lattice.d + r * lattice.cols + c;
}

export function emptyFlips(lattice) {
  return new Uint8Array(lattice.edges.length);
}

export function xorFlips(a, b) {
  return a.map((bit, id) => bit ^ b[id]);
}

export function countFlips(flips) {
  return flips.reduce((total, bit) => total + bit, 0);
}

// Flips each data qubit independently with probability p.
export function sampleErrors(lattice, p, rng) {
  return emptyFlips(lattice).map(() => (rng() < p ? 1 : 0));
}

// Returns a Uint8Array indexed by check id: 1 where the check is lit.
export function syndrome(lattice, flips) {
  const lit = new Uint8Array(lattice.numChecks);
  flips.forEach((bit, id) => {
    if (!bit) return;
    const { a, b } = lattice.edges[id];
    if (a >= 0) lit[a] ^= 1;
    if (b >= 0) lit[b] ^= 1;
  });
  return lit;
}

// Lists lit checks as { id, r, c }.
export function findDefects(lattice, flips) {
  const defects = [];
  syndrome(lattice, flips).forEach((bit, id) => {
    if (bit) defects.push({ id, r: Math.floor(id / lattice.cols), c: id % lattice.cols });
  });
  return defects;
}

// Only meaningful for a residual with no defects left: it is then a set of
// cycles and boundary-to-boundary chains, and a chain joining the two different
// boundaries crosses the left edges an odd number of times.
export function isLogicalError(lattice, residual) {
  let crossings = 0;
  for (const id of lattice.leftEdges) crossings += residual[id];
  return crossings % 2 === 1;
}

// Finds one left-to-right chain through the residual, as a list of edge ids.
// Returns an empty list when there is none.
export function logicalChain(lattice, residual) {
  const reachedBy = new Map();
  const queue = [];
  for (const id of lattice.leftEdges) {
    const node = lattice.edges[id].b;
    if (residual[id] && !reachedBy.has(node)) {
      reachedBy.set(node, id);
      queue.push(node);
    }
  }

  for (let head = 0; head < queue.length; head++) {
    const node = queue[head];
    for (const id of lattice.checkEdges[node]) {
      if (!residual[id]) continue;
      const edge = lattice.edges[id];
      const next = edge.a === node ? edge.b : edge.a;
      if (next === RIGHT) return traceBack(lattice, reachedBy, node, id);
      if (next !== LEFT && !reachedBy.has(next)) {
        reachedBy.set(next, id);
        queue.push(next);
      }
    }
  }
  return [];
}

function traceBack(lattice, reachedBy, lastNode, lastEdge) {
  const chain = [lastEdge];
  let node = lastNode;
  while (node !== LEFT) {
    const id = reachedBy.get(node);
    const edge = lattice.edges[id];
    chain.push(id);
    node = edge.a === node ? edge.b : edge.a;
  }
  return chain;
}
