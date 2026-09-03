import test from 'node:test';
import assert from 'node:assert/strict';
import { ModuleEngine } from '../core/module-engine.js';

/** Captures the CHAT_CHANGED handler module-engine.js registers, so tests can fire it directly — same as start()/enable()/disable(), no DOM needed since we never call mount(). */
function makeEngine() {
    let chatChangedHandler = null;
    const context = {
        extensionSettings: {}, chatMetadata: {}, chat: [],
        eventTypes: { CHAT_CHANGED: 'CHAT_CHANGED' },
        eventSource: {
            on(type, handler) { if (type === 'CHAT_CHANGED') chatChangedHandler = handler; },
            off(type, handler) { if (type === 'CHAT_CHANGED' && chatChangedHandler === handler) chatChangedHandler = null; },
        },
        saveSettingsDebounced() {}, saveMetadataDebounced() {},
    };
    const engine = new ModuleEngine(() => context);
    return { engine, fireChatChanged: () => chatChangedHandler?.() };
}

function stubModule(id, overrides = {}) {
    return { id, title: id, description: '', defaultEnabled: true, activate: () => () => {}, render() {}, ...overrides };
}

test('a normal onChatChanged listener is called once per fire, with no reentrancy involved', async () => {
    const { engine, fireChatChanged } = makeEngine();
    let calls = 0;
    engine.register(stubModule('m', {
        activate(host) { const unsub = host.onChatChanged(() => { calls++; }); return unsub; },
    }));
    await engine.start();
    fireChatChanged();
    fireChatChanged();
    assert.equal(calls, 2);
});

test('a listener that synchronously re-fires CHAT_CHANGED does not recurse — the nested fire is dropped', async () => {
    const { engine, fireChatChanged } = makeEngine();
    let outerCalls = 0;
    let maxObservedDepth = 0;
    let depth = 0;
    engine.register(stubModule('loopy', {
        activate(host) {
            const unsub = host.onChatChanged(() => {
                outerCalls++;
                depth++;
                maxObservedDepth = Math.max(maxObservedDepth, depth);
                if (depth < 50) fireChatChanged(); // would recurse without the engine's guard
                depth--;
            });
            return unsub;
        },
    }));
    await engine.start();
    assert.doesNotThrow(() => fireChatChanged(), 'no stack overflow / unbounded recursion');
    // The reentrancy guard means the SECOND (nested) fire is dropped before it ever
    // reaches the listener — so the listener body itself only ever runs at depth 1.
    assert.equal(maxObservedDepth, 1, 'the listener never observes being re-entered — the nested dispatch never reached it');
    assert.ok(outerCalls >= 1 && outerCalls < 50, `expected a small, bounded number of calls, got ${outerCalls}`);
});

test('a burst of many separate CHAT_CHANGED fires in a short window is throttled instead of processed unboundedly', async () => {
    const { engine, fireChatChanged } = makeEngine();
    let calls = 0;
    engine.register(stubModule('m', {
        activate(host) { return host.onChatChanged(() => { calls++; }); },
    }));
    await engine.start();
    for (let i = 0; i < 30; i++) fireChatChanged(); // far more than a real chat-switch burst
    assert.ok(calls < 30, `expected the burst limiter to cap processed calls well below 30, got ${calls}`);
    assert.ok(calls > 0, 'legitimate calls before the limit kicked in were still processed');
});

test('one listener throwing does not stop other listeners from running', async () => {
    const { engine, fireChatChanged } = makeEngine();
    let goodCalls = 0;
    engine.register(stubModule('bad', { activate(host) { return host.onChatChanged(() => { throw new Error('boom'); }); } }));
    engine.register(stubModule('good', { activate(host) { return host.onChatChanged(() => { goodCalls++; }); } }));
    await engine.start();
    assert.doesNotThrow(() => fireChatChanged());
    assert.equal(goodCalls, 1);
});

test('an async listener that rejects does not throw out of the dispatcher or block other listeners', async () => {
    const { engine, fireChatChanged } = makeEngine();
    let goodCalls = 0;
    engine.register(stubModule('bad-async', { activate(host) { return host.onChatChanged(async () => { throw new Error('async boom'); }); } }));
    engine.register(stubModule('good', { activate(host) { return host.onChatChanged(() => { goodCalls++; }); } }));
    await engine.start();
    assert.doesNotThrow(() => fireChatChanged());
    assert.equal(goodCalls, 1);
    await new Promise(resolve => setTimeout(resolve, 10)); // let the rejection's .catch() log settle without an unhandled rejection
});
