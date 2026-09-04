import test from 'node:test';
import assert from 'node:assert/strict';
import { ModuleEngine } from '../core/module-engine.js';

/**
 * Covers the audit-driven fixes to ModuleEngine's shared, cross-module
 * registries: collision protection for host.registerTool()/host.services.register()
 * (previously silent — a second module could steal a name with no warning, unlike
 * host.data.reserve()'s own macro-collision check), and the belt-and-suspenders
 * sweep on disable() for host.onChatChanged()/host.onEvent() (previously only the
 * bus and services got this — a module whose own cleanup() forgot to unsubscribe
 * leaked a listener with a stale closure forever).
 */
function stubModule(id, overrides = {}) {
    return { id, title: id, description: '', defaultEnabled: true, activate: () => () => {}, render() {}, ...overrides };
}

function makeEngine() {
    const registered = new Map(); // name -> definition, for registerFunctionTool
    const eventSubs = new Map(); // eventName -> Set<handler>, for a real working eventSource
    const context = {
        extensionSettings: {}, chatMetadata: {}, chat: [],
        eventTypes: { SOME_EVENT: 'some_event', CHAT_CHANGED: 'chat_changed' },
        eventSource: {
            on: (name, handler) => { const set = eventSubs.get(name) ?? new Set(); set.add(handler); eventSubs.set(name, set); },
            off: (name, handler) => { eventSubs.get(name)?.delete(handler); },
        },
        saveSettingsDebounced() {}, saveMetadataDebounced() {},
        registerFunctionTool: definition => registered.set(definition.name, definition),
        unregisterFunctionTool: name => registered.delete(name),
    };
    const engine = new ModuleEngine(() => context);
    // start() wires the engine's own CHAT_CHANGED dispatcher onto the (fake) real
    // eventSource — firing it for real (not calling a private method) is what lets
    // these tests prove a leaked onChatChanged listener genuinely stops firing.
    const fireChatChanged = () => { for (const handler of eventSubs.get('chat_changed') ?? []) handler(); };
    return { engine, context, registered, eventSubs, fireChatChanged };
}

// --- registerTool() collision protection ---

test('registerTool() refuses a name a DIFFERENT module already owns — the first module keeps it', async () => {
    const { engine, registered } = makeEngine();
    engine.register(stubModule('first', { activate: host => { host.registerTool({ name: 'Roll', action: () => 'first' }); return () => {}; } }));
    engine.register(stubModule('second', { activate: host => { host.registerTool({ name: 'Roll', action: () => 'second' }); return () => {}; } }));
    await engine.start();

    assert.equal(registered.get('Roll').action(), 'first', 'the second module\'s registration must be refused, not silently overwrite the first');
});

test('registerTool() lets a module re-register its OWN tool name (e.g. a Retry re-running activate())', async () => {
    const { engine, registered } = makeEngine();
    let host;
    engine.register(stubModule('mod', { activate: h => { host = h; h.registerTool({ name: 'Roll', action: () => 'v1' }); return () => {}; } }));
    await engine.start();
    host.registerTool({ name: 'Roll', action: () => 'v2' });
    assert.equal(registered.get('Roll').action(), 'v2');
});

test('unregisterTool() does not remove a DIFFERENT module\'s tool just because you pass its name', async () => {
    const { engine, registered } = makeEngine();
    let secondHost;
    engine.register(stubModule('first', { activate: host => { host.registerTool({ name: 'Roll', action: () => 'first' }); return () => {}; } }));
    engine.register(stubModule('second', { activate: host => { secondHost = host; return () => {}; } }));
    await engine.start();

    secondHost.unregisterTool('Roll'); // never owned it — must be a no-op against the real registration
    assert.ok(registered.has('Roll'), 'a module must not be able to unregister a tool it never registered');
});

// --- services.register() collision protection ---

test('services.register() refuses a name a DIFFERENT module already provides', async () => {
    const { engine } = makeEngine();
    let secondHost;
    engine.register(stubModule('first', { activate: host => { host.services.register('tracker', { from: 'first' }); return () => {}; } }));
    engine.register(stubModule('second', { activate: host => { secondHost = host; host.services.register('tracker', { from: 'second' }); return () => {}; } }));
    await engine.start();

    // get()/request() are global lookups by name, not scoped to the caller — the
    // real assertion is that the name still resolves to the FIRST module's api,
    // from EITHER host, proving the second module's call never took effect at all.
    assert.equal(secondHost.services.get('tracker').from, 'first');
    assert.equal(secondHost.services.request('tracker').from, 'first', 'the FIRST module\'s service must still be the one every consumer reaches');
});

test('services.register() still lets a module re-register its own service', async () => {
    const { engine } = makeEngine();
    let host;
    engine.register(stubModule('mod', { activate: h => { host = h; h.services.register('svc', { v: 1 }); return () => {}; } }));
    await engine.start();
    host.services.register('svc', { v: 2 });
    assert.equal(host.services.get('svc').v, 2);
});

// --- onChatChanged() leak sweep on disable() ---

test('disable() sweeps up an onChatChanged listener a module\'s own cleanup() forgot to unsubscribe', async () => {
    const { engine, fireChatChanged } = makeEngine();
    let leakyCalls = 0;
    let goodCalls = 0;
    engine.register(stubModule('leaky', {
        activate: host => {
            host.onChatChanged(() => { leakyCalls++; });
            return () => {}; // deliberately "forgets" to call the returned unsubscribe
        },
    }));
    engine.register(stubModule('good', {
        activate: host => { const off = host.onChatChanged(() => { goodCalls++; }); return () => off(); },
    }));
    await engine.start();

    fireChatChanged();
    assert.deepEqual([leakyCalls, goodCalls], [1, 1], 'both listeners fire normally before either module is disabled');

    await engine.disable('leaky');
    fireChatChanged();
    assert.deepEqual([leakyCalls, goodCalls], [1, 2], 'the leaked listener must no longer fire after disable() — swept even though cleanup() forgot to unsubscribe it; the still-enabled module\'s own listener is unaffected');
});

// --- onEvent() leak sweep on disable() ---

test('disable() unsubscribes from context.eventSource an onEvent listener a module forgot to unsubscribe itself', async () => {
    const { engine, context, eventSubs } = makeEngine();
    engine.register(stubModule('leaky', {
        activate: host => {
            host.onEvent('SOME_EVENT', () => {});
            return () => {}; // forgets to call the returned unsubscribe
        },
    }));
    await engine.start();

    assert.equal(eventSubs.get('some_event')?.size, 1, 'the real eventSource.on() call must have happened');
    await engine.disable('leaky');
    assert.equal(eventSubs.get('some_event')?.size ?? 0, 0, 'disable() must have swept the forgotten subscription off the real eventSource too');
});

test('onEvent()\'s own returned unsubscribe still works normally, and disable() does not double-unsubscribe', async () => {
    const { engine, eventSubs } = makeEngine();
    let unsubscribe;
    engine.register(stubModule('good', {
        activate: host => { unsubscribe = host.onEvent('SOME_EVENT', () => {}); return () => unsubscribe(); },
    }));
    await engine.start();
    assert.equal(eventSubs.get('some_event')?.size, 1);

    await engine.disable('good'); // calls cleanup() -> unsubscribe() -> then the sweep finds nothing left
    assert.equal(eventSubs.get('some_event')?.size ?? 0, 0);
});
