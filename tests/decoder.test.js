// Run with: node tests/decoder.test.js

import assert from 'node:assert/strict';

import { mulberry32, nextSeed, parseSeed } from '../src/rng.js';
import {
  LEFT,
  RIGHT,
  buildLattice,
  checkAt,
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
  pairPath,
  pairWeight,
} from '../src/decoder.js';
import {
  LEVEL_COUNT,
  LEVELS_PER_TIER,
  applyMove,
  canSubmit,
  clearCorrection,
  emptyProgress,
  emptyStats,
  generateErrors,
  hasSeenTour,
  levelAttempt,
  levelPreset,
  levelSeed,
  levelState,
  liveDefects,
  loadProgress,
  loadStats,
  markTourSeen,
  newRound,
  recordLevelResult,
  recordResult,
  recordStars,
  resolveRound,
  roundVerdict,
  saveProgress,
  saveStats,
  scriptedRound,
  starsFor,
  takeHint,
  toggleCorrection,
  totalStars,
  undoMove,
} from '../src/game.js';
import { TOUR_DISTANCE, TOUR_STEPS } from '../src/tour.js';

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

test('levels: 30 levels split into Easy, Medium and Hard', () => {
  assert.equal(LEVEL_COUNT, 30);
  const tiers = Array.from({ length: LEVEL_COUNT }, (_, i) => levelPreset(i + 1));
  assert.deepEqual(tiers.slice(0, 10), Array(10).fill('easy'));
  assert.deepEqual(tiers.slice(10, 20), Array(10).fill('medium'));
  assert.deepEqual(tiers.slice(20, 30), Array(10).fill('hard'));
  assert.equal(LEVELS_PER_TIER, 10);
});

test('levels: first puzzles are fixed and a retry gets a different puzzle', () => {
  const firstSeeds = new Set();
  for (let level = 1; level <= LEVEL_COUNT; level++) {
    const preset = levelPreset(level);
    const first = newRound(preset, levelSeed(level));
    assert.deepEqual(first.errors, newRound(preset, levelSeed(level)).errors);
    assert.equal(levelSeed(level, 0), levelSeed(level));
    assert.notEqual(levelSeed(level, 1), levelSeed(level, 0));
    assert.notEqual(levelSeed(level, 2), levelSeed(level, 1));
    firstSeeds.add(levelSeed(level));
  }
  assert.equal(firstSeeds.size, LEVEL_COUNT);
});

test('levels: MWPM beats every first puzzle', () => {
  for (let level = 1; level <= LEVEL_COUNT; level++) {
    const result = resolveRound(newRound(levelPreset(level), levelSeed(level)), true);
    assert.equal(result.mwpmWon, true, `level ${level}`);
  }
});

test('levels: only the next level is open and the rest stay locked', () => {
  const progress = { ...emptyProgress(), cleared: 4 };
  assert.equal(levelState(progress, 1), 'cleared');
  assert.equal(levelState(progress, 4), 'cleared');
  assert.equal(levelState(progress, 5), 'current');
  assert.equal(levelState(progress, 6), 'locked');
  assert.equal(levelState(progress, 30), 'locked');
  assert.equal(levelState(emptyProgress(), 1), 'current');
  assert.equal(levelState({ ...emptyProgress(), cleared: LEVEL_COUNT }, LEVEL_COUNT), 'cleared');
});

test('levels: a win unlocks the next level, a loss counts a retry', () => {
  let progress = emptyProgress();
  progress = recordLevelResult(progress, 1, false);
  assert.deepEqual([progress.cleared, progress.attempts], [0, 1]);
  assert.equal(levelState(progress, 2), 'locked');
  assert.equal(levelAttempt(progress, 1), 1);

  progress = recordLevelResult(progress, 1, false);
  assert.equal(levelAttempt(progress, 1), 2);

  progress = recordLevelResult(progress, 1, true);
  assert.deepEqual([progress.cleared, progress.attempts], [1, 0]);
  assert.equal(levelState(progress, 2), 'current');
  assert.equal(levelAttempt(progress, 2), 0);
});

test('levels: replaying a cleared level never changes progress', () => {
  const progress = { ...emptyProgress(), cleared: 3, attempts: 2 };
  assert.deepEqual(recordLevelResult(progress, 2, true), progress);
  assert.deepEqual(recordLevelResult(progress, 2, false), progress);
});

test('levels: a replay opens a new puzzle, not the one already revealed', () => {
  const progress = { ...emptyProgress(), cleared: 3 };
  for (const random of [() => 0, () => 0.5, () => 0.999999]) {
    const attempt = levelAttempt(progress, 2, random);
    assert.ok(attempt >= 1);
    assert.notEqual(levelSeed(2, attempt), levelSeed(2));
  }
  assert.equal(levelAttempt(progress, 4, () => 0.5), 0);
});

test('levels: attempt k is the first seed advanced k times', () => {
  for (const level of [1, 15, 30]) {
    let seed = levelSeed(level);
    for (let attempt = 1; attempt <= 5; attempt++) {
      seed = nextSeed(seed);
      assert.equal(levelSeed(level, attempt), seed);
    }
  }
});

test('levels: defects never drop from one level to the next within a tier', () => {
  const count = (level) => liveDefects(newRound(levelPreset(level), levelSeed(level))).length;
  for (let level = 2; level <= LEVEL_COUNT; level++) {
    if ((level - 1) % LEVELS_PER_TIER === 0) continue;
    assert.ok(count(level) >= count(level - 1), `level ${level}`);
  }
});

test('levels: a locked level cannot be cleared', () => {
  const progress = { ...emptyProgress(), cleared: 3 };
  assert.deepEqual(recordLevelResult(progress, 7, true), progress);
});

test('levels: progress round-trips through storage and survives bad data', () => {
  const store = new Map();
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  assert.deepEqual(loadProgress(storage), emptyProgress());
  const saved = recordStars({ ...emptyProgress(), cleared: 7, attempts: 2 }, 3, 2);
  saveProgress(storage, saved);
  assert.deepEqual(loadProgress(storage), saved);

  // Progress saved before stars existed keeps its levels.
  store.set('be-the-decoder.progress', '{"cleared":7,"attempts":2}');
  assert.deepEqual(loadProgress(storage), { ...emptyProgress(), cleared: 7, attempts: 2 });
  store.set('be-the-decoder.progress', '{"cleared":7,"attempts":2,"stars":[5]}');
  assert.deepEqual(loadProgress(storage).stars, emptyProgress().stars);

  for (const bad of ['not json', '{"cleared":"7","attempts":0}', '{"cleared":-1,"attempts":0}', '{"cleared":31,"attempts":0}']) {
    store.set('be-the-decoder.progress', bad);
    assert.deepEqual(loadProgress(storage), emptyProgress());
  }
  assert.deepEqual(loadProgress(null), emptyProgress());
  saveProgress(null, emptyProgress());
});

test('levels: stars keep the best result per level', () => {
  let progress = emptyProgress();
  progress = recordStars(progress, 2, 2);
  progress = recordStars(progress, 2, 1);
  assert.equal(progress.stars[1], 2);
  progress = recordStars(progress, 2, 3);
  progress = recordStars(progress, 5, 1);
  assert.equal(progress.stars[1], 3);
  assert.equal(totalStars(progress), 4);
});

function resultWith(fields) {
  return { gaveUp: false, playerWon: true, mwpmWon: true, playerWeight: 3, mwpmWeight: 3, ...fields };
}

test('stars: one for a win, two for MWPM length, three on a clean first try', () => {
  const firstTry = { firstTry: true, hinted: false };
  assert.equal(starsFor(resultWith({ playerWon: false }), firstTry), 0);
  assert.equal(starsFor(resultWith({ playerWeight: 5 }), firstTry), 1);
  assert.equal(starsFor(resultWith({}), firstTry), 3);
  assert.equal(starsFor(resultWith({}), { firstTry: false, hinted: false }), 2);
  assert.equal(starsFor(resultWith({}), { firstTry: true, hinted: true }), 2);
  // Beating MWPM counts as efficient even with a longer fix.
  assert.equal(starsFor(resultWith({ playerWeight: 5, mwpmWon: false }), firstTry), 3);
});

test('verdict: tells bad luck from a mistake', () => {
  assert.match(roundVerdict(resultWith({ playerWon: false, mwpmWon: false })), /^Unlucky: MWPM lost too/);
  assert.match(roundVerdict(resultWith({ playerWon: false })), /^A mistake: MWPM found a safe fix with 3 flips/);
  assert.match(roundVerdict(resultWith({})), /^Perfect/);
  assert.match(roundVerdict(resultWith({ playerWeight: 4 })), /needed 1 flip fewer/);
  assert.match(roundVerdict(resultWith({ mwpmWon: false })), /^You beat MWPM/);
  assert.match(roundVerdict(resultWith({ gaveUp: true, playerWon: false, mwpmWeight: 1 })), /fixed it with 1 flip\./);
  assert.match(roundVerdict(resultWith({ gaveUp: true, playerWon: false, mwpmWon: false })), /lost this one too/);
});

test('moves: a drawn path undoes in one step and Clear can be undone', () => {
  const round = newRound('medium', 77);
  const path = [1, 2, 3];
  applyMove(round, path);
  toggleCorrection(round, 10);
  assert.equal(countFlips(round.correction), 4);
  undoMove(round);
  assert.equal(countFlips(round.correction), 3);
  clearCorrection(round);
  assert.equal(countFlips(round.correction), 0);
  undoMove(round);
  assert.deepEqual([...round.correction.keys()].filter((id) => round.correction[id]), path);
  undoMove(round);
  undoMove(round);
  assert.equal(countFlips(round.correction), 0);
  clearCorrection(round);
  assert.equal(round.history.length, 0);
});

test('moves: nothing changes after the round is resolved', () => {
  const round = newRound('easy', 123);
  round.errors.forEach((bit, id) => bit && toggleCorrection(round, id));
  resolveRound(round);
  const before = [...round.correction];
  applyMove(round, [0]);
  undoMove(round);
  clearCorrection(round);
  assert.deepEqual([...round.correction], before);
  assert.equal(takeHint(round), null);
});

test('drawn paths light up exactly their two ends, or one end at a boundary', () => {
  const rng = mulberry32(6006);
  for (const d of [3, 5, 7]) {
    const lattice = buildLattice(d);
    for (let i = 0; i < 200; i++) {
      const a = checkAt(lattice, Math.floor(rng() * lattice.numChecks));
      const b = checkAt(lattice, Math.floor(rng() * lattice.numChecks));
      if (a.id === b.id) continue;
      const ends = findDefects(lattice, flipsOf(lattice, pairPath(lattice, a, b))).map((defect) => defect.id);
      assert.deepEqual(ends, [a.id, b.id].sort((x, y) => x - y));
      for (const side of [LEFT, RIGHT]) {
        const end = findDefects(lattice, flipsOf(lattice, boundaryPath(lattice, a, side)));
        assert.deepEqual(end.map((defect) => defect.id), [a.id]);
      }
    }
  }
});

test('hint: shows one MWPM path that clears its own defects', () => {
  let seed = 8008;
  for (let i = 0; i < 200; i++) {
    const round = newRound('hard', seed);
    const before = liveDefects(round).length;
    const hint = takeHint(round);
    const { matches } = decode(round.lattice, liveDefects(round));
    const match = matches.find((m) => m.path.join() === hint.join());
    assert.ok(match);
    assert.ok(matches.every((m) => m.path.length >= hint.length));
    applyMove(round, hint);
    assert.equal(liveDefects(round).length, before - match.defects.length);
    assert.equal(round.hintsUsed, 1);
    seed = nextSeed(seed);
  }
  const solved = scriptedRound(3, []);
  assert.equal(takeHint(solved), null);
  assert.equal(solved.hintsUsed, 0);
});

test('reveal: MWPM matches pair up every defect once and build its correction', () => {
  let seed = 9009;
  for (let i = 0; i < 300; i++) {
    const round = newRound(['easy', 'medium', 'hard'][i % 3], seed);
    const defects = liveDefects(round).map((defect) => defect.id);
    const { mwpmMatches, mwpmCorrection } = resolveRound(round, true);
    const matched = mwpmMatches.flatMap((match) => match.defects.map((defect) => defect.id)).sort((a, b) => a - b);
    assert.deepEqual(matched, defects);
    assert.deepEqual(flipsOf(round.lattice, mwpmMatches.flatMap((match) => match.path)), mwpmCorrection);
    seed = nextSeed(seed);
  }
});

// Plays the tour script, returning the round as it stands after each step.
function playTour() {
  let round = null;
  return TOUR_STEPS.map((step) => {
    if (step.puzzle) round = scriptedRound(TOUR_DISTANCE, step.puzzle.errors);
    const defectsBefore = liveDefects(round).length;
    for (const id of step.flip ?? []) toggleCorrection(round, id);
    if (step.submit) resolveRound(round);
    return { step, round, defectsBefore, defectsAfter: liveDefects(round).length };
  });
}

const tourStep = (played, title) => played.find(({ step }) => step.title === title);

test('tour: every step opens on a board and every task can be finished', () => {
  const played = playTour();
  assert.ok(TOUR_STEPS[0].puzzle);
  for (const { step, defectsAfter } of played) {
    assert.ok(step.title && step.body.length > 0);
    for (const id of step.flip ?? []) assert.ok(id >= 0 && id < 13, step.title);
    if (step.flip) assert.equal(defectsAfter, 0, step.title);
    if (step.flip || step.submit) assert.ok(step.why, `${step.title} should explain the result`);
  }
});

test('tour: the defect counts match what each step says', () => {
  const played = playTour();
  assert.equal(tourStep(played, 'Welcome, decoder').defectsBefore, 0);
  assert.equal(tourStep(played, 'An error hits').defectsBefore, 2);
  assert.equal(tourStep(played, 'Why only one dot?').defectsBefore, 1);
  assert.equal(tourStep(played, 'Chains hide their middle').defectsBefore, 2);
  assert.equal(tourStep(played, 'Now without hints').defectsBefore, 1);
});

test('tour: the loop fix is safe and differs from the errors', () => {
  const { round } = tourStep(playTour(), 'Any route can work');
  const residual = xorFlips(round.errors, round.correction);
  assert.equal(countFlips(residual), 4);
  assert.equal(findDefects(round.lattice, residual).length, 0);
  assert.equal(isLogicalError(round.lattice, residual), false);
});

test('tour: the trap loses for the player and MWPM alike', () => {
  const played = playTour();
  const { round } = tourStep(played, 'Submit your answer');
  const { result } = round;
  assert.equal(result.playerLogical, true);
  assert.equal(result.mwpmLogical, true);
  assert.deepEqual(result.mwpmCorrection, round.correction);
  assert.equal(result.mwpmWeight, 1);
  assert.equal(result.playerChain.length, 3);
  assert.equal(countFlips(round.errors), 2);
  assert.equal(tourStep(played, 'Now without hints').step.puzzle.visible, false);
});

test('tour: scripted rounds behave like normal rounds', () => {
  const round = scriptedRound(TOUR_DISTANCE, TOUR_STEPS[1].puzzle.errors);
  assert.equal(canSubmit(round), false);
  toggleCorrection(round, TOUR_STEPS[1].puzzle.errors[0]);
  assert.equal(canSubmit(round), true);
});

test('tour: seen flag round-trips and survives broken storage', () => {
  const store = new Map();
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  assert.equal(hasSeenTour(storage), false);
  markTourSeen(storage);
  assert.equal(hasSeenTour(storage), true);
  assert.equal(hasSeenTour(null), false);
  markTourSeen(null);
});

console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
