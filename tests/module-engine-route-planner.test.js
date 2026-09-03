import test from 'node:test';
import assert from 'node:assert/strict';
import { ModuleEngine } from '../core/module-engine.js';

/**
 * Proves engine.routePlanner is real, live-wired, and purely observational
 * through the actual engine — not just the standalone class (see
 * tests/route-planner.test.js for that). RoutePlanner's own decision logic is
 * not re-tested here.
 */

function stubModule(id, overrides = {}) {
    return { id, title: id, description: '', defaultEnabled: true, activate: () => () => {}, render() {}, ...overrides };
}

function makeEngine() {
    const context = {
        extensionSettings: {}, chatMetadata: {}, chat: [],
        eventTypes: {}, eventSource: { on() {}, off() {} },
        saveSettingsDebounced() {}, saveMetadataDebounced() {},
    };
    return new ModuleEngine(() => context);
}

test('engine.routePlanner exists and starts observing as soon as start() runs', async () => {
    const engine = makeEngine();
    engine.register(stubModule('tracker'));
    await engine.start();

    engine.bus.set('state-track', 'main', { phase: 'idle', lastOutcome: 'success', toolCallsInCycle: 0 });
    engine.bus.set('tracker', 'x', 1);
    assert.deepEqual(engine.routePlanner.passCounts('tracker'), { duringGeneration: 0, afterGeneration: 1 });
});

test('engine.routePlanner never changes any real module\'s behavior — it only counts, decide() is never called by the engine itself', async () => {
    const engine = makeEngine();
    let activateCalls = 0;
    engine.register(stubModule('tracker', { activate: () => { activateCalls++; return () => {}; } }));
    await engine.start();
    engine.bus.set('state-track', 'main', { phase: 'generating', lastOutcome: null, toolCallsInCycle: 0 });
    for (let i = 0; i < 5; i++) engine.bus.set('tracker', 'x', i);
    assert.equal(activateCalls, 1, 'activate() must only run once, from the normal enable() path — RoutePlanner must never re-trigger a module');
});
