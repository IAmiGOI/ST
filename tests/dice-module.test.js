import test from 'node:test';
import assert from 'node:assert/strict';
import { diceModule, DICE_TYPES, rollDie, rollDice, parseDiceNotation } from '../modules/dice/index.js';

test('dice module exposes standard dice types', () => {
    assert.deepEqual(DICE_TYPES.map(d => d.name), ['d2', 'd3', 'd4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd30', 'd100', 'd%']);
    assert.equal(diceModule.id, 'dice');
    assert.equal(diceModule.defaultEnabled, true);
});

test('rollDie returns a value within bounds', () => {
    assert.equal(rollDie(20, () => 0), 1);
    assert.equal(rollDie(20, () => 0.999999), 20);
});

test('rollDice rolls the requested pool size', () => {
    const results = rollDice(4, 6, () => 0.5);
    assert.deepEqual(results, [4, 4, 4, 4]);
});

test('parseDiceNotation handles omitted count and percentile dice', () => {
    assert.deepEqual(parseDiceNotation('d20'), { count: 1, sides: 20 });
    assert.deepEqual(parseDiceNotation('2d6'), { count: 2, sides: 6 });
    assert.deepEqual(parseDiceNotation('4d%'), { count: 4, sides: 100 });
});

test('parseDiceNotation rejects malformed or unsafe pools', () => {
    assert.throws(() => parseDiceNotation('2d1'));
    assert.throws(() => parseDiceNotation('101d6'));
    assert.throws(() => parseDiceNotation('not dice'));
});
