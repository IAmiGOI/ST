import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { ModuleEngine } from '../core/module-engine.js';
import {
    trackerModule, resolvePollMode, resolvePollTurns, resolvePollIntervalMs, runBlockPoll, waitForPostProcess,
} from '../modules/tracker/index.js';
import { createTrackerStore } from '../modules/tracker/store.js';

/**
 * Covers the 4-mode poll-timing system (per-block "when to ask SideCar"
 * switches): 'user-message' (fires on the player's own message, no message
 * snapshot), 'after-turn' (the default — fires once the AI's reply lands,
 * waiting for Post-Turn Processor first if it's enabled), 'every-n-turns'
 * (same trigger, throttled to every Nth reply), and 'every-n-time' (a real
 * wall-clock timer, independent of chat events).
 */

// ---------------------------------------------------------------------------
// resolvePollMode / resolvePollTurns / resolvePollIntervalMs — defensive
// readers so a block saved before this feature existed (no pollMode field at
// all) falls back to sane defaults instead of crashing or misbehaving.
// ---------------------------------------------------------------------------

test('resolvePollMode falls back to after-turn for a missing or unrecognized value, passes through a valid one', () => {
    assert.equal(resolvePollMode({}), 'after-turn');
    assert.equal(resolvePollMode(undefined), 'after-turn');
    assert.equal(resolvePollMode({ pollMode: 'not-a-real-mode' }), 'after-turn');
    assert.equal(resolvePollMode({ pollMode: 'every-n-turns' }), 'every-n-turns');
    assert.equal(resolvePollMode({ pollMode: 'user-message' }), 'user-message');
    assert.equal(resolvePollMode({ pollMode: 'every-n-time' }), 'every-n-time');
});

test('resolvePollTurns clamps to [1, 50], rounds, and falls back to 3 for non-finite input', () => {
    assert.equal(resolvePollTurns({}), 3);
    assert.equal(resolvePollTurns({ pollTurns: 0 }), 1);
    assert.equal(resolvePollTurns({ pollTurns: -5 }), 1);
    assert.equal(resolvePollTurns({ pollTurns: 999 }), 50);
    assert.equal(resolvePollTurns({ pollTurns: 7.6 }), 8);
    assert.equal(resolvePollTurns({ pollTurns: 'not a number' }), 3);
});

test('resolvePollIntervalMs clamps minutes to [1, 180] and converts to milliseconds, defaulting to 5 minutes', () => {
    assert.equal(resolvePollIntervalMs({}), 5 * 60000);
    assert.equal(resolvePollIntervalMs({ pollIntervalMinutes: 0 }), 1 * 60000);
    assert.equal(resolvePollIntervalMs({ pollIntervalMinutes: 999 }), 180 * 60000);
    assert.equal(resolvePollIntervalMs({ pollIntervalMinutes: 'nope' }), 5 * 60000);
    assert.equal(resolvePollIntervalMs({ pollIntervalMinutes: 12.4 }), 12 * 60000);
});

// ---------------------------------------------------------------------------
// runBlockPoll — the one piece of SideCar-request-and-store-write logic
// shared by all 4 modes. Never throws.
// ---------------------------------------------------------------------------

function makeStoreHost({ chat = [], sidecarRequest } = {}) {
    const context = { chat, chatMetadata: {} };
    const store = createTrackerStore(() => context);
    const host = {
        context: () => context,
        sidecar: { request: sidecarRequest ?? (async () => '{}') },
    };
    return { host, store, context };
}

function makeBlock(overrides = {}) {
    return {
        id: 'b1', title: 'Vitals', enabled: true,
        fields: [{ name: 'health', instruction: '' }],
        sidecarProfile: 'default', systemPromptTemplate: 'sys {fields}', promptTemplate: 'prompt {current}', displayTemplate: '',
        ...overrides,
    };
}

test('runBlockPoll fails without calling SideCar when the block has no fields configured', async () => {
    const requests = [];
    const { host, store } = makeStoreHost({ sidecarRequest: async opts => { requests.push(opts); return '{}'; } });
    const result = await runBlockPoll(host, store, makeBlock({ fields: [] }));
    assert.equal(result.ok, false);
    assert.match(result.error.message, /no fields configured/i);
    assert.equal(requests.length, 0);
});

test('runBlockPoll fails when SideCar itself rejects', async () => {
    const { host, store } = makeStoreHost({ sidecarRequest: async () => { throw new Error('connection refused'); } });
    const result = await runBlockPoll(host, store, makeBlock());
    assert.equal(result.ok, false);
    assert.match(result.error.message, /connection refused/);
});

test('runBlockPoll fails when SideCar\'s reply has no parseable JSON object', async () => {
    const { host, store } = makeStoreHost({ sidecarRequest: async () => 'sorry, I cannot help with that' });
    const result = await runBlockPoll(host, store, makeBlock());
    assert.equal(result.ok, false);
    assert.match(result.error.message, /no usable data/i);
});

test('runBlockPoll succeeds end to end: writes the parsed field to the store and builds a label', async () => {
    const { host, store } = makeStoreHost({ sidecarRequest: async () => '{"health": "72"}' });
    const result = await runBlockPoll(host, store, makeBlock());
    assert.equal(result.ok, true);
    assert.equal(result.nextState.health, '72');
    assert.equal(result.label, 'health: 72');
    assert.deepEqual(result.fields, ['health']);
    // and it really persisted to the store, not just returned in-memory:
    assert.equal(store.get('b1').health, '72');
});

// ---------------------------------------------------------------------------
// waitForPostProcess — must never hang when Post-Turn Processor isn't
// present, must resolve on a matching signal, and — the actual race this
// function exists to avoid — must not miss a signal that fires the instant
// after subscribing, in the SAME synchronous tick, with no timer ever
// advanced. mock.timers with the clock left untouched is the proof: if the
// implementation only resolved via its timeout, this test would hang.
// ---------------------------------------------------------------------------

function makeMessageHandledService() {
    const listeners = new Set();
    return {
        service: {
            onMessageHandled(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        },
        emit(messageId) { for (const listener of [...listeners]) listener(messageId); },
    };
}

test('waitForPostProcess resolves immediately when the postprocess service is not available at all', async () => {
    const host = { services: { isAvailable: () => false, request: () => { throw new Error('should not be called'); } } };
    await waitForPostProcess(host, 'm1', 50); // would time out after 50ms if this were broken; it must return long before that
});

test('waitForPostProcess resolves immediately when the registered service has no onMessageHandled', async () => {
    const host = { services: { isAvailable: () => true, request: () => ({}) } };
    await waitForPostProcess(host, 'm1', 50);
});

test('waitForPostProcess resolves on a matching signal without needing its timeout, even fired synchronously in the same tick', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const { service, emit } = makeMessageHandledService();
        const host = { services: { isAvailable: () => true, request: () => service } };
        const wait = waitForPostProcess(host, 'm1', 999999); // huge timeout — if the test ever needed it, it would hang forever since the fake clock is never advanced
        emit('m1'); // synchronous, no await between subscribe and this — the exact race the doc comment describes
        await wait; // must resolve from the signal alone; mock.timers.tick() is never called
    } finally {
        mock.timers.reset();
    }
});

test('waitForPostProcess ignores a signal for a different messageId and only resolves via its own timeout', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const { service, emit } = makeMessageHandledService();
        const host = { services: { isAvailable: () => true, request: () => service } };
        let resolved = false;
        const wait = waitForPostProcess(host, 'm1', 1000).then(() => { resolved = true; });
        emit('some-other-message');
        assert.equal(resolved, false, 'a mismatched id must not resolve the wait');
        mock.timers.tick(1000);
        await wait;
        assert.equal(resolved, true, 'the timeout must still fire eventually as a safety net');
    } finally {
        mock.timers.reset();
    }
});

// ---------------------------------------------------------------------------
// activate()-level integration: the actual per-block dispatch wiring, through
// a real ModuleEngine (same convention as tracker-publish-reconciliation.test.js)
// so host.data/host.services behave exactly as they do in the real extension.
// document/Node are stubbed (Tracker's HUD panel needs a DOM to construct at
// all) and global fetch is stubbed to stand in for the SideCar HTTP call.
// ---------------------------------------------------------------------------

function installStubDom() {
    const previous = { document: globalThis.document, Node: globalThis.Node };
    class StubNode {}
    function makeStub() {
        const node = new StubNode();
        Object.assign(node, {
            className: '', innerHTML: '', textContent: '', style: {}, dataset: {}, hidden: false,
            classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
            addEventListener() {}, removeEventListener() {},
            append() {}, appendChild() {}, prepend() {}, remove() {}, replaceChildren() {},
            setAttribute() {}, removeAttribute() {},
            querySelector: () => makeStub(),
            querySelectorAll: () => [],
        });
        return node;
    }
    globalThis.Node = StubNode;
    globalThis.document = { createElement: () => makeStub(), createTextNode: text => Object.assign(makeStub(), { textContent: text }), body: makeStub(), head: makeStub() };
    return () => { globalThis.document = previous.document; globalThis.Node = previous.Node; };
}

/** A working (recording + replayable) fake ST eventSource — real enough for host.onEvent()'s direct subscriptions. */
function makeEventSource() {
    const listeners = new Map(); // name -> Set<fn>
    return {
        eventSource: {
            on(name, fn) { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); },
            off(name, fn) { listeners.get(name)?.delete(fn); },
        },
        async fire(name, ...args) {
            const fns = [...(listeners.get(name) ?? [])];
            await Promise.all(fns.map(fn => fn(...args)));
        },
    };
}

function makeEngine({ chat = [] } = {}) {
    const { eventSource, fire } = makeEventSource();
    const context = {
        extensionSettings: {}, chatMetadata: {}, chat,
        eventSource,
        updateMessageBlock() {}, saveChatConditional() {}, saveChat() {}, saveMetadataDebounced() {},
        saveSettingsDebounced() {},
    };
    const engine = new ModuleEngine(() => context);
    // A configured SideCar worker (see core/sidecar-manager.js's configs()/isConfigured()) —
    // real fetch is stubbed below rather than mocking SidecarManager itself, so the
    // real request()/queue/#pick() code path runs exactly as it does in production.
    engine.settings().sidecars = [{ id: 'primary', name: 'Primary', enabled: true, endpoint: 'http://sidecar.test', format: 'openai' }];
    return { engine, context, fire };
}

/** Stubs global fetch to answer every SideCar chat-completion call with `reply` (a JSON string, e.g. '{"health":"80"}'). */
function stubSidecarFetch(replyOrFn) {
    const calls = [];
    const previous = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        const content = typeof replyOrFn === 'function' ? await replyOrFn(calls.length) : replyOrFn;
        return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
    };
    return { calls, restore: () => { globalThis.fetch = previous; } };
}

/**
 * Modes 1 and 4 deliberately fire-and-forget runAndApply() (see its own call
 * sites in activate()) rather than awaiting it — MESSAGE_SENT's own listener
 * isn't async, and a setInterval() callback has nothing to await either. A
 * test that fires the event/tick must therefore wait out the SideCar
 * round trip's own microtask chain (real fetch stub -> SidecarService ->
 * SidecarManager's queue -> runBlockPoll -> runAndApply's publish()) before
 * asserting on its result — several hops deeper than a single
 * `await Promise.resolve()`. Purely microtask-based, so this costs no real
 * wall-clock time even under mock.timers.
 */
async function flushAsync(rounds = 25) {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function makeTrackerBlock(overrides = {}) {
    return {
        id: 'b1', title: 'Vitals', collapsed: false, enabled: true,
        fields: [{ name: 'health', instruction: '' }],
        sidecarProfile: 'default', systemPromptTemplate: 'sys', promptTemplate: 'prompt', displayTemplate: '',
        ...overrides,
    };
}

test('mode "user-message": MESSAGE_SENT polls the block and updates the bus, with no message-.extra snapshot', async () => {
    const restoreDom = installStubDom();
    const chat = [{ is_user: true, is_system: false, mesid: 0, mes: 'hi' }];
    const { engine, fire } = makeEngine({ chat });
    const fetchStub = stubSidecarFetch('{"health": "55"}');
    try {
        engine.register(trackerModule);
        const settings = engine.moduleSettings('tracker', {});
        settings.blocks = [makeTrackerBlock({ pollMode: 'user-message' })];
        await engine.enable('tracker');

        await fire('MESSAGE_SENT', 0);
        await flushAsync();

        assert.equal(fetchStub.calls.length, 1, 'the user-message-mode block must poll on MESSAGE_SENT');
        assert.equal(engine.bus.get('tracker', 'field:b1:health'), '55', 'the fresh value must reach the bus');
        assert.equal(chat[0].extra, undefined, 'mode 1 must never write a message-.extra snapshot — there is no AI message yet to attach one to');
    } finally {
        fetchStub.restore();
        restoreDom();
    }
});

test('mode "after-turn" (default): MESSAGE_RECEIVED polls and snapshots the label onto the message', async () => {
    const restoreDom = installStubDom();
    const chat = [{ is_user: false, is_system: false, mesid: 0, mes: 'The character replies.', extra: {} }];
    const { engine, fire } = makeEngine({ chat });
    const fetchStub = stubSidecarFetch('{"health": "90"}');
    try {
        engine.register(trackerModule);
        const settings = engine.moduleSettings('tracker', {});
        settings.blocks = [makeTrackerBlock()]; // default pollMode: 'after-turn'
        await engine.enable('tracker');

        await fire('MESSAGE_RECEIVED', 0, 'normal');

        assert.equal(fetchStub.calls.length, 1);
        assert.equal(chat[0].extra.stme_tracker_snapshot.b1.label, 'health: 90');
        assert.equal(engine.bus.get('tracker', 'field:b1:health'), '90');
    } finally {
        fetchStub.restore();
        restoreDom();
    }
});

test('an "after-turn" block waits for Post-Turn Processor\'s onMessageHandled signal before polling', async () => {
    const restoreDom = installStubDom();
    const chat = [{ is_user: false, is_system: false, mesid: 0, mes: 'reply', extra: {} }];
    const { engine, fire } = makeEngine({ chat });
    const fetchStub = stubSidecarFetch('{"health": "40"}');
    let releasePostprocess;
    const gate = new Promise(resolve => { releasePostprocess = resolve; });
    try {
        // A fake 'postprocess' service, registered BEFORE tracker enables — same
        // dependency order the real extension's index.js establishes.
        let signalMessageId = null;
        engine.register({
            id: 'fake-postprocess',
            title: 'Fake Post-Turn Processor',
            activate(host) {
                host.services.register('postprocess', {
                    onMessageHandled(listener) {
                        gate.then(() => listener(signalMessageId));
                        return () => {};
                    },
                });
                return () => {};
            },
            render() {},
        });
        await engine.enable('fake-postprocess');

        engine.register(trackerModule);
        const settings = engine.moduleSettings('tracker', {});
        settings.blocks = [makeTrackerBlock()];
        await engine.enable('tracker');

        signalMessageId = 0;
        const received = fire('MESSAGE_RECEIVED', 0, 'normal'); // not awaited yet — must not resolve until the gate opens
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(fetchStub.calls.length, 0, 'must not poll SideCar before Post-Turn Processor signals it is done with this message');

        releasePostprocess();
        await received;
        assert.equal(fetchStub.calls.length, 1, 'must poll once Post-Turn Processor signals');
        assert.equal(chat[0].extra.stme_tracker_snapshot.b1.label, 'health: 40');
    } finally {
        fetchStub.restore();
        restoreDom();
    }
});

test('mode "every-n-turns": polls only on the Nth real AI reply, resetting the counter afterward', async () => {
    const restoreDom = installStubDom();
    const chat = [{ is_user: false, is_system: false, mesid: 0, mes: 'reply', extra: {} }];
    const { engine, fire } = makeEngine({ chat });
    const fetchStub = stubSidecarFetch('{"health": "33"}');
    try {
        engine.register(trackerModule);
        const settings = engine.moduleSettings('tracker', {});
        settings.blocks = [makeTrackerBlock({ pollMode: 'every-n-turns', pollTurns: 3 })];
        await engine.enable('tracker');

        await fire('MESSAGE_RECEIVED', 0, 'normal');
        assert.equal(fetchStub.calls.length, 0, 'turn 1/3 — must not poll yet');
        await fire('MESSAGE_RECEIVED', 0, 'normal');
        assert.equal(fetchStub.calls.length, 0, 'turn 2/3 — must not poll yet');
        await fire('MESSAGE_RECEIVED', 0, 'normal');
        assert.equal(fetchStub.calls.length, 1, 'turn 3/3 — must poll now');
        assert.equal(chat[0].extra.stme_tracker_snapshot.b1.label, 'health: 33');

        delete chat[0].extra.stme_tracker_snapshot; // simulate a fresh reply so the "already snapshotted" guard doesn't mask the next window
        await fire('MESSAGE_RECEIVED', 0, 'normal');
        assert.equal(fetchStub.calls.length, 1, 'counter must have reset — turn 1 of the next window must not poll yet');
    } finally {
        fetchStub.restore();
        restoreDom();
    }
});

test('mode "every-n-time": a real timer polls periodically and just publish()es — no message snapshot', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    const restoreDom = installStubDom();
    const chat = [];
    const { engine } = makeEngine({ chat });
    const fetchStub = stubSidecarFetch('{"health": "20"}');
    try {
        engine.register(trackerModule);
        const settings = engine.moduleSettings('tracker', {});
        settings.blocks = [makeTrackerBlock({ pollMode: 'every-n-time', pollIntervalMinutes: 1 })];
        await engine.enable('tracker');

        assert.equal(fetchStub.calls.length, 0, 'must not poll immediately on enable — only once the interval elapses');
        mock.timers.tick(60000);
        await flushAsync();

        assert.equal(fetchStub.calls.length, 1);
        assert.equal(engine.bus.get('tracker', 'field:b1:health'), '20', 'the fresh value must still reach the bus via publish()');
    } finally {
        fetchStub.restore();
        restoreDom();
        mock.timers.reset();
    }
});

test('changing a block\'s poll-interval setting reconciles its timer instead of leaving the old one running (syncPollTimers, via publish())', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    const restoreDom = installStubDom();
    const { engine } = makeEngine({ chat: [] });
    const fetchStub = stubSidecarFetch('{"health": "10"}');
    try {
        engine.register(trackerModule);
        const settings = engine.moduleSettings('tracker', {});
        settings.blocks = [makeTrackerBlock({ pollMode: 'every-n-time', pollIntervalMinutes: 5 })];
        await engine.enable('tracker');

        settings.blocks[0].pollIntervalMinutes = 1;
        engine.bus.get('tracker', 'publish')();

        mock.timers.tick(60000); // the OLD 5-minute timer would not have fired yet at 1 minute
        await flushAsync();
        assert.equal(fetchStub.calls.length, 1, 'the reconciled 1-minute timer must have fired');
    } finally {
        fetchStub.restore();
        restoreDom();
        mock.timers.reset();
    }
});

test('removing a block from settings clears its running "every-n-time" timer (syncPollTimers)', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    const restoreDom = installStubDom();
    const { engine } = makeEngine({ chat: [] });
    const fetchStub = stubSidecarFetch('{"health": "10"}');
    try {
        engine.register(trackerModule);
        const settings = engine.moduleSettings('tracker', {});
        settings.blocks = [makeTrackerBlock({ pollMode: 'every-n-time', pollIntervalMinutes: 1 })];
        await engine.enable('tracker');

        settings.blocks = [];
        engine.bus.get('tracker', 'publish')();

        mock.timers.tick(120000);
        await flushAsync();
        assert.equal(fetchStub.calls.length, 0, 'a removed block\'s timer must be cleared, not keep firing');
    } finally {
        fetchStub.restore();
        restoreDom();
        mock.timers.reset();
    }
});
