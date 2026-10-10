import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadWeb } from './helpers/load.mjs';

const web = loadWeb('random', 'sampler', 'distribution');
const distribution = web.wheelDistribution;
const sampler = web.wheelSampler;

const entries = (...values) => values.map(value => ({ value }));

function probabilitiesOf(values, config) {
  const computed = distribution.compute(entries(...values), config);
  const engine = sampler.createSampler(computed.weights);
  return { probabilities: engine.probabilities(), weights: computed.weights, notes: computed.notes };
}

test('the original score scheme is still available and behaves as before', () => {
  const { probabilities } = probabilitiesOf([1, 1, 2], { mode: 'score' });
  assert.deepEqual(probabilities.map(value => Math.round(value * 100)), [25, 25, 50]);
  assert.equal(distribution.modeById('score').original, true);
  /* Only the ratio matters: scaling every score must not change anything. */
  const scaled = probabilitiesOf([10, 10, 20], { mode: 'score' }).probabilities;
  probabilities.forEach((value, index) => assert.ok(Math.abs(value - scaled[index]) < 1e-9));
});

test('the original equal mode ignores the numbers entirely', () => {
  const { probabilities } = probabilitiesOf([1, 999, 0.01], { mode: 'equal' });
  probabilities.forEach(value => assert.ok(Math.abs(value - 1 / 3) < 1e-9));
  assert.equal(distribution.modeById('equal').original, true);
});

test('percent mode normalises a total that is not 100 and says so', () => {
  const { probabilities, notes } = probabilitiesOf([30, 30, 30], { mode: 'percent' });
  probabilities.forEach(value => assert.ok(Math.abs(value - 1 / 3) < 1e-9));
  assert.ok(notes.some(note => note.includes('90')), `expected a normalisation note, got ${JSON.stringify(notes)}`);

  const exact = probabilitiesOf([10, 20, 70], { mode: 'percent' });
  assert.deepEqual(exact.probabilities.map(value => Math.round(value * 100)), [10, 20, 70]);
  assert.deepEqual(exact.notes, []);
});

test('ratio mode is a plain multiplier', () => {
  const { probabilities } = probabilitiesOf([3, 1], { mode: 'ratio' });
  assert.ok(Math.abs(probabilities[0] - 0.75) < 1e-9);
  assert.ok(Math.abs(probabilities[1] - 0.25) < 1e-9);
});

test('softmax temperature interpolates between concentrated and uniform', () => {
  const cold = probabilitiesOf([10, 0, 0], { mode: 'softmax', temperature: 0.05 }).probabilities;
  assert.ok(cold[0] > 0.999, `cold softmax should be nearly deterministic, got ${cold[0]}`);

  const warm = probabilitiesOf([10, 0, 0], { mode: 'softmax', temperature: 5 }).probabilities;
  assert.ok(warm[0] < 0.9 && warm[0] > 0.6, `warm softmax should soften the favourite, got ${warm[0]}`);

  /* With a score spread far below the temperature the distribution is uniform;
     that is the T -> infinity limit, and it is what makes the knob readable. */
  const flat = probabilitiesOf([0.001, 0, 0], { mode: 'softmax', temperature: 5 }).probabilities;
  flat.forEach(value => assert.ok(Math.abs(value - 1 / 3) < 1e-4, `expected near-uniform, got ${value}`));

  /* Entropy must be monotone in temperature. */
  const entropy = list => -list.reduce((sum, value) => sum + (value > 0 ? value * Math.log(value) : 0), 0);
  const coldest = entropy(probabilitiesOf([4, 1, 0], { mode: 'softmax', temperature: 0.2 }).probabilities);
  const warmer = entropy(probabilitiesOf([4, 1, 0], { mode: 'softmax', temperature: 1 }).probabilities);
  const warmest = entropy(probabilitiesOf([4, 1, 0], { mode: 'softmax', temperature: 4 }).probabilities);
  assert.ok(coldest < warmer && warmer < warmest, 'entropy is not monotone in temperature');
});

test('softmax survives scores that would overflow a naive implementation', () => {
  const { probabilities } = probabilitiesOf([3000, 2999, -3000], { mode: 'softmax', temperature: 1 });
  assert.ok(probabilities.every(value => Number.isFinite(value) && value >= 0));
  assert.ok(Math.abs(probabilities.reduce((sum, value) => sum + value, 0) - 1) < 1e-9);
  assert.ok(probabilities[0] > probabilities[1] && probabilities[1] > probabilities[2]);
});

test('softmax warns when the score spread makes the low scores unreachable', () => {
  const { notes } = probabilitiesOf([0, 100], { mode: 'softmax', temperature: 0.05 });
  assert.ok(notes.some(note => note.includes('温度')), `expected a temperature hint, got ${JSON.stringify(notes)}`);
});

test('rank mode ignores the values and uses list order', () => {
  const zipf = probabilitiesOf([9, 9, 9, 9], { mode: 'rank', power: 1 }).probabilities;
  const harmonic = [1, 1 / 2, 1 / 3, 1 / 4];
  const sum = harmonic.reduce((total, value) => total + value, 0);
  zipf.forEach((value, index) => assert.ok(Math.abs(value - harmonic[index] / sum) < 1e-7));
  assert.ok(zipf[0] > zipf[1] && zipf[1] > zipf[2] && zipf[2] > zipf[3]);

  const flat = probabilitiesOf([9, 9, 9], { mode: 'rank', power: 0 }).probabilities;
  flat.forEach(value => assert.ok(Math.abs(value - 1 / 3) < 1e-9));
});

test('the probability floor lifts the smallest share without reordering', () => {
  const without = probabilitiesOf([100, 1], { mode: 'score' });
  const withFloor = probabilitiesOf([100, 1], { mode: 'score', floorPercent: 10 });
  assert.ok(withFloor.probabilities[1] >= 0.0999, `floor not reached: ${withFloor.probabilities[1]}`);
  assert.ok(withFloor.probabilities[0] > withFloor.probabilities[1]);
  assert.ok(withFloor.probabilities[1] > without.probabilities[1]);
});

test('the probability floor is capped below 1/n because nothing above it is reachable', () => {
  const weights = distribution.applyFloor([1000, 1, 1, 1], 0.9);
  const total = weights.reduce((sum, value) => sum + value, 0);
  const smallest = Math.min(...weights) / total;
  assert.ok(smallest < 0.25, `a floor above 1/4 is impossible, got ${smallest}`);
  assert.ok(weights.every(value => Number.isFinite(value) && value > 0));
});

test('a zero weight really means "never", and the note says so', () => {
  /* A weight that is positive but tiny stays reachable (scaleToIntegers gives
     it one unit); a literal zero does not, which is the behaviour a user
     typing 0 expects. The note has to describe the real one. */
  const { probabilities, notes } = probabilitiesOf([5, 0, 5], { mode: 'score' });
  assert.equal(probabilities[1], 0, 'a literal zero weight should not be drawn');
  assert.ok(Math.abs(probabilities[0] - 0.5) < 1e-9 && Math.abs(probabilities[2] - 0.5) < 1e-9);
  assert.ok(notes.some(note => note.includes('停用')), `expected an explanation, got ${JSON.stringify(notes)}`);

  const tiny = probabilitiesOf([5, 1e-9, 5], { mode: 'score' });
  assert.ok(tiny.probabilities[1] > 0, 'a positive weight that rounds to nothing must still be reachable');
  assert.deepEqual(tiny.notes, []);
});

test('an all-zero wheel falls back to equal with an explanation', () => {
  const { probabilities, notes } = probabilitiesOf([0, 0, 0], { mode: 'score' });
  probabilities.forEach(value => assert.ok(Math.abs(value - 1 / 3) < 1e-9));
  assert.ok(notes.some(note => note.includes('等概率')));
});

test('an unknown mode falls back to the default instead of throwing', () => {
  assert.equal(distribution.modeById('nope').id, 'score');
  const { probabilities } = probabilitiesOf([1, 1], { mode: 'nope' });
  assert.equal(probabilities.length, 2);
});

test('parameters outside their declared range are clamped', () => {
  const low = probabilitiesOf([10, 0], { mode: 'softmax', temperature: -5 }).probabilities;
  const floor = probabilitiesOf([10, 0], { mode: 'softmax', temperature: 0.05 }).probabilities;
  low.forEach((value, index) => assert.ok(Math.abs(value - floor[index]) < 1e-9));
  const big = probabilitiesOf([1, 1, 1], { mode: 'rank', power: 99 }).probabilities;
  const capped = probabilitiesOf([1, 1, 1], { mode: 'rank', power: 3 }).probabilities;
  big.forEach((value, index) => assert.ok(Math.abs(value - capped[index]) < 1e-9));
});

test('parseValue() separates the trailing number from the label', () => {
  const cases = [
    ['吃火锅 3', '吃火锅', 3],
    ['吃火锅,3', '吃火锅', 3],
    ['吃火锅，3', '吃火锅', 3],
    ['吃火锅、3', '吃火锅', 3],
    ['吃火锅\t3', '吃火锅', 3],
    ['吃火锅 *3', '吃火锅', 3],
    ['吃火锅 30%', '吃火锅', 30],
    ['吃火锅（3）', '吃火锅', 3],
    ['吃火锅(3)', '吃火锅', 3],
    ['吃火锅：3', '吃火锅', 3],
    ['吃火锅 0.5', '吃火锅', 0.5],
  ];
  for (const [line, label, value] of cases) {
    const parsed = distribution.parseValue(line);
    assert.equal(parsed.label, label, `label of ${line}`);
    assert.equal(parsed.value, value, `value of ${line}`);
  }
  /* A label that merely ends in a digit, or a line with no number at all,
     must be kept whole: the original script would have eaten the digit. */
  assert.deepEqual(distribution.parseValue('房间 204'), { label: '房间', value: 204, explicit: true });
  assert.equal(distribution.parseValue('吃火锅').label, '吃火锅');
  assert.equal(distribution.parseValue('吃火锅').value, null);
  assert.equal(distribution.parseValue('   ').label, '');
});

test('every mode declares the input affordance the list needs', () => {
  for (const mode of distribution.MODES) {
    assert.ok(mode.id && mode.label && mode.summary, `${mode.id} is missing display text`);
    if (mode.parameter) {
      assert.ok(mode.parameter.key && mode.parameter.label);
      assert.ok(mode.parameter.min < mode.parameter.max);
      assert.ok(mode.parameter.fallback >= mode.parameter.min && mode.parameter.fallback <= mode.parameter.max);
      assert.ok(mode.parameter.hint);
    }
  }
  assert.equal(distribution.MODES.filter(mode => mode.original).length, 2);
});
