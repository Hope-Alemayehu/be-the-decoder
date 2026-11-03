// SVG rendering and click handling.

import { nextSeed, parseSeed, randomSeed } from './rng.js';
import { LEFT, RIGHT, checkAt, syndrome, xorFlips } from './lattice.js';
import { boundaryPath, pairPath } from './decoder.js';
import {
  DEFAULT_PRESET,
  LEVEL_COUNT,
  LEVEL_TIERS,
  LEVELS_PER_TIER,
  MAX_STARS,
  PRESETS,
  applyMove,
  browserStorage,
  canSubmit,
  clearCorrection,
  hasSeen,
  levelAttempt,
  levelPreset,
  levelSeed,
  levelState,
  loadProgress,
  loadStats,
  markSeen,
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
  totalStars,
  undoMove,
} from './game.js';
import {
  BREAK_LEVELS,
  BREAK_LEVEL_COUNT,
  BREAK_PROGRESS_KEY,
  BREAK_TIERS,
  breakRound,
  breakStars,
  breakVerdict,
  canRun,
  placedCount,
  runDecoder,
} from './break.js';
import { BREAK_TOUR_STEPS, TOUR_DISTANCE, TOUR_STEPS } from './tour.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SPACING = 90;
const MARGIN_X = 60;
const MARGIN_Y = 44;
const NODE_RADIUS = 10;
const CHECK_HIT_RADIUS = 20;
const LAYER_OFFSET = 6;
const PAIR_COLORS = ['#7dd3fc', '#f9a8d4', '#fdba74', '#c4b5fd', '#bef264', '#5eead4'];

const MAP_STEP_X = 92;
const MAP_STEP_Y = 82;
const MAP_TIER_GAP = 42;
const MAP_MARGIN_X = 54;
const MAP_TOP = 64;
const LEVEL_RADIUS = 27;
const STAR_RADIUS = 6.5;

// The two level paths. Each tier fills whole rows, so the path always turns at
// the side where the next row starts.
const CAMPAIGNS = {
  decode: {
    blurb: 'Find the hidden errors and fix them before they become a logical error.',
    count: LEVEL_COUNT,
    columns: 5,
    tiers: LEVEL_TIERS.map((presetKey) => ({ label: PRESETS[presetKey].label, size: LEVELS_PER_TIER })),
    storageKey: undefined,
    describe: (level) => PRESETS[levelPreset(level)].label,
  },
  break: {
    blurb: 'Switch sides: place as few errors as you can to make MWPM fail.',
    count: BREAK_LEVEL_COUNT,
    columns: 3,
    tiers: BREAK_TIERS,
    storageKey: BREAK_PROGRESS_KEY,
    describe: (level) => `d = ${BREAK_LEVELS[level - 1].d}`,
  },
};

const TOURS = {
  decode: { steps: TOUR_STEPS, flag: 'tour', mode: 'decode' },
  break: { steps: BREAK_TOUR_STEPS, flag: 'break-tour', mode: 'break' },
};

const $ = (id) => document.getElementById(id);

const board = $('board');
const storage = browserStorage();

let round = null;
let stats = loadStats(storage);
const progress = {
  decode: loadProgress(storage),
  break: loadProgress(storage, BREAK_PROGRESS_KEY, BREAK_LEVEL_COUNT),
};
let campaign = 'decode'; // the level path on show
let mode = 'decode'; // 'break' while the player places errors instead of fixing them
let activeLevel = null; // { campaign, level, attempt, firstTry } while playing a level, null otherwise
let tour = null; // { kind, index } during a tour, otherwise null
let selectedCheck = null; // the defect a drawn path starts from
let checkGroup = null;
let checkNodes = [];
let checkHits = [];
let edgeNodes = [];
let litChecks = new Uint8Array(0);
let layers = {};

function svgElement(tag, attributes, parent) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  parent.appendChild(element);
  return element;
}

function checkPosition(lattice, checkId) {
  const c = checkId % lattice.cols;
  const r = Math.floor(checkId / lattice.cols);
  return { x: MARGIN_X + (c + 1) * SPACING, y: MARGIN_Y + r * SPACING };
}

function edgeEnds(lattice, edge) {
  if (edge.kind === 'v') {
    return [checkPosition(lattice, edge.a), checkPosition(lattice, edge.b)];
  }
  const y = MARGIN_Y + edge.r * SPACING;
  const left = edge.a === LEFT ? { x: MARGIN_X, y } : checkPosition(lattice, edge.a);
  const right = edge.b === RIGHT ? { x: MARGIN_X + lattice.d * SPACING, y } : checkPosition(lattice, edge.b);
  return [left, right];
}

function lineAttributes(lattice, edge, offset = 0) {
  const [from, to] = edgeEnds(lattice, edge);
  const dx = edge.kind === 'v' ? offset : 0;
  const dy = edge.kind === 'h' ? offset : 0;
  return { x1: from.x + dx, y1: from.y + dy, x2: to.x + dx, y2: to.y + dy };
}

function edgeLabel(edge) {
  return edge.kind === 'h'
    ? `Data qubit: row ${edge.r + 1}, horizontal edge ${edge.k + 1}`
    : `Data qubit: vertical edge ${edge.c + 1} below row ${edge.r + 1}`;
}

function drawBoard() {
  const { lattice } = round;
  const { d, rows } = lattice;
  const width = 2 * MARGIN_X + d * SPACING;
  const height = 2 * MARGIN_Y + (rows - 1) * SPACING;

  board.replaceChildren();
  board.setAttribute('viewBox', `0 0 ${width} ${height}`);
  board.classList.remove('revealed');
  selectedCheck = null;

  const barTop = MARGIN_Y - 26;
  const barBottom = height - MARGIN_Y + 26;
  const boundaries = [
    ['left', MARGIN_X, MARGIN_X - 22, -90, 'LEFT BOUNDARY'],
    ['right', width - MARGIN_X, width - MARGIN_X + 22, 90, 'RIGHT BOUNDARY'],
  ];
  for (const [, x, labelX, angle, text] of boundaries) {
    svgElement('line', { class: 'boundary-bar', x1: x, y1: barTop, x2: x, y2: barBottom }, board);
    const label = svgElement('text', {
      class: 'boundary-label',
      x: labelX,
      y: height / 2,
      transform: `rotate(${angle} ${labelX} ${height / 2})`,
    }, board);
    label.textContent = text;
  }

  const edgeGroup = svgElement('g', {}, board);
  edgeNodes = lattice.edges.map((edge) => {
    const locked = round.locked.has(edge.id);
    const group = svgElement('g', {
      class: 'edge',
      'data-edge': edge.id,
      role: 'button',
      'aria-label': edgeLabel(edge),
      'aria-pressed': 'false',
    }, edgeGroup);
    if (locked) group.setAttribute('aria-disabled', 'true');
    else group.setAttribute('tabindex', 0);
    const line = lineAttributes(lattice, edge);
    svgElement('line', { class: 'edge-line', ...line }, group);
    svgElement('line', { class: 'edge-hit', ...line }, group);
    return group;
  });

  // Above the edges, so a selected path can end on a boundary bar.
  for (const [side, x] of boundaries) {
    svgElement('line', { class: 'boundary-hit', 'data-boundary': side, x1: x, y1: barTop, x2: x, y2: barBottom }, board);
  }

  layers = {};

  checkGroup = svgElement('g', {}, board);
  checkNodes = [];
  checkHits = [];
  for (let id = 0; id < lattice.numChecks; id++) {
    const { x, y } = checkPosition(lattice, id);
    checkNodes.push(svgElement('circle', { class: 'check', cx: x, cy: y, r: NODE_RADIUS }, checkGroup));
    checkHits.push(svgElement('circle', { class: 'check-hit', 'data-check': id, cx: x, cy: y, r: CHECK_HIT_RADIUS }, checkGroup));
  }
  litChecks = new Uint8Array(lattice.numChecks);
}

// Marks a Break level's shielded qubits and draws its pre-placed errors.
function drawLocks(level) {
  for (const id of level.shielded) edgeNodes[id].classList.add('shielded');
  for (const id of level.fixed) edgeNodes[id].classList.add('fixed');
  if (level.fixed.length > 0) drawLayer('fixed', level.fixed, 0);
}

function popCheck(checkId) {
  const node = checkNodes[checkId];
  const ring = svgElement('circle', {
    class: 'pop',
    cx: node.getAttribute('cx'),
    cy: node.getAttribute('cy'),
    r: NODE_RADIUS,
  }, board);
  ring.addEventListener('animationend', () => ring.remove(), { once: true });
}

function currentBreakLevel() {
  return activeLevel?.campaign === 'break' ? BREAK_LEVELS[activeLevel.level - 1] : null;
}

function refreshBoard() {
  const { lattice, errors, correction, result } = round;
  const lit = syndrome(lattice, xorFlips(errors, correction));

  lit.forEach((bit, id) => {
    checkNodes[id].classList.toggle('lit', bit === 1);
    checkNodes[id].classList.toggle('selected', id === selectedCheck);
    checkHits[id].classList.toggle('lit', bit === 1);
    if (litChecks[id] && !bit) popCheck(id);
  });
  litChecks = lit;
  board.classList.toggle('selecting', selectedCheck !== null);

  edgeNodes.forEach((group, id) => {
    const corrected = correction[id] === 1;
    // After the reveal the layers draw these edges instead.
    group.classList.toggle('corrected', corrected && !result);
    group.setAttribute('aria-pressed', String(corrected));
  });

  const defectCount = lit.reduce((total, bit) => total + bit, 0);
  $('defect-count').textContent = defectCount;
  const breakLevel = currentBreakLevel();
  $('placed-count').textContent = breakLevel ? `${placedCount(round)} · par ${breakLevel.par}` : placedCount(round);

  $('undo').disabled = result !== null || round.history.length === 0;
  $('clear').disabled = result !== null || !correction.includes(1);
  $('hint').disabled = mode === 'break' || result !== null || defectCount === 0;
  $('submit').disabled = mode === 'break' ? !canRun(round) : !canSubmit(round);
  $('give-up').disabled = result !== null;
  $('next').disabled = result === null;
  $('next').textContent = nextLabel();
  if (tour) refreshTourCard();
}

function nextLabel() {
  if (!activeLevel) return 'Next round';
  const won = activeLevel.campaign === 'break' ? round.result?.broke : round.result?.playerWon;
  if (round.result && !won) return 'Try again';
  return activeLevel.level === CAMPAIGNS[activeLevel.campaign].count ? 'Back to levels' : 'Next level';
}

function setMode(newMode) {
  mode = newMode;
  const breaking = mode === 'break';
  document.body.classList.toggle('breaking', breaking);
  $('submit').textContent = breaking ? 'Run MWPM' : 'Submit';
  $('submit').title = breaking ? 'Run MWPM (Enter)' : 'Submit (Enter)';
  $('clear').title = breaking ? 'Remove all your errors' : 'Clear all your flips';
  $('errors-toggle-label').textContent = breaking ? 'Errors' : 'Hidden errors';
}

function setSeedDisplay() {
  const seed = $('seed');
  seed.textContent = round.seed;
  seed.href = `?seed=${round.seed}&preset=${round.presetKey}`;
}

function startRound(presetKey, seed) {
  setMode('decode');
  round = newRound(presetKey, seed);
  setSeedDisplay();
  drawBoard();
  clearRevealPanel();
  refreshBoard();
}

function showScreen(screen) {
  const inGame = screen === 'game';
  const breaking = mode === 'break';
  document.body.classList.toggle('touring', tour !== null);
  $('tour-card').hidden = tour === null;
  $('break-card').hidden = !inGame || tour !== null || !breaking;
  $('game-screen').hidden = !inGame;
  $('levels-screen').hidden = inGame;
  $('levels-button').hidden = !inGame || tour !== null;
  $('seed-field').hidden = !inGame || tour !== null || breaking;
  $('defects-field').hidden = !inGame;
  $('placed-field').hidden = !inGame || !breaking;
  $('preset-field').hidden = !inGame || tour !== null || activeLevel !== null;
  $('level-field').hidden = !inGame || activeLevel === null;
}

function fillParagraphs(container, paragraphs) {
  container.replaceChildren(...paragraphs.map((text) => {
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    return paragraph;
  }));
}

function tourSteps() {
  return TOURS[tour.kind].steps;
}

function startTour(kind) {
  activeLevel = null;
  tour = { kind, index: 0 };
  setMode(TOURS[kind].mode);
  showScreen('game');
  enterTourStep(0);
}

function endTour() {
  const { kind } = tour;
  tour = null;
  $('submit').hidden = false;
  markSeen(storage, TOURS[kind].flag);
  markSeen(storage, 'help');
  campaign = kind;
  showLevels();
}

function showTourPuzzle({ errors, visible }) {
  round = scriptedRound(TOUR_DISTANCE, errors);
  drawBoard();
  clearRevealPanel();
  if (visible && errors.length > 0) drawLayer('errors', errors, -LAYER_OFFSET);
}

function enterTourStep(index) {
  const step = tourSteps()[index];
  tour.index = index;
  if (step.puzzle) showTourPuzzle(step.puzzle);

  $('tour-count').textContent = `Step ${index + 1} of ${tourSteps().length}`;
  $('tour-title').textContent = step.title;
  fillParagraphs($('tour-body'), step.body);
  $('tour-next').textContent = index === tourSteps().length - 1 ? 'Go to levels' : 'Next';
  $('submit').hidden = !step.submit;
  edgeNodes.forEach((group, id) => group.classList.toggle('tour-target', tourTargets().includes(id)));
  refreshBoard();
}

function tourTargets() {
  return tourSteps()[tour.index].flip ?? [];
}

// A step's explanation waits until the player has done what it asked.
function refreshTourCard() {
  const step = tourSteps()[tour.index];
  const done = step.submit ? round.result !== null : tourTargets().every((id) => round.correction[id] === 1);
  $('tour-next').disabled = !done;
  fillParagraphs($('tour-why'), step.why ?? []);
  $('tour-why').hidden = !done || !step.why;
}

function advanceTour() {
  if (tour.index === tourSteps().length - 1) endTour();
  else enterTourStep(tour.index + 1);
}

function startFreePlay(presetKey, seed) {
  activeLevel = null;
  $('preset').value = presetKey;
  startRound(presetKey, seed);
  showScreen('game');
}

function playLevel(level, attempt, firstTry) {
  activeLevel = { campaign: 'decode', level, attempt, firstTry };
  const presetKey = levelPreset(level);
  $('level-label').textContent = `${level} of ${LEVEL_COUNT} (${PRESETS[presetKey].label})`;
  startRound(presetKey, levelSeed(level, attempt));
  showScreen('game');
}

function playBreakLevel(level) {
  const puzzle = BREAK_LEVELS[level - 1];
  activeLevel = { campaign: 'break', level };
  setMode('break');
  round = breakRound(level);
  drawBoard();
  drawLocks(puzzle);
  clearRevealPanel();

  $('level-label').textContent = `Break ${level} of ${BREAK_LEVEL_COUNT} (d = ${puzzle.d})`;
  $('break-level').textContent = `Level ${level} · distance ${puzzle.d}`;
  $('break-title').textContent = puzzle.title;
  $('break-goal').textContent = puzzle.goal;
  $('break-par').textContent = `Par: ${puzzle.par} ${puzzle.par === 1 ? 'error' : 'errors'}`;
  refreshBoard();
  showScreen('game');
}

// A replay counts as a first try, so it can still earn three stars.
function openLevel(level) {
  if (campaign === 'break') {
    playBreakLevel(level);
    return;
  }
  const levels = progress.decode;
  const firstTry = levelState(levels, level) === 'cleared' || levels.attempts === 0;
  playLevel(level, levelAttempt(levels, level), firstTry);
}

// Leaving a round in progress is unscored, the same as changing difficulty.
function showLevels() {
  activeLevel = null;
  setMode('decode');
  drawLevelMap();
  showScreen('levels');
}

function switchCampaign(name) {
  campaign = name;
  if (name === 'break' && !hasSeen(storage, TOURS.break.flag)) startTour('break');
  else showLevels();
}

function advance() {
  if (!activeLevel) {
    startRound(round.presetKey, nextSeed(round.seed));
    return;
  }
  const { level, attempt } = activeLevel;
  const won = activeLevel.campaign === 'break' ? round.result.broke : round.result.playerWon;
  if (!won) {
    if (activeLevel.campaign === 'break') playBreakLevel(level);
    else playLevel(level, attempt + 1, false);
  } else if (level === CAMPAIGNS[activeLevel.campaign].count) {
    showLevels();
  } else {
    openLevel(level + 1);
  }
}

function levelPosition(config, level) {
  let row = 0;
  let first = 1;
  for (const [tier, { size }] of config.tiers.entries()) {
    if (level < first + size) {
      const index = level - first;
      const rowInTier = row + Math.floor(index / config.columns);
      const column = index % config.columns;
      // Odd rows run right to left so the path winds down the screen.
      const x = rowInTier % 2 ? config.columns - 1 - column : column;
      return {
        x: MAP_MARGIN_X + x * MAP_STEP_X,
        y: MAP_TOP + rowInTier * MAP_STEP_Y + tier * MAP_TIER_GAP,
      };
    }
    row += size / config.columns;
    first += size;
  }
  throw new RangeError(`No level ${level}`);
}

function pathPoints(config, levelCount) {
  return Array.from({ length: levelCount }, (_, index) => {
    const { x, y } = levelPosition(config, index + 1);
    return `${x},${y}`;
  }).join(' ');
}

function drawBadge(group, state) {
  const badge = svgElement('g', { transform: `translate(${LEVEL_RADIUS - 6} ${LEVEL_RADIUS - 6})` }, group);
  svgElement('circle', { class: 'level-badge', r: 10 }, badge);
  svgElement('path', {
    class: 'level-icon',
    d: state === 'cleared'
      ? 'M-4.5 0 L-1.5 3.5 L4.5 -3.5'
      : 'M-4 -0.5 H4 V5 H-4 Z M-2.5 -0.5 V-2.5 A2.5 2.5 0 0 1 2.5 -2.5 V-0.5',
  }, badge);
}

function starPoints(cx, cy) {
  return Array.from({ length: 10 }, (_, i) => {
    const radius = i % 2 ? STAR_RADIUS * 0.45 : STAR_RADIUS;
    const angle = (Math.PI / 5) * i - Math.PI / 2;
    return `${(cx + radius * Math.cos(angle)).toFixed(2)},${(cy + radius * Math.sin(angle)).toFixed(2)}`;
  }).join(' ');
}

function drawStars(group, earned) {
  for (let i = 0; i < MAX_STARS; i++) {
    svgElement('polygon', {
      class: `level-star${i < earned ? ' earned' : ''}`,
      points: starPoints((i - 1) * 15, LEVEL_RADIUS + 12),
    }, group);
  }
}

function drawLevelNode(map, config, levels, level) {
  const state = levelState(levels, level);
  const stars = levels.stars[level - 1];
  const { x, y } = levelPosition(config, level);
  const group = svgElement('g', {
    class: `level ${state}`,
    'data-level': level,
    transform: `translate(${x} ${y})`,
    role: 'button',
    'aria-label': `Level ${level}, ${config.describe(level)}, ${state}${state === 'cleared' ? `, ${stars} of ${MAX_STARS} stars` : ''}`,
  }, map);
  if (state === 'locked') group.setAttribute('aria-disabled', 'true');
  else group.setAttribute('tabindex', 0);

  svgElement('circle', { class: 'level-node', r: LEVEL_RADIUS }, group);
  svgElement('text', { class: 'level-number' }, group).textContent = level;
  if (state !== 'current') drawBadge(group, state);
  if (state === 'cleared') drawStars(group, stars);
}

function drawLevelMap() {
  const config = CAMPAIGNS[campaign];
  const levels = progress[campaign];
  const map = $('level-map');
  const width = 2 * MAP_MARGIN_X + (config.columns - 1) * MAP_STEP_X;
  const height = levelPosition(config, config.count).y + LEVEL_RADIUS + 24;

  map.replaceChildren();
  map.setAttribute('viewBox', `0 0 ${width} ${height}`);
  map.style.maxWidth = `${width}px`;
  svgElement('polyline', { class: 'map-path', points: pathPoints(config, config.count) }, map);
  svgElement('polyline', {
    class: 'map-path done',
    points: pathPoints(config, Math.min(levels.cleared + 1, config.count)),
  }, map);

  let firstLevel = 1;
  for (const { label, size } of config.tiers) {
    const text = svgElement('text', {
      class: 'tier-label',
      x: width / 2,
      y: levelPosition(config, firstLevel).y - LEVEL_RADIUS - 11,
    }, map);
    text.textContent = label.toUpperCase();
    firstLevel += size;
  }

  for (let level = 1; level <= config.count; level++) drawLevelNode(map, config, levels, level);

  for (const tab of document.querySelectorAll('[data-campaign]')) {
    tab.setAttribute('aria-selected', String(tab.dataset.campaign === campaign));
  }
  $('free-play').hidden = campaign !== 'decode';
  $('campaign-blurb').textContent = config.blurb;
  $('levels-progress').textContent = `${levels.cleared} of ${config.count} levels cleared`
    + ` · ${totalStars(levels)} of ${config.count * MAX_STARS} stars`;
}

function clearRevealPanel() {
  for (const id of ['banner', 'banner-detail', 'verdict', 'level-note', 'level-stars', 'layers']) $(id).hidden = true;
  $('weights').textContent = '–';
  for (const toggle of document.querySelectorAll('[data-layer]')) toggle.checked = true;
}

// Layers sit under the check nodes so the dots stay on top.
function drawLayer(name, edgeIds, offset) {
  const { lattice } = round;
  removeLayer(name);
  const group = svgElement('g', { class: `layer layer-${name}` }, board);
  board.insertBefore(group, checkGroup);
  for (const id of edgeIds) svgElement('line', lineAttributes(lattice, lattice.edges[id], offset), group);
  layers[name] = group;
  return group;
}

function removeLayer(name) {
  layers[name]?.remove();
  delete layers[name];
}

function flippedIds(flips) {
  return [...flips.keys()].filter((id) => flips[id]);
}

// Numbered coloured rings show which defects MWPM joined together.
function drawPairs(matches) {
  const { lattice } = round;
  matches.forEach((match, index) => {
    const color = PAIR_COLORS[index % PAIR_COLORS.length];
    for (const defect of match.defects) {
      const { x, y } = checkPosition(lattice, defect.id);
      svgElement('circle', { class: 'pair-ring', cx: x, cy: y, r: 17, stroke: color }, layers.mwpm);
      const label = svgElement('text', { class: 'pair-label', x: x + 17, y: y - 16, fill: color }, layers.mwpm);
      label.textContent = index + 1;
    }
  });
}

function finishReveal() {
  board.classList.add('revealed');
  for (const group of edgeNodes) group.removeAttribute('tabindex');
}

function drawReveal() {
  const { errors, correction, result } = round;

  // Offset so all three layers stay visible on an edge they share.
  drawLayer('chain', result.playerChain, 0);
  drawLayer('errors', flippedIds(errors), -LAYER_OFFSET);
  drawLayer('player', flippedIds(correction), 0);
  drawLayer('mwpm', flippedIds(result.mwpmCorrection), LAYER_OFFSET);
  drawPairs(result.mwpmMatches);
  finishReveal();
}

// In Break mode every error on the board, placed or pre-placed, is one layer.
function drawBreakReveal() {
  const { result } = round;
  removeLayer('fixed');
  drawLayer('chain', result.chain, 0);
  drawLayer('errors', flippedIds(result.board), -LAYER_OFFSET);
  drawLayer('mwpm', flippedIds(result.mwpmCorrection), LAYER_OFFSET);
  drawPairs(result.mwpmMatches);
  finishReveal();
}

function logicalLabel(isLogical) {
  return isLogical ? 'Logical error' : 'Logical safe';
}

function showBanner(text, tone) {
  const banner = $('banner');
  banner.hidden = false;
  banner.className = `banner ${tone}`;
  banner.textContent = text;
}

function showLines(detail, verdict) {
  $('banner-detail').textContent = detail;
  $('banner-detail').hidden = false;
  $('verdict').textContent = verdict;
  $('verdict').hidden = false;
}

function showResult() {
  const { result } = round;
  if (result.gaveUp) showBanner('Gave up', 'gave-up');
  else showBanner(logicalLabel(result.playerLogical), result.playerLogical ? 'logical' : 'safe');
  showLines(`MWPM: ${logicalLabel(result.mwpmLogical)}`, roundVerdict(result));

  $('layers').hidden = false;
  $('chain-toggle').hidden = result.playerChain.length === 0;
  $('weights').textContent = result.gaveUp
    ? `– vs ${result.mwpmWeight}`
    : `${result.playerWeight} vs ${result.mwpmWeight}`;
}

// The tour's board is an open d = 3 code, where par is 2.
function breakPar() {
  return currentBreakLevel()?.par ?? (TOUR_DISTANCE + 1) / 2;
}

function showBreakResult() {
  const { result } = round;
  const par = breakPar();
  if (result.broke) showBanner('MWPM broken!', 'safe');
  else showBanner('MWPM survived', 'logical');
  const used = `You used ${result.placed} ${result.placed === 1 ? 'error' : 'errors'}`;
  showLines(currentBreakLevel() ? `${used} · par ${par}` : used, breakVerdict(round, par));

  $('layers').hidden = false;
  $('chain-toggle').hidden = result.chain.length === 0;
}

function formatRate(wins) {
  return stats.rounds === 0 ? '–' : `${Math.round((wins / stats.rounds) * 100)}%`;
}

function showStats() {
  $('streak').textContent = stats.streak;
  $('best-streak').textContent = stats.bestStreak;
  $('player-rate').textContent = formatRate(stats.playerWins);
  $('mwpm-rate').textContent = formatRate(stats.mwpmWins);
  $('rounds').textContent = stats.rounds;
}

function levelNote(level, won, count, clearedBefore, clearedAfter) {
  if (!won) return activeLevel.campaign === 'break' ? 'Try again: the puzzle stays the same.' : 'Try again with a new puzzle.';
  if (clearedAfter === clearedBefore) return '';
  return level === count ? 'All levels cleared!' : `Level ${level + 1} unlocked!`;
}

function starAdvice(stars, par) {
  if (stars === MAX_STARS) return activeLevel.campaign === 'break' ? 'Right on par.' : 'Perfect round.';
  if (activeLevel.campaign === 'break') {
    return stars === 2 ? `One over par. Can you do it with ${par}?` : `Par is ${par}. Can you use fewer errors?`;
  }
  if (stars === 1) return 'Make your fix as short as MWPM\'s for 2 stars.';
  return 'Do that on your first try, without a hint, for 3 stars.';
}

function showStarsEarned(stars, par) {
  $('level-stars').hidden = stars === 0;
  $('level-stars-icons').textContent = '★'.repeat(stars) + '☆'.repeat(MAX_STARS - stars);
  $('level-stars-text').textContent = `${stars} of ${MAX_STARS} stars. ${starAdvice(stars, par)}`;
}

// Records a finished level in its campaign and shows the unlock and stars.
function recordLevel(won, stars, par) {
  const { campaign: name, level } = activeLevel;
  const { count, storageKey } = CAMPAIGNS[name];
  const clearedBefore = progress[name].cleared;
  progress[name] = recordStars(recordLevelResult(progress[name], level, won), level, stars);
  saveProgress(storage, progress[name], storageKey);

  const note = $('level-note');
  note.textContent = levelNote(level, won, count, clearedBefore, progress[name].cleared);
  note.hidden = note.textContent === '';
  showStarsEarned(stars, par);
}

// Drops the path in progress and any hint, which a new move makes stale.
function clearDrawing() {
  selectedCheck = null;
  removeLayer('preview');
  removeLayer('hint');
}

function finishRound(gaveUp) {
  if (round.result) return;
  if (mode === 'break') {
    if (gaveUp || !canRun(round)) return;
    clearDrawing();
    runDecoder(round);
    const puzzle = currentBreakLevel();
    if (puzzle && !tour) recordLevel(round.result.broke, breakStars(round.result, puzzle.par), puzzle.par);
    drawBreakReveal();
    showBreakResult();
    refreshBoard();
    return;
  }

  if (!gaveUp && !canSubmit(round)) return;
  clearDrawing();
  resolveRound(round, gaveUp);
  if (!tour) {
    stats = recordResult(stats, round.result);
    saveStats(storage, stats);
    if (activeLevel) {
      const stars = starsFor(round.result, { firstTry: activeLevel.firstTry, hinted: round.hintsUsed > 0 });
      recordLevel(round.result.playerWon, stars);
    }
  }
  drawReveal();
  showResult();
  showStats();
  refreshBoard();
}

function makeMove(edgeIds) {
  clearDrawing();
  applyMove(round, edgeIds);
  refreshBoard();
}

function undo() {
  if (round.result || round.history.length === 0) return;
  clearDrawing();
  undoMove(round);
  refreshBoard();
}

function clearAll() {
  clearDrawing();
  clearCorrection(round);
  refreshBoard();
}

function showHint() {
  clearDrawing();
  const path = takeHint(round);
  if (path) drawLayer('hint', path, 0);
  refreshBoard();
}

function cancelSelection() {
  if (selectedCheck === null) return;
  selectedCheck = null;
  removeLayer('preview');
  refreshBoard();
}

// The path from the selected defect to a dot or boundary, or null if the target
// cannot end one.
function pathTo(target) {
  if (selectedCheck === null || !target) return null;
  const { lattice } = round;
  const from = checkAt(lattice, selectedCheck);
  if ('boundary' in target.dataset) {
    return boundaryPath(lattice, from, target.dataset.boundary === 'left' ? LEFT : RIGHT);
  }
  const to = Number(target.dataset.check);
  return to === selectedCheck ? null : pairPath(lattice, from, checkAt(lattice, to));
}

function handleCheck(target) {
  const id = Number(target.dataset.check);
  if (selectedCheck === null) {
    if (!litChecks[id]) return;
    selectedCheck = id;
    refreshBoard();
  } else if (selectedCheck === id) {
    cancelSelection();
  } else {
    makeMove(pathTo(target));
  }
}

function handleBoardClick(event) {
  if (round.result) return;
  const target = event.target.closest('[data-edge], [data-check], [data-boundary]');
  if (!target) return;

  if ('edge' in target.dataset) {
    const edgeId = Number(target.dataset.edge);
    if (tour && !tourTargets().includes(edgeId)) return;
    makeMove([edgeId]);
  } else if (!tour) {
    if ('check' in target.dataset) handleCheck(target);
    else if (selectedCheck !== null) makeMove(pathTo(target));
  }
}

// Shows where a drawn path would go, in red if it crosses a locked qubit.
function previewPath(event) {
  const path = round?.result ? null : pathTo(event.target.closest('[data-check], [data-boundary]'));
  if (!path) {
    removeLayer('preview');
    return;
  }
  const group = drawLayer('preview', path, 0);
  group.classList.toggle('blocked', path.some((id) => round.locked.has(id)));
}

function handleLevel(event) {
  const node = event.target.closest('[data-level]');
  if (!node) return;
  const level = Number(node.dataset.level);
  if (levelState(progress[campaign], level) !== 'locked') openLevel(level);
}

function onActivate(element, handler) {
  element.addEventListener('click', handler);
  element.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    handler(event);
  });
}

function openHelp() {
  $('help').hidden = false;
  $('help-close').focus();
}

function closeHelp() {
  if ($('help').hidden) return;
  $('help').hidden = true;
  markSeen(storage, 'help');
  $('help-open').focus();
}

// Shortcuts work during a normal round, not in the tour, the help or a form field.
function handleShortcut(event) {
  if (event.key === 'Escape') {
    if (!$('help').hidden) closeHelp();
    else if (round) cancelSelection();
    return;
  }
  if (!$('help').hidden || tour || $('game-screen').hidden || event.altKey) return;
  if (event.target.closest('input:not([type="checkbox"]), select, textarea')) return;

  const key = event.key.toLowerCase();
  const command = event.ctrlKey || event.metaKey;
  if (key === 'z' && !event.shiftKey) {
    event.preventDefault();
    undo();
  } else if (command) {
    return;
  } else if (key === 'h') {
    if (!$('hint').disabled) showHint();
  } else if (key === 'n') {
    if (!$('next').disabled) advance();
  } else if (key === 'enter' && !event.target.closest('button, [role="button"], a')) {
    finishRound(false);
  }
}

function bindEvents() {
  onActivate(board, handleBoardClick);
  board.addEventListener('pointerover', previewPath);
  board.addEventListener('pointerleave', () => removeLayer('preview'));
  onActivate($('level-map'), handleLevel);

  $('undo').addEventListener('click', undo);
  $('clear').addEventListener('click', clearAll);
  $('hint').addEventListener('click', showHint);
  $('submit').addEventListener('click', () => finishRound(false));
  $('give-up').addEventListener('click', () => finishRound(true));
  $('next').addEventListener('click', advance);
  $('levels-button').addEventListener('click', showLevels);
  $('free-play').addEventListener('click', () => startFreePlay($('preset').value, randomSeed()));
  for (const tab of document.querySelectorAll('[data-campaign]')) {
    tab.addEventListener('click', () => switchCampaign(tab.dataset.campaign));
  }

  // Dropping a round in progress is deliberately unscored.
  $('preset').addEventListener('change', (event) => startRound(event.target.value, nextSeed(round.seed)));

  $('layers').addEventListener('change', (event) => {
    const group = layers[event.target.dataset.layer];
    if (group) group.toggleAttribute('hidden', !event.target.checked);
  });

  $('tour-next').addEventListener('click', advanceTour);
  $('tour-skip').addEventListener('click', endTour);

  $('help-open').addEventListener('click', openHelp);
  $('help-close').addEventListener('click', closeHelp);
  $('help-tour').addEventListener('click', () => {
    closeHelp();
    startTour('decode');
  });
  $('help-break-tour').addEventListener('click', () => {
    closeHelp();
    startTour('break');
  });
  $('help').addEventListener('click', (event) => {
    if (event.target === $('help')) closeHelp();
  });
  document.addEventListener('keydown', handleShortcut);
}

function fillPresets() {
  for (const [key, { label, d, p }] of Object.entries(PRESETS)) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = `${label} (d = ${d}, p = ${p})`;
    $('preset').appendChild(option);
  }
}

function init() {
  const params = new URLSearchParams(location.search);
  const seed = parseSeed(params.get('seed'));
  const presetParam = params.get('preset');
  const hasPreset = Object.hasOwn(PRESETS, presetParam);

  fillPresets();
  bindEvents();
  showStats();
  if (seed !== null || hasPreset) {
    // A shared link goes straight to its round, so only the short help shows.
    startFreePlay(hasPreset ? presetParam : DEFAULT_PRESET, seed ?? randomSeed());
    if (!hasSeen(storage, 'help')) openHelp();
  } else if (hasSeen(storage, TOURS.decode.flag)) {
    showLevels();
  } else {
    startTour('decode');
  }
}

init();
