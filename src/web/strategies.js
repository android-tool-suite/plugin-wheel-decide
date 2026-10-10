(() => {
  'use strict';

  /**
   * What happens to the wheel after something is drawn.
   *
   * The original script kept every option forever, so a wheel with a favourite
   * entry could return it ten times in a row. These policies are the answer to
   * "keep going, but not the same answer again": each one changes the *next*
   * draw only, never the drawn result, and every change is recorded in the
   * round state so it can be undone as a whole.
   */
  const POLICIES = [
    {
      id: 'keep',
      label: '保留',
      summary: '抽中后不改变任何选项，每次都是同一个转盘。',
      parameter: null,
    },
    {
      id: 'remove',
      label: '移出本轮',
      summary: '抽中后该选项不再参与后续抽取，全部抽完自动开启新一轮。',
      parameter: null,
    },
    {
      id: 'decay',
      label: '概率衰减',
      summary: '抽中后把该选项的数值乘以衰减系数，连中会越来越难。',
      parameter: {
        key: 'decayFactor',
        label: '衰减系数',
        min: 0.05,
        max: 0.95,
        step: 0.05,
        fallback: 0.5,
        hint: '0.5 表示每抽中一次权重减半',
      },
    },
    {
      id: 'cooldown',
      label: '冷却',
      summary: '抽中后该选项在接下来若干次抽取中不参与，之后自动恢复。',
      parameter: {
        key: 'cooldownSpins',
        label: '冷却次数',
        min: 1,
        max: 20,
        step: 1,
        fallback: 3,
        hint: '冷却期间其余选项会分摊它的概率',
      },
    },
  ];

  function policyById(id) {
    return POLICIES.find(policy => policy.id === id) || POLICIES[0];
  }

  function createRound() {
    return { spin: 0, removed: [], decays: {}, baseline: {}, cooldowns: {}, replacements: 0 };
  }

  function cloneRound(round) {
    return {
      spin: round.spin,
      removed: [...round.removed],
      decays: { ...round.decays },
      baseline: { ...round.baseline },
      cooldowns: { ...round.cooldowns },
      replacements: round.replacements,
    };
  }

  function isNeutral(round) {
    return round.removed.length === 0
      && Object.keys(round.decays).length === 0
      && Object.keys(round.cooldowns).length === 0;
  }

  /* Counts down one tick for every cooling option. Called once per draw, has
     to run before the participating set is computed. */
  function tick(round) {
    const next = cloneRound(round);
    for (const [id, remaining] of Object.entries(next.cooldowns)) {
      if (remaining <= 1) delete next.cooldowns[id];
      else next.cooldowns[id] = remaining - 1;
    }
    return next;
  }

  function baselineOf(round, option) {
    return Object.prototype.hasOwnProperty.call(round.baseline, option.id)
      ? round.baseline[option.id]
      : option.value;
  }

  /**
   * Effective numeric value for an option, after every decay applied so far.
   * The wheel itself is never mutated: a decay only exists inside the round, so
   * a preset saved mid-round still stores what the user typed.
   */
  function effectiveValue(round, option, config = {}) {
    const steps = round.decays[option.id] || 0;
    if (!steps) return baselineOf(round, option);
    const factor = parameterOf(policyById(config.postSpin), config) ?? 0.5;
    return baselineOf(round, option) * factor ** steps;
  }

  function parameterOf(policy, config) {
    if (!policy.parameter) return null;
    const raw = Number(config?.[policy.parameter.key]);
    const value = Number.isFinite(raw) ? raw : policy.parameter.fallback;
    return Math.min(policy.parameter.max, Math.max(policy.parameter.min, value));
  }

  /**
   * Applies the policy to one drawn option and returns the next round state
   * plus a short user-facing description of what changed.
   */
  function apply(round, option, config = {}) {
    const policy = policyById(config.postSpin);
    const next = cloneRound(round);
    next.spin += 1;
    switch (policy.id) {
      case 'remove': {
        if (!next.removed.includes(option.id)) next.removed.push(option.id);
        return { round: next, policy: policy.id, detail: `已把「${option.label}」移出本轮` };
      }
      case 'decay': {
        const factor = parameterOf(policy, config);
        if (!Object.prototype.hasOwnProperty.call(next.baseline, option.id)) {
          next.baseline[option.id] = option.value;
        }
        next.decays[option.id] = (next.decays[option.id] || 0) + 1;
        const after = next.baseline[option.id] * factor ** next.decays[option.id];
        return {
          round: next,
          policy: policy.id,
          detail: `「${option.label}」数值 ${trim(next.baseline[option.id])} → ${trim(after)}`,
        };
      }
      case 'cooldown': {
        const spins = parameterOf(policy, config);
        next.cooldowns[option.id] = spins;
        return { round: next, policy: policy.id, detail: `「${option.label}」冷却 ${spins} 次` };
      }
      case 'keep':
      default:
        return { round: next, policy: policy.id, detail: null };
    }
  }

  function trim(value) {
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
  }

  /**
   * Rebuilds the round state after the caller edited the option list, so a
   * removed or decayed option cannot leak state onto an option that no longer
   * exists, and an edited value restarts that option's decay.
   */
  function reconcile(round, options, editedId = null) {
    const next = cloneRound(round);
    const present = new Set(options.map(option => option.id));
    next.removed = next.removed.filter(id => present.has(id) && id !== editedId);
    for (const id of Object.keys(next.decays)) {
      if (!present.has(id) || id === editedId) delete next.decays[id];
    }
    for (const id of Object.keys(next.baseline)) {
      if (!present.has(id) || id === editedId) delete next.baseline[id];
    }
    for (const id of Object.keys(next.cooldowns)) if (!present.has(id)) delete next.cooldowns[id];
    return next;
  }

  /** Human readable state of the round, for the "本轮" summary line. */
  function summarize(round, options, config = {}) {
    const policy = policyById(config.postSpin);
    if (policy.id === 'keep') return '本策略不会改变转盘';
    const parts = [];
    if (round.removed.length) parts.push(`已移出 ${round.removed.length} 项`);
    const decayed = Object.keys(round.decays).length;
    if (decayed) parts.push(`已衰减 ${decayed} 项`);
    const cooling = Object.keys(round.cooldowns).length;
    if (cooling) {
      const shortest = Math.min(...Object.values(round.cooldowns));
      parts.push(`${cooling} 项冷却中（最少还需 ${shortest} 次）`);
    }
    return parts.length ? parts.join(' · ') : `已抽取 ${round.spin} 次，暂未调整`;
  }

  globalThis.wheelStrategies = {
    POLICIES,
    policyById,
    parameterOf,
    createRound,
    cloneRound,
    isNeutral,
    tick,
    baselineOf,
    effectiveValue,
    apply,
    reconcile,
    summarize,
  };
})();
