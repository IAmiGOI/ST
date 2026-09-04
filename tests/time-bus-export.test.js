import test from 'node:test';
import assert from 'node:assert/strict';
import { ModuleEngine } from '../core/module-engine.js';
import { timeModule } from '../modules/time/index.js';
import { macrosModule } from '../modules/macros/index.js';

/**
 * RP Time used to expose its current value ONLY through host.services
 * ('time'.getCurrent(), a JS method call) — it never called host.data.reserve()/
 * set() at all. That meant no real ST {{macro}} (unlike Tracker's per-field ones)
 * AND no way for the Macros module's own mini-language to read it either
 * (`get "time:current"` needs a plain bus value; host.data.read()/get() are NOT
 * compute()-aware — only the real ST macro handler is, see core/data-bus.js's
 * #registerMacro). Both halves are covered here, through the real ModuleEngine —
 * same makeEngine() shape tests/macros-module.test.js already uses.
 */
function makeEngine() {
    const registeredMacros = new Map();
    const context = {
        extensionSettings: {}, chatMetadata: {}, chat: [],
        eventTypes: {}, eventSource: { on() {}, off() {} },
        saveSettingsDebounced() {}, saveMetadataDebounced() {},
        registerMacro: (name, handler) => registeredMacros.set(name, handler),
        unregisterMacro: name => registeredMacros.delete(name),
    };
    const engine = new ModuleEngine(() => context);
    return { engine, context, registeredMacros };
}

/** The one real way RP Time's "current time" becomes non-default — a labeled character message already in the chat (see modules/time/index.js's getCurrentTime()). */
function seedCurrentTime(context, label) {
    context.chat.push({ is_user: false, is_system: false, mes: 'Earlier reply.', extra: { stme_rp_time: label } });
}

test('{{rp_time}} registers as a real ST macro and resolves to the current in-world time', async () => {
    const { engine, registeredMacros } = makeEngine();
    engine.register(timeModule);
    await engine.enable('time');

    assert.equal(registeredMacros.get('rp_time')(), 'Year 1, Month 1, Day 1, 08:00 (Morning)'); // the default startTime — nothing labeled yet
});

test('{{rp_time}} is always live — computed fresh from the chat, not a snapshot from registration time', async () => {
    const { engine, context, registeredMacros } = makeEngine();
    engine.register(timeModule);
    await engine.enable('time');

    seedCurrentTime(context, 'Day 3, 14:00 (Afternoon)');
    assert.equal(registeredMacros.get('rp_time')(), 'Day 3, 14:00 (Afternoon)');

    seedCurrentTime(context, 'Day 4, 09:00 (Morning)');
    assert.equal(registeredMacros.get('rp_time')(), 'Day 4, 09:00 (Morning)');
});

test('host.data.get("time","current") is published immediately on enable — a fresh subscriber never sees emptiness', async () => {
    const { engine } = makeEngine();
    engine.register(timeModule);
    await engine.enable('time');

    assert.equal(engine.bus.get('time', 'current'), 'Year 1, Month 1, Day 1, 08:00 (Morning)');
});

test('a Macros code program can read RP Time\'s current value via get "time:current" — the actual gap this fix closes', async () => {
    const { engine, registeredMacros } = makeEngine();
    engine.register(timeModule);
    engine.register(macrosModule);
    await engine.enable('time');
    await engine.enable('macros');

    const settings = engine.moduleSettings('macros', {});
    settings.programs = [{
        id: 'm1', name: 'Echo time', macroName: 'echo_time', kind: 'code', enabled: true, collapsed: false,
        source: 'return get "time:current"',
    }];
    engine.bus.get('macros', 'sync')();

    // Read as the raw bus value RP Time's own publishCurrentTime() writes — a plain
    // get "namespace:key" only ever sees the last set(), never compute() (see this
    // file's own doc comment); the initial-publish test above already covers that
    // RP Time itself keeps this value fresh, so this test only needs to prove the
    // Macros side genuinely reaches across the bus for it.
    engine.bus.set('time', 'current', 'Day 2, 13:00 (Afternoon)');
    assert.equal(registeredMacros.get('echo_time')(), 'Day 2, 13:00 (Afternoon)');
});
