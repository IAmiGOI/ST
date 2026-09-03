import test from 'node:test';
import assert from 'node:assert/strict';
import { ModuleDataBus } from '../core/data-bus.js';

test('ModuleDataBus exchanges arbitrary values by namespace without ST state', () => {
    const bus = new ModuleDataBus();
    const object = { nested: ['any', 'value'] };
    let received;
    const unsubscribe = bus.subscribe('time', 'result', value => { received = value; });
    bus.set('time', 'result', object);
    assert.equal(bus.get('time', 'result'), object);
    assert.equal(received, object);
    unsubscribe();
    bus.set('time', 'result', 'next');
    assert.equal(received, object);
    assert.equal(bus.get('missing', 'key', 'fallback'), 'fallback');
});

test('reserve() with a shape schema rejects a malformed write and keeps the last good value', () => {
    const reports = [];
    const bus = new ModuleDataBus({ onContaminate: report => reports.push(report) });
    bus.reserve('tracker', 'health', { name: 'Health', schema: { type: 'string' } });
    assert.equal(bus.set('tracker', 'health', 'Healthy'), true);
    assert.equal(bus.set('tracker', 'health', { not: 'a string' }), false);
    assert.equal(bus.get('tracker', 'health'), 'Healthy');
    assert.equal(reports.length, 1);
    assert.equal(reports[0].type, 'schema-violation');
});

test('reserve() with a function schema can reject with a custom message', () => {
    const bus = new ModuleDataBus();
    bus.reserve('time', 'clock', { schema: value => (typeof value === 'string' && value.length <= 5) || 'too long' });
    assert.equal(bus.set('time', 'clock', '12:00'), true);
    assert.equal(bus.set('time', 'clock', 'this is way too long'), false);
    assert.equal(bus.get('time', 'clock'), '12:00');
});

test('a write from another module into a reserved channel is rejected unless allowExternalWrite is set', () => {
    const bus = new ModuleDataBus();
    bus.reserve('tracker', 'health', {});
    assert.equal(bus.write('tracker', 'health', 'hacked', 'some-other-module'), false);
    assert.equal(bus.get('tracker', 'health'), undefined);

    bus.reserve('tracker', 'open', { allowExternalWrite: true });
    assert.equal(bus.write('tracker', 'open', 'ok', 'some-other-module'), true);
    assert.equal(bus.get('tracker', 'open'), 'ok');

    // The owner itself can always write, regardless of allowExternalWrite.
    assert.equal(bus.write('tracker', 'health', 'Healthy', 'tracker'), true);
});

test('an unreserved key has no protection at all — anyone can write it, as before', () => {
    const bus = new ModuleDataBus();
    assert.equal(bus.write('anyone', 'anything', 123, 'someone-else'), true);
    assert.equal(bus.get('anyone', 'anything'), 123);
});

test('a channel writing far faster than the rate limit gets throttled', () => {
    const bus = new ModuleDataBus();
    bus.reserve('spammy', 'counter', {});
    let accepted = 0;
    for (let i = 0; i < 30; i++) if (bus.set('spammy', 'counter', i)) accepted++;
    assert.ok(accepted < 30, 'some writes within the same window must be dropped');
    assert.ok(accepted >= 20, 'the limit itself should not be overly aggressive');
});

test('history() keeps recent values and restore() rolls back without re-validating', () => {
    const bus = new ModuleDataBus();
    bus.reserve('tracker', 'health', { schema: { type: 'string' } });
    bus.set('tracker', 'health', 'Healthy');
    bus.set('tracker', 'health', 'Injured');
    bus.set('tracker', 'health', 'Critical');
    const history = bus.history('tracker', 'health');
    assert.deepEqual(history.map(entry => entry.value), ['Critical', 'Injured', 'Healthy']);

    let received;
    bus.subscribe('tracker', 'health', value => { received = value; });
    assert.equal(bus.restore('tracker', 'health', 1), true);
    assert.equal(bus.get('tracker', 'health'), 'Injured');
    assert.equal(received, 'Injured');
    assert.equal(bus.restore('tracker', 'health', 50), false, 'restoring past the kept history fails cleanly');
});

test('releaseNamespace() drops values and channel metadata owned by that namespace only', () => {
    const bus = new ModuleDataBus();
    bus.reserve('tracker', 'health', {});
    bus.set('tracker', 'health', 'Healthy');
    bus.set('time', 'clock', '12:00');

    bus.releaseNamespace('tracker');
    assert.equal(bus.get('tracker', 'health'), undefined);
    assert.deepEqual(bus.history('tracker', 'health'), []);
    assert.equal(bus.describe('tracker', 'health'), null);
    assert.equal(bus.get('time', 'clock'), '12:00', 'an unrelated namespace is untouched');
});

test('re-reserving the same channel (same owner) cleanly swaps its macro registration', () => {
    const registered = new Map();
    const context = { registerMacro: (name, handler) => registered.set(name, handler), unregisterMacro: name => registered.delete(name) };
    const bus = new ModuleDataBus({ getContext: () => context });
    bus.reserve('tracker', 'health', { name: 'Health', macro: 'health_v1' });
    assert.equal(registered.has('health_v1'), true);
    bus.reserve('tracker', 'health', { name: 'Health', macro: 'health_v2' });
    assert.equal(registered.has('health_v1'), false, 'the old macro name is unregistered on redeclaration');
    assert.equal(registered.has('health_v2'), true);
});

test('listChannels() and findByName() address channels by id or by human name', () => {
    const bus = new ModuleDataBus();
    bus.reserve('tracker', 'health', { name: 'Health' });
    bus.reserve('tracker', 'mood', { name: 'Mood' });
    const own = bus.listChannels('tracker');
    assert.equal(own.length, 2);
    assert.deepEqual(own.map(c => c.id).sort(), ['tracker:health', 'tracker:mood']);
    const found = bus.findByName('Mood');
    assert.equal(found.id, 'tracker:mood');
    assert.equal(bus.findByName('Nope'), null);
});

test('macro: reserving with { macro } registers a live-reading macro via the legacy context API', () => {
    const registered = new Map();
    const context = {
        registerMacro: (name, handler) => registered.set(name, handler),
        unregisterMacro: name => registered.delete(name),
    };
    const bus = new ModuleDataBus({ getContext: () => context });
    bus.reserve('tracker', 'health', { macro: 'tracker_health' });
    assert.equal(registered.has('tracker_health'), true);
    bus.set('tracker', 'health', 'Injured');
    assert.equal(registered.get('tracker_health')(), 'Injured');

    bus.releaseNamespace('tracker');
    assert.equal(registered.has('tracker_health'), false);
});

test('macro: prefers the modern macros.register() API when the host exposes it', () => {
    const registered = new Map();
    const context = { macros: { register: (name, options) => registered.set(name, options) } };
    const bus = new ModuleDataBus({ getContext: () => context });
    bus.reserve('tracker', 'health', { macro: 'tracker_health' });
    bus.set('tracker', 'health', 'Healthy');
    assert.equal(registered.get('tracker_health').handler(), 'Healthy');
});

test('macro: a colliding macro name is rejected for the second channel, first keeps working', () => {
    const reports = [];
    const registered = new Map();
    const context = { registerMacro: (name, handler) => registered.set(name, handler) };
    const bus = new ModuleDataBus({ getContext: () => context, onContaminate: report => reports.push(report) });
    bus.reserve('tracker', 'health', { macro: 'state' });
    bus.reserve('time', 'clock', { macro: 'state' });
    assert.equal(reports.some(report => report.type === 'macro-collision'), true);
    bus.set('tracker', 'health', 'Healthy');
    assert.equal(registered.get('state')(), 'Healthy');
});

function makeContextWithMetadata() {
    const state = { chatMetadata: {}, saves: 0 };
    state.context = { chatMetadata: state.chatMetadata, saveMetadataDebounced: () => state.saves++ };
    return state;
}

test('persist: an accepted write to a persist:true channel is mirrored into chatMetadata', () => {
    const state = makeContextWithMetadata();
    const bus = new ModuleDataBus({ getContext: () => state.context });
    bus.reserve('tracker', 'health', { persist: true });
    bus.set('tracker', 'health', 'Injured');
    assert.equal(state.chatMetadata.stme_bus['tracker:health'], 'Injured');
    assert.ok(state.saves >= 1, 'saveMetadataDebounced was called');
});

test('persist: a fresh bus instance rehydrates a persisted value on reserve() — surviving a page reload', () => {
    const state = makeContextWithMetadata();
    const first = new ModuleDataBus({ getContext: () => state.context });
    first.reserve('tracker', 'health', { persist: true });
    first.set('tracker', 'health', 'Critical');

    // Simulate a page reload: a brand new bus instance, same chatMetadata object.
    const second = new ModuleDataBus({ getContext: () => state.context });
    assert.equal(second.get('tracker', 'health'), undefined, 'nothing in memory yet, before reserve() runs');
    second.reserve('tracker', 'health', { persist: true });
    assert.equal(second.get('tracker', 'health'), 'Critical', 'reserve() rehydrated the value from chatMetadata');
});

test('persist: a non-persisted channel never touches chatMetadata', () => {
    const state = makeContextWithMetadata();
    const bus = new ModuleDataBus({ getContext: () => state.context });
    bus.reserve('time', 'clock', {});
    bus.set('time', 'clock', '12:00');
    assert.equal(state.chatMetadata.stme_bus, undefined);
});

test('persist: remove() also clears the persisted copy', () => {
    const state = makeContextWithMetadata();
    const bus = new ModuleDataBus({ getContext: () => state.context });
    bus.reserve('tracker', 'health', { persist: true });
    bus.set('tracker', 'health', 'Injured');
    bus.remove('tracker', 'health');
    assert.equal('tracker:health' in state.chatMetadata.stme_bus, false);
});

test('webhook: an accepted write POSTs the value to the reserved pushUrl', async () => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({}) }; };
    try {
        const bus = new ModuleDataBus();
        bus.reserve('tracker', 'health', { name: 'Health', webhook: { pushUrl: 'https://example.invalid/push' } });
        bus.set('tracker', 'health', 'Healthy');
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'https://example.invalid/push');
        assert.equal(calls[0].body.value, 'Healthy');
        assert.equal(calls[0].body.id, 'tracker:health');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('webhook: a failed push never throws and never blocks the write from being applied', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('network down'); };
    try {
        const bus = new ModuleDataBus();
        bus.reserve('tracker', 'health', { webhook: { pushUrl: 'https://example.invalid/push' } });
        assert.equal(bus.set('tracker', 'health', 'Healthy'), true);
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(bus.get('tracker', 'health'), 'Healthy');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('webhook: pulled external data still goes through schema + ownership validation', async () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    let capturedTick;
    globalThis.setInterval = fn => { capturedTick = fn; return 1; };
    globalThis.clearInterval = () => {};
    const originalFetch = globalThis.fetch;
    try {
        const goodValue = { level: 'ok' };
        globalThis.fetch = async () => ({ ok: true, json: async () => goodValue });
        const bus = new ModuleDataBus();
        bus.reserve('tracker', 'remote', { schema: { type: 'object' }, allowExternalWrite: true, webhook: { pullUrl: 'https://example.invalid/pull', pullIntervalMs: 5000 } });
        assert.equal(typeof capturedTick, 'function', 'a pull timer was scheduled');
        await capturedTick();
        assert.deepEqual(bus.get('tracker', 'remote'), goodValue);

        globalThis.fetch = async () => ({ ok: true, json: async () => 'not an object' });
        await capturedTick();
        assert.deepEqual(bus.get('tracker', 'remote'), goodValue, 'a malformed pull is rejected, last good value stays');
    } finally {
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
        globalThis.fetch = originalFetch;
    }
});

test('a listener that subscribes a new listener to the same key during dispatch does not run it in the same pass (write)', () => {
    // Root cause of a real, previously-shipped bug: JS Set iteration is LIVE, so a listener
    // added mid-dispatch used to be visited in the SAME for..of pass. Combined with a module
    // re-subscribing on every re-render, this formed a self-sustaining infinite synchronous
    // loop with no stack growth — RAM climbed until the tab hung. #applyWrite() must snapshot
    // the listeners before iterating.
    const bus = new ModuleDataBus();
    let firstPassCalls = 0;
    let secondListenerCallsDuringFirstDispatch = 0;
    const unsubscribeSecond = () => {};
    let secondSubscribed = false;
    bus.subscribe('m', 'key', () => {
        firstPassCalls++;
        if (!secondSubscribed) {
            secondSubscribed = true;
            bus.subscribe('m', 'key', () => { secondListenerCallsDuringFirstDispatch++; });
        }
    });
    bus.set('m', 'key', 1);
    assert.equal(firstPassCalls, 1, 'the first listener only runs once for this write');
    assert.equal(secondListenerCallsDuringFirstDispatch, 0, 'a listener subscribed mid-dispatch must not run until the NEXT write');
    bus.set('m', 'key', 2);
    assert.equal(secondListenerCallsDuringFirstDispatch, 1, 'it runs normally on a subsequent write');
    void unsubscribeSecond;
});

test('a listener that subscribes a new listener to the same key during dispatch does not run it in the same pass (restore)', () => {
    const bus = new ModuleDataBus();
    bus.set('m', 'key', 'v1');
    bus.set('m', 'key', 'v2');
    let sameDispatchCalls = 0;
    let subscribed = false;
    bus.subscribe('m', 'key', () => {
        if (!subscribed) {
            subscribed = true;
            bus.subscribe('m', 'key', () => { sameDispatchCalls++; });
        }
    });
    bus.restore('m', 'key', 1); // rolls back to 'v1'
    assert.equal(sameDispatchCalls, 0, 'a listener subscribed during restore() dispatch must not run in the same pass');
});

test('unreserve(namespace, key) fully retires a channel: value, history, and macro all gone — not just protections', () => {
    const registered = new Map();
    const bus = new ModuleDataBus({ getContext: () => ({ registerMacro: (name, read) => registered.set(name, read), unregisterMacro: name => registered.delete(name) }) });
    bus.reserve('tracker', 'health', { name: 'Health', schema: { type: 'string' }, macro: 'tracker_health' });
    bus.set('tracker', 'health', 'Healthy');
    assert.equal(bus.get('tracker', 'health'), 'Healthy');
    assert.ok(registered.has('tracker_health'));
    assert.equal(bus.history('tracker', 'health').length, 1);

    bus.unreserve('tracker', 'health');

    assert.equal(bus.get('tracker', 'health'), undefined, 'the stale value must not keep being served after the channel is retired');
    assert.equal(registered.has('tracker_health'), false, 'the macro must be unregistered so {{tracker_health}} stops resolving to stale data');
    assert.equal(bus.history('tracker', 'health').length, 0);
    assert.equal(bus.describe('tracker', 'health'), null, 'the channel itself is gone, so a later plain write is unprotected again');
});

test('unreserve() on a key that was never reserved is a harmless no-op', () => {
    const bus = new ModuleDataBus();
    assert.doesNotThrow(() => bus.unreserve('nobody', 'nothing'));
});

test('re-reserving the same channel (e.g. re-publishing unchanged config) does not wipe its current value', () => {
    const bus = new ModuleDataBus();
    bus.reserve('tracker', 'health', { schema: { type: 'string' } });
    bus.set('tracker', 'health', 'Healthy');
    bus.reserve('tracker', 'health', { schema: { type: 'string' } });
    assert.equal(bus.get('tracker', 'health'), 'Healthy', 'only an explicit unreserve() should clear a value, not a routine re-reserve');
});

test('a listener that unsubscribes itself during dispatch does not break iteration for the remaining listeners', () => {
    const bus = new ModuleDataBus();
    let secondCalls = 0;
    let unsubscribeFirst;
    unsubscribeFirst = bus.subscribe('m', 'key', () => { unsubscribeFirst(); });
    bus.subscribe('m', 'key', () => { secondCalls++; });
    bus.set('m', 'key', 1);
    assert.equal(secondCalls, 1, 'unsubscribing mid-dispatch must not skip a later listener');
});
