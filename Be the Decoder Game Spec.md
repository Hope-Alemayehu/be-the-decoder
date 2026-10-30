# Be the Decoder: Game Spec

Oct 30, 2026 · @Hope

## Overview

Be the Decoder is a browser game where the player acts as a quantum error correction decoder on a surface code, then gets compared against a minimum-weight perfect matching (MWPM) decoder solving the same round.

The goal for the first version is a small, complete, playable loop: generate hidden errors, show syndromes, let the player place corrections, reveal the truth, score the round. No backend, no accounts, no build step.

The decoder is written from scratch as a bitmask DP, not imported from a library. That is part of the point of the project.

## Game rules and round flow

Each round is one decoding problem. The player wins the round if their correction does not cause a logical error.

1. **Generate.** Flip each data qubit independently with probability p. If the resulting syndrome is empty, resample. The errors stay hidden.
2. **Show.** Draw the lattice with lit check nodes (defects) only.
3. **Play.** The player clicks data qubits (edges) to toggle corrections. Defects update live, based on error XOR correction.
4. **Submit.** The Submit button is enabled only when no defects remain lit. A "Give up" button skips straight to the reveal.
5. **Reveal.** Show the hidden errors, the player's correction and the MWPM correction as separate toggleable layers. Show whether the player caused a logical error, and whether MWPM did.
6. **Score.** Update the streak and stats, then offer "Next round".

Difficulty presets:

| Preset | Distance d | Error probability p |
| --- | --- | --- |
| Easy | 3 | 0.05 |
| Medium | 5 | 0.07 |
| Hard | 7 | 0.09 |

Scoring per round: win or lose, plus the player's correction weight (number of edges flipped) compared with MWPM's. Track rounds played, player win rate, MWPM win rate on the same rounds, current streak and best streak. Persist stats in localStorage, wrapped in try/catch so the game still works if storage is blocked.

## Surface code model

The game uses an unrotated planar surface code, bit-flip (X) errors only, with perfect syndrome measurement. Internally it is just the matching graph: check nodes are vertices, data qubits are edges.

**Lattice for distance d**

- Check nodes: d rows by (d - 1) columns, indexed (r, c) with r in 0..d-1 and c in 0..d-2.
- Horizontal edges: in each row, one edge from the left boundary to (r, 0), edges between (r, c) and (r, c+1), and one edge from (r, d-2) to the right boundary. That is d horizontal edges per row.
- Vertical edges: between (r, c) and (r+1, c) for every column.
- Total data qubits: d² + (d - 1)², which is 41 for d = 5.
- The left and right boundaries are virtual nodes, drawn as boundary lines, not as clickable checks.

Layout for d = 3 (o = check node, | and - = data qubits, L / R = boundaries):

```
L - o - o - R
    |   |
L - o - o - R
    |   |
L - o - o - R
```

**Syndrome.** A check node is lit when an odd number of its incident edges are flipped in (error XOR correction). Boundary nodes have no syndrome.

**Logical failure.** Once all defects are cleared, the residual (error XOR correction) is a set of cycles and boundary-to-boundary chains. The round is a logical error if the number of residual edges among the d leftmost horizontal edges (the ones touching the left boundary) is odd.

**Randomness.** Use a small seeded PRNG (for example mulberry32). Read the seed from a ?seed= URL parameter when present, otherwise pick one and show it on screen, so any round can be replayed.

## Decoder: bitmask DP matching

The MWPM decoder is exact min-weight matching over the defects, where each defect is either paired with another defect or matched to the nearest boundary.

**Distances**

- Defect to defect: Manhattan distance on the grid, |r1 - r2| + |c1 - c2|.
- Defect to boundary: min(c + 1, d - 1 - c), going to the left or right boundary, whichever is closer.

**DP over subsets**, with k defects indexed 0..k-1:

```latex
dp[\emptyset] = 0, \quad dp[S] = \min\Big( dp[S \setminus \{i\}] + w_{\partial}(i),\ \min_{j \in S,\, j \neq i} dp[S \setminus \{i, j\}] + w(i, j) \Big)
```

where i is the lowest-indexed defect in S. Complexity is O(2^k · k). Store the choice at each mask so the matching can be reconstructed.

**Turning the matching into a correction**

- Pair (i, j): flip an L-shaped path of edges, horizontal first, then vertical.
- Boundary match: flip the straight horizontal path from the defect to the chosen boundary.
- XOR all paths together. Ties between equal-weight matchings can be broken arbitrarily.

**Limit.** If a round has more than 20 defects, resample it. With the presets above this should be rare.

Keep the decoder as pure functions with no DOM access, so it can be tested in Node.

## UI and visuals

The lattice is the centerpiece and should feel good to click. Render it as SVG so each edge is its own clickable element.

**Board**

- Check nodes: small circles. Lit defects glow (pulsing animation), unlit ones are dim.
- Data qubits: lines between nodes, with a wide invisible hit area so they are easy to click. Hover thickens the line.
- Player corrections: a solid highlight color on the edge.
- Boundaries: two vertical bars on the left and right labeled as boundaries.
- When a click clears a defect, a short satisfying animation (a pop or fade).

**Reveal layers**, each with a toggle:

- Hidden errors: red.
- Player correction: blue.
- MWPM correction: green, dashed.
- Optional: highlight the residual logical chain when one exists, so the player sees why they lost.

**Panels around the board**

- Top: difficulty selector, seed display, live defect count.
- Bottom: Submit, Give up, Next round.
- Side: result banner after reveal ("Logical safe" or "Logical error"), weight comparison (you vs MWPM), streak, best streak, overall win rates.
- A short "How to play" overlay on first visit, three or four sentences.

**Style:** dark background, clean and minimal, one accent color per layer. Works on a laptop screen first; mobile is nice to have.

## Tech constraints and file structure

Plain HTML, CSS and vanilla JavaScript (ES modules). No framework, no bundler, no npm dependencies for the game itself. It must run by opening index.html through a simple static server and deploy as-is to Vercel or GitHub Pages.

```
be-the-decoder/
  index.html        page shell and panels
  style.css         visuals and animations
  src/
    rng.js          seeded PRNG
    lattice.js      lattice construction, syndrome, logical check
    decoder.js      bitmask DP matching and path reconstruction
    game.js         round state and scoring
    ui.js           SVG rendering and click handling
  tests/
    decoder.test.js run with: node tests/decoder.test.js
  README.md         what it is, how to play, how to run
```

lattice.js and decoder.js must not touch the DOM. Tests use only Node built-ins (node:assert).

## Acceptance checks

The version is done when all of these pass.

**Automated (tests/decoder.test.js)**

- [ ] Decoder matches brute force: on 1,000 random small cases (k up to 8 defects), the DP cost equals the cost from trying every matching.
- [ ] Decoder correction is valid: on 1,000 random rounds, applying the MWPM correction clears every defect.
- [ ] Logical check sanity: a single full row of horizontal edges is a logical error; any closed loop of 4 edges is not; a defect matched to its own boundary is not.
- [ ] Threshold behavior: at p = 0.05 over 10,000 rounds each, the MWPM logical error rate decreases as d goes 3, 5, 7.
- [ ] Same seed gives the same round.

**Manual (in the browser)**

- [ ] Clicking an edge toggles it and updates defects instantly.
- [ ] Submit stays disabled while defects are lit.
- [ ] Reveal layers toggle independently and the result banner is correct.
- [ ] Stats survive a page reload, and the game still works in a private window.
- [ ] Opening with ?seed=123 twice shows the same round.

## Out of scope for this version

Do not build these yet; keep the code simple enough that they can be added later.

- Real-time mode: a timer, with new errors arriving while the player decodes.
- Measurement errors and multiple syndrome rounds (the 3D matching graph).
- Phase-flip (Z) and Y errors, or both check types at once.
- Rotated surface code layout.
- Sound effects and music.
- Leaderboards, accounts or any backend.
- Comparison against other decoders (union-find, a neural decoder).
