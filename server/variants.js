export const BASE_COLORS = ['red', 'yellow', 'green', 'blue', 'white'];

const STANDARD = [1, 1, 1, 2, 2, 3, 3, 4, 4, 5];
const REVERSE = [5, 5, 5, 4, 4, 3, 3, 2, 2, 1];
const CRITICAL = [1, 2, 3, 4, 5];

const baseSuits = BASE_COLORS.map((color) => ({
  color,
  distribution: STANDARD,
  direction: 'up',
  hintMatches: 'self',
}));

const rainbowFull = { color: 'rainbow', distribution: STANDARD, direction: 'up', hintMatches: 'all' };
const rainbowCritical = { color: 'rainbow', distribution: CRITICAL, direction: 'up', hintMatches: 'all' };
const blackFull = { color: 'black', distribution: STANDARD, direction: 'up', hintMatches: 'none' };
const blackReverse = { color: 'black', distribution: REVERSE, direction: 'down', hintMatches: 'none' };

export const VARIANTS = {
  simple: {
    id: 'simple',
    name: 'Simple',
    suits: baseSuits,
  },
  rainbow: {
    id: 'rainbow',
    name: 'Rainbow',
    suits: [...baseSuits, rainbowFull],
  },
  rainbowCritical: {
    id: 'rainbowCritical',
    name: 'Rainbow Critical',
    suits: [...baseSuits, rainbowCritical],
  },
  rainbowCriticalBlack: {
    id: 'rainbowCriticalBlack',
    name: 'Rainbow Critical + Black',
    suits: [...baseSuits, rainbowCritical, blackFull],
  },
  rainbowCriticalBlackReverse: {
    id: 'rainbowCriticalBlackReverse',
    name: 'Rainbow Critical + Black Reverse',
    suits: [...baseSuits, rainbowCritical, blackReverse],
  },
};

export function getVariant(id) {
  const v = VARIANTS[id];
  if (!v) throw new Error(`Unknown variant: ${id}`);
  return v;
}

export function maxScore(variant) {
  return variant.suits.length * 5;
}
