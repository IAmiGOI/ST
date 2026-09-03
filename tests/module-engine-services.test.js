import test from 'node:test';
import assert from 'node:assert/strict';
import { ModuleEngine } from '../core/module-engine.js';

/**
 * These tests exercise register()/enable()/disable() and the host API only —
 * never mount(), so render() is never invoked and no DOM is needed at all.
 */
function makeEngine() {
    const context = {
        extensionSettings: {}, chatMetadata: {}, chat: [],
        eventTypes: {}, eventSource: { on() {}, off() {} },
        saveSettingsDebounced() {}, saveMetadataDebounced() {},
    };
    return new ModuleEngine(() => context);
}

function stubModule(id, overrides = {}) {
    return { id, title: id, description: '', defaultEnabled: true, activate: () => () => {}, render() {}, ...overrides };
}

test('services.request() returns undefined-free access to a registered service', async () => {
    const engine = makeEngine();
    let greeting = null;
    engine.register(stubModule('provider', {
        activate(host) {
            host.services.register('greeter', { greet: name => `Hello, ${name}` });
            return () => {};
        },
    }));
    engine.register(stubModule('consumer', {
        activate(host) {
            greeting = host.services.request('greeter').greet('world');
            return () => {};
        },
    }));
    await engine.start();
    assert.equal(greeting, 'Hello, world');
});

test('services.get() is undefined when the provider is not enabled; request() never is', async () => {
    const engine = makeEngine();
    engine.register(stubModule('provider', { defaultEnabled: false, activate: () => () => {} }));
    let getResult = 'unset';
    let requestResult = 'unset';
    engine.register(stubModule('consumer', {
        activate(host) {
            getResult = host.services.get('nope');
            requestResult = host.services.request('nope');
            return () => {};
        },
    }));
    await engine.start();
    assert.equal(getResult, undefined);
    assert.notEqual(requestResult, undefined);
});

test('a void service (request() for an unavailable provider) never throws, however deep the chain', async () => {
    const engine = makeEngine();
    let threw = false;
    engine.register(stubModule('consumer', {
        activate(host) {
            try {
                const service = host.services.request('does-not-exist');
                service.doAnything(1, 2, 3).thenSomethingElse().andAgain('x').whatever;
            } catch { threw = true; }
            return () => {};
        },
    }));
    await engine.start();
    assert.equal(threw, false);
});

test('isAvailable() flips with the provider\'s enabled state', async () => {
    const engine = makeEngine();
    let checkerHost;
    engine.register(stubModule('provider', {
        activate(host) { host.services.register('svc', {}); return () => {}; },
    }));
    engine.register(stubModule('checker', {
        activate(host) { checkerHost = host; return () => {}; },
    }));
    await engine.start();

    assert.equal(checkerHost.services.isAvailable('svc'), true, 'available while the provider is enabled');
    await engine.disable('provider');
    assert.equal(checkerHost.services.isAvailable('svc'), false, 'no longer available once the provider is disabled');
    await engine.enable('provider');
    assert.equal(checkerHost.services.isAvailable('svc'), true, 're-enabling the provider re-registers the service');
});

test('disabling the providing module unregisters its service — a consumer degrades instead of erroring', async () => {
    const engine = makeEngine();
    let consumerHost;
    engine.register(stubModule('provider', {
        activate(host) { host.services.register('svc', { ping: () => 'pong' }); return () => {}; },
    }));
    engine.register(stubModule('consumer', {
        activate(host) { consumerHost = host; return () => {}; },
    }));
    await engine.start();
    assert.equal(consumerHost.services.request('svc').ping(), 'pong');

    await engine.disable('provider');
    assert.equal(consumerHost.services.get('svc'), undefined);
    assert.doesNotThrow(() => consumerHost.services.request('svc').ping());
});

test('ask() delivers a typed request to the provider\'s handleRequest and returns its answer', async () => {
    const engine = makeEngine();
    let consumerHost;
    engine.register(stubModule('tracker-ish', {
        activate(host) {
            host.services.register('tracker', {
                handleRequest(type, payload, askerId) {
                    if (type === 'classify') return { keys: payload.vocabulary.filter(key => key === 'combat'), askerId };
                    throw new Error(`unknown type ${type}`);
                },
            });
            return () => {};
        },
    }));
    engine.register(stubModule('music', { activate(host) { consumerHost = host; return () => {}; } }));
    await engine.start();

    const answer = await consumerHost.services.ask('tracker', 'classify', { vocabulary: ['combat', 'tavern'] });
    assert.deepEqual(answer, { keys: ['combat'], askerId: 'music' });
});

test('ask() resolves to undefined (never rejects) when the service is missing, unsupported, or throws', async () => {
    const engine = makeEngine();
    let host;
    engine.register(stubModule('provider', {
        activate(h) {
            h.services.register('no-handler', { push() {} });
            h.services.register('throws', { handleRequest() { throw new Error('boom'); } });
            return () => {};
        },
    }));
    engine.register(stubModule('consumer', { activate(h) { host = h; return () => {}; } }));
    await engine.start();

    await assert.doesNotReject(async () => {
        assert.equal(await host.services.ask('does-not-exist', 'x', {}), undefined);
        assert.equal(await host.services.ask('no-handler', 'x', {}), undefined);
        assert.equal(await host.services.ask('throws', 'x', {}), undefined);
    });
});

test('a module can unregister its own service explicitly, but not one it does not own', async () => {
    const engine = makeEngine();
    let ownerHost;
    let impostorHost;
    engine.register(stubModule('owner', {
        activate(host) { ownerHost = host; host.services.register('svc', { x: 1 }); return () => {}; },
    }));
    engine.register(stubModule('impostor', {
        activate(host) { impostorHost = host; return () => {}; },
    }));
    await engine.start();
    assert.equal(ownerHost.services.get('svc').x, 1);

    impostorHost.services.unregister('svc'); // not the owner — must be a no-op
    assert.equal(ownerHost.services.get('svc').x, 1, 'a non-owner cannot unregister someone else\'s service');

    ownerHost.services.unregister('svc');
    assert.equal(ownerHost.services.get('svc'), undefined, 'the owner can unregister its own service');
});
