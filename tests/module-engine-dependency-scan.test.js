import test from 'node:test';
import assert from 'node:assert/strict';
import { ModuleEngine } from '../core/module-engine.js';

/**
 * Covers ModuleEngine's #moduleSourceUrl + start()'s fire-and-forget
 * scanServiceContracts() call — the wiring that lets core/dependency-scanner.js
 * find each module's own raw source to regex-parse. The scanner's own parsing
 * logic is covered in tests/dependency-scanner.test.js; this only proves the
 * engine hands it the right URLs, for the right modules, without blocking start().
 */

function stubModule(id, overrides = {}) {
    return { id, title: id, description: '', defaultEnabled: true, activate: () => () => {}, render() {}, ...overrides };
}

// Returns a stable context reference (captured once), never a fresh object per
// call — getContext() is called repeatedly throughout ModuleEngine's own code, and
// a test context must behave like the real one: the SAME settings object across
// every call, not a new blank one each time.
function makeEngine(baseUrl) {
    const context = {
        extensionSettings: {}, chatMetadata: {}, chat: [],
        eventTypes: {}, eventSource: { on() {}, off() {} },
        saveSettingsDebounced() {}, saveMetadataDebounced() {},
    };
    return new ModuleEngine(() => context, baseUrl);
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('start() scans every built-in module at baseUrl + modules/<id>/index.js — once for service contracts, once for activation conditions (two separate scans, see dependency-scanner.js)', async () => {
    const engine = makeEngine('https://host/ext/');
    engine.register(stubModule('tracker'));
    engine.register(stubModule('music', { defaultEnabled: false }));

    const requestedUrls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async url => { requestedUrls.push(String(url)); return { ok: true, text: async () => '' }; };
    try {
        await engine.start();
        await settle();
        const counts = requestedUrls.reduce((map, url) => map.set(url, (map.get(url) ?? 0) + 1), new Map());
        assert.deepEqual([...counts.keys()].sort(), ['https://host/ext/modules/music/index.js', 'https://host/ext/modules/tracker/index.js']);
        assert.equal(counts.get('https://host/ext/modules/music/index.js'), 2, 'fetched once per scan (scanServiceContracts + scanActivationConditions)');
        assert.equal(counts.get('https://host/ext/modules/tracker/index.js'), 2);
    } finally { globalThis.fetch = originalFetch; }
});

test('start() finds real activation-condition edges (e.g. an onEvent subscription) through the full engine wiring, not just the scanner in isolation', async () => {
    const engine = makeEngine('https://host/ext/');
    engine.register(stubModule('tracker'));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, text: async () => `host.onEvent('GENERATION_STARTED', () => {});` });
    try {
        await engine.start();
        await settle();
        assert.deepEqual(engine.dependencyScanner.dependenciesOf('tracker'), ['st-event:GENERATION_STARTED']);
    } finally { globalThis.fetch = originalFetch; }
});

test('activationInfo() is reachable through the real engine, reading the actual registered module\'s own defaultEnabled/minEngineVersion', () => {
    const engine = makeEngine();
    engine.register(stubModule('tracker', { defaultEnabled: false, minEngineVersion: '0.2.0' }));
    assert.deepEqual(engine.dependencyScanner.activationInfo('tracker'), { defaultEnabled: false, minEngineVersion: '0.2.0' });
});

test('start() does not block on the scan — it resolves long before a slow fetch does', async () => {
    const engine = makeEngine('https://host/ext/');
    engine.register(stubModule('tracker'));
    let resolveFetch;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => new Promise(resolve => { resolveFetch = resolve; });
    try {
        const startedAt = Date.now();
        await engine.start();
        assert.ok(Date.now() - startedAt < 50, 'start() must not wait on the service-contract scan');
    } finally {
        resolveFetch?.({ ok: true, text: async () => '' });
        globalThis.fetch = originalFetch;
    }
});

test('an externally-loaded module (a stored sourceUrl) is scanned at that URL instead of the baseUrl convention', async () => {
    const engine = makeEngine(); // no baseUrl at all — proves sourceUrl alone is enough
    engine.register(stubModule('community-mod'));
    engine.settings().modules['community-mod'] = { sourceUrl: 'https://raw.githubusercontent.com/someone/repo/main/index.js' };

    const requestedUrls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async url => { requestedUrls.push(String(url)); return { ok: true, text: async () => '' }; };
    try {
        await engine.start();
        await settle();
        assert.deepEqual(new Set(requestedUrls), new Set(['https://raw.githubusercontent.com/someone/repo/main/index.js']));
    } finally { globalThis.fetch = originalFetch; }
});

test('without a baseUrl, a built-in module (no sourceUrl) is simply skipped — no crash, no fetch attempted for it', async () => {
    const engine = makeEngine(); // no baseUrl
    engine.register(stubModule('tracker'));
    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { fetchCalled = true; return { ok: true, text: async () => '' }; };
    try {
        await engine.start();
        await settle();
        assert.equal(fetchCalled, false);
    } finally { globalThis.fetch = originalFetch; }
});

test('a failed scan (fetch throws) is logged but never crashes start() or leaves the engine unusable', async () => {
    const engine = makeEngine('https://host/ext/');
    engine.register(stubModule('tracker'));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('network down'); };
    try {
        await assert.doesNotReject(() => engine.start());
        await settle();
        assert.equal(engine.dependencyScanner.edges().length, 0);
    } finally { globalThis.fetch = originalFetch; }
});
