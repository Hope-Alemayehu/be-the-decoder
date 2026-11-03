# Be the Decoder

A browser game where you act as a quantum error correction decoder. Hidden bit-flip errors hit a surface code, you see only the syndrome, and you try to correct it without causing a logical error. Each round you are compared with a minimum-weight perfect matching (MWPM) decoder solving the same problem.

The game uses an unrotated planar surface code with bit-flip (X) errors only and perfect syndrome measurement. The decoder is written from scratch as a bitmask DP in [src/decoder.js](src/decoder.js), and no decoding library is used.

## How to play

1. Glowing nodes are defects: check nodes at the ends of error chains. The errors themselves stay hidden.
2. Click edges (data qubits) to flip them. Defects update as you click. Join defects to each other, or to the left or right boundary, until none are lit.
3. Press **Submit** once the board is clear, or **Give up** to skip to the reveal. Giving up counts as a loss.
4. The reveal shows the hidden errors, your correction and the MWPM correction as separate layers you can toggle. Numbered coloured rings show which defects MWPM paired together, and a line under the result says whether a loss was bad luck (MWPM lost too) or a mistake (MWPM found a safe fix).

You win if what is left after your correction (errors XOR correction) does not join the left boundary to the right boundary. A chain that does is a logical error. Clearing every defect is not enough: you can have a clean board and still lose.

The **How to play** button at the top of the page shows these rules at any time.

| Preset | Distance d | Error probability p |
| --- | --- | --- |
| Easy | 3 | 0.05 |
| Medium | 5 | 0.07 |
| Hard | 7 | 0.09 |

### Controls

- **Draw a path:** click a defect, then another dot or a boundary bar, and the whole path between them flips at once. A faint preview shows the path first. Clicking single edges still works.
- **Undo** takes back your last move, including a whole drawn path. **Clear** removes all your flips, and can itself be undone.
- **Hint** shows one path MWPM would draw for the board as it stands. In a level, using it costs the third star.
- **Shortcuts:** Z or Ctrl+Z to undo, H for a hint, Enter to submit, N for the next round, Esc to cancel a path.

### Guided tour

Your first visit starts a 10-step tour. You make each move yourself on a small board, and each step explains why the game reacted the way it did. It covers defects, boundaries, chains, loops, and why a clean board can still be a logical error. You can skip it, and you can take it again from **How to play**. The tour does not count towards your stats or level progress.

### Levels

The game opens on a path of 30 levels: 1–10 are Easy, 11–20 Medium and 21–30 Hard. Beat a level to unlock the next one. If you lose or give up, you try again with a new puzzle, because the reveal has already shown you the answer to the last one. Cleared levels can be replayed at any time.

Each level's first puzzle is the same for everyone, and MWPM beats all of them. Within each tier the levels are ordered so the number of defects never drops. Retries are random, so on a retry even the best play can sometimes lose. Replaying a cleared level gives you a new puzzle, because you have already seen the answer to the old one.

Each level awards up to three stars, and the map shows your best:

1. One star for a win.
2. Two if your fix is no longer than MWPM's, or MWPM lost the round.
3. Three if you did that on your first try without a hint. Replays count as a first try.

### Free play

The **Free play** button on the Levels screen gives you endless rounds at any difficulty. Changing difficulty during a round drops that round without scoring it, and so does leaving a level for the Levels screen.

Stats and level progress are saved in your browser's localStorage, and rounds from both modes count towards your stats. The game still works if storage is blocked, but your stats and progress then last only until the page closes.

### Replaying a round

Each round has its own seed, shown at the top of the page. The seed is a link that opens that exact round in Free play, for example `?seed=123&preset=hard`. With no `preset`, a seed opens on Easy.

## Run it locally

There is nothing to install or build. Serve this folder with any static server, because ES modules do not load from `file://`:

```
python -m http.server 8000
```

On some systems the command is `python3`. Then open <http://localhost:8000>.

To deploy, publish this folder as-is to Vercel or GitHub Pages.

## Run the tests

The tests need Node.js 22.7 or newer and have no dependencies:

```
node tests/decoder.test.js
```

They cover the decoder against brute force, correction validity, the logical check, threshold behaviour, seeding, scoring, levels and stars, undo, hints, drawn paths and the tour script.

## Project layout

```
index.html            page shell and panels
style.css             visuals and animations
src/rng.js            seeded PRNG
src/lattice.js        lattice construction, syndrome, logical check
src/decoder.js        bitmask DP matching and path reconstruction
src/game.js           round state and scoring
src/tour.js           guided tour script
src/ui.js             SVG rendering and click handling
tests/decoder.test.js test suite
```
