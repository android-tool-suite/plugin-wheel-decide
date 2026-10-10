(() => {
  'use strict';

  const LIMITS = {
    options: 512,
    labelLength: 80,
    wheelNameLength: 60,
    presets: 64,
    history: 500,
    importLines: 2000,
  };

  const DEFAULT_CONFIG = {
    mode: 'score',
    temperature: 0.5,
    power: 1,
    floorPercent: 0,
    postSpin: 'keep',
    decayFactor: 0.5,
    cooldownSpins: 3,
    drawCount: 1,
    algorithm: 'auto',
  };

  function randomId(prefix) {
    const cryptoObject = globalThis.crypto;
    if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
      return `${prefix}-${cryptoObject.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    }
    return `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1679616).toString(36)}`;
  }

  function clampNumber(value, minimum, maximum, fallback) {
    const number = typeof value === 'number' ? value : Number.parseFloat(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, number));
  }

  function text(value, maximum, fallback = '') {
    const source = typeof value === 'string' ? value : value == null ? '' : String(value);
    const trimmed = source.replace(/\s+/g, ' ').trim();
    if (trimmed === '') return fallback;
    return trimmed.slice(0, maximum);
  }

  function createOption(label, value) {
    return { id: randomId('opt'), label: text(label, LIMITS.labelLength, '未命名选项'), value: clampNumber(value, 0, 1e12, 1) };
  }

  function normalizeConfig(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const mode = wheelDistribution.MODES.some(item => item.id === source.mode) ? source.mode : DEFAULT_CONFIG.mode;
    const postSpin = wheelStrategies.POLICIES.some(item => item.id === source.postSpin) ? source.postSpin : DEFAULT_CONFIG.postSpin;
    return {
      mode,
      temperature: clampNumber(source.temperature, 0.05, 5, DEFAULT_CONFIG.temperature),
      power: clampNumber(source.power, 0, 3, DEFAULT_CONFIG.power),
      floorPercent: clampNumber(source.floorPercent, 0, 100, DEFAULT_CONFIG.floorPercent),
      postSpin,
      decayFactor: clampNumber(source.decayFactor, 0.05, 0.95, DEFAULT_CONFIG.decayFactor),
      cooldownSpins: Math.round(clampNumber(source.cooldownSpins, 1, 20, DEFAULT_CONFIG.cooldownSpins)),
      drawCount: Math.round(clampNumber(source.drawCount, 1, LIMITS.options, DEFAULT_CONFIG.drawCount)),
      algorithm: ['auto', 'alias', 'prefix'].includes(source.algorithm) ? source.algorithm : DEFAULT_CONFIG.algorithm,
    };
  }

  function normalizeOption(raw, index) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
      id: typeof source.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(source.id) ? source.id : randomId('opt'),
      label: text(source.label, LIMITS.labelLength, `选项 ${index + 1}`),
      value: clampNumber(source.value, 0, 1e12, 1),
      enabled: source.enabled !== false,
    };
  }

  function createWheel(partial = {}) {
    const now = Date.now();
    const options = Array.isArray(partial.options) && partial.options.length > 0
      ? partial.options.map(normalizeOption)
      : [createOption('选项一', 1), createOption('选项二', 1)];
    return {
      id: typeof partial.id === 'string' && partial.id ? partial.id : randomId('wheel'),
      name: text(partial.name, LIMITS.wheelNameLength, '未命名转盘'),
      createdAt: Number.isFinite(partial.createdAt) ? partial.createdAt : now,
      updatedAt: Number.isFinite(partial.updatedAt) ? partial.updatedAt : now,
      options: options.slice(0, LIMITS.options),
      config: normalizeConfig(partial.config),
    };
  }

  function normalizeWheel(raw) {
    if (!raw || typeof raw !== 'object') return createWheel({});
    const wheel = createWheel(raw);
    if (Array.isArray(raw.options) && raw.options.length === 0) wheel.options = [];
    return wheel;
  }

  function touch(wheel) {
    wheel.updatedAt = Date.now();
    return wheel;
  }

  function cloneWheel(wheel) {
    return {
      ...wheel,
      options: wheel.options.map(option => ({ ...option })),
      config: { ...wheel.config },
    };
  }

  /**
   * Reads a pasted list. One option per line; a trailing number is the value
   * for the current distribution mode, so both "吃火锅 3" and "吃火锅,3" work
   * and a line without a number falls back to the mode's neutral value.
   *
   * The original script stored the whole line as the option name, so the weight
   * was printed back as part of the result; here the name and the number are
   * separated.
   */
  function parseList(source, fallbackValue = 1) {
    const lines = String(source ?? '').split(/\r?\n/).slice(0, LIMITS.importLines);
    const options = [];
    const warnings = [];
    const seen = new Map();
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
      if (options.length >= LIMITS.options) {
        warnings.push(`最多支持 ${LIMITS.options} 个选项，其余行已忽略。`);
        break;
      }
      const parsed = wheelDistribution.parseValue(trimmed);
      const label = text(parsed.label, LIMITS.labelLength, '');
      if (label === '') continue;
      const value = parsed.value === null ? fallbackValue : clampNumber(parsed.value, 0, 1e12, fallbackValue);
      if (seen.has(label)) {
        seen.set(label, seen.get(label) + 1);
      } else {
        seen.set(label, 1);
      }
      options.push({ id: randomId('opt'), label, value, enabled: true });
    }
    const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([label]) => label);
    if (duplicates.length > 0) {
      warnings.push(`有重复选项：${duplicates.slice(0, 3).join('、')}${duplicates.length > 3 ? ' 等' : ''}，它们会各自独立参与抽取。`);
    }
    return { options, warnings };
  }

  /**
   * Writes the wheel back out in the same shape `parseList` reads, so a copied
   * list can be pasted straight back in. `shareOf` optionally supplies the
   * current displayed percentage for an option id.
   */
  function formatList(wheel, shareOf = null) {
    return wheel.options
      .map(option => {
        const share = shareOf ? shareOf(option.id) : null;
        const suffix = Number.isFinite(share) ? `\t${share.toFixed(1)}%` : '';
        return `${option.label}\t${option.value}${suffix}`;
      })
      .join('\n');
  }

  function activeOptions(wheel) {
    return wheel.options.filter(option => option.enabled);
  }

  /**
   * Everything needed to draw once: the participating entries in wheel order,
   * their effective values, the exact sampler, and the probabilities the UI
   * shows. The displayed percentage comes from the same integers the sampler
   * uses, so what the user reads is what the draw actually does.
   */
  function buildPlan(wheel, round) {
    const removed = new Set(round.removed);
    const cooling = new Set(Object.keys(round.cooldowns));
    const entries = [];
    for (const option of wheel.options) {
      if (!option.enabled) continue;
      if (removed.has(option.id)) continue;
      if (cooling.has(option.id)) continue;
      entries.push({
        id: option.id,
        label: option.label,
        value: wheelStrategies.effectiveValue(round, option, wheel.config),
      });
    }
    const computed = wheelDistribution.compute(entries, wheel.config);
    const notes = [...computed.notes];
    if (entries.length === 0) {
      return { entries, weights: [], probabilities: [], shares: [], notes, sampler: null, excluded: { removed, cooling } };
    }
    const sampler = wheelSampler.createSampler(computed.weights, { algorithm: wheel.config.algorithm });
    const probabilities = sampler.probabilities();
    /* Displayed percentages come from the same integers as the draw, and are
       apportioned so the column adds up to exactly 100.0 instead of 99.9. */
    const shares = wheelSampler.formatPercentages(probabilities);
    return { entries, weights: computed.weights, probabilities, shares, notes, sampler, excluded: { removed, cooling } };
  }

  /**
   * Draws `count` options. Each draw re-plans the wheel because a post-spin
   * policy may have removed, decayed or cooled the previous winner; that is
   * also what makes "draw 3 without repeats" fall out of the same code path.
   */
  function spin(wheel, round, source, count = 1) {
    let state = wheelStrategies.reconcile(round, wheel.options);
    const results = [];
    const notices = [];
    const draws = Math.max(1, Math.min(Math.round(count) || 1, LIMITS.options));
    for (let index = 0; index < draws; index += 1) {
      state = wheelStrategies.tick(state);
      let plan = buildPlan(wheel, state);
      if (plan.entries.length === 0) {
        if (state.removed.length > 0) {
          state = { ...state, removed: [], replacements: state.replacements + 1 };
          notices.push('本轮选项已全部抽完，已自动开始新一轮。');
          plan = buildPlan(wheel, state);
        }
        if (plan.entries.length === 0) {
          return { round: state, results, notices, error: wheel.options.length === 0 ? '转盘里还没有选项。' : '所有选项都已停用或冷却中。' };
        }
      }
      const position = plan.sampler.sample(source);
      const entry = plan.entries[position];
      const probability = plan.probabilities[position];
      const applied = wheelStrategies.apply(state, entry, wheel.config);
      state = applied.round;
      results.push({ ...entry, probability, share: plan.shares[position], detail: applied.detail });
    }
    return { round: state, results, notices, error: null };
  }

  function historyEntry(wheel, result, extra = {}) {
    return {
      id: randomId('spin'),
      at: Date.now(),
      wheelId: wheel.id,
      wheelName: wheel.name,
      mode: wheel.config.mode,
      label: result.label,
      probability: Math.round(result.probability * 1e6) / 1e6,
      share: Number.isFinite(result.share) ? result.share : Math.round(result.probability * 1e4) / 100,
      detail: result.detail || null,
      ...extra,
    };
  }

  function normalizeHistory(raw) {
    const source = raw && typeof raw === 'object' && Array.isArray(raw.entries) ? raw.entries : [];
    return source
      .filter(item => item && typeof item === 'object' && typeof item.id === 'string' && typeof item.label === 'string')
      .map(item => ({
        id: item.id,
        at: Number.isFinite(item.at) ? item.at : Date.now(),
        wheelId: typeof item.wheelId === 'string' ? item.wheelId : '',
        wheelName: text(item.wheelName, LIMITS.wheelNameLength, '未命名转盘'),
        mode: typeof item.mode === 'string' ? item.mode : '',
        label: text(item.label, LIMITS.labelLength, ''),
        probability: clampNumber(item.probability, 0, 1, 0),
        share: clampNumber(item.share, 0, 100, clampNumber(item.probability, 0, 1, 0) * 100),
        detail: typeof item.detail === 'string' ? item.detail.slice(0, 120) : null,
      }))
      .sort((left, right) => right.at - left.at)
      .slice(0, LIMITS.history);
  }

  function normalizeStore(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const wheels = Array.isArray(source.wheels)
      ? source.wheels.filter(item => item && typeof item === 'object').map(normalizeWheel).slice(0, LIMITS.presets)
      : [];
    const activeWheelId = typeof source.activeWheelId === 'string' ? source.activeWheelId : '';
    const prefs = source.prefs && typeof source.prefs === 'object' ? source.prefs : {};
    return {
      formatVersion: 1,
      wheels,
      activeWheelId,
      prefs: {
        historyOpen: prefs.historyOpen === true,
        showProbability: prefs.showProbability !== false,
        lastMode: wheelDistribution.MODES.some(item => item.id === prefs.lastMode) ? prefs.lastMode : '',
      },
    };
  }

  const TEMPORARY_ID = '__temporary__';

  function createTemporaryWheel(partial = {}) {
    return createWheel({ ...partial, id: TEMPORARY_ID, name: text(partial.name, LIMITS.wheelNameLength, '临时转盘') });
  }

  function isTemporary(wheel) {
    return wheel.id === TEMPORARY_ID;
  }

  /**
   * Duplicating into a preset is how a temporary wheel becomes permanent
   * without the temporary slot ever being written to storage.
   */
  function duplicateWheel(wheel, name = null) {
    const copy = cloneWheel(wheel);
    copy.id = randomId('wheel');
    copy.name = text(name ?? (isTemporary(wheel) ? `${wheel.name} 副本` : `${wheel.name} 副本`), LIMITS.wheelNameLength, '未命名转盘');
    copy.options = wheel.options.map(option => ({ ...option, id: randomId('opt') }));
    copy.createdAt = Date.now();
    copy.updatedAt = copy.createdAt;
    return copy;
  }

  globalThis.wheelModel = {
    LIMITS,
    DEFAULT_CONFIG,
    TEMPORARY_ID,
    randomId,
    clampNumber,
    createOption,
    createWheel,
    normalizeWheel,
    normalizeConfig,
    normalizeStore,
    normalizeHistory,
    cloneWheel,
    touch,
    parseList,
    formatList,
    activeOptions,
    buildPlan,
    spin,
    historyEntry,
    createTemporaryWheel,
    isTemporary,
    duplicateWheel,
  };
})();
