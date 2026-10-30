// Run with: node tests/decoder.test.js

import assert from 'node:assert/strict';

import { mulberry32, nextSeed, parseSeed } from '../src/rng.js';
import {
  LEFT,
  RIGHT,
  buildLattice,
  countFlips,
  emptyFlips,
  findDefects,
  horizontalEdge,
  isLogicalError,
  logicalChain,
  verticalEdge,
  xorFlips,
} from '../src/lattice.js';
import {
  MAX_DEFECTS,
  boundaryPath,
  boundaryWeight,
  decode,
  matchDefects,
  pairWeight,
} from '../src/decoder.js';
import {
  emptyStats,
  generateErrors,
  loadStats,
  newRound,
  recordResult,
  resolveRound,
  saveStats,
  toggleCorrection,
} from '../src/game.js';

let failures = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`ok    ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL  ${name}`);
    console.log(error);
  }
}

function flipsOf(lattice, ids) {
  const flips = emptyFlips(lattice);
  for (const id of ids) flips[id] ^= 1;
  return flips;
}

// Tries every matching: the first defect goes to a boundary or to any other.
function bruteForceCost(d, defects) {
  if (defects.length === 0) return 0;
  const [first, ...rest] = defects;
  let best = boundaryWeight(d, first) + bruteForceCost(d, rest);
  rest.forEach((other, index) => {
    const remaining = rest.filter((_, i) => i !== index);
    best = Math.min(best, pairWeight(first, other) + bruteForceCost(d, remaining));
  });
  return best;
}

function randomDefects(lattice, count, rng) {
  const ids = Array.from({ length: lattice.numChecks }, (_, id) => id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids
    .slice(0, count)
    .sort((a, b) => a - b)
    .map((id) => ({ id, r: Math.floor(id / lattice.cols), c: id % lattice.cols }));
}

function logicalErrorRate(d, p, rounds, startSeed) {
  const lattice = buildLattice(d);
  let seed = startSeed;
  let logicalErrors = 0;
  for (let i = 0; i < rounds; i++) {
    const errors = generateErrors(lattice, p, seed);
    const { correction } = decode(lattice, findDefects(lattice, errors));
    if (isLogicalError(lattice, xorFlips(errors, correction))) logicalErrors++;
    seed = nextSeed(seed);
  }
  return logicalErrors / rounds;
}

test('lattice has d^2 + (d-1)^2 data qubits and the right endpoints', () => {
  for (const d of [3, 5, 7]) {
    const lattice = buildLattice(d);
    assert.equal(lattice.edges.length, d * d + (d - 1) * (d - 1));
    assert.equal(lattice.numChecks, d * (d - 1));
    assert.equal(lattice.leftEdges.length, d);
    assert.equal(lattice.edges.filter((edge) => edge.b === RIGHT).length, d);
    lattice.edges.forEach((edge, id) => assert.equal(edge.id, id));
  }
  const lattice = buildLattice(5);
  assert.equal(lattice.edges.length, 41);
  assert.equal(lattice.edges[horizontalEdge(lattice, 2, 0)].a, LEFT);
  assert.equal(lattice.edges[horizontalEdge(lattice, 2, 4)].b, RIGHT);
  const vertical = lattice.edges[verticalEdge(lattice, 1, 3)];
  assert.deepEqual([vertical.a, vertical.b], [1 * 4 + 3, 2 * 4 + 3]);
});

test('decoder matches brute force on 1,000 random cases (k up to 8)', () => {
  const rng = mulberry32(1001);
  const sizes = [3, 5, 7];
  for (let i = 0; i < 1000; i++) {
    const d = sizes[i % sizes.length];
    const lattice = buildLattice(d);
    const count = Math.floor(rng() * (Math.min(8, lattice.numChecks) + 1));
    const defects = randomDefects(lattice, count, rng);
    assert.equal(matchDefects(d, defects).cost, bruteForceCost(d, defects));
  }
});

test('MWPM correction clears every defect on 1,000 random rounds', () => {
  const sizes = [[3, 0.05], [5, 0.07], [7, 0.09]];
  let seed = 2002;
  for (let i = 0; i < 1000; i++) {
    const [d, p] = sizes[i % sizes.length];
    const lattice = buildLattice(d);
    const errors = generateErrors(lattice, p, seed);
    const { cost, correction } = decode(lattice, findDefects(lattice, errors));
    assert.equal(findDefects(lattice, xorFlips(errors, correction)).length, 0);
    assert.equal(countFlips(correction), cost);
    seed = nextSeed(seed);
  }
});

test('decoder handles the largest allowed round', () => {
  const lattice = buildLattice(7);
  const defects = randomDefects(lattice, MAX_DEFECTS, mulberry32(3003));
  const errors = decode(lattice, defects).correction;
  assert.deepEqual(findDefects(lattice, errors).map((defect) => defect.id), defects.map((defect) => defect.id));
  assert.throws(() => matchDefects(7, randomDefects(lattice, MAX_DEFECTS + 1, mulberry32(1))), RangeError);
});

test('logical check: a full row of horizontal edges is a logical error', () => {
  for (const d of [3, 5, 7]) {
    const lattice = buildLattice(d);
    for (let r = 0; r < d; r++) {
      const row = Array.from({ length: d }, (_, k) => horizontalEdge(lattice, r, k));
      const residual = flipsOf(lattice, row);
      assert.equal(findDefects(lattice, residual).length, 0);
      assert.equal(isLogicalError(lattice, residual), true);
      assert.deepEqual(logicalChain(lattice, residual).sort((a, b) => a - b), row);
    }
  }
});

test('logical check: every closed loop of 4 edges is not a logical error', () => {
  for (const d of [3, 5, 7]) {
    const lattice = buildLattice(d);
    for (let r = 0; r < d - 1; r++) {
      for (let k = 1; k < d - 1; k++) {
        const residual = flipsOf(lattice, [
          horizontalEdge(lattice, r, k),
          horizontalEdge(lattice, r + 1, k),
          verticalEdge(lattice, r, k - 1),
          verticalEdge(lattice, r, k),
        ]);
        assert.equal(findDefects(lattice, residual).length, 0);
        assert.equal(isLogicalError(lattice, residual), false);
        assert.deepEqual(logicalChain(lattice, residual), []);
      }
    }
  }
});

test('logical check: a defect matched to its own boundary is not a logical error', () => {
  for (const d of [3, 5, 7]) {
    const lattice = buildLattice(d);
    for (let r = 0; r < d; r++) {
      for (let c = 0; c < d - 1; c++) {
        for (const side of [LEFT, RIGHT]) {
          const defect = { r, c };
          const otherSide = side === LEFT ? RIGHT : LEFT;
          const errors = flipsOf(lattice, boundaryPath(lattice, defect, side));

          const own = flipsOf(lattice, boundaryPath(lattice, defect, side));
          const ownResidual = xorFlips(errors, own);
          assert.equal(findDefects(lattice, ownResidual).length, 0);
          assert.equal(isLogicalError(lattice, ownResidual), false);

          // Matching to the opposite boundary completes a full row instead.
          const opposite = flipsOf(lattice, boundaryPath(lattice, defect, otherSide));
          assert.equal(isLogicalError(lattice, xorFlips(errors, opposite)), true);
        }
      }
    }
  }
});

test('threshold: logical error rate falls as d goes 3, 5, 7 at p = 0.05', () => {
  const rounds = 10000;
  const rates = [3, 5, 7].map((d) => logicalErrorRate(d, 0.05, rounds, 4004 + d));
  [3, 5, 7].forEach((d, i) => {
    console.log(`      d = ${d}: ${(rates[i] * 100).toFixed(2)}% logical errors over ${rounds} rounds`);
  });
  assert.ok(rates[0] > rates[1], `d=3 ${rates[0]} should exceed d=5 ${rates[1]}`);
  assert.ok(rates[1] > rates[2], `d=5 ${rates[1]} should exceed d=7 ${rates[2]}`);
});

test('same seed gives the same round', () => {
  for (const preset of ['easy', 'medium', 'hard']) {
    const first = newRound(preset, 123);
    const second = newRound(preset, 123);
    assert.deepEqual(first.errors, second.errors);
    assert.notDeepEqual(first.errors, newRound(preset, 124).errors);
  }
  assert.equal(nextSeed(123), nextSeed(123));
  assert.notEqual(nextSeed(123), 123);
});

test('rounds always have between 1 and MAX_DEFECTS defects', () => {
  const lattice = buildLattice(7);
  let seed = 5005;
  for (let i = 0; i < 1000; i++) {
    const count = findDefects(lattice, generateErrors(lattice, 0.09, seed)).length;
    assert.ok(count >= 1 && count <= MAX_DEFECTS);
    seed = nextSeed(seed);
  }
});

test('seed parsing accepts only 32-bit unsigned integers', () => {
  assert.equal(parseSeed('123'), 123);
  assert.equal(parseSeed('4294967295'), 4294967295);
  for (const bad of [null, '', 'abc', '-1', '1.5', '4294967296']) assert.equal(parseSeed(bad), null);
});

test('scoring: a correct submission wins and extends the streak', () => {
  const round = newRound('easy', 123);
  const { lattice, errors } = round;
  errors.forEach((bit, id) => bit && toggleCorrection(round, id));
  const result = resolveRound(round);
  assert.equal(result.playerWon, true);
  assert.equal(result.playerLogical, false);
  assert.equal(result.playerWeight, countFlips(errors));
  assert.equal(findDefects(lattice, xorFlips(errors, result.mwpmCorrection)).length, 0);

  const stats = recordResult({ ...emptyStats(), streak: 2, bestStreak: 2 }, result);
  assert.equal(stats.rounds, 1);
  assert.equal(stats.playerWins, 1);
  assert.equal(stats.streak, 3);
  assert.equal(stats.bestStreak, 3);
});

test('scoring: submitting with defects lit is refused', () => {
  assert.throws(() => resolveRound(newRound('easy', 123)));
});

test('scoring: a logical error loses the round and shows the chain', () => {
  const round = newRound('easy', 123);
  const { lattice, errors } = round;
  const row = Array.from({ length: 3 }, (_, k) => horizontalEdge(lattice, 0, k));
  const target = xorFlips(errors, flipsOf(lattice, row));
  target.forEach((bit, id) => bit && toggleCorrection(round, id));
  const result = resolveRound(round);
  assert.equal(result.playerLogical, true);
  assert.equal(result.playerWon, false);
  assert.deepEqual(result.playerChain.sort((a, b) => a - b), row);
  assert.equal(recordResult({ ...emptyStats(), streak: 4, bestStreak: 4 }, result).streak, 0);
});

test('scoring: giving up is a loss, resets the streak and still scores MWPM', () => {
  const result = resolveRound(newRound('easy', 123), true);
  assert.equal(result.gaveUp, true);
  assert.equal(result.playerLogical, null);
  assert.equal(result.playerWon, false);

  const stats = recordResult({ ...emptyStats(), streak: 4, bestStreak: 4 }, result);
  assert.equal(stats.rounds, 1);
  assert.equal(stats.playerWins, 0);
  assert.equal(stats.mwpmWins, result.mwpmWon ? 1 : 0);
  assert.equal(stats.streak, 0);
  assert.equal(stats.bestStreak, 4);
});

test('stats round-trip through storage and survive broken storage', () => {
  const store = new Map();
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  assert.deepEqual(loadStats(storage), emptyStats());
  const stats = { ...emptyStats(), rounds: 5, streak: 2 };
  saveStats(storage, stats);
  assert.deepEqual(loadStats(storage), stats);

  store.set('be-the-decoder.stats', 'not json');
  assert.deepEqual(loadStats(storage), emptyStats());

  const blocked = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
  };
  assert.deepEqual(loadStats(blocked), emptyStats());
  saveStats(blocked, stats);
  assert.deepEqual(loadStats(null), emptyStats());
  saveStats(null, stats);
});

console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
