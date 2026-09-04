import test from 'node:test';
import assert from 'node:assert/strict';
import { ModuleEngine } from '../core/module-engine.js';
import { diceModule, rollDie, rollDice, parseDiceNotation, DICE_TYPES } from '../modules/dice/index.js';

// --- Pure dice math — no engine, no DOM.

test('rollDie returns a value within [1, sides]', () => {
    for (let i = 0; i < 200; i++) {
        const value = rollDie(6);
        assert.ok(value >= 1 && value <= 6, `expected 1-6, got ${value}`);
    }
});

test('rollDie is deterministic given a fixed random source, and off-by-one correct at both ends', () => {
    assert.equal(rollDie(20, () => 0), 1); // lowest possible roll
    assert.equal(rollDie(20, () => 0.999999), 20); // highest possible roll
});

test('rollDie rejects an invalid sides count', () => {
    assert.throws(() => rollDie(1), /Dice sides must be an integer from 2/);
    assert.throws(() => rollDie(1001), /Dice sides must be an integer from 2/);
    assert.throws(() => rollDie(3.5), /Dice sides must be an integer from 2/);
    assert.throws(() => rollDie('not a number'), /Dice sides must be an integer from 2/);
});

test('rollDice returns exactly `count` results, each independently valid', () => {
    const results = rollDice(10, 6);
    assert.equal(results.length, 10);
    for (const value of results) assert.ok(value >= 1 && value <= 6);
});

test('rollDice rejects an invalid dice count', () => {
    assert.throws(() => rollDice(0, 6), /Dice count must be an integer from 1/);
    assert.throws(() => rollDice(101, 6), /Dice count must be an integer from 1/);
});

test('parseDiceNotation reads count+sides from standard notation, case-insensitively, defaulting count to 1', () => {
    assert.deepEqual(parseDiceNotation('d20'), { count: 1, sides: 20 });
    assert.deepEqual(parseDiceNotation('2d6'), { count: 2, sides: 6 });
    assert.deepEqual(parseDiceNotation('D20'), { count: 1, sides: 20 });
    assert.deepEqual(parseDiceNotation('4d%'), { count: 4, sides: 100 });
    assert.deepEqual(parseDiceNotation('  3d8  '), { count: 3, sides: 8 });
});

test('parseDiceNotation rejects garbage and out-of-range notation', () => {
    assert.throws(() => parseDiceNotation('not dice'), /Use dice notation/);
    assert.throws(() => parseDiceNotation(''), /Use dice notation/);
    assert.throws(() => parseDiceNotation('0d6'), /Dice count must be/);
    assert.throws(() => parseDiceNotation('101d6'), /Dice count must be/);
    assert.throws(() => parseDiceNotation('d1'), /Dice sides must be/);
    assert.throws(() => parseDiceNotation('d1001'), /Dice sides must be/);
});

// --- DICE_TYPES — a structural guard against the original bug (d100 and d%
// shared `sides: 100`, and Select() used to key its dropdown by `sides`, so one
// silently swallowed the other's visible option). Keying by `id` (now unique for
// every entry, including d100/d%) is what fixes it — this only asserts the data
// stays fixable, since the Select() wiring itself lives in render() and needs a
// real DOM to exercise directly.
test('every DICE_TYPES entry has a unique id, even though d100 and d% share the same `sides`', () => {
    const ids = DICE_TYPES.map(item => item.id);
    assert.equal(new Set(ids).size, ids.length);
    const hundredSided = DICE_TYPES.filter(item => item.sides === 100);
    assert.equal(hundredSided.length, 2, 'd100 and d% both exist, both rolling out of 100');
    assert.notEqual(hundredSided[0].id, hundredSided[1].id);
});

// --- Real ModuleEngine wiring: the function tool + the host.services push/pull
// pair, mirroring tests/module-engine-services.test.js's own no-DOM pattern
// (activate() only, render() never invoked).
function makeEngine() {
    let capturedTool = null;
    const context = {
        extensionSettings: {}, chatMetadata: {}, chat: [],
        eventTypes: {}, eventSource: { on() {}, off() {} },
        saveSettingsDebounced() {}, saveMetadataDebounced() {},
        registerFunctionTool: definition => { capturedTool = definition; },
        unregisterFunctionTool: () => { capturedTool = null; },
    };
    const engine = new ModuleEngine(() => context);
    return { engine, context, getTool: () => capturedTool };
}

test('the Dice function tool rolls real notation and returns the formatted text', async () => {
    const { engine, getTool } = makeEngine();
    engine.register(diceModule);
    await engine.enable('dice');

    const tool = getTool();
    assert.equal(tool.name, 'Dice');
    const result = await tool.action({ dice: '3d6' });
    assert.match(result, /^3d6: \[\d+, \d+, \d+\] = \d+$/);
});

test('the Dice function tool returns a readable error instead of throwing on bad notation', async () => {
    const { engine, getTool } = makeEngine();
    engine.register(diceModule);
    await engine.enable('dice');

    const result = await getTool().action({ dice: 'not dice' });
    assert.match(result, /Use dice notation/);
});

test('disabling Dice unregisters its function tool', async () => {
    const { engine, getTool } = makeEngine();
    engine.register(diceModule);
    await engine.enable('dice');
    assert.ok(getTool());

    await engine.disable('dice');
    assert.equal(getTool(), null);
});

test('another module can PULL a roll from Dice via host.services.ask — a pure computation, never throws on bad input', async () => {
    const { engine } = makeEngine();
    let consumerHost;
    engine.register(diceModule);
    engine.register({ id: 'consumer', title: 'Consumer', description: '', defaultEnabled: true, activate: host => { consumerHost = host; return () => {}; }, render() {} });
    // Dice defaults to disabled (see the module itself) — engine.start() only
    // auto-enables defaultEnabled:true modules, so it must be enabled explicitly.
    await engine.enable('dice');
    await engine.enable('consumer');

    const good = await consumerHost.services.ask('dice', 'roll', { notation: '2d20' });
    assert.equal(good.results.length, 2);
    assert.ok(good.results.every(value => value >= 1 && value <= 20));
    assert.equal(good.total, good.results.reduce((sum, value) => sum + value, 0));
    assert.match(good.text, /^2d20: /);

    const bad = await consumerHost.services.ask('dice', 'roll', { notation: 'nonsense' });
    assert.match(bad.error, /Use dice notation/);
});

test('another module can PUSH a named quick roll into Dice\'s own display via host.services.request().track()', async () => {
    const { engine } = makeEngine();
    let consumerHost;
    engine.register(diceModule);
    engine.register({ id: 'consumer', title: 'Consumer', description: '', defaultEnabled: true, activate: host => { consumerHost = host; return () => {}; }, render() {} });
    await engine.enable('dice');
    await engine.enable('consumer');

    const handle = consumerHost.services.request('dice').track('consumer', 'damage_roll', { name: 'Damage roll', initial: '14' });
    assert.deepEqual(engine.bus.get('dice', 'quickIndex'), [{ id: 'consumer:damage_roll', requesterId: 'consumer', name: 'Damage roll' }]);
    assert.equal(engine.bus.get('dice', 'quick:consumer:damage_roll'), '14');

    handle.set('20');
    assert.equal(engine.bus.get('dice', 'quick:consumer:damage_roll'), '20');

    handle.remove();
    assert.deepEqual(engine.bus.get('dice', 'quickIndex'), []);
    assert.equal(engine.bus.get('dice', 'quick:consumer:damage_roll'), undefined);
});

test('disabling Dice retires every quick-roll channel it owned', async () => {
    const { engine } = makeEngine();
    let consumerHost;
    engine.register(diceModule);
    engine.register({ id: 'consumer', title: 'Consumer', description: '', defaultEnabled: true, activate: host => { consumerHost = host; return () => {}; }, render() {} });
    await engine.enable('dice');
    await engine.enable('consumer');
    consumerHost.services.request('dice').track('consumer', 'x', { name: 'X' });
    assert.equal(engine.bus.get('dice', 'quickIndex').length, 1);

    await engine.disable('dice');
    assert.equal(engine.bus.get('dice', 'quickIndex'), undefined);
});
