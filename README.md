# Be the Decoder

A browser game where you act as a quantum error correction decoder. Hidden bit-flip errors hit a surface code, you see only the syndrome, and you try to correct it without causing a logical error. Each round you are compared with a minimum-weight perfect matching (MWPM) decoder solving the same problem.

The game uses an unrotated planar surface code with bit-flip (X) errors only and perfect syndrome measurement. The decoder is written from scratch as a bitmask DP in [src/decoder.js](src/decoder.js), and no decoding library is used.

## How to play

1. Glowing nodes are defects: check nodes at the ends of error chains. The errors themselves stay hidden.
2. Click edges (data qubits) to flip them. Defects update as you click. Join defects to each other, or to the left or right boundary, until none are lit.
3. Press **Submit** once the board is clear, or **Give up** to skip to the reveal. Giving up counts as a loss.
4. The reveal shows the hidden errors, your correction and the MWPM correction as separate layers you can toggle.

You win if what is left after your correction (errors XOR correction) does not join the left boundary to the right boundary. A chain that does is a logical error. Clearing every defect is not enough: you can have a clean board and still lose.

| Preset | Distance d | Error probability p |
| --- | --- | --- |
| Easy | 3 | 0.05 |
| Medium | 5 | 0.07 |
| Hard | 7 | 0.09 |

Changing difficulty during a round drops that round without scoring it. Stats are saved in your browser's localStorage. The game still works if storage is blocked, but stats then last only until the page closes.

### Replaying a round

Each round has its own seed, shown at the top of the page. The seed is a link to that exact round, for example `?seed=123&preset=hard`. With no `preset`, a seed opens on Easy.

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

They cover the decoder against brute force, correction validity, the logical check, threshold behaviour, seeding and scoring.

## Project layout

```
index.html            page shell and panels
style.css             visuals and animations
src/rng.js            seeded PRNG
src/lattice.js        lattice construction, syndrome, logical check
src/decoder.js        bitmask DP matching and path reconstruction
src/game.js           round state and scoring
src/ui.js             SVG rendering and click handling
tests/decoder.test.js test suite
```
