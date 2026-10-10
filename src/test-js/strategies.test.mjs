import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadWeb } from './helpers/load.mjs';

const web = loadWeb('random', 'sampler', 'distribution', 'strategies');
const strategies = web.wheelStrategies;

const option = (id, value = 1) => ({ id, label: `选项${id}`, value, enabled: true });

test('createRound() starts neutral and tick() is a no-op on it', () => {
  const round = strategies.createRound();
  assert.equal(strategies.isNeutral(round), true);
  assert.equal(strategies.isNeutral(strategies.tick(round)), true);
  assert.equal(round.spin, 0);
});

test('keep leaves the wheel untouched', () => {
  const round = strategies.createRound();
  const next = strategies.apply(round, option('a'), { postSpin: 'keep' });
  assert.equal(next.policy, 'keep');
  assert.equal(next.detail, null);
  assert.equal(strategies.isNeutral(next.round), true);
  assert.equal(next.round.spin, 1);
  assert.equal(round.spin, 0, 'apply() mutated the round it was given');
});

test('remove takes the winner out of the round and can be reset', () => {
  let round = strategies.createRound();
  round = strategies.apply(round, option('a'), { postSpin: 'remove' }).round;
  round = strategies.apply(round, option('b'), { postSpin: 'remove' }).round;
  assert.deepEqual(round.removed, ['a', 'b']);
  assert.equal(strategies.isNeutral(round), false);

  const applied = strategies.apply(round, option('a'), { postSpin: 'remove' });
  assert.equal(applied.round.removed.filter(id => id === 'a').length, 1, 'a winner was removed twice');

  /* An option that no longer exists must not keep state alive. */
  const reconciled = strategies.reconcile(round, [option('b')]);
  assert.deepEqual(reconciled.removed, ['b']);
});

test('decay compounds and reports the value it moved from and to', () => {
  let round = strategies.createRound();
  const config = { postSpin: 'decay', decayFactor: 0.5 };
  const first = strategies.apply(round, option('a', 8), config);
  assert.equal(first.round.decays.a, 1);
  assert.equal(strategies.effectiveValue(first.round, option('a', 8), config), 4);
  assert.match(first.detail, /8 → 4/);

  const second = strategies.apply(first.round, option('a', 8), config);
  assert.equal(second.round.decays.a, 2);
  assert.equal(strategies.effectiveValue(second.round, option('a', 8), config), 2);
  /* The wheel value is never mutated: a preset saved mid-round keeps what the
     user typed. */
  const stored = option('a', 8);
  strategies.effectiveValue(second.round, stored, config);
  assert.equal(stored.value, 8);
});

test('editing a value restarts that option decay and leaves the others alone', () => {
  let round = strategies.createRound();
  const config = { postSpin: 'decay', decayFactor: 0.5 };
  round = strategies.apply(round, option('a', 8), config).round;
  round = strategies.apply(round, option('b', 8), config).round;
  const reconciled = strategies.reconcile(round, [option('a', 3), option('b', 8)], 'a');
  assert.equal(reconciled.decays.a, undefined);
  assert.equal(reconciled.decays.b, 1);
  assert.equal(strategies.effectiveValue(reconciled, option('a', 3), config), 3);
});

test('cooldown excludes the winner for exactly the configured number of draws', () => {
  let round = strategies.createRound();
  round = strategies.apply(round, option('a'), { postSpin: 'cooldown', cooldownSpins: 3 }).round;
  assert.equal(round.cooldowns.a, 3);

  const remaining = [];
  for (let step = 0; step < 4; step += 1) {
    round = strategies.tick(round);
    remaining.push(round.cooldowns.a ?? 0);
  }
  assert.deepEqual(remaining, [2, 1, 0, 0], 'cooldown did not expire after three draws');
  assert.equal(strategies.isNeutral(round), true);
});

test('cooldown parameters outside their range are clamped', () => {
  const high = strategies.apply(strategies.createRound(), option('a'), { postSpin: 'cooldown', cooldownSpins: 999 });
  assert.equal(high.round.cooldowns.a, 20);
  const low = strategies.apply(strategies.createRound(), option('a'), { postSpin: 'cooldown', cooldownSpins: 0 });
  assert.equal(low.round.cooldowns.a, 1);
});

test('an unknown policy degrades to keep rather than throwing', () => {
  assert.equal(strategies.policyById('nope').id, 'keep');
  const applied = strategies.apply(strategies.createRound(), option('a'), { postSpin: 'nope' });
  assert.equal(strategies.isNeutral(applied.round), true);
});

test('summarize() describes the round in words a user can check', () => {
  let round = strategies.createRound();
  assert.match(strategies.summarize(round, [], { postSpin: 'remove' }), /暂未调整/);
  round = strategies.apply(round, option('a'), { postSpin: 'remove' }).round;
  assert.match(strategies.summarize(round, [], { postSpin: 'remove' }), /已移出 1 项/);
  round = strategies.apply(round, option('b'), { postSpin: 'decay', decayFactor: 0.5 }).round;
  assert.match(strategies.summarize(round, [], { postSpin: 'decay' }), /已移出 1 项 · 已衰减 1 项/);
  round = strategies.apply(round, option('c'), { postSpin: 'cooldown', cooldownSpins: 3 }).round;
  assert.match(strategies.summarize(round, [], { postSpin: 'cooldown' }), /1 项冷却中/);
  assert.equal(strategies.summarize(round, [], { postSpin: 'keep' }), '本策略不会改变转盘');
});

test('every policy declares the parameter affordance the UI needs', () => {
  for (const policy of strategies.POLICIES) {
    assert.ok(policy.id && policy.label && policy.summary);
    if (policy.parameter) {
      assert.ok(policy.parameter.key && policy.parameter.label && policy.parameter.hint);
      assert.ok(policy.parameter.fallback >= policy.parameter.min);
      assert.ok(policy.parameter.fallback <= policy.parameter.max);
    }
  }
  assert.equal(strategies.POLICIES.length, 4);
});
