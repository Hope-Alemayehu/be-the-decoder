// Round state and scoring. No DOM access: the only browser API used is
// localStorage, and storage functions take the store as a parameter.

import { mulberry32 } from './rng.js';
import {
  buildLattice,
  countFlips,
  emptyFlips,
  findDefects,
  isLogicalError,
  logicalChain,
  sampleErrors,
  xorFlips,
} from './lattice.js';
import { MAX_DEFECTS, decode } from './decoder.js';

export const PRESETS = {
  easy: { label: 'Easy', d: 3, p: 0.05 },
  medium: { label: 'Medium', d: 5, p: 0.07 },
  hard: { label: 'Hard', d: 7, p: 0.09 },
};

export const DEFAULT_PRESET = 'easy';

export const LEVELS_PER_TIER = 10;
export const LEVEL_TIERS = ['easy', 'medium', 'hard'];
export const LEVEL_COUNT = LEVELS_PER_TIER * LEVEL_TIERS.length;
export const MAX_STARS = 3;

// Chosen so MWPM beats every level's first puzzle, which keeps a first attempt
// from being unwinnable by sensible play. Retries are not screened.
const LEVEL_SEED_BASE = 20261102;
const LEVEL_SEED_STEP = 1000003;
// The same step as nextSeed, so attempt k is nextSeed applied k times.
const ATTEMPT_SEED_STEP = 0x9e3779b9;
const REPLAY_ATTEMPTS = 1000000;

const STATS_KEY = 'be-the-decoder.stats';
const HELP_KEY = 'be-the-decoder.help-seen';
const TOUR_KEY = 'be-the-decoder.tour-seen';
const PROGRESS_KEY = 'be-the-decoder.progress';

// Samples hidden errors, resampling empty syndromes and rounds the decoder
// would not accept. The same arguments always give the same errors.
export function generateErrors(lattice, p, seed) {
  const rng = mulberry32(seed);
  for (;;) {
    const errors = sampleErrors(lattice, p, rng);
    const defectCount = findDefects(lattice, errors).length;
    if (defectCount > 0 && defectCount <= MAX_DEFECTS) return errors;
  }
}

function roundWith(lattice, errors, presetKey, seed) {
  return {
    presetKey,
    seed,
    lattice,
    errors,
    correction: emptyFlips(lattice),
    history: [],
    hintsUsed: 0,
    result: null,
  };
}

export function newRound(presetKey, seed) {
  const { d, p } = PRESETS[presetKey];
  const lattice = buildLattice(d);
  return roundWith(lattice, generateErrors(lattice, p, seed), presetKey, seed);
}

// A round with chosen errors, for the guided tour.
export function scriptedRound(d, errorIds) {
  const lattice = buildLattice(d);
  const errors = emptyFlips(lattice);
  for (const id of errorIds) errors[id] = 1;
  return roundWith(lattice, errors, null, null);
}

export function liveDefects(round) {
  return findDefects(round.lattice, xorFlips(round.errors, round.correction));
}

// Flips a set of edges as one move, so a drawn path undoes in one step.
export function applyMove(round, edgeIds) {
  if (round.result || edgeIds.length === 0) return;
  for (const id of edgeIds) round.correction[id] ^= 1;
  round.history.push([...edgeIds]);
}

export function toggleCorrection(round, edgeId) {
  applyMove(round, [edgeId]);
}

export function undoMove(round) {
  if (round.result) return;
  const move = round.history.pop();
  if (move) for (const id of move) round.correction[id] ^= 1;
}

// Clearing is itself a move, so it can be undone.
export function clearCorrection(round) {
  applyMove(round, [...round.correction.keys()].filter((id) => round.correction[id]));
}

// Returns the shortest path MWPM would flip for the board as it stands, or null
// when no defects are lit.
export function takeHint(round) {
  if (round.result) return null;
  const { matches } = decode(round.lattice, liveDefects(round));
  if (matches.length === 0) return null;
  round.hintsUsed++;
  return matches.reduce((best, match) => (match.path.length < best.path.length ? match : best)).path;
}

export function canSubmit(round) {
  return !round.result && liveDefects(round).length === 0;
}

// Ends the round. A give-up is a loss whatever the board looks like: the logical
// check needs a defect-free residual, so playerLogical stays null.
export function resolveRound(round, gaveUp = false) {
  if (!gaveUp && !canSubmit(round)) throw new Error('Round cannot be submitted');

  const { lattice, errors, correction } = round;
  const mwpm = decode(lattice, findDefects(lattice, errors));
  const mwpmResidual = xorFlips(errors, mwpm.correction);
  const mwpmLogical = isLogicalError(lattice, mwpmResidual);

  const playerResidual = xorFlips(errors, correction);
  const playerLogical = gaveUp ? null : isLogicalError(lattice, playerResidual);

  round.result = {
    gaveUp,
    playerWon: playerLogical === false,
    mwpmWon: !mwpmLogical,
    playerLogical,
    mwpmLogical,
    playerWeight: countFlips(correction),
    mwpmWeight: mwpm.cost,
    mwpmCorrection: mwpm.correction,
    mwpmMatches: mwpm.matches,
    playerChain: playerLogical ? logicalChain(lattice, playerResidual) : [],
  };
  return round.result;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// One line on whether the round was won well, lost to bad luck or lost to a
// mistake, judged against MWPM on the same errors.
export function roundVerdict(result) {
  const { gaveUp, playerWon, mwpmWon, playerWeight, mwpmWeight } = result;
  if (gaveUp) {
    return mwpmWon
      ? `MWPM fixed it with ${plural(mwpmWeight, 'flip')}. Follow its green path to see how.`
      : 'MWPM lost this one too, so it was a tough round.';
  }
  if (!playerWon) {
    return mwpmWon
      ? `A mistake: MWPM found a safe fix with ${plural(mwpmWeight, 'flip')}. Compare its green path with yours.`
      : 'Unlucky: MWPM lost too. The errors took an unlikely path, so the most likely fix was wrong.';
  }
  if (!mwpmWon) return 'You beat MWPM! It lost this round.';
  if (playerWeight === mwpmWeight) return 'Perfect: your fix is as short as MWPM\'s.';
  return `Safe, but MWPM needed ${plural(playerWeight - mwpmWeight, 'flip')} fewer.`;
}

// One star for a win, two if the fix was as short as MWPM's (or beat it), three
// if that came on the first try without a hint.
export function starsFor(result, { firstTry, hinted }) {
  if (!result.playerWon) return 0;
  const efficient = result.playerWeight <= result.mwpmWeight || !result.mwpmWon;
  if (!efficient) return 1;
  return firstTry && !hinted ? 3 : 2;
}

// Levels are numbered from 1.
export function levelPreset(level) {
  return LEVEL_TIERS[Math.floor((level - 1) / LEVELS_PER_TIER)];
}

let firstSeeds = null;

// Each tier's first puzzles, sorted so defects rise steadily through the tier.
function levelFirstSeeds() {
  if (!firstSeeds) {
    firstSeeds = LEVEL_TIERS.flatMap((presetKey, tier) => {
      const puzzles = Array.from({ length: LEVELS_PER_TIER }, (_, index) => {
        const seed = LEVEL_SEED_BASE + (tier * LEVELS_PER_TIER + index + 1) * LEVEL_SEED_STEP;
        const round = newRound(presetKey, seed);
        const defects = liveDefects(round);
        return { seed, defects: defects.length, weight: decode(round.lattice, defects).cost };
      });
      puzzles.sort((a, b) => a.defects - b.defects || a.weight - b.weight);
      return puzzles.map((puzzle) => puzzle.seed);
    });
  }
  return firstSeeds;
}

// A level's first puzzle is fixed. Each retry gets a new one, because the reveal
// has already shown the answer to the last.
export function levelSeed(level, attempt = 0) {
  return (levelFirstSeeds()[level - 1] + Math.imul(attempt, ATTEMPT_SEED_STEP)) >>> 0;
}

// Progress is the number of levels cleared in order, the finished attempts on
// the level after them, and the best stars earned on each level.
export function emptyProgress() {
  return { cleared: 0, attempts: 0, stars: Array(LEVEL_COUNT).fill(0) };
}

export function levelState(progress, level) {
  if (level <= progress.cleared) return 'cleared';
  return level === progress.cleared + 1 ? 'current' : 'locked';
}

// Which attempt to open a level on. A replay gets a random new puzzle, since
// the player has already seen the answer to the first one.
export function levelAttempt(progress, level, random = Math.random) {
  if (levelState(progress, level) === 'cleared') return 1 + Math.floor(random() * REPLAY_ATTEMPTS);
  return progress.attempts;
}

// Only the current level moves progress on: replays never change it.
export function recordLevelResult(progress, level, won) {
  if (levelState(progress, level) !== 'current') return progress;
  return won
    ? { ...progress, cleared: level, attempts: 0 }
    : { ...progress, attempts: progress.attempts + 1 };
}

// Keeps the best stars earned on a level.
export function recordStars(progress, level, stars) {
  if (stars <= progress.stars[level - 1]) return progress;
  const best = [...progress.stars];
  best[level - 1] = stars;
  return { ...progress, stars: best };
}

export function totalStars(progress) {
  return progress.stars.reduce((total, stars) => total + stars, 0);
}

export function emptyStats() {
  return { rounds: 0, playerWins: 0, mwpmWins: 0, streak: 0, bestStreak: 0 };
}

export function recordResult(stats, result) {
  const streak = result.playerWon ? stats.streak + 1 : 0;
  return {
    rounds: stats.rounds + 1,
    playerWins: stats.playerWins + (result.playerWon ? 1 : 0),
    mwpmWins: stats.mwpmWins + (result.mwpmWon ? 1 : 0),
    streak,
    bestStreak: Math.max(stats.bestStreak, streak),
  };
}

// Reading window.localStorage itself throws when storage is blocked.
export function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadStats(storage) {
  try {
    return { ...emptyStats(), ...JSON.parse(storage.getItem(STATS_KEY)) };
  } catch {
    return emptyStats();
  }
}

export function saveStats(storage, stats) {
  try {
    storage.setItem(STATS_KEY, JSON.stringify(stats));
  } catch {
    // Stats just last for this page load.
  }
}

function validStars(stars) {
  return Array.isArray(stars) && stars.length === LEVEL_COUNT
    && stars.every((count) => Number.isInteger(count) && count >= 0 && count <= MAX_STARS);
}

// Progress saved before stars existed loads with no stars.
export function loadProgress(storage) {
  try {
    const { cleared, attempts, stars } = JSON.parse(storage.getItem(PROGRESS_KEY));
    const valid = Number.isInteger(cleared) && Number.isInteger(attempts)
      && cleared >= 0 && cleared <= LEVEL_COUNT && attempts >= 0;
    if (!valid) return emptyProgress();
    return { cleared, attempts, stars: validStars(stars) ? stars : emptyProgress().stars };
  } catch {
    return emptyProgress();
  }
}

export function saveProgress(storage, progress) {
  try {
    storage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  } catch {
    // Progress just lasts for this page load.
  }
}

export function hasSeenHelp(storage) {
  try {
    return storage.getItem(HELP_KEY) === '1';
  } catch {
    return false;
  }
}

export function markHelpSeen(storage) {
  try {
    storage.setItem(HELP_KEY, '1');
  } catch {
    // The overlay just shows again next visit.
  }
}

export function hasSeenTour(storage) {
  try {
    return storage.getItem(TOUR_KEY) === '1';
  } catch {
    return false;
  }
}

export function markTourSeen(storage) {
  try {
    storage.setItem(TOUR_KEY, '1');
  } catch {
    // The tour just starts again next visit.
  }
}
