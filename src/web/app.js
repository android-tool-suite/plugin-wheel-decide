(() => {
  'use strict';

  const model = globalThis.wheelModel;
  const distribution = globalThis.wheelDistribution;
  const strategies = globalThis.wheelStrategies;
  const runtime = globalThis.wheelRuntime;
  const storage = globalThis.wheelStorage;
  const canvasLib = globalThis.wheelCanvas;

  const ICONS = {
    add: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z',
    up: 'M12 5l7 7h-4v7h-6v-7H5z',
    down: 'M12 19l-7-7h4V5h6v7h4z',
    trash: 'M9 3h6l1 2h5v2H3V5h5zM5 9h14l-1 11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2z',
    eye: 'M12 5c-5 0-9 4.5-9 7s4 7 9 7 9-4.5 9-7-4-7-9-7zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm0-2a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
    eyeOff: 'M3.3 2 2 3.3l4.1 4.1A11.7 11.7 0 0 0 3 12c0 2.5 4 7 9 7 1.5 0 2.9-.4 4.2-1.1L19.7 21 21 19.7zM12 17a5 5 0 0 1-5-5c0-.6.1-1.1.3-1.6l1.7 1.7a3 3 0 0 0 3.9 3.9l1.7 1.7c-.8.2-1.7.3-2.6.3zm9-5c0-2.5-4-7-9-7-.8 0-1.6.1-2.4.3l2.1 2.1A6 6 0 0 1 16 11.4l2.6 2.6c1.5-1.6 2.4-3.3 2.4-4z',
    check: 'M9.5 17.5 4 12l1.4-1.4 4.1 4.1L18.6 5.6 20 7z',
    close: 'M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6z',
    copy: 'M8 3h9a2 2 0 0 1 2 2v11h-2V5H8zM5 7h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z',
  };

  const state = {
    store: model.normalizeStore(null),
    history: [],
    temporary: model.createTemporaryWheel({ options: [model.createOption('选项一', 1), model.createOption('选项二', 1)] }),
    wheel: null,
    round: strategies.createRound(),
    plan: null,
    source: globalThis.wheelRandom.createSource(),
    lastResults: [],
    spinning: false,
    loading: true,
    problems: [],
    presetEditingId: '',
    pendingConfirm: null,
    persistTimer: null,
    persistPending: { store: false, history: false },
  };

  const elements = {};
  let wheel = null;
  let feedback = null;

  /* ------------------------------------------------------------------ utils */

  function node(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text != null) item.textContent = text;
    return item;
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICONS[name]);
    svg.append(path);
    return svg;
  }

  function iconButton(name, label, extraClass = '') {
    const button = node('button', `icon-button ${extraClass}`.trim());
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.append(icon(name));
    return button;
  }

  /* Percentages are apportioned to one decimal so the column adds up to
     exactly 100.0. A share that is real but below the displayed precision is
     shown as "<0.1%" rather than "0.0%", which would claim the option can
     never win. */
  function shareText(share) {
    if (!Number.isFinite(share)) return '—';
    if (share > 0 && share < 0.05) return '<0.1%';
    return `${share.toFixed(1)}%`;
  }

  function shareOf(index) {
    return state.plan.shares[index];
  }

  function shareForOption(id) {
    const index = state.plan.entries.findIndex(entry => entry.id === id);
    return index < 0 ? null : state.plan.shares[index];
  }

  function clockText(at) {
    const date = new Date(at);
    if (Number.isNaN(date.getTime())) return '—';
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    return `${day} ${time}`;
  }

  function notice(text, tone = 'neutral') {
    elements.notice.hidden = !text;
    elements.notice.className = tone === 'neutral' ? 'notice' : `notice ${tone}`;
    elements.notice.textContent = text || '';
  }

  /* ------------------------------------------------------------------- data */

  function activeWheelId() {
    return state.store.activeWheelId || '';
  }

  function findWheel(id) {
    return state.store.wheels.find(item => item.id === id) || null;
  }

  function isTemporaryActive() {
    return model.isTemporary(state.wheel);
  }

  function recompute() {
    state.plan = model.buildPlan(state.wheel, state.round);
    return state.plan;
  }

  function schedulePersist(kind) {
    if (kind === 'store') state.persistPending.store = true;
    if (kind === 'history') state.persistPending.history = true;
    clearTimeout(state.persistTimer);
    state.persistTimer = setTimeout(() => { void flushPersist(); }, 400);
  }

  async function flushPersist() {
    const pending = { ...state.persistPending };
    state.persistPending = { store: false, history: false };
    if (!pending.store && !pending.history) return;
    try {
      if (pending.store) await storage.saveStore(state.store);
      if (pending.history) await storage.saveHistory(state.history);
    } catch (error) {
      feedback.show(`保存失败：${error.message}`, { error: true });
    }
  }

  /* --------------------------------------------------------------- rendering */

  function renderContext() {
    const temporary = isTemporaryActive();
    elements['wheel-name'].textContent = state.wheel.name;
    elements['wheel-kind'].textContent = temporary ? '一次性临时转盘' : '已保存预设';
    elements['wheel-kind'].className = `badge${temporary ? ' temp' : ''}`;
    elements['wheel-count'].textContent = `${state.wheel.options.length} 个选项 · 参与 ${state.plan.entries.length} 个`;
    elements['save-title'].textContent = temporary ? '保存为预设' : '另存为新预设';
    elements['save-description'].textContent = temporary
      ? '保存后可以随时切回这个转盘，临时转盘本身不会被保留。'
      : '会复制当前转盘为一个新预设，原来的预设保持不变。';
  }

  function renderWheel() {
    const slices = state.plan.entries.map((entry, index) => ({
      label: entry.label,
      share: state.plan.probabilities[index] ?? 0,
    }));
    wheel.setSlices(slices);
    const summary = slices.length === 0
      ? '转盘当前没有可抽取的选项。'
      : `转盘共 ${slices.length} 个参与选项：${slices
        .map((slice, index) => `${slice.label} ${shareText(shareOf(index))}`)
        .join('、')}。`;
    elements.wheel.setAttribute('aria-label', summary);
  }

  function renderModes() {
    elements.modes.replaceChildren(...distribution.MODES.map(mode => {
      const button = node('button', 'chip');
      button.type = 'button';
      button.textContent = mode.label;
      button.dataset.mode = mode.id;
      button.dataset.control = `mode:${mode.id}`;
      button.setAttribute('aria-pressed', String(mode.id === state.wheel.config.mode));
      button.onclick = () => {
        state.wheel.config.mode = mode.id;
        state.store.prefs.lastMode = mode.id;
        model.touch(state.wheel);
        commitChange({ structure: true, persist: true });
      };
      return button;
    }));
    const mode = distribution.modeById(state.wheel.config.mode);
    elements['mode-summary'].textContent = mode.summary;
    const parameter = mode.parameter;
    if (!parameter) {
      elements['mode-parameter'].replaceChildren();
    } else {
      const value = state.wheel.config[parameter.key];
      const wrapper = node('label', 'field');
      const head = node('span', 'field-head');
      head.append(node('span', null, parameter.label), node('strong', 'tabular', String(value)));
      const input = node('input');
      input.type = 'range';
      input.min = String(parameter.min);
      input.max = String(parameter.max);
      input.step = String(parameter.step);
      input.value = String(value);
      input.id = `parameter-${parameter.key}`;
      input.dataset.control = `parameter:${parameter.key}`;
      input.setAttribute('aria-valuetext', `${parameter.label} ${value}`);
      input.oninput = event => {
        state.wheel.config[parameter.key] = Number(event.target.value);
        head.lastChild.textContent = String(state.wheel.config[parameter.key]);
        model.touch(state.wheel);
        recompute();
        renderWheel();
        updateOptionShares();
        renderOptionsHint();
        schedulePersist('store');
      };
      wrapper.append(head, input, node('small', 'supporting', parameter.hint));
      elements['mode-parameter'].replaceChildren(wrapper);
    }
    elements.floor.value = String(state.wheel.config.floorPercent);
    elements['floor-hint'].textContent = state.wheel.config.floorPercent > 0
      ? `每个参与选项至少 ${state.wheel.config.floorPercent}% 的概率`
      : '0 表示不设下限';
    elements.notes.replaceChildren(...state.plan.notes.map(text => node('p', 'supporting', text)));
  }

  function renderPolicies() {
    elements.policies.replaceChildren(...strategies.POLICIES.map(policy => {
      const button = node('button', 'chip');
      button.type = 'button';
      button.textContent = policy.label;
      button.dataset.policy = policy.id;
      button.dataset.control = `policy:${policy.id}`;
      button.setAttribute('aria-pressed', String(policy.id === state.wheel.config.postSpin));
      button.onclick = () => {
        state.wheel.config.postSpin = policy.id;
        /* A round belongs to the policy that produced it; carrying "removed"
           entries into a policy that never removes anything would be a
           state the user cannot explain. */
        state.round = strategies.createRound();
        model.touch(state.wheel);
        commitChange({ structure: true, persist: true });
      };
      return button;
    }));
    const policy = strategies.policyById(state.wheel.config.postSpin);
    elements['policy-summary'].textContent = policy.summary;
    const parameter = policy.parameter;
    if (!parameter) {
      elements['policy-parameter'].replaceChildren();
    } else {
      const value = state.wheel.config[parameter.key];
      const wrapper = node('label', 'field');
      const head = node('span', 'field-head');
      head.append(node('span', null, parameter.label), node('strong', 'tabular', String(value)));
      const input = node('input');
      input.type = 'range';
      input.min = String(parameter.min);
      input.max = String(parameter.max);
      input.step = String(parameter.step);
      input.value = String(value);
      input.id = `policy-${parameter.key}`;
      input.dataset.control = `policy-parameter:${parameter.key}`;
      input.setAttribute('aria-valuetext', `${parameter.label} ${value}`);
      input.oninput = event => {
        state.wheel.config[parameter.key] = Number(event.target.value);
        head.lastChild.textContent = String(state.wheel.config[parameter.key]);
        model.touch(state.wheel);
        recompute();
        renderWheel();
        updateOptionShares();
        renderRoundSummary();
        schedulePersist('store');
      };
      wrapper.append(head, input, node('small', 'supporting', parameter.hint));
      elements['policy-parameter'].replaceChildren(wrapper);
    }
    renderRoundSummary();
  }

  function renderRoundSummary() {
    const policy = strategies.policyById(state.wheel.config.postSpin);
    elements['round-summary'].textContent = policy.id === 'keep'
      ? '当前策略不会改变转盘。'
      : strategies.summarize(state.round, state.wheel.options, state.wheel.config);
    elements['reset-round'].disabled = strategies.isNeutral(state.round);
  }

  /**
   * Why an option is not in the current draw, in the user's words. The reason
   * is shown in the percentage column: a bare "—" where a number used to be
   * looks like a bug otherwise. `full` goes in the tooltip and the label.
   */
  function exclusionOf(option) {
    if (!option.enabled) return { short: '已停用', full: '已停用，不参与抽取' };
    if (state.round.removed.includes(option.id)) return { short: '本轮移出', full: '本轮已抽中并移出，重置本轮后恢复' };
    const cooling = state.round.cooldowns[option.id];
    if (cooling) return { short: `冷却 ${cooling}`, full: `冷却中，还需 ${cooling} 次抽取才恢复` };
    return null;
  }

  function optionRow(option, index) {
    const active = state.plan.entries.findIndex(entry => entry.id === option.id);
    const probability = active < 0 ? null : state.plan.probabilities[active];
    const exclusion = exclusionOf(option);
    const row = node('li', `option-row${exclusion ? ' excluded' : ''}`);
    row.dataset.option = option.id;

    const badge = node('span', 'option-index tabular', String(index + 1));

    const label = node('input', 'option-label');
    label.type = 'text';
    label.value = option.label;
    label.maxLength = model.LIMITS.labelLength;
    label.setAttribute('aria-label', `第 ${index + 1} 个选项的名称`);
    label.dataset.control = `label:${option.id}`;
    label.oninput = event => {
      option.label = event.target.value;
      model.touch(state.wheel);
      renderWheel();
      schedulePersist('store');
    };
    label.onchange = () => {
      option.label = event.target.value.trim() === '' ? `选项 ${index + 1}` : event.target.value.trim();
      label.value = option.label;
      commitChange({ structure: true, persist: true });
    };

    const value = node('input', 'option-value tabular');
    value.type = 'number';
    value.inputMode = 'decimal';
    value.step = '0.1';
    value.min = '0';
    value.value = String(roundValue(option.value));
    value.disabled = state.wheel.config.mode === 'equal' || state.wheel.config.mode === 'rank';
    value.setAttribute('aria-label', `${option.label} 的${distribution.modeById(state.wheel.config.mode).inputLabel}`);
    value.dataset.control = `value:${option.id}`;
    value.oninput = () => {
      if (value.value === '') return;
      option.value = model.clampNumber(Number(value.value), 0, 1e12, option.value);
      state.round = strategies.reconcile(state.round, state.wheel.options, option.id);
      model.touch(state.wheel);
      recompute();
      renderWheel();
      updateOptionShares();
      renderRoundSummary();
      schedulePersist('store');
    };
    value.onchange = () => {
      option.value = model.clampNumber(Number(value.value), 0, 1e12, 1);
      value.value = String(roundValue(option.value));
      commitChange({ structure: true, persist: true });
    };

    const share = node('span', exclusion ? 'option-share option-exclusion' : 'option-share tabular',
      exclusion ? exclusion.short : shareText(state.plan.shares[active]));
    share.dataset.share = option.id;
    if (exclusion) share.title = exclusion.full;

    const up = iconButton('up', `把${option.label}上移`);
    up.disabled = index === 0;
    up.onclick = () => moveOption(index, -1);
    const down = iconButton('down', `把${option.label}下移`);
    down.disabled = index === state.wheel.options.length - 1;
    down.onclick = () => moveOption(index, 1);

    const toggle = iconButton(option.enabled ? 'eye' : 'eyeOff', option.enabled ? `停用${option.label}` : `启用${option.label}`);
    toggle.setAttribute('aria-pressed', String(option.enabled));
    toggle.onclick = () => {
      option.enabled = !option.enabled;
      model.touch(state.wheel);
      commitChange({ structure: true, persist: true });
    };

    const remove = iconButton('trash', `删除${option.label}`, 'danger-text');
    remove.onclick = () => {
      if (state.wheel.options.length <= 1) {
        feedback.show('至少保留一个选项。', { error: true });
        return;
      }
      state.wheel.options.splice(index, 1);
      state.round = strategies.reconcile(state.round, state.wheel.options);
      model.touch(state.wheel);
      commitChange({ structure: true, persist: true });
    };

    const main = node('div', 'option-main');
    main.append(badge, label, share);
    const meta = node('div', 'option-meta');
    const valueField = node('label', 'option-value-field');
    valueField.append(node('span', 'option-value-label', distribution.modeById(state.wheel.config.mode).inputLabel), value);
    meta.append(valueField, up, down, toggle, remove);
    row.append(main, meta);
    return row;
  }

  function roundValue(value) {
    return Number.isInteger(value) ? value : Number(value.toFixed(4));
  }

  function updateOptionShares() {
    for (const option of state.wheel.options) {
      const holder = elements.options.querySelector(`[data-share="${option.id}"]`);
      if (!holder) continue;
      const index = state.plan.entries.findIndex(entry => entry.id === option.id);
      const exclusion = index < 0 ? exclusionOf(option) : null;
      /* The cell is either a percentage or the reason there is none, never
         both, so the column width stays stable while the wheel changes. */
      holder.className = exclusion ? 'option-share option-exclusion' : 'option-share tabular';
      holder.textContent = exclusion ? exclusion.short : shareText(state.plan.shares[index]);
      holder.title = exclusion ? exclusion.full : '';
      holder.closest('.option-row')?.classList.toggle('excluded', Boolean(exclusion));
    }
  }

  function renderOptions() {
    const focused = document.activeElement?.dataset?.control;
    const caret = document.activeElement?.selectionStart ?? null;
    elements.options.replaceChildren(...state.wheel.options.map(optionRow));
    elements['options-empty'].hidden = state.wheel.options.length > 0;
    elements['options-hint'].textContent = state.wheel.options.length >= model.LIMITS.options
      ? `已达上限 ${model.LIMITS.options} 个选项。`
      : `最多 ${model.LIMITS.options} 个选项；停用的选项不参与抽取。`;
    if (focused) {
      const target = elements.options.querySelector(`[data-control="${focused}"]`);
      if (target) {
        target.focus({ preventScroll: true });
        if (caret !== null && typeof target.setSelectionRange === 'function') {
          try { target.setSelectionRange(caret, caret); } catch (_) { /* number inputs reject it */ }
        }
      }
    }
  }

  function renderOptionsHint() {
    elements['options-hint'].textContent = state.wheel.options.length >= model.LIMITS.options
      ? `已达上限 ${model.LIMITS.options} 个选项。`
      : `最多 ${model.LIMITS.options} 个选项；停用的选项不参与抽取。`;
  }

  function renderResult() {
    const results = state.lastResults;
    elements.result.hidden = results.length === 0;
    elements['result-label'].textContent = results[0]?.label ?? '';
    elements['result-probability'].textContent = results[0] ? `当时概率 ${shareText(results[0].share)}` : '';
    elements['result-detail'].textContent = results[0]?.detail ?? '';
    if (results.length > 1) {
      elements['result-more'].replaceChildren(...results.map((item, index) => {
        const row = node('li', 'timeline-item');
        row.append(
          node('strong', null, `${index + 1}. ${item.label}`),
          node('small', 'supporting', `当时概率 ${shareText(item.share)}${item.detail ? ` · ${item.detail}` : ''}`),
        );
        return row;
      }));
      elements['result-more'].hidden = false;
    } else {
      elements['result-more'].replaceChildren();
      elements['result-more'].hidden = true;
    }
    elements['result-actions'].hidden = results.length === 0;
  }

  function renderHistory() {
    elements['history-count'].textContent = state.history.length === 0 ? '暂无记录' : `${state.history.length} 条记录`;
    elements['history-clear'].disabled = state.history.length === 0;
    elements['history-copy'].disabled = state.history.length === 0;
    if (state.history.length === 0) {
      elements.history.replaceChildren(node('p', 'empty', '还没有抽取记录。抽取结果会自动记录在这里，只保存在本机。'));
      return;
    }
    elements.history.replaceChildren(...state.history.slice(0, 100).map(entry => {
      const row = node('li', 'timeline-item');
      const head = node('div', 'history-head');
      head.append(node('strong', null, entry.label), node('span', 'badge', shareText(entry.share)));
      row.append(head, node('small', 'supporting', `${clockText(entry.at)} · ${entry.wheelName}${entry.detail ? ` · ${entry.detail}` : ''}`));
      return row;
    }));
    if (state.history.length > 100) {
      elements.history.append(node('p', 'supporting', `仅显示最近 100 条，另有 ${state.history.length - 100} 条未显示。`));
    }
  }

  function renderDrawCount() {
    elements['draw-count'].value = String(state.wheel.config.drawCount);
    elements['draw-hint'].textContent = state.wheel.config.drawCount === 1
      ? '一次抽一个'
      : `一次抽 ${state.wheel.config.drawCount} 个，逐个计算，抽中后的调整会立即生效`;
  }

  function renderDialogs() {
    renderPresets();
    elements['import-preview'].textContent = '';
  }

  function render() {
    recompute();
    renderContext();
    renderWheel();
    renderModes();
    renderPolicies();
    renderOptions();
    renderResult();
    renderHistory();
    renderDrawCount();
    document.body.classList.remove('initializing');
    document.body.removeAttribute('aria-busy');
    state.loading = false;
  }

  /* Full change: rebuild everything that depends on the plan and persist. */
  function commitChange({ structure = false, persist = false, history = false } = {}) {
    recompute();
    if (structure) {
      renderOptions();
      renderModes();
      renderPolicies();
      renderDrawCount();
      renderContext();
    }
    renderWheel();
    updateOptionShares();
    renderRoundSummary();
    renderResult();
    if (history) renderHistory();
    if (persist) schedulePersist('store');
    if (history) schedulePersist('history');
  }

  function moveOption(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= state.wheel.options.length) return;
    const [item] = state.wheel.options.splice(index, 1);
    state.wheel.options.splice(target, 0, item);
    model.touch(state.wheel);
    commitChange({ structure: true, persist: true });
    elements.options.querySelector(`[data-option="${item.id}"] [data-control^="label:"]`)?.focus({ preventScroll: true });
  }

  /* -------------------------------------------------------------- wheel ops */

  function activateWheel(next) {
    state.wheel = next;
    state.round = strategies.createRound();
    state.lastResults = [];
    render();
  }

  function selectWheel(id) {
    if (id === model.TEMPORARY_ID) {
      state.store.activeWheelId = model.TEMPORARY_ID;
      activateWheel(state.temporary);
    } else {
      const found = findWheel(id);
      if (!found) return;
      state.store.activeWheelId = id;
      activateWheel(found);
    }
    schedulePersist('store');
  }

  function saveTemporaryAsPreset(name) {
    if (state.store.wheels.length >= model.LIMITS.presets) {
      feedback.show(`最多保存 ${model.LIMITS.presets} 个预设，请先删除不用的预设。`, { error: true });
      return;
    }
    const copy = model.duplicateWheel(state.wheel, name || state.wheel.name || '新的转盘');
    copy.name = name || copy.name;
    state.store.wheels.push(copy);
    state.store.activeWheelId = copy.id;
    activateWheel(copy);
    schedulePersist('store');
    feedback.show(`已保存预设「${copy.name}」。`);
  }

  function newWheel() {
    if (state.store.wheels.length >= model.LIMITS.presets) {
      feedback.show(`最多保存 ${model.LIMITS.presets} 个预设，请先删除不用的预设。`, { error: true });
      return;
    }
    const created = model.createWheel({ name: `转盘 ${state.store.wheels.length + 1}` });
    state.store.wheels.push(created);
    state.store.activeWheelId = created.id;
    activateWheel(created);
    schedulePersist('store');
  }

  function resetTemporary() {
    state.temporary = model.createTemporaryWheel({ options: [model.createOption('选项一', 1), model.createOption('选项二', 1)] });
    state.store.activeWheelId = model.TEMPORARY_ID;
    activateWheel(state.temporary);
    schedulePersist('store');
  }

  /* ------------------------------------------------------------------ spin */

  async function spin() {
    if (state.spinning) return;
    const plan = recompute();
    if (plan.entries.length === 0) {
      feedback.show(state.wheel.options.length === 0 ? '转盘里还没有选项，先添加选项。' : '所有选项都已停用或冷却中。', { error: true });
      return;
    }
    state.spinning = true;
    elements.spin.disabled = true;
    elements['spin-label'].textContent = '抽取中';
    const winnerIndex = plan.sampler.sample(state.source);
    const outcome = model.spin(state.wheel, state.round, state.source, state.wheel.config.drawCount);
    state.round = outcome.round;
    if (outcome.error) {
      state.spinning = false;
      elements.spin.disabled = false;
      elements['spin-label'].textContent = '开始抽取';
      feedback.show(outcome.error, { error: true });
      return;
    }
    const animating = wheel.animateTo(winnerIndex, { turns: 3 + Math.min(3, state.wheel.config.drawCount) });
    state.lastResults = outcome.results;
    const stamp = Date.now();
    for (const [index, result] of outcome.results.entries()) {
      /* Count backwards so the first draw of a batch is the newest entry once
         the history is sorted by time. */
      state.history.unshift(model.historyEntry(state.wheel, result, { at: stamp - index }));
    }
    state.history = model.normalizeHistory({ entries: state.history });
    await animating;
    state.spinning = false;
    elements.spin.disabled = false;
    elements['spin-label'].textContent = '开始抽取';
    for (const text of outcome.notices) feedback.show(text);
    commitChange({ structure: true, persist: true, history: true });
  }

  /* --------------------------------------------------------------- dialogs */

  function openDialog(dialog) {
    if (!dialog.open) dialog.showModal();
    runtime.call('app.setBackNavigation', { enabled: true }).catch(() => {});
  }

  function closeDialog(dialog) {
    if (dialog.open) dialog.close();
  }

  function syncBackNavigation() {
    const open = [...document.querySelectorAll('dialog[open]')].length > 0;
    runtime.call('app.setBackNavigation', { enabled: open }).catch(() => {});
  }

  function askConfirm({ title, description, action, run }) {
    state.pendingConfirm = run;
    elements['confirm-title'].textContent = title;
    elements['confirm-description'].textContent = description;
    elements['confirm-action'].textContent = action;
    openDialog(elements['confirm-dialog']);
  }

  function renderPresets() {
    const items = [];
    const temporaryRow = node('li', 'preset-row');
    const temporaryPick = node('button', 'preset-pick');
    temporaryPick.type = 'button';
    temporaryPick.dataset.preset = model.TEMPORARY_ID;
    temporaryPick.setAttribute('aria-pressed', String(isTemporaryActive()));
    temporaryPick.append(
      node('strong', null, state.temporary.name),
      node('small', 'supporting', `一次性 · 关闭工具后不保留 · ${state.temporary.options.length} 个选项`),
    );
    temporaryPick.onclick = () => { selectWheel(model.TEMPORARY_ID); closeDialog(elements['preset-dialog']); };
    temporaryRow.append(temporaryPick);
    const temporaryReset = node('button', 'text-button');
    temporaryReset.type = 'button';
    temporaryReset.textContent = '重置';
    temporaryReset.onclick = () => { resetTemporary(); closeDialog(elements['preset-dialog']); };
    temporaryRow.append(temporaryReset);
    items.push(temporaryRow);

    if (state.store.wheels.length === 0) {
      const empty = node('li', 'preset-row');
      empty.append(node('p', 'empty', '还没有保存的预设。保存后会一直保留在本机，可以随时切回来继续用同一个转盘。'));
      items.push(empty);
    }

    for (const preset of state.store.wheels) {
      const row = node('li', 'preset-row');
      if (state.presetEditingId === preset.id) {
        const form = node('div', 'preset-edit');
        const input = node('input');
        input.type = 'text';
        input.value = preset.name;
        input.maxLength = model.LIMITS.wheelNameLength;
        input.setAttribute('aria-label', '预设名称');
        input.dataset.control = `preset-name:${preset.id}`;
        const actions = node('div', 'button-row');
        const save = node('button', 'secondary', '保存名称');
        save.type = 'button';
        save.onclick = () => {
          preset.name = input.value.trim() === '' ? preset.name : input.value.trim().slice(0, model.LIMITS.wheelNameLength);
          model.touch(preset);
          state.presetEditingId = '';
          schedulePersist('store');
          renderPresets();
          if (state.wheel.id === preset.id) renderContext();
        };
        const copy = node('button', 'secondary', '复制一份');
        copy.type = 'button';
        copy.onclick = () => {
          if (state.store.wheels.length >= model.LIMITS.presets) {
            feedback.show(`最多保存 ${model.LIMITS.presets} 个预设。`, { error: true });
            return;
          }
          const duplicate = model.duplicateWheel(preset);
          state.store.wheels.push(duplicate);
          state.presetEditingId = '';
          schedulePersist('store');
          renderPresets();
          feedback.show(`已复制为「${duplicate.name}」。`);
        };
        const remove = node('button', 'danger', '删除预设');
        remove.type = 'button';
        remove.onclick = () => {
          askConfirm({
            title: '删除预设',
            description: `「${preset.name}」及其选项会从本机删除，已抽取的历史记录会保留。`,
            action: '删除预设',
            run: () => {
              state.store.wheels = state.store.wheels.filter(item => item.id !== preset.id);
              state.presetEditingId = '';
              if (state.wheel.id === preset.id) {
                const fallback = state.store.wheels[0] || null;
                if (fallback) {
                  state.store.activeWheelId = fallback.id;
                  activateWheel(fallback);
                } else {
                  resetTemporary();
                }
              }
              schedulePersist('store');
              renderPresets();
              renderContext();
            },
          });
        };
        const cancel = node('button', 'text-button', '取消');
        cancel.type = 'button';
        cancel.onclick = () => { state.presetEditingId = ''; renderPresets(); };
        actions.append(save, copy, remove, cancel);
        form.append(node('span', 'field-label', '重命名'), input, actions);
        row.append(form);
      } else {
        const pick = node('button', 'preset-pick');
        pick.type = 'button';
        pick.dataset.preset = preset.id;
        pick.setAttribute('aria-pressed', String(preset.id === activeWheelId()));
        pick.append(
          node('strong', null, preset.name),
          node('small', 'supporting', `${preset.options.length} 个选项 · 更新于 ${clockText(preset.updatedAt)}`),
        );
        pick.onclick = () => { selectWheel(preset.id); closeDialog(elements['preset-dialog']); };
        const manage = node('button', 'text-button');
        manage.type = 'button';
        manage.textContent = '管理';
        manage.setAttribute('aria-label', `管理预设${preset.name}`);
        manage.dataset.control = `preset-manage:${preset.id}`;
        manage.onclick = () => {
          if (state.store.wheels.length <= 1) {
            /* Still allow renaming, but skip the destructive branch wording. */
          }
          state.presetEditingId = preset.id;
          renderPresets();
          elements['preset-list'].querySelector(`[data-control="preset-name:${preset.id}"]`)?.focus();
        };
        row.append(pick, manage);
      }
      items.push(row);
    }
    elements['preset-list'].replaceChildren(...items);
    elements['preset-count'].textContent = `${state.store.wheels.length} / ${model.LIMITS.presets} 个预设`;
  }

  /* ------------------------------------------------------------- interaction */

  function wire() {
    elements['wheel-picker'].onclick = () => { renderPresets(); openDialog(elements['preset-dialog']); };
    elements['preset-close'].onclick = () => closeDialog(elements['preset-dialog']);
    elements['preset-new'].onclick = () => { newWheel(); closeDialog(elements['preset-dialog']); };
    elements['preset-temporary'].onclick = () => { state.store.activeWheelId = model.TEMPORARY_ID; activateWheel(state.temporary); schedulePersist('store'); closeDialog(elements['preset-dialog']); };
    elements['save-preset'].onclick = () => {
      const input = elements['save-preset-name'];
      saveTemporaryAsPreset(input.value);
      closeDialog(elements['save-dialog']);
    };
    elements['save-cancel'].onclick = () => closeDialog(elements['save-dialog']);
    elements['open-save'].onclick = () => {
      /* A temporary wheel is called "临时转盘"; offering that as the preset name
         would produce two rows with the same label in the picker. */
      elements['save-preset-name'].value = isTemporaryActive() ? '我的转盘' : state.wheel.name;
      openDialog(elements['save-dialog']);
    };

    elements.spin.onclick = () => { void spin(); };

    elements['draw-count'].onchange = event => {
      state.wheel.config.drawCount = model.clampNumber(Number(event.target.value), 1, 20, 1);
      model.touch(state.wheel);
      commitChange({ structure: false, persist: true });
      renderDrawCount();
    };

    elements.floor.onchange = event => {
      state.wheel.config.floorPercent = model.clampNumber(Number(event.target.value), 0, 100, 0);
      model.touch(state.wheel);
      commitChange({ structure: false, persist: true });
      renderModes();
    };
    elements.floor.oninput = event => {
      elements['floor-hint'].textContent = Number(event.target.value) > 0
        ? `每个参与选项至少 ${Number(event.target.value)}% 的概率`
        : '0 表示不设下限';
    };

    elements['add-option'].onclick = () => {
      if (state.wheel.options.length >= model.LIMITS.options) {
        feedback.show(`最多 ${model.LIMITS.options} 个选项。`, { error: true });
        return;
      }
      const option = model.createOption(`选项 ${state.wheel.options.length + 1}`, 1);
      state.wheel.options.push(option);
      model.touch(state.wheel);
      commitChange({ structure: true, persist: true });
      const input = elements.options.querySelector(`[data-option="${option.id}"] [data-control^="label:"]`);
      if (input) {
        input.focus({ preventScroll: true });
        input.select();
      }
    };

    elements['reset-round'].onclick = () => {
      state.round = strategies.createRound();
      commitChange({ structure: true });
      feedback.show('已重置本轮，所有选项恢复到初始状态。');
    };

    elements['open-import'].onclick = () => {
      elements['import-text'].value = model.formatList(state.wheel);
      elements['import-preview'].textContent = '';
      openDialog(elements['import-dialog']);
    };
    elements['import-cancel'].onclick = () => closeDialog(elements['import-dialog']);
    elements['import-text'].oninput = () => {
      const parsed = model.parseList(elements['import-text'].value, 1);
      const lines = [];
      lines.push(`将替换为 ${parsed.options.length} 个选项。`);
      for (const warning of parsed.warnings) lines.push(warning);
      elements['import-preview'].textContent = parsed.options.length === 0 ? '没有识别到任何选项。' : lines.join('\n');
    };
    elements['import-apply'].onclick = () => {
      const parsed = model.parseList(elements['import-text'].value, 1);
      if (parsed.options.length === 0) {
        feedback.show('没有识别到任何选项，请每行写一个选项。', { error: true });
        return;
      }
      const apply = () => {
        state.wheel.options = parsed.options;
        state.round = strategies.createRound();
        model.touch(state.wheel);
        commitChange({ structure: true, persist: true });
        closeDialog(elements['import-dialog']);
        feedback.show(`已导入 ${parsed.options.length} 个选项。`);
      };
      if (state.wheel.options.length > 1) {
        askConfirm({
          title: '替换全部选项',
          description: `现有的 ${state.wheel.options.length} 个选项会被粘贴内容替换，本轮已做的移除与衰减也会重置。`,
          action: '替换选项',
          run: apply,
        });
      } else {
        apply();
      }
    };

    elements['options-copy'].onclick = () => { void copyText(model.formatList(state.wheel, shareForOption), '选项列表'); };
    elements['result-copy'].onclick = () => {
      const text = state.lastResults.map(item => `${item.label}\t${shareText(item.share)}`).join('\n');
      void copyText(text, '抽取结果');
    };
    elements['history-copy'].onclick = () => {
      const rows = ['时间\t转盘\t结果\t当时概率', ...state.history.map(entry => `${clockText(entry.at)}\t${entry.wheelName}\t${entry.label}\t${shareText(entry.share)}`)];
      void copyText(rows.join('\n'), '抽取历史');
    };
    elements['history-clear'].onclick = () => {
      askConfirm({
        title: '清空历史',
        description: '所有抽取记录会从本机删除，已保存的预设和当前转盘不受影响。',
        action: '清空历史',
        run: () => {
          state.history = [];
          renderHistory();
          schedulePersist('history');
        },
      });
    };
    elements['help-open'].onclick = () => openDialog(elements['help-dialog']);
    elements['help-close'].onclick = () => closeDialog(elements['help-dialog']);

    elements['confirm-cancel'].onclick = () => { state.pendingConfirm = null; closeDialog(elements['confirm-dialog']); };
    elements['confirm-action'].onclick = () => {
      const run = state.pendingConfirm;
      state.pendingConfirm = null;
      closeDialog(elements['confirm-dialog']);
      if (typeof run === 'function') run();
    };

    for (const dialog of document.querySelectorAll('dialog')) {
      dialog.addEventListener('close', () => {
        syncBackNavigation();
        if (dialog === elements['preset-dialog']) state.presetEditingId = '';
        if (dialog === elements['confirm-dialog']) state.pendingConfirm = null;
      });
    }

    elements['history-section'].addEventListener('toggle', () => {
      state.store.prefs.historyOpen = elements['history-section'].open;
      schedulePersist('store');
    });

    window.addEventListener('resize', () => wheel.render());
    window.addEventListener('orientationchange', () => setTimeout(() => wheel.render(), 120));
  }

  async function copyText(text, what) {
    if (text.trim() === '') {
      feedback.show(`${what}为空，没有可复制的内容。`, { error: true });
      return;
    }
    try {
      await runtime.call('clipboard.write', { text });
      feedback.show(`已复制${what}。`);
    } catch (error) {
      if (error.code === 'PERMISSION_DENIED') {
        feedback.show(`复制${what}需要剪贴板权限。`, { error: true, action: { label: '去授权', run: () => runtime.call('app.openPermissions').catch(() => {}) } });
      } else {
        feedback.show(`复制${what}失败：${error.message}`, { error: true });
      }
    }
  }

  /**
   * Publishes how much of the screen the software keyboard covers, for the
   * platforms that report it through `visualViewport`. Android WebView often
   * reports nothing here, which is why the stylesheet also keeps input dialogs
   * in the upper part of the screen rather than relying on this alone.
   */
  function watchKeyboard() {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const apply = () => {
      const covered = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
      document.documentElement.style.setProperty('--wheel-keyboard-inset', `${covered}px`);
      document.documentElement.dataset.keyboard = covered > 80 ? 'open' : 'closed';
    };
    viewport.addEventListener('resize', apply);
    viewport.addEventListener('scroll', apply);
    apply();
  }

  function runtimeEvent(message) {
    if (message.event === 'app.backRequested') {
      const open = [...document.querySelectorAll('dialog[open]')].pop();
      if (open) open.close();
      return;
    }
    if (message.event === 'app.visibilityChanged' && message.payload.visible !== false) {
      wheel.render();
    }
  }

  /* ------------------------------------------------------------------ boot */

  function collect() {
    for (const id of [
      'wheel-name', 'wheel-kind', 'wheel-count', 'wheel-picker', 'save-preset', 'open-save',
      'wheel', 'spin', 'spin-label', 'draw-count', 'draw-hint',
      'result', 'result-label', 'result-probability', 'result-detail', 'result-more', 'result-actions', 'result-copy',
      'modes', 'mode-summary', 'mode-parameter', 'floor', 'floor-hint', 'notes',
      'policies', 'policy-summary', 'policy-parameter', 'round-summary', 'reset-round',
      'options', 'options-empty', 'options-hint', 'options-copy', 'add-option', 'open-import',
      'history-section', 'history', 'history-count', 'history-clear', 'history-copy',
      'notice', 'snackbar',
      'preset-dialog', 'preset-list', 'preset-count', 'preset-close', 'preset-new', 'preset-temporary',
      'save-dialog', 'save-title', 'save-description', 'save-preset-name', 'save-cancel', 'save-preset',
      'import-dialog', 'import-text', 'import-preview', 'import-apply', 'import-cancel',
      'help-dialog', 'help-open', 'help-close',
      'confirm-dialog', 'confirm-title', 'confirm-description', 'confirm-action', 'confirm-cancel',
      'build-version',
    ]) {
      elements[id] = document.getElementById(id);
    }
  }

  async function boot() {
    collect();
    feedback = globalThis.wheelFeedback.create(elements.snackbar);
    wheel = canvasLib.create(elements.wheel);
    wire();
    watchKeyboard();
    runtime.on('*', () => {});
    for (const name of ['app.backRequested', 'app.visibilityChanged']) runtime.on(name, runtimeEvent);

    try {
      await runtime.ready;
    } catch (error) {
      notice(error.message, 'danger');
      document.body.classList.remove('initializing');
      document.body.removeAttribute('aria-busy');
      return;
    }

    const loaded = await storage.load();
    state.store = loaded.store;
    state.history = loaded.history;
    state.problems = loaded.problems;

    const active = activeWheelId() === model.TEMPORARY_ID
      ? state.temporary
      : findWheel(activeWheelId()) || state.store.wheels[0] || state.temporary;
    if (model.isTemporary(active) && state.store.activeWheelId !== model.TEMPORARY_ID) {
      state.store.activeWheelId = active.id;
      schedulePersist('store');
    }
    state.wheel = active;
    elements['history-section'].open = state.store.prefs.historyOpen;

    if (state.problems.length > 0) {
      notice(state.problems.join(' '));
    }
    render();
    if (globalThis.wheelBuild?.version) {
      elements['build-version'].textContent = `版本 ${globalThis.wheelBuild.version}`;
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { void boot(); });
  else void boot();
})();
