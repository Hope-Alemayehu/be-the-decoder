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

const STATS_KEY = 'be-the-decoder.stats';
const HELP_KEY = 'be-the-decoder.help-seen';

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

export function newRound(presetKey, seed) {
  const { d, p } = PRESETS[presetKey];
  const lattice = buildLattice(d);
  return {
    presetKey,
    seed,
    lattice,
    errors: generateErrors(lattice, p, seed),
    correction: emptyFlips(lattice),
    result: null,
  };
}

export function liveDefects(round) {
  return findDefects(round.lattice, xorFlips(round.errors, round.correction));
}

export function toggleCorrection(round, edgeId) {
  if (round.result) return;
  round.correction[edgeId] ^= 1;
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
    playerChain: playerLogical ? logicalChain(lattice, playerResidual) : [],
  };
  return round.result;
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
