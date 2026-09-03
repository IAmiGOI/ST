import test from 'node:test';
import assert from 'node:assert/strict';
import { ModuleEngine, ENGINE_VERSION, compareVersions } from '../core/module-engine.js';

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

// --- compareVersions ---

test('compareVersions compares dotted-numeric versions, including different segment counts', () => {
    assert.equal(compareVersions('1.2.0', '1.2.0'), 0);
    assert.equal(compareVersions('1.10.0', '1.2.0'), 1, 'segment-wise, not lexicographic — 10 > 2');
    assert.equal(compareVersions('1.2.0', '1.10.0'), -1);
    assert.equal(compareVersions('1.2', '1.2.0'), 0, 'a missing trailing segment counts as 0');
    assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
});

test('compareVersions treats missing/non-numeric input as version 0', () => {
    assert.equal(compareVersions(undefined, '0.0.0'), 0);
    assert.equal(compareVersions('1.0.0', undefined), 1);
});

// --- enable()-time compatibility gate ---

test('a module declaring a minEngineVersion the engine satisfies enables normally', async () => {
    const engine = makeEngine();
    let activated = false;
    engine.register(stubModule('ok', { minEngineVersion: ENGINE_VERSION, activate: () => { activated = true; return () => {}; } }));
    await engine.start();
    assert.equal(activated, true);
    assert.equal(engine.listModuleStates()[0].error, null);
});

test('a module requiring a newer engine than this one lands in the error state without activate() ever running', async () => {
    const engine = makeEngine();
    let activated = false;
    engine.register(stubModule('too-new', {
        minEngineVersion: '9999.0.0',
        activate: () => { activated = true; return () => {}; },
    }));
    await engine.start();
    assert.equal(activated, false, 'activate() must never run for an incompatible module');
    const state = engine.listModuleStates()[0];
    assert.match(state.error, /requires ST Module Engine v9999\.0\.0 or later/);
});

test('an incompatible module does not block a DIFFERENT module registered after it in the same init()', async () => {
    const engine = makeEngine();
    let otherActivated = false;
    engine.register(stubModule('too-new', { minEngineVersion: '9999.0.0' }));
    engine.register(stubModule('fine', { activate: () => { otherActivated = true; return () => {}; } }));
    await engine.start();
    assert.equal(otherActivated, true);
});

test('a module with no minEngineVersion at all is always considered compatible', async () => {
    const engine = makeEngine();
    let activated = false;
    engine.register(stubModule('no-version-field', { activate: () => { activated = true; return () => {}; } }));
    await engine.start();
    assert.equal(activated, true);
});

// --- unregister() ---

test('unregister() disables an active module and removes it from every registry', async () => {
    const engine = makeEngine();
    let cleanedUp = false;
    engine.register(stubModule('gone', { activate: () => () => { cleanedUp = true; } }));
    await engine.start();
    assert.equal(engine.listModuleStates().length, 1);

    await engine.unregister('gone');
    assert.equal(cleanedUp, true, 'the module\'s own cleanup() must run, same as disable()');
    assert.equal(engine.listModuleStates().length, 0, 'fully gone, not just disabled');
});

test('after unregister(), the same id can be registered again fresh (no "already registered" error)', async () => {
    const engine = makeEngine();
    engine.register(stubModule('reusable'));
    await engine.start();
    await engine.unregister('reusable');

    assert.doesNotThrow(() => engine.register(stubModule('reusable', { title: 'Reusable v2' })));
    await engine.enable('reusable');
    assert.equal(engine.listModuleStates()[0].title, 'Reusable v2');
});

test('unregister() releases a service the module provided, same as disable()', async () => {
    const engine = makeEngine();
    let consumerHost;
    engine.register(stubModule('provider', { activate(host) { host.services.register('svc', { x: 1 }); return () => {}; } }));
    engine.register(stubModule('consumer', { activate(host) { consumerHost = host; return () => {}; } }));
    await engine.start();
    assert.equal(consumerHost.services.isAvailable('svc'), true);

    await engine.unregister('provider');
    assert.equal(consumerHost.services.isAvailable('svc'), false);
});

test('unregister() on an unknown id is a harmless no-op', async () => {
    const engine = makeEngine();
    await assert.doesNotReject(() => engine.unregister('never-registered'));
});

// --- installModule() — the public entry point a future community-catalog browser
// will call per entry (engine.installModule(entry.url)), same mechanism as the
// Module Loader card's own "Load module" button. Node's ESM loader can't
// dynamic-import(blob:...) (confirmed elsewhere in this repo), so this only proves
// delegation up to that point — the import step itself is real-browser-only, same
// as the pre-existing "Load module" button it shares code with. ---

test('installModule() delegates to the same download path #loadRemoteModule uses (proves it is not a separate/divergent implementation)', async () => {
    const engine = makeEngine();
    let requestedUrl;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async url => { requestedUrl = url; return { ok: false, status: 404 }; };
    try {
        await assert.rejects(() => engine.installModule('https://raw.githubusercontent.com/x/y/main/index.js'), /Module download failed: HTTP 404/);
        assert.equal(requestedUrl, 'https://raw.githubusercontent.com/x/y/main/index.js');
    } finally { globalThis.fetch = originalFetch; }
});
