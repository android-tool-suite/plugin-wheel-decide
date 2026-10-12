(() => {
  'use strict';

  const EPSILON = 1e-12;

  /**
   * Probability schemes. Every scheme answers one question: given the number
   * the user typed next to each option, how much probability mass does that
   * option get? They all end as a list of non-negative floats whose ratios are
   * the probabilities; the sampler turns those into exact integers.
   *
   * `score` and `equal` reproduce the two modes of the original script, so the
   * old behaviour stays available next to the better-behaved schemes.
   */
  const MODES = [
    {
      id: 'score',
      label: '按权重',
      summary: '按各项权重占比分配概率，只比较相对大小，不要求合计为 100。',
      choiceHint: '用数值分配概率',
      inputLabel: '权重',
      inputHint: '权重越大，抽中机会越大',
      parameter: null,
      original: true,
    },
    {
      id: 'equal',
      label: '等概率',
      summary: '每个选项概率相同，忽略填写的数值。',
      choiceHint: '每项机会相同',
      inputLabel: '不参与',
      inputHint: '此模式下数值被忽略',
      parameter: null,
      original: true,
    },
    {
      id: 'softmax',
      label: 'softmax 温度',
      summary: '用温度压缩或放大评分差距：温度越低越集中在高分项，越高越接近等概率。',
      choiceHint: '调整评分差距的影响',
      inputLabel: '评分',
      inputHint: '差距越大影响越强',
      parameter: {
        key: 'temperature',
        label: '温度',
        min: 0.05,
        max: 5,
        step: 0.05,
        fallback: 0.5,
        hint: '0.05 接近只抽最高分，5 接近等概率',
      },
    },
    {
      id: 'rank',
      label: '排名幂律',
      summary: '按列表顺序衰减：第 k 项权重为 1/k^幂，用来表达“排序即优先级”。',
      choiceHint: '列表顺序决定优先级',
      inputLabel: '不参与',
      inputHint: '此模式只用列表顺序',
      parameter: {
        key: 'power',
        label: '幂',
        min: 0,
        max: 3,
        step: 0.1,
        fallback: 1,
        hint: '0 为等概率，1 为调和衰减，越大越偏向前几项',
      },
    },
  ];

  /* The first mode is the default a new wheel starts in, which is also the
     behaviour the original script had when it was not told to go equal. */
  const DEFAULT_MODE = MODES[0].id;

  function modeById(id) {
    return MODES.find(mode => mode.id === id) || MODES[0];
  }

  function finite(value, fallback = 0) {
    const number = typeof value === 'number' ? value : Number.parseFloat(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function parameterOf(config, mode) {
    if (!mode.parameter) return null;
    const raw = finite(config?.[mode.parameter.key], mode.parameter.fallback);
    return Math.min(mode.parameter.max, Math.max(mode.parameter.min, raw));
  }

  /**
   * Guarantees every option at least `floorRatio` of the mass.
   *
   * Adding the same constant to every weight pulls the smallest probability up
   * while keeping the ordering; solving `(w_min + L) / (W + n*L) = p` for L
   * gives the exact amount instead of an iterative search. Floor is capped
   * below 1/n because no assignment can give everyone more than that.
   */
  function applyFloor(weights, floorRatio) {
    const count = weights.length;
    if (count === 0) return weights;
    const ceiling = 1 / count;
    const target = Math.min(Math.max(floorRatio, 0), ceiling * (1 - 1e-9));
    if (target <= 0) return weights;
    const sum = weights.reduce((total, value) => total + value, 0);
    if (sum <= 0) return weights.map(() => 1);
    const minimum = Math.min(...weights);
    const lift = (target * sum - minimum) / (1 - count * target);
    if (!Number.isFinite(lift) || lift <= 0) return weights;
    return weights.map(value => value + lift);
  }

  /**
   * @param entries  `[{ value }]` in display order; `value` is the number the
   *                 user typed for the selected mode.
   * @param config   `{ mode, temperature, power, floorPercent }`.
   * @returns `{ weights, mode, notes }` where notes are user-facing remarks.
   */
  function compute(entries, config = {}) {
    const mode = modeById(config.mode);
    const notes = [];
    let weights;
    switch (mode.id) {
      case 'equal':
      case 'rank': {
        const power = mode.id === 'rank' ? parameterOf(config, mode) : 0;
        weights = entries.map((entry, index) => (power === 0 ? 1 : 1 / (index + 1) ** power));
        break;
      }
      case 'softmax': {
        const temperature = parameterOf(config, mode);
        const scores = entries.map(entry => finite(entry.value, 0));
        const peak = scores.length > 0 ? Math.max(...scores) : 0;
        /* Subtract the maximum before exponentiating: exp(700) overflows to
           Infinity while the ratio is perfectly well defined. */
        weights = scores.map(score => Math.exp((score - peak) / temperature));
        const spread = peak - Math.min(...scores);
        if (spread > 40 * temperature) notes.push('评分差距远大于温度，低分项概率已接近 0，可调高温度。');
        break;
      }
      case 'score':
      default: {
        weights = entries.map(entry => Math.max(0, finite(entry.value, 0)));
        if (weights.every(value => value <= 0)) {
          weights = entries.map(() => 1);
          notes.push('没有任何正数权重，已按等概率处理。');
        } else if (weights.some(value => value <= 0)) {
          notes.push('数值为 0 的选项不会被抽中；想临时排除又不想改数值，可以停用该选项。');
        }
        break;
      }
    }
    const floorPercent = Math.min(Math.max(finite(config.floorPercent, 0), 0), 100);
    if (floorPercent > 0) weights = applyFloor(weights, floorPercent / 100);
    const sum = weights.reduce((total, value) => total + value, 0);
    if (!(sum > 0)) weights = entries.map(() => 1);
    return { weights, mode: mode.id, notes };
  }

  /**
   * Reads one option line the way the original script did, but without losing
   * the label: `吃火锅 3` yields label `吃火锅` and value 3, where the script
   * kept the whole line as the label and printed the weight with it.
   */
  function parseValue(text) {
    const source = String(text ?? '').trim();
    if (source === '') return { label: '', value: null };
    const patterns = [
      /^(.*?)[\s,，、|]+\*?\s*(-?\d+(?:\.\d+)?)\s*%?\s*$/,
      /^(.*?)\s*[（(]\s*(-?\d+(?:\.\d+)?)\s*%?\s*[)）]\s*$/,
      /^(.*?)\s*[:：]\s*(-?\d+(?:\.\d+)?)\s*%?\s*$/,
    ];
    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (match && match[1].trim() !== '') {
        return { label: match[1].trim(), value: Number.parseFloat(match[2]), explicit: true };
      }
    }
    return { label: source, value: null, explicit: false };
  }

  globalThis.wheelDistribution = { MODES, DEFAULT_MODE, modeById, compute, applyFloor, parameterOf, parseValue, EPSILON };
})();
