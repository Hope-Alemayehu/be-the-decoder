// SVG rendering and click handling.

import { nextSeed, parseSeed, randomSeed } from './rng.js';
import { LEFT, RIGHT, syndrome, xorFlips } from './lattice.js';
import {
  DEFAULT_PRESET,
  PRESETS,
  browserStorage,
  canSubmit,
  hasSeenHelp,
  liveDefects,
  loadStats,
  markHelpSeen,
  newRound,
  recordResult,
  resolveRound,
  saveStats,
  toggleCorrection,
} from './game.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SPACING = 90;
const MARGIN_X = 60;
const MARGIN_Y = 44;
const NODE_RADIUS = 10;
const LAYER_OFFSET = 6;

const $ = (id) => document.getElementById(id);

const board = $('board');
const storage = browserStorage();

let round = null;
let stats = loadStats(storage);
let checkGroup = null;
let checkNodes = [];
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

  const barTop = MARGIN_Y - 26;
  const barBottom = height - MARGIN_Y + 26;
  for (const [x, labelX, angle, text] of [
    [MARGIN_X, MARGIN_X - 22, -90, 'LEFT BOUNDARY'],
    [width - MARGIN_X, width - MARGIN_X + 22, 90, 'RIGHT BOUNDARY'],
  ]) {
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

  layers = {};

  checkGroup = svgElement('g', {}, board);
  checkNodes = Array.from({ length: lattice.numChecks }, (_, id) => {
    const { x, y } = checkPosition(lattice, id);
    return svgElement('circle', { class: 'check', cx: x, cy: y, r: NODE_RADIUS }, checkGroup);
  });
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
    if (litChecks[id] && !bit) popCheck(id);
  });
  litChecks = lit;

  edgeNodes.forEach((group, id) => {
    const corrected = correction[id] === 1;
    // After the reveal the player layer draws these edges instead.
    group.classList.toggle('corrected', corrected && !result);
    group.setAttribute('aria-pressed', String(corrected));
  });

  $('defect-count').textContent = liveDefects(round).length;
  $('submit').disabled = !canSubmit(round);
  $('give-up').disabled = result !== null;
  $('next').disabled = result === null;
}

function setSeedDisplay() {
  const seed = $('seed');
  seed.textContent = round.seed;
  seed.href = `?seed=${round.seed}&preset=${round.presetKey}`;
}

function startRound(presetKey, seed) {
  round = newRound(presetKey, seed);
  $('preset').value = presetKey;
  setSeedDisplay();
  drawBoard();
  clearRevealPanel();
  refreshBoard();
}

function clearRevealPanel() {
  $('banner').hidden = true;
  $('banner-detail').hidden = true;
  $('layers').hidden = true;
  $('weights').textContent = '–';
  for (const toggle of document.querySelectorAll('[data-layer]')) toggle.checked = true;
}

function drawLayer(name, edgeIds, offset) {
  const { lattice } = round;
  const group = svgElement('g', { class: `layer layer-${name}` }, board);
  for (const id of edgeIds) svgElement('line', lineAttributes(lattice, lattice.edges[id], offset), group);
  layers[name] = group;
}

function flippedIds(flips) {
  return [...flips.keys()].filter((id) => flips[id]);
}

function drawReveal() {
  const { errors, correction, result } = round;

  // Offset so all three layers stay visible on an edge they share.
  drawLayer('chain', result.playerChain, 0);
  drawLayer('errors', flippedIds(errors), -LAYER_OFFSET);
  drawLayer('player', flippedIds(correction), 0);
  drawLayer('mwpm', flippedIds(result.mwpmCorrection), LAYER_OFFSET);

  board.appendChild(checkGroup);
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

function finishRound(gaveUp) {
  resolveRound(round, gaveUp);
  stats = recordResult(stats, round.result);
  saveStats(storage, stats);
  drawReveal();
  showResult();
  showStats();
  refreshBoard();
}

function edgeFromEvent(event) {
  return event.target.closest?.('[data-edge]') ?? null;
}

function handleEdge(group) {
  if (!group || round.result) return;
  toggleCorrection(round, Number(group.dataset.edge));
  refreshBoard();
}

function bindEvents() {
  board.addEventListener('click', (event) => handleEdge(edgeFromEvent(event)));
  board.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    handleEdge(edgeFromEvent(event));
  });

  $('submit').addEventListener('click', () => finishRound(false));
  $('give-up').addEventListener('click', () => finishRound(true));
  $('next').addEventListener('click', () => startRound(round.presetKey, nextSeed(round.seed)));

  // Dropping a round in progress is deliberately unscored.
  $('preset').addEventListener('change', (event) => startRound(event.target.value, nextSeed(round.seed)));

  $('layers').addEventListener('change', (event) => {
    const group = layers[event.target.dataset.layer];
    if (group) group.toggleAttribute('hidden', !event.target.checked);
  });

  $('help-close').addEventListener('click', () => {
    $('help').hidden = true;
    markHelpSeen(storage);
  });
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
  const seed = parseSeed(params.get('seed')) ?? randomSeed();
  const presetParam = params.get('preset');
  const preset = Object.hasOwn(PRESETS, presetParam) ? presetParam : DEFAULT_PRESET;

  fillPresets();
  bindEvents();
  showStats();
  startRound(preset, seed);
  $('help').hidden = hasSeenHelp(storage);
}

init();
