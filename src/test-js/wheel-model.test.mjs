import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadWeb } from './helpers/load.mjs';

const web = loadWeb('random', 'sampler', 'distribution', 'strategies', 'wheel-model');
const model = web.wheelModel;
const strategies = web.wheelStrategies;
const { createSource } = web.wheelRandom;

function wheelOf(...labels) {
  return model.createWheel({ name: '测试', options: labels.map(label => model.createOption(label, 1)) });
}

test('createWheel() always produces a usable wheel', () => {
  const wheel = model.createWheel({});
  assert.equal(wheel.options.length, 2);
  assert.ok(wheel.id && wheel.name);
  assert.deepEqual(wheel.config, model.DEFAULT_CONFIG);
});

test('draw counts accept every integer in the supported range instead of a preset list', () => {
  const counts = [1, 7, 9, 11, 20, 21, 100, model.LIMITS.options];
  for (const count of counts) {
    assert.equal(model.parseDrawCount(count), count);
    assert.equal(model.parseDrawCount(String(count)), count);
    const wheel = wheelOf('甲', '乙');
    wheel.config = model.normalizeConfig({ drawCount: count });
    assert.equal(wheel.config.drawCount, count);
    const outcome = model.spin(wheel, strategies.createRound(), createSource({ seed: 'count-test' }), wheel.config.drawCount);
    assert.equal(outcome.error, null);
    assert.equal(outcome.results.length, count);
  }
});

test('invalid draw count drafts are rejected instead of rounded or silently clamped', () => {
  for (const value of ['', ' ', 'abc', '1.5', '0', '-1', '513', 0, -1, 1.5, 513, NaN, Infinity, null, undefined, true]) {
    assert.equal(model.parseDrawCount(value), null, `accepted invalid count ${String(value)}`);
  }
});

test('normalizeWheel() repairs anything storage could hand back', () => {
  const wheel = model.normalizeWheel({
    id: 'wheel-x',
    name: '  太多的    空格  ',
    options: [
      { id: 'bad id!', label: '', value: 'abc', enabled: 'yes' },
      { id: 'ok', label: '好', value: -5, enabled: false },
      null,
    ],
    config: { mode: '不存在', postSpin: '不存在', temperature: 99, drawCount: -3, algorithm: 'nope' },
  });
  assert.equal(wheel.options.length, 3);
  assert.match(wheel.options[0].id, /^opt-/);
  assert.equal(wheel.options[0].value, 1, 'a non-numeric value must fall back, not become NaN');
  assert.equal(wheel.options[0].enabled, true, 'only an explicit false disables an option');
  assert.equal(wheel.options[1].value, 0);
  assert.equal(wheel.options[1].enabled, false);
  assert.equal(wheel.config.mode, 'score');
  assert.equal(wheel.config.postSpin, 'keep');
  assert.equal(wheel.config.temperature, 5);
  assert.equal(wheel.config.drawCount, 1);
  assert.equal(wheel.config.algorithm, 'auto');
  assert.equal(wheel.name, '太多的 空格');
  assert.ok(!JSON.stringify(wheel).includes('NaN'));
});

test('normalizeWheel() keeps an empty option list empty instead of inventing options', () => {
  const wheel = model.normalizeWheel({ options: [] });
  assert.deepEqual(wheel.options, []);
});

test('normalizeStore() caps the preset list and repairs preferences', () => {
  const store = model.normalizeStore({
    wheels: Array.from({ length: 200 }, (_, index) => ({ id: `w${index}`, options: [] })),
    activeWheelId: 42,
    prefs: { historyOpen: 'yes', lastMode: 'nope' },
  });
  assert.equal(store.wheels.length, model.LIMITS.presets);
  assert.equal(store.activeWheelId, '');
  assert.equal(store.prefs.historyOpen, false);
  assert.equal(store.prefs.lastMode, '');
  assert.equal(store.prefs.showProbability, true);
  assert.deepEqual(model.normalizeStore(null).wheels, []);
});

test('parseList() reads one option per line and separates the weight', () => {
  const parsed = model.parseList([
    '# 今天吃什么',
    '吃火锅 3',
    '吃日料,1',
    '',
    '吃沙拉 0.5',
    '随便',
  ].join('\n'));
  assert.deepEqual(parsed.options.map(item => item.label), ['吃火锅', '吃日料', '吃沙拉', '随便']);
  assert.deepEqual(parsed.options.map(item => item.value), [3, 1, 0.5, 1]);
  assert.deepEqual(parsed.warnings, []);
});

test('parseList() keeps duplicate labels and warns about them', () => {
  /* The original script stored options in a dict but summed the weights
     separately, so a repeated label silently overwrote one entry while still
     contributing twice to the total. Duplicates are legal here, and the user is
     told about them. */
  const parsed = model.parseList('小明 1\n小红 1\n小明 1');
  assert.equal(parsed.options.length, 3);
  assert.ok(parsed.warnings.some(warning => warning.includes('小明')));
  const total = parsed.options.reduce((sum, item) => sum + item.value, 0);
  assert.equal(total, 3);
});

test('parseList() reports what it ignored instead of failing silently', () => {
  const tooMany = model.parseList(Array.from({ length: model.LIMITS.importLines }, () => 'x').join('\n'));
  assert.equal(tooMany.options.length, model.LIMITS.options);
  assert.ok(tooMany.warnings.some(warning => warning.includes(String(model.LIMITS.options))));
  assert.deepEqual(model.parseList('   \n\n  ').options, []);
});

test('formatList() round-trips through parseList()', () => {
  const wheel = wheelOf('甲', '乙', '丙');
  wheel.options[0].value = 3;
  wheel.options[1].value = 0.25;
  const parsed = model.parseList(model.formatList(wheel));
  assert.deepEqual(parsed.options.map(item => item.label), ['甲', '乙', '丙']);
  assert.deepEqual(parsed.options.map(item => item.value), [3, 0.25, 1]);
});

test('buildPlan() excludes disabled, removed and cooling options', () => {
  const wheel = wheelOf('甲', '乙', '丙');
  wheel.options[1].enabled = false;
  const round = { ...strategies.createRound(), removed: [wheel.options[2].id] };
  const plan = model.buildPlan(wheel, round);
  assert.deepEqual(plan.entries.map(entry => entry.label), ['甲']);
  assert.equal(plan.probabilities.length, 1);
  assert.equal(plan.shares[0], 100);
});

test('buildPlan() returns a plan without a sampler for an empty round', () => {
  const wheel = model.normalizeWheel({ options: [] });
  const plan = model.buildPlan(wheel, strategies.createRound());
  assert.deepEqual(plan.entries, []);
  assert.equal(plan.sampler, null);
  assert.deepEqual(plan.shares, []);
});

test('shares always add up to 100 in the plan the UI renders', () => {
  const wheel = model.createWheel({ name: 'x', options: 'abcdefg'.split('').map(letter => model.createOption(letter, 1)) });
  const plan = model.buildPlan(wheel, strategies.createRound());
  const total = plan.shares.reduce((sum, value) => sum + value, 0);
  assert.equal(Math.round(total * 10), 1000);
});

test('spin() is reproducible for a given seed and reaches every option', () => {
  const wheel = wheelOf('甲', '乙', '丙');
  const first = model.spin(wheel, strategies.createRound(), createSource({ seed: 'fixed' }), 40);
  const second = model.spin(wheel, strategies.createRound(), createSource({ seed: 'fixed' }), 40);
  assert.deepEqual(first.results.map(item => item.label), second.results.map(item => item.label));
  assert.equal(first.error, null);
  assert.ok(new Set(first.results.map(item => item.label)).size > 1);

  const all = model.spin(wheel, strategies.createRound(), createSource({ seed: 'coverage' }), 300);
  assert.deepEqual(new Set(all.results.map(item => item.label)), new Set(['甲', '乙', '丙']));
});

test('spin() reports the probability the draw actually used', () => {
  const wheel = model.createWheel({ options: [model.createOption('甲', 3), model.createOption('乙', 1)] });
  const outcome = model.spin(wheel, strategies.createRound(), createSource({ seed: 'share' }), 20);
  for (const result of outcome.results) {
    const expected = result.label === '甲' ? 75 : 25;
    assert.equal(result.share, expected);
    assert.ok(Math.abs(result.probability - expected / 100) < 1e-6);
  }
});

test('spin() applies the post-spin policy between draws of a batch', () => {
  const wheel = wheelOf('甲', '乙', '丙');
  wheel.config.postSpin = 'remove';
  const outcome = model.spin(wheel, strategies.createRound(), createSource({ seed: 'batch' }), 3);
  assert.equal(new Set(outcome.results.map(item => item.label)).size, 3, 'a batch with "remove" repeated a winner');
  assert.equal(outcome.round.removed.length, 3);
  assert.equal(outcome.round.spin, 3);
});

test('spin() starts a new round instead of dead-ending when everything was removed', () => {
  const wheel = wheelOf('甲', '乙');
  wheel.config.postSpin = 'remove';
  const outcome = model.spin(wheel, strategies.createRound(), createSource({ seed: 'refill' }), 4);
  assert.equal(outcome.error, null);
  assert.equal(outcome.results.length, 4);
  assert.equal(outcome.round.replacements, 1);
  assert.ok(outcome.notices.some(note => note.includes('新一轮')));
});

test('spin() refuses politely when there is nothing to draw', () => {
  const wheel = model.normalizeWheel({ options: [] });
  const empty = model.spin(wheel, strategies.createRound(), createSource({ seed: 'x' }), 1);
  assert.match(empty.error, /还没有选项/);
  assert.deepEqual(empty.results, []);

  const off = wheelOf('甲');
  off.options[0].enabled = false;
  const disabled = model.spin(off, strategies.createRound(), createSource({ seed: 'x' }), 1);
  assert.match(disabled.error, /停用/);
});

test('spin() does not mutate the wheel it draws from', () => {
  const wheel = wheelOf('甲', '乙', '丙');
  wheel.config.postSpin = 'decay';
  wheel.config.decayFactor = 0.5;
  const before = JSON.stringify(wheel);
  model.spin(wheel, strategies.createRound(), createSource({ seed: 'pure' }), 5);
  assert.equal(JSON.stringify(wheel), before, 'a round leaked into the saved preset');
});

test('historyEntry() records what is needed to explain a result later', () => {
  const wheel = wheelOf('甲', '乙');
  const outcome = model.spin(wheel, strategies.createRound(), createSource({ seed: 'history' }), 1);
  const entry = model.historyEntry(wheel, outcome.results[0]);
  assert.ok(entry.id.startsWith('spin-'));
  assert.equal(entry.wheelId, wheel.id);
  assert.equal(entry.wheelName, wheel.name);
  assert.equal(entry.label, outcome.results[0].label);
  assert.ok(entry.share > 0 && entry.share <= 100);
  assert.ok(entry.at > 0);
});

test('normalizeHistory() drops junk, sorts newest first and caps the list', () => {
  const entries = [
    { id: 'a', label: '甲', at: 100 },
    { id: 'b', label: '乙', at: 300 },
    null,
    { label: '没有 id' },
    { id: 'c', label: '丙', at: 200, probability: 'x' },
    ...Array.from({ length: 600 }, (_, index) => ({ id: `f${index}`, label: '补', at: 10 })),
  ];
  const history = model.normalizeHistory({ entries });
  assert.equal(history.length, model.LIMITS.history);
  assert.equal(history[0].id, 'b');
  assert.equal(history[1].id, 'c');
  assert.equal(history[1].probability, 0, 'a non-numeric probability must not become NaN');
  assert.equal(history.find(item => item.id === 'a').share, 0);
  assert.deepEqual(model.normalizeHistory(null), []);
});

test('a temporary wheel is separate from the preset list and can be saved later', () => {
  const temporary = model.createTemporaryWheel({ options: [model.createOption('甲', 1)] });
  assert.equal(model.isTemporary(temporary), true);
  assert.equal(temporary.id, model.TEMPORARY_ID);

  const copy = model.duplicateWheel(temporary, '我的转盘');
  assert.equal(model.isTemporary(copy), false);
  assert.equal(copy.name, '我的转盘');
  assert.notEqual(copy.id, temporary.id);
  assert.notEqual(copy.options[0].id, temporary.options[0].id, 'a copy shares option ids with its source');
  copy.options[0].label = '改过了';
  assert.equal(temporary.options[0].label, '甲', 'a copy shares option objects with its source');
});

test('reconciling a round against an edited list cannot resurrect dead options', () => {
  const wheel = wheelOf('甲', '乙', '丙');
  let round = strategies.createRound();
  round = strategies.apply(round, { id: wheel.options[0].id, label: '甲', value: 1 }, { postSpin: 'remove' }).round;
  round = strategies.apply(round, { id: wheel.options[1].id, label: '乙', value: 1 }, { postSpin: 'cooldown', cooldownSpins: 2 }).round;
  wheel.options.splice(0, 2);
  const plan = model.buildPlan(wheel, round);
  assert.deepEqual(plan.entries.map(entry => entry.label), ['丙']);
});
