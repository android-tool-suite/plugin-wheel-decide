(() => {
  'use strict';

  const UINT32 = 4294967296;
  const MAX_EXACT_INTEGER = Number.MAX_SAFE_INTEGER;

  /* xmur3 mixes a string into a well distributed 32 bit seed sequence. */
  function hashSeed(text) {
    let hash = 1779033703 ^ String(text).length;
    for (let index = 0; index < String(text).length; index += 1) {
      hash = Math.imul(hash ^ String(text).charCodeAt(index), 3432918353);
      hash = (hash << 13) | (hash >>> 19);
    }
    return () => {
      hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
      hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
      hash ^= hash >>> 16;
      return hash >>> 0;
    };
  }

  /* sfc32: small, fast, passes PractRand to 2^128; used only when a seed is pinned. */
  function sfc32(a, b, c, d) {
    return () => {
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      let value = (a + b) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      d = (d + 1) | 0;
      value = (value + d) | 0;
      c = (c + value) | 0;
      return value >>> 0;
    };
  }

  /**
   * A uniform random source over integers, floats and permutations.
   *
   * The default source reads from the platform CSPRNG so that a spin cannot be
   * predicted from previously observed spins. Games and statistics do not
   * require that property, but a decision tool that people argue about does.
   * Passing `seed` switches to a reproducible sfc32 stream, which exists so a
   * spin can be replayed in tests and audits.
   */
  function createSource(options = {}) {
    const cryptoObject = options.crypto || globalThis.crypto;
    const secure = !options.seed && cryptoObject && typeof cryptoObject.getRandomValues === 'function';
    const fallback = Math.random;
    const seedBits = options.seed ? hashSeed(options.seed) : null;
    const stream = seedBits ? sfc32(seedBits(), seedBits(), seedBits(), seedBits()) : null;
    const buffer = secure ? new Uint32Array(64) : null;
    let cursor = buffer ? buffer.length : 0;

    function next32() {
      if (stream) return stream();
      if (buffer) {
        if (cursor >= buffer.length) {
          cryptoObject.getRandomValues(buffer);
          cursor = 0;
        }
        return buffer[cursor++];
      }
      return Math.floor(fallback() * UINT32) >>> 0;
    }

    /* 53 uniform bits: 27 from one word, 26 from the next. */
    function next53() {
      return (next32() >>> 5) * 67108864 + (next32() >>> 6);
    }

    /**
     * Uniform integer in [0, limit) with rejection sampling, so every value has
     * exactly the same probability. The naive `next32() % limit` would bias the
     * first `2^32 % limit` values upward; for a wheel with 3 equal options that
     * is a measurable 2.3e-10 skew. Rejection removes it entirely at the cost
     * of one extra draw in the worst case.
     *
     * Limits above 2^32 use the 53 bit word: rejecting everything at or above
     * the largest multiple of `limit` inside [0, 2^53) makes the remainder
     * uniform. The tempting "split into equal spans and pick a span first"
     * shortcut is wrong whenever the last span is short, because the short span
     * then hands each of its values more probability than the others.
     */
    function below(limit) {
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new RangeError('below() needs a positive safe integer');
      }
      if (limit === 1) return 0;
      if (limit > UINT32) {
        const bound = Math.floor(9007199254740992 / limit) * limit;
        for (;;) {
          const value = next53();
          if (value < bound) return value % limit;
        }
      }
      const ceiling = UINT32 - (UINT32 % limit);
      let value = next32();
      while (value >= ceiling) value = next32();
      return value % limit;
    }

    /* Uniform float in [0, 1) built from 53 random bits, i.e. every double in
       the interval with the same spacing, unlike Math.random's engine-specific
       precision. */
    function fraction() {
      const high = next32() >>> 5;
      const low = next32() >>> 6;
      return (high * 67108864 + low) / 9007199254740992;
    }

    /* Fisher-Yates with unbiased indices. */
    function shuffle(items) {
      for (let index = items.length - 1; index > 0; index -= 1) {
        const other = below(index + 1);
        const swap = items[index];
        items[index] = items[other];
        items[other] = swap;
      }
      return items;
    }

    return {
      below,
      fraction,
      shuffle,
      next32,
      entropy: stream ? 'seeded' : secure ? 'platform' : 'fallback',
      seed: options.seed ? String(options.seed) : null,
    };
  }

  globalThis.wheelRandom = { createSource, hashSeed, sfc32, UINT32, MAX_EXACT_INTEGER };
})();
