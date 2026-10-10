(() => {
  'use strict';

  /* Total integer mass every wheel is scaled to. 2^30 keeps scaled*n below
     2^53 for up to 512 options, so every comparison in this file is exact. */
  const DEFAULT_BUDGET = 1073741824;
  const MAX_OPTIONS = 512;

  function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  /**
   * Turns arbitrary non-negative floats into integers of a fixed total.
   *
   * Rounding each weight on its own would make the integers sum to something
   * other than the budget, which silently rescales every probability. The
   * largest-remainder (Hamilton) apportionment below hands the leftover units
   * to the weights with the largest fractional part, so the total is exact and
   * the per-option error never exceeds one unit (about 1e-9 here).
   */
  function scaleToIntegers(weights, budget = DEFAULT_BUDGET) {
    const count = weights.length;
    if (count === 0) return [];
    if (count > MAX_OPTIONS) throw new RangeError(`at most ${MAX_OPTIONS} options are supported`);
    const safe = weights.map(value => (isFiniteNumber(value) && value > 0 ? value : 0));
    const sum = safe.reduce((total, value) => total + value, 0);
    const usable = sum > 0 ? safe : safe.map(() => 1);
    const usableSum = sum > 0 ? sum : count;
    const exact = usable.map(value => (value * budget) / usableSum);
    const scaled = exact.map(value => Math.floor(value));
    let assigned = scaled.reduce((total, value) => total + value, 0);
    const order = exact
      .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
      .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
    for (let step = 0; assigned < budget; step += 1) {
      scaled[order[step % count].index] += 1;
      assigned += 1;
    }
    /* A weight that is positive but astronomically small would floor to zero
       and become unreachable; give it one unit and take it from the largest
       bucket so the total still matches the budget. */
    for (let index = 0; index < count; index += 1) {
      if (usable[index] > 0 && scaled[index] === 0) {
        let largest = 0;
        for (let probe = 1; probe < count; probe += 1) if (scaled[probe] > scaled[largest]) largest = probe;
        if (scaled[largest] > 1) {
          scaled[largest] -= 1;
          scaled[index] = 1;
        }
      }
    }
    return scaled;
  }

  function totalOf(values) {
    let total = 0;
    for (const value of values) total += value;
    return total;
  }

  /* Prefix sums of exact integers stay exact: the running total never leaves
     the safe integer range, so the last entry is the true sum. */
  function buildPrefixTable(integers) {
    const prefix = new Float64Array(integers.length);
    let running = 0;
    for (let index = 0; index < integers.length; index += 1) {
      running += integers[index];
      prefix[index] = running;
    }
    return { kind: 'prefix', prefix, total: running, size: integers.length };
  }

  /**
   * Vose's alias method, kept in exact integer arithmetic.
   *
   * The textbook version stores `prob[i] = w[i] * n / total` as a double and
   * compares it against `1`. Multiplying the whole construction by `total`
   * turns every one of those comparisons into an integer comparison and the
   * `prob[l] += prob[s] - 1` repair step into `g[l] += g[s] - total`, so the
   * build cannot drift and no `== 1` test is ever needed (that equality test is
   * the classic bug in walker/vose implementations).
   */
  function buildAliasTable(integers) {
    const count = integers.length;
    const bucket = new Int32Array(count);
    const threshold = new Float64Array(count);
    const small = [];
    const large = [];
    let total = 0;
    for (let index = 0; index < count; index += 1) {
      total += integers[index];
      bucket[index] = index;
      threshold[index] = integers[index] * count;
    }
    for (let index = 0; index < count; index += 1) {
      if (threshold[index] < total) small.push(index);
      else large.push(index);
    }
    while (small.length > 0 && large.length > 0) {
      const low = small.pop();
      const high = large.pop();
      bucket[low] = high;
      threshold[high] += threshold[low] - total;
      if (threshold[high] < total) small.push(high);
      else large.push(high);
    }
    /* Only reachable through rounding or a zero weight; clamping is a no-op in
       exact arithmetic but keeps the table well formed for degenerate input. */
    while (large.length > 0) threshold[large.pop()] = total;
    while (small.length > 0) threshold[small.pop()] = total;
    return { kind: 'alias', bucket, threshold, total, size: count };
  }

  function samplePrefix(table, source) {
    const target = source.below(table.total);
    let low = 0;
    let high = table.size - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (table.prefix[middle] > target) high = middle;
      else low = middle + 1;
    }
    return low;
  }

  function sampleAlias(table, source) {
    const column = source.below(table.size);
    /* Accept column with probability threshold[column] / total: a uniform draw
       below the threshold means "keep the column", anything else falls through
       to its alias. Both branches are exact integers. */
    return source.below(table.total) < table.threshold[column] ? column : table.bucket[column];
  }

  /* Cumulative table + binary search is the default: it is the same shape as
     CPython's random.choices and libstdc++'s discrete_distribution, it has no
     build-time invariant to violate, and a reader can verify a spin by hand.
     The alias table is opt-in for callers that would rather have O(1) draws. */
  function chooseAlgorithm(size, requested) {
    if (requested === 'alias' || requested === 'prefix') return requested;
    return size > 256 ? 'alias' : 'prefix';
  }

  /**
   * Builds a sampler for a list of non-negative weights.
   *
   * `alias` samples in O(1) after an O(n) build, `prefix` samples in O(log n)
   * from a cumulative table. Both consume exactly the probability mass the
   * caller asked for; the tests assert that with a chi-square goodness-of-fit
   * test rather than by eyeballing output.
   */
  function createSampler(weights, options = {}) {
    const integers = scaleToIntegers(weights, options.budget || DEFAULT_BUDGET);
    const algorithm = chooseAlgorithm(integers.length, options.algorithm);
    const table = algorithm === 'alias' ? buildAliasTable(integers) : buildPrefixTable(integers);
    return {
      algorithm,
      integers,
      total: table.total,
      size: table.size,
      table,
      sample(source) {
        if (this.size === 0) throw new RangeError('cannot sample an empty wheel');
        if (this.total === 0) return 0;
        return table.kind === 'alias' ? sampleAlias(table, source) : samplePrefix(table, source);
      },
      /* Probability of each entry, derived from the same integers the sampler
         uses, so the displayed percentage is the value actually drawn. */
      probabilities() {
        return integers.map(value => (table.total === 0 ? 0 : value / table.total));
      },
    };
  }

  /**
   * Renders probabilities as percentages that add up to exactly 100.
   *
   * Formatting each value independently shows "33.3 + 33.3 + 33.3 = 99.9",
   * which looks like a bug to users; the remainder is given to the entries with
   * the largest discarded fraction instead. This is largest-remainder
   * apportionment, so no entry is ever off by a whole unit.
   */
  function formatPercentages(probabilities, decimals = 1) {
    const factor = 10 ** decimals;
    const target = Math.round(100 * factor);
    const exact = probabilities.map(value => value * 100 * factor);
    const units = exact.map(value => Math.floor(value));
    let assigned = units.reduce((total, value) => total + value, 0);
    const order = exact
      .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
      .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
    for (let step = 0; assigned < target; step += 1) {
      units[order[step % units.length].index] += 1;
      assigned += 1;
    }
    /* Floating point can also make the floors overshoot by one unit; take it
       back from the smallest fractions so the total is exact in both
       directions. */
    for (let step = 0; assigned > target; step += 1) {
      const pick = order[units.length - 1 - (step % units.length)].index;
      if (units[pick] > 0) {
        units[pick] -= 1;
        assigned -= 1;
      }
    }
    return units.map(value => value / factor);
  }

  globalThis.wheelSampler = {
    DEFAULT_BUDGET,
    MAX_OPTIONS,
    scaleToIntegers,
    totalOf,
    buildPrefixTable,
    buildAliasTable,
    samplePrefix,
    sampleAlias,
    createSampler,
    formatPercentages,
  };
})();
