// Seeded PRNG. Seeds are unsigned 32-bit integers.

const MAX_SEED = 0xffffffff;

// mulberry32: returns a function producing floats in [0, 1).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomSeed() {
  return Math.floor(Math.random() * (MAX_SEED + 1));
}

// Derives the seed of the following round, so a run of rounds is reproducible
// while each round can still be replayed from its own seed alone. An odd step
// visits all 2^32 seeds; feeding PRNG output back in would cycle within ~10^5.
export function nextSeed(seed) {
  return (seed + 0x9e3779b9) >>> 0;
}

// Returns the seed as a number, or null if the text is not a valid seed.
export function parseSeed(text) {
  if (text === null || !/^\d+$/.test(text)) return null;
  const seed = Number(text);
  return seed <= MAX_SEED ? seed : null;
}
