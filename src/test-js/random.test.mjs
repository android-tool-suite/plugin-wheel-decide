import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

(0, eval)(readFileSync(new URL('../web/random.js', import.meta.url), 'utf8'));
const { createSource, hashSeed, UINT32 } = globalThis.wheelRandom;

/* A source that hands back every value of [0, limit) exactly once, so a
   distribution can be checked by counting instead of by sampling. */
function enumeratingSource() {
  return {
    below: limit => limit - 1,
    fraction: () => 0,
    shuffle: items => items,
    next32: () => 0,
  };
}

test('below() stays inside its range and covers every value', () => {
  const source = createSource({ seed: 'range' });
  for (const limit of [1, 2, 3, 7, 100, 4096]) {
    const seen = new Set();
    for (let step = 0; step < Math.max(4000, limit * 12); step += 1) {
      const value = source.below(limit);
      assert.ok(Number.isInteger(value), `${value} is not an integer`);
      assert.ok(value >= 0 && value < limit, `${value} is outside [0, ${limit})`);
      seen.add(value);
    }
    assert.equal(seen.size, limit, `limit ${limit} was not fully covered`);
  }
  assert.throws(() => source.below(0), RangeError);
  assert.throws(() => source.below(1.5), RangeError);
});

test('below() is uniform over ranges far larger than one 32 bit word', () => {
  /* Full coverage is impossible to check here, so the values are bucketed and
     compared with a chi-square test at alpha = 0.001 (df = 63). */
  for (const limit of [65536, UINT32 - 1, 2 ** 40 + 7, 2 ** 53 - 1]) {
    const source = createSource({ seed: `wide-${limit}` });
    const buckets = new Array(64).fill(0);
    const rounds = 640000;
    for (let step = 0; step < rounds; step += 1) {
      const value = source.below(limit);
      assert.ok(Number.isSafeInteger(value) && value >= 0 && value < limit, `${value} is outside [0, ${limit})`);
      buckets[Math.min(63, Math.floor((value / limit) * 64))] += 1;
    }
    const expected = rounds / 64;
    const statistic = buckets.reduce((sum, count) => sum + ((count - expected) ** 2) / expected, 0);
    assert.ok(statistic < 130, `limit ${limit} is not uniform: chi-square ${statistic.toFixed(2)} > 130 for df 63`);
  }
});

test('below() avoids modulo bias by rejection instead of truncating', () => {
  /* 3 does not divide 2^32, so `next32() % 3` would hand the first
     (2^32 mod 3) = 1 value a sliver of extra probability. With rejection the
     three outcomes must be within a fraction of a percent of each other. */
  const source = createSource('uniform-3');
  const counts = [0, 0, 0];
  const rounds = 150000;
  for (let step = 0; step < rounds; step += 1) counts[source.below(3)] += 1;
  for (const count of counts) {
    const deviation = Math.abs(count / rounds - 1 / 3);
    assert.ok(deviation < 0.006, `deviation ${deviation} is larger than sampling noise`);
  }
});

test('below() handles limits above 2^32 without collapsing', () => {
  const source = createSource({ seed: 'wide' });
  const limit = 2 ** 40 + 7;
  const buckets = new Set();
  for (let step = 0; step < 2000; step += 1) {
    const value = source.below(limit);
    assert.ok(Number.isSafeInteger(value) && value >= 0 && value < limit);
    buckets.add(Math.floor(value / 2 ** 32));
  }
  assert.ok(buckets.size > 100, 'the high bits never change');
});

test('fraction() uses the full 53 bit mantissa and stays in [0,1)', () => {
  const source = createSource({ seed: 'fraction' });
  let minimum = 1;
  let maximum = 0;
  const seen = new Set();
  for (let step = 0; step < 20000; step += 1) {
    const value = source.fraction();
    assert.ok(value >= 0 && value < 1);
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
    seen.add(value);
  }
  assert.equal(seen.size, 20000, 'fraction() repeated a value');
  assert.ok(minimum < 0.001 && maximum > 0.999, 'the interval is not covered');
});

test('a seeded source is reproducible and unseeded sources are not', () => {
  const first = createSource({ seed: 'wheel-decide' });
  const second = createSource({ seed: 'wheel-decide' });
  const other = createSource({ seed: 'wheel-decide!' });
  const left = Array.from({ length: 32 }, () => first.next32());
  const right = Array.from({ length: 32 }, () => second.next32());
  assert.deepEqual(left, right);
  assert.notDeepEqual(left, Array.from({ length: 32 }, () => other.next32()));
  assert.equal(first.entropy, 'seeded');

  const platform = createSource();
  assert.equal(platform.entropy, 'platform');
  assert.notDeepEqual(
    Array.from({ length: 8 }, () => platform.next32()),
    Array.from({ length: 8 }, () => platform.next32()),
  );
});

test('the platform source is the CSPRNG when one is present', () => {
  const calls = [];
  const source = createSource({
    crypto: {
      getRandomValues(buffer) {
        calls.push(buffer.length);
        for (let index = 0; index < buffer.length; index += 1) buffer[index] = index * 2654435761 >>> 0;
        return buffer;
      },
    },
  });
  assert.equal(source.entropy, 'platform');
  source.below(1000);
  assert.ok(calls.length >= 1, 'the platform generator was never used');
  assert.equal(source.below(1), 0);
});

test('shuffle() is a permutation and every position is reachable', () => {
  const source = createSource({ seed: 'shuffle' });
  const original = Array.from({ length: 6 }, (_, index) => index);
  const firstPositions = new Set();
  for (let step = 0; step < 3000; step += 1) {
    const items = source.shuffle([...original]);
    assert.deepEqual([...items].sort((a, b) => a - b), original);
    firstPositions.add(items[0]);
  }
  assert.equal(firstPositions.size, 6);
});

test('hashSeed() is stable across calls and differs for similar text', () => {
  const left = hashSeed('转盘');
  const right = hashSeed('转盘');
  assert.equal(left(), right());
  assert.notEqual(hashSeed('转盘')(), hashSeed('转盘 ' )());
});
