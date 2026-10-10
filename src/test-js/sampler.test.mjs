import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadWeb, chiSquare, totalVariation, totalVariationBound, CHI_SQUARE_CRITICAL_001 } from './helpers/load.mjs';

const web = loadWeb('random', 'sampler');
const { createSource } = web.wheelRandom;
const sampler = web.wheelSampler;

function draw(weights, algorithm, samples, seed) {
  const source = createSource({ seed });
  const engine = sampler.createSampler(weights, { algorithm });
  const counts = new Array(weights.length).fill(0);
  for (let step = 0; step < samples; step += 1) counts[engine.sample(source)] += 1;
  return { counts, engine };
}

test('scaleToIntegers() preserves ratios and hits the budget exactly', () => {
  for (const weights of [[1, 1, 1], [1, 2, 3, 4], [0.001, 0.002, 1000], [7], [0, 0, 1]]) {
    const integers = sampler.scaleToIntegers(weights);
    const total = integers.reduce((sum, value) => sum + value, 0);
    assert.equal(total, sampler.DEFAULT_BUDGET, `weights ${weights} do not fill the budget`);
    assert.ok(integers.every(value => Number.isSafeInteger(value) && value >= 0));
    const sum = weights.reduce((accumulator, value) => accumulator + Math.max(0, value), 0);
    integers.forEach((value, index) => {
      if (weights[index] <= 0) {
        assert.equal(value, 0);
        return;
      }
      assert.ok(value >= 1, `weight ${weights[index]} became unreachable`);
      const ideal = (weights[index] / sum) * sampler.DEFAULT_BUDGET;
      assert.ok(Math.abs(value - ideal) <= 1.0000001, `${value} is more than one unit from ${ideal}`);
    });
  }
});

test('scaleToIntegers() treats an all-zero wheel as equal, not as a division by zero', () => {
  const integers = sampler.scaleToIntegers([0, 0, 0, 0]);
  assert.deepEqual(new Set(integers).size, 1);
  assert.equal(integers.reduce((sum, value) => sum + value, 0), sampler.DEFAULT_BUDGET);
});

test('scaleToIntegers() clamps negatives to zero instead of corrupting the table', () => {
  const integers = sampler.scaleToIntegers([-5, 1, 1]);
  assert.equal(integers[0], 0);
  assert.ok(integers[1] > 0 && integers[2] > 0);
});

test('scaleToIntegers() refuses more options than the wheel supports', () => {
  assert.throws(() => sampler.scaleToIntegers(new Array(513).fill(1)), RangeError);
  assert.doesNotThrow(() => sampler.scaleToIntegers(new Array(512).fill(1)));
});

test('both samplers walk the whole random range exactly once', () => {
  /* Enumerating the entire random space turns a statistical claim into a
     counting proof: the histogram must equal the target exactly, with no
     sampling error left to argue about. A small budget keeps the space small
     enough to enumerate in full. */
  const budget = 64;
  const weights = [1, 3, 10, 86];

  const prefix = sampler.createSampler(weights, { algorithm: 'prefix', budget });
  assert.equal(prefix.total, budget);
  const prefixCounts = new Array(weights.length).fill(0);
  for (let value = 0; value < budget; value += 1) {
    prefixCounts[prefix.sample({ below: limit => value % limit, fraction: () => 0, next32: () => 0 })] += 1;
  }
  assert.deepEqual(prefixCounts, prefix.integers, 'prefix sampling does not reproduce the target counts');

  const alias = sampler.createSampler(weights, { algorithm: 'alias', budget });
  const aliasCounts = new Array(weights.length).fill(0);
  const aliasSize = alias.size;
  for (let column = 0; column < aliasSize; column += 1) {
    for (let value = 0; value < budget; value += 1) {
      const enumerator = {
        below: limit => (limit === aliasSize ? column : value),
        fraction: () => 0,
        next32: () => 0,
      };
      aliasCounts[alias.sample(enumerator)] += 1;
    }
  }
  /* Every column is one of `size` equally likely columns, so the exact
     expectation is size times the target counts. */
  assert.deepEqual(
    aliasCounts,
    alias.integers.map(value => value * aliasSize),
    'alias sampling does not reproduce the target counts exactly',
  );
  assert.deepEqual(alias.integers, prefix.integers);
});

test('the alias table never dereferences an empty worklist (n = 1 and n = 2)', () => {
  for (const algorithm of ['prefix', 'alias']) {
    for (const weights of [[1], [1, 0], [0, 1], [5, 5]]) {
      const engine = sampler.createSampler(weights, { algorithm });
      const source = createSource({ seed: `tiny-${weights.join()}-${algorithm}` });
      const counts = new Array(weights.length).fill(0);
      for (let step = 0; step < 500; step += 1) counts[engine.sample(source)] += 1;
      const sum = weights.reduce((total, value) => total + value, 0);
      counts.forEach((count, index) => {
        if (weights[index] === 0) assert.equal(count, 0, 'a zero weight was drawn');
        else assert.ok(count > 0, `${weights} never drew index ${index}`);
      });
      assert.equal(counts.reduce((total, value) => total + value, 0), 500);
      assert.ok(sum >= 0);
    }
  }
});

test('the alias table survives the floating point trap cases', () => {
  /* Weights that produce a mathematically exact prob[i] == 1 are the inputs
     that break implementations which test equality against 1 or subtract
     (1 - p) instead of adding p and subtracting the total. */
  const cases = [
    [1, 1, 1],
    [1, 1, 1, 1, 1, 1, 1, 1],
    [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
    [1, 0, 0, 0],
    [0, 0, 0, 1],
    [1 / 3, 1 / 3, 1 / 3],
    [1e-9, 1, 1],
  ];
  for (const weights of cases) {
    const engine = sampler.createSampler(weights, { algorithm: 'alias' });
    const { bucket, threshold, total } = engine.table;
    assert.equal(bucket.length, weights.length);
    for (let index = 0; index < weights.length; index += 1) {
      assert.ok(Number.isInteger(bucket[index]) && bucket[index] >= 0 && bucket[index] < weights.length);
      assert.ok(threshold[index] >= 0 && threshold[index] <= total, 'a threshold escaped its range');
    }
  }
});

test('prefix and alias agree with each other and with the target distribution', () => {
  const cases = [
    { weights: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], samples: 200000 },
    { weights: [1, 3, 10, 86], samples: 200000 },
    { weights: [50, 30, 15, 5], samples: 200000 },
    { weights: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], samples: 300000 },
  ];
  for (const { weights, samples } of cases) {
    const reference = sampler.createSampler(weights, { algorithm: 'prefix' });
    const probabilities = reference.probabilities();
    const expected = weights.map(value => value / weights.reduce((sum, item) => sum + item, 0));
    probabilities.forEach((value, index) => {
      assert.ok(Math.abs(value - expected[index]) < 1e-8, `displayed probability drifted at ${index}`);
    });
    for (const algorithm of ['prefix', 'alias']) {
      const { counts } = draw(weights, algorithm, samples, `agree-${algorithm}-${weights.length}-${weights[0]}`);
      const chi = chiSquare(counts, probabilities);
      assert.ok(
        chi.statistic <= CHI_SQUARE_CRITICAL_001[chi.df],
        `${algorithm} failed chi-square: ${chi.statistic.toFixed(2)} > ${CHI_SQUARE_CRITICAL_001[chi.df]} (worst bin off by ${(chi.worstRelative * 100).toFixed(2)}%)`,
      );
      const tvd = totalVariation(counts, probabilities);
      assert.ok(
        tvd <= totalVariationBound(weights.length, samples),
        `${algorithm} TVD ${tvd.toFixed(4)} exceeds the 4 sigma envelope`,
      );
    }
  }
});

test('a heavily skewed wheel is still sampled correctly', () => {
  /* A uniform-only test passes even when the normalisation is wrong, so the
     suite needs one shape where a single option owns almost all the mass. */
  const weights = [999, 1];
  const engine = sampler.createSampler(weights);
  const source = createSource({ seed: 'skew' });
  const counts = new Array(2).fill(0);
  for (let step = 0; step < 200000; step += 1) counts[engine.sample(source)] += 1;
  const probabilities = engine.probabilities();
  assert.ok(Math.abs(probabilities[0] - 0.999) < 1e-6, `expected 0.999, got ${probabilities[0]}`);
  const chi = chiSquare(counts, probabilities);
  assert.ok(chi.statistic <= CHI_SQUARE_CRITICAL_001[chi.df], `skewed chi-square ${chi.statistic.toFixed(2)}`);
  assert.ok(counts[1] > 0, 'the rare option was never drawn in 200000 spins');
});

test('formatPercentages() always adds up to exactly 100', () => {
  const cases = [
    [1 / 3, 1 / 3, 1 / 3],
    [1 / 7, 2 / 7, 4 / 7],
    [0.5, 0.5],
    [1],
    [0.001, 0.001, 0.998],
    Array.from({ length: 37 }, () => 1 / 37),
  ];
  for (const probabilities of cases) {
    for (const decimals of [0, 1, 2]) {
      const shares = sampler.formatPercentages(probabilities, decimals);
      const total = shares.reduce((sum, value) => sum + value, 0);
      assert.equal(
        Math.round(total * 10 ** decimals),
        100 * 10 ** decimals,
        `${probabilities.length} entries at ${decimals} decimals summed to ${total}`,
      );
      const factor = 10 ** decimals;
      shares.forEach((value, index) => {
        const ideal = probabilities[index] * 100 * factor;
        assert.ok(Math.abs(value * factor - ideal) < 1.0000001, 'a share moved by a whole unit');
      });
    }
  }
});
