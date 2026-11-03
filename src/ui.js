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
  hasSeenHelp,
  hasSeenTour,
  levelAttempt,
  levelPreset,
  levelSeed,
  levelState,
  loadProgress,
  loadStats,
  markHelpSeen,
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
  totalStars,
  undoMove,
} from './game.js';
import { TOUR_DISTANCE, TOUR_STEPS } from './tour.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SPACING = 90;
const MARGIN_X = 60;
const MARGIN_Y = 44;
const NODE_RADIUS = 10;
const CHECK_HIT_RADIUS = 20;
const LAYER_OFFSET = 6;
const PAIR_COLORS = ['#7dd3fc', '#f9a8d4', '#fdba74', '#c4b5fd', '#bef264', '#5eead4'];

const MAP_COLUMNS = 5;
const MAP_STEP_X = 92;
const MAP_STEP_Y = 82;
const MAP_TIER_GAP = 42;
const MAP_MARGIN_X = 54;
const MAP_TOP = 64;
const LEVEL_RADIUS = 27;
const STAR_RADIUS = 6.5;

const $ = (id) => document.getElementById(id);

const board = $('board');
const storage = browserStorage();

let round = null;
let stats = loadStats(storage);
let progress = loadProgress(storage);
let activeLevel = null; // { level, attempt, firstTry } while playing a level, null in Free play
let tourIndex = null; // index into TOUR_STEPS during the tour, otherwise null
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
    const group = svgElement('g', {
      class: 'edge',
      'data-edge': edge.id,
      role: 'button',
      tabindex: 0,
      'aria-label': edgeLabel(edge),
      'aria-pressed': 'false',
    }, edgeGroup);
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
    // After the reveal the player layer draws these edges instead.
    group.classList.toggle('corrected', corrected && !result);
    group.setAttribute('aria-pressed', String(corrected));
  });

  const defectCount = lit.reduce((total, bit) => total + bit, 0);
  $('defect-count').textContent = defectCount;
  $('undo').disabled = result !== null || round.history.length === 0;
  $('clear').disabled = result !== null || !correction.includes(1);
  $('hint').disabled = result !== null || defectCount === 0;
  $('submit').disabled = !canSubmit(round);
  $('give-up').disabled = result !== null;
  $('next').disabled = result === null;
  $('next').textContent = nextLabel();
  if (tourIndex !== null) refreshTourCard();
}

function nextLabel() {
  if (!activeLevel) return 'Next round';
  if (round.result && !round.result.playerWon) return 'Try again';
  return activeLevel.level === LEVEL_COUNT ? 'Back to levels' : 'Next level';
}

function setSeedDisplay() {
  const seed = $('seed');
  seed.textContent = round.seed;
  seed.href = `?seed=${round.seed}&preset=${round.presetKey}`;
}

function startRound(presetKey, seed) {
  round = newRound(presetKey, seed);
  setSeedDisplay();
  drawBoard();
  clearRevealPanel();
  refreshBoard();
}

function showScreen(screen) {
  const inGame = screen === 'game';
  const touring = tourIndex !== null;
  document.body.classList.toggle('touring', touring);
  $('tour-card').hidden = !touring;
  $('game-screen').hidden = !inGame;
  $('levels-screen').hidden = inGame;
  $('levels-button').hidden = !inGame || touring;
  $('seed-field').hidden = !inGame || touring;
  $('defects-field').hidden = !inGame;
  $('preset-field').hidden = !inGame || touring || activeLevel !== null;
  $('level-field').hidden = !inGame || activeLevel === null;
}

function fillParagraphs(container, paragraphs) {
  container.replaceChildren(...paragraphs.map((text) => {
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    return paragraph;
  }));
}

function startTour() {
  activeLevel = null;
  tourIndex = 0;
  showScreen('game');
  enterTourStep(0);
}

function endTour() {
  tourIndex = null;
  $('submit').hidden = false;
  markTourSeen(storage);
  markHelpSeen(storage);
  showLevels();
}

function showTourPuzzle({ errors, visible }) {
  round = scriptedRound(TOUR_DISTANCE, errors);
  drawBoard();
  clearRevealPanel();
  if (visible) drawLayer('errors', errors, -LAYER_OFFSET);
}

function enterTourStep(index) {
  const step = TOUR_STEPS[index];
  tourIndex = index;
  if (step.puzzle) showTourPuzzle(step.puzzle);

  $('tour-count').textContent = `Step ${index + 1} of ${TOUR_STEPS.length}`;
  $('tour-title').textContent = step.title;
  fillParagraphs($('tour-body'), step.body);
  $('tour-next').textContent = index === TOUR_STEPS.length - 1 ? 'Go to levels' : 'Next';
  $('submit').hidden = !step.submit;
  edgeNodes.forEach((group, id) => group.classList.toggle('tour-target', tourTargets().includes(id)));
  refreshBoard();
}

function tourTargets() {
  return TOUR_STEPS[tourIndex].flip ?? [];
}

// A step's explanation waits until the player has done what it asked.
function refreshTourCard() {
  const step = TOUR_STEPS[tourIndex];
  const done = step.submit ? round.result !== null : tourTargets().every((id) => round.correction[id] === 1);
  $('tour-next').disabled = !done;
  fillParagraphs($('tour-why'), step.why ?? []);
  $('tour-why').hidden = !done || !step.why;
}

function advanceTour() {
  if (tourIndex === TOUR_STEPS.length - 1) endTour();
  else enterTourStep(tourIndex + 1);
}

function startFreePlay(presetKey, seed) {
  activeLevel = null;
  $('preset').value = presetKey;
  startRound(presetKey, seed);
  showScreen('game');
}

function playLevel(level, attempt, firstTry) {
  activeLevel = { level, attempt, firstTry };
  const presetKey = levelPreset(level);
  $('level-label').textContent = `${level} of ${LEVEL_COUNT} (${PRESETS[presetKey].label})`;
  startRound(presetKey, levelSeed(level, attempt));
  showScreen('game');
}

// A replay counts as a first try, so it can still earn three stars.
function openLevel(level) {
  const firstTry = levelState(progress, level) === 'cleared' || progress.attempts === 0;
  playLevel(level, levelAttempt(progress, level), firstTry);
}

// Leaving a round in progress is unscored, the same as changing difficulty.
function showLevels() {
  activeLevel = null;
  drawLevelMap();
  showScreen('levels');
}

function advance() {
  if (!activeLevel) {
    startRound(round.presetKey, nextSeed(round.seed));
    return;
  }
  const { level, attempt } = activeLevel;
  if (!round.result.playerWon) playLevel(level, attempt + 1, false);
  else if (level === LEVEL_COUNT) showLevels();
  else openLevel(level + 1);
}

function levelPosition(level) {
  const index = level - 1;
  const row = Math.floor(index / MAP_COLUMNS);
  const column = index % MAP_COLUMNS;
  const tier = Math.floor(index / LEVELS_PER_TIER);
  // Odd rows run right to left so the path winds down the screen.
  const x = row % 2 ? MAP_COLUMNS - 1 - column : column;
  return { x: MAP_MARGIN_X + x * MAP_STEP_X, y: MAP_TOP + row * MAP_STEP_Y + tier * MAP_TIER_GAP };
}

function pathPoints(levelCount) {
  return Array.from({ length: levelCount }, (_, index) => {
    const { x, y } = levelPosition(index + 1);
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

function drawLevelNode(map, level) {
  const state = levelState(progress, level);
  const stars = progress.stars[level - 1];
  const { x, y } = levelPosition(level);
  const label = PRESETS[levelPreset(level)].label;
  const group = svgElement('g', {
    class: `level ${state}`,
    'data-level': level,
    transform: `translate(${x} ${y})`,
    role: 'button',
    'aria-label': `Level ${level}, ${label}, ${state}${state === 'cleared' ? `, ${stars} of ${MAX_STARS} stars` : ''}`,
  }, map);
  if (state === 'locked') group.setAttribute('aria-disabled', 'true');
  else group.setAttribute('tabindex', 0);

  svgElement('circle', { class: 'level-node', r: LEVEL_RADIUS }, group);
  svgElement('text', { class: 'level-number' }, group).textContent = level;
  if (state !== 'current') drawBadge(group, state);
  if (state === 'cleared') drawStars(group, stars);
}

function drawLevelMap() {
  const map = $('level-map');
  const width = 2 * MAP_MARGIN_X + (MAP_COLUMNS - 1) * MAP_STEP_X;
  const height = levelPosition(LEVEL_COUNT).y + LEVEL_RADIUS + 24;

  map.replaceChildren();
  map.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svgElement('polyline', { class: 'map-path', points: pathPoints(LEVEL_COUNT) }, map);
  svgElement('polyline', {
    class: 'map-path done',
    points: pathPoints(Math.min(progress.cleared + 1, LEVEL_COUNT)),
  }, map);

  LEVEL_TIERS.forEach((presetKey, tier) => {
    const firstLevel = tier * LEVELS_PER_TIER + 1;
    const label = svgElement('text', {
      class: 'tier-label',
      x: width / 2,
      y: levelPosition(firstLevel).y - LEVEL_RADIUS - 11,
    }, map);
    label.textContent = PRESETS[presetKey].label.toUpperCase();
  });

  for (let level = 1; level <= LEVEL_COUNT; level++) drawLevelNode(map, level);

  $('levels-progress').textContent = `${progress.cleared} of ${LEVEL_COUNT} levels cleared`
    + ` · ${totalStars(progress)} of ${LEVEL_COUNT * MAX_STARS} stars`;
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

function drawReveal() {
  const { errors, correction, result } = round;

  // Offset so all three layers stay visible on an edge they share.
  drawLayer('chain', result.playerChain, 0);
  drawLayer('errors', flippedIds(errors), -LAYER_OFFSET);
  drawLayer('player', flippedIds(correction), 0);
  drawLayer('mwpm', flippedIds(result.mwpmCorrection), LAYER_OFFSET);
  drawPairs(result.mwpmMatches);

  board.classList.add('revealed');
  for (const group of edgeNodes) group.removeAttribute('tabindex');
}

function logicalLabel(isLogical) {
  return isLogical ? 'Logical error' : 'Logical safe';
}

function showResult() {
  const { result } = round;
  const banner = $('banner');
  banner.hidden = false;
  if (result.gaveUp) {
    banner.className = 'banner gave-up';
    banner.textContent = 'Gave up';
  } else {
    banner.className = `banner ${result.playerLogical ? 'logical' : 'safe'}`;
    banner.textContent = logicalLabel(result.playerLogical);
  }

  const detail = $('banner-detail');
  detail.hidden = false;
  detail.textContent = `MWPM: ${logicalLabel(result.mwpmLogical)}`;

  $('verdict').textContent = roundVerdict(result);
  $('verdict').hidden = false;

  $('layers').hidden = false;
  $('chain-toggle').hidden = result.playerChain.length === 0;
  $('weights').textContent = result.gaveUp
    ? `– vs ${result.mwpmWeight}`
    : `${result.playerWeight} vs ${result.mwpmWeight}`;
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

function levelNote(level, clearedBefore) {
  if (!round.result.playerWon) return 'Try again with a new puzzle.';
  if (progress.cleared === clearedBefore) return '';
  return level === LEVEL_COUNT ? 'All levels cleared!' : `Level ${level + 1} unlocked!`;
}

function starAdvice(stars) {
  if (stars === MAX_STARS) return 'Perfect round.';
  if (stars === 1) return 'Make your fix as short as MWPM\'s for 2 stars.';
  return 'Do that on your first try, without a hint, for 3 stars.';
}

function showStarsEarned(stars) {
  $('level-stars').hidden = stars === 0;
  $('level-stars-icons').textContent = '★'.repeat(stars) + '☆'.repeat(MAX_STARS - stars);
  $('level-stars-text').textContent = `${stars} of ${MAX_STARS} stars. ${starAdvice(stars)}`;
}

function updateLevelProgress() {
  if (!activeLevel) return;
  const { level, firstTry } = activeLevel;
  const { result } = round;
  const stars = starsFor(result, { firstTry, hinted: round.hintsUsed > 0 });
  const clearedBefore = progress.cleared;
  progress = recordStars(recordLevelResult(progress, level, result.playerWon), level, stars);
  saveProgress(storage, progress);

  const note = $('level-note');
  note.textContent = levelNote(level, clearedBefore);
  note.hidden = note.textContent === '';
  showStarsEarned(stars);
}

// Drops the path in progress and any hint, which a new move makes stale.
function clearDrawing() {
  selectedCheck = null;
  removeLayer('preview');
  removeLayer('hint');
}

function finishRound(gaveUp) {
  if (round.result || (!gaveUp && !canSubmit(round))) return;
  clearDrawing();
  resolveRound(round, gaveUp);
  if (tourIndex === null) {
    stats = recordResult(stats, round.result);
    saveStats(storage, stats);
    updateLevelProgress();
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
    if (tourIndex !== null && !tourTargets().includes(edgeId)) return;
    makeMove([edgeId]);
  } else if (tourIndex === null) {
    if ('check' in target.dataset) handleCheck(target);
    else if (selectedCheck !== null) makeMove(pathTo(target));
  }
}

function previewPath(event) {
  const path = round.result ? null : pathTo(event.target.closest('[data-check], [data-boundary]'));
  if (path) drawLayer('preview', path, 0);
  else removeLayer('preview');
}

function handleLevel(event) {
  const node = event.target.closest('[data-level]');
  if (!node) return;
  const level = Number(node.dataset.level);
  if (levelState(progress, level) !== 'locked') openLevel(level);
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
  markHelpSeen(storage);
  $('help-open').focus();
}

// Shortcuts work during a normal round, not in the tour, the help or a form field.
function handleShortcut(event) {
  if (event.key === 'Escape') {
    if (!$('help').hidden) closeHelp();
    else if (round) cancelSelection();
    return;
  }
  if (!$('help').hidden || tourIndex !== null || $('game-screen').hidden || event.altKey) return;
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
    startTour();
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
    if (!hasSeenHelp(storage)) openHelp();
  } else if (hasSeenTour(storage)) {
    showLevels();
  } else {
    startTour();
  }
}

init();
