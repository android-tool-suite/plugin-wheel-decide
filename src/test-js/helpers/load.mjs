import { readFileSync } from 'node:fs';

/* The Web payload is plain scripts that attach to globalThis, exactly the shape
   the host loads. Evaluating the real files (rather than importing a parallel
   copy) means the tests cannot drift from what ships. */
export function loadWeb(...names) {
  for (const name of names) {
    (0, eval)(readFileSync(new URL(`../../web/${name}.js`, import.meta.url), 'utf8'));
  }
  return globalThis;
}

export const CHI_SQUARE_CRITICAL_001 = [
  0, 6.635, 9.210, 11.345, 13.277, 15.086, 16.812, 18.475, 20.090, 21.666, 23.209,
  24.725, 26.217, 27.688, 29.141, 30.578, 32.000, 33.409, 34.805, 36.191, 37.566,
  38.932, 40.289, 41.638, 42.980, 44.314, 45.642, 46.963, 48.278, 49.588, 50.892,
  52.191, 53.486,
];

/**
 * Chi-square goodness-of-fit with df = k - 1 at alpha = 0.01.
 *
 * The target probabilities are fixed by construction, so no parameter is
 * estimated from the data and df stays k - 1. Bins whose expected count is
 * below 5 are rejected loudly rather than silently, because the chi-square
 * approximation is invalid there and a low count would make the test pass by
 * accident.
 */
export function chiSquare(counts, probabilities) {
  const total = counts.reduce((sum, value) => sum + value, 0);
  let statistic = 0;
  let worst = 0;
  counts.forEach((observed, index) => {
    const expected = total * probabilities[index];
    if (expected < 5) throw new Error(`bin ${index} has expected count ${expected.toFixed(2)} < 5`);
    const deviation = observed - expected;
    statistic += (deviation * deviation) / expected;
    worst = Math.max(worst, Math.abs(deviation) / expected);
  });
  return { statistic, df: counts.length - 1, worstRelative: worst };
}

/** Total variation distance between target probabilities and observed counts. */
export function totalVariation(counts, probabilities) {
  const total = counts.reduce((sum, value) => sum + value, 0);
  let sum = 0;
  counts.forEach((observed, index) => {
    sum += Math.abs(observed / total - probabilities[index]);
  });
  return sum / 2;
}

/** A four-sigma envelope for TVD; adapts to the bin count and sample size. */
export function totalVariationBound(bins, samples, sigma = 4) {
  return Math.min(0.5, (sigma * 0.5 * Math.sqrt(bins / samples)));
}

export function countsOf(samples, bins) {
  const counts = new Array(bins).fill(0);
  for (const sample of samples) counts[sample] += 1;
  return counts;
}
