import test from 'node:test';
import assert from 'node:assert/strict';
import { SidecarManager } from '../core/sidecar-manager.js';

test('SideCar Manager migrates a legacy SideCar configuration into a worker', () => {
    const root = { sidecar: { enabled: true, endpoint: 'https://example.test/v1', model: 'small' } };
    const manager = new SidecarManager(() => root, () => {});
    assert.equal(manager.configs().length, 1);
    assert.equal(root.sidecar, undefined);
    assert.equal(manager.configs()[0].id, 'primary');
});

test('SideCar Manager adds independent workers', () => {
    const root = { sidecars: [{ id: 'primary', name: 'Primary', enabled: false }] };
    const manager = new SidecarManager(() => root, () => {});
    const id = manager.add();
    assert.equal(manager.configs().length, 2);
    assert.notEqual(id, 'primary');
    assert.notEqual(manager.configs()[0], manager.configs()[1]);
});

// --- Main-LLM fallback: priority-0, never part of the normal worker pool, only
// reachable via the explicit requestFallback()/forModule().requestFallback() path.

function makeManager(root = { sidecars: [{ id: 'primary', name: 'Primary', enabled: false }] }, context = { generateRaw: async () => 'fallback answer' }) {
    return new SidecarManager(() => root, () => {}, () => context);
}

test('the main-LLM fallback is enabled by default, with no configuration needed', () => {
    const manager = makeManager();
    assert.equal(manager.mainLlmFallbackEnabled(), true);
    assert.equal(manager.isMainLlmFallbackAvailable(), true);
});

test('setMainLlmFallbackEnabled(false) turns it off, and requestFallback() then refuses', async () => {
    const manager = makeManager();
    manager.setMainLlmFallbackEnabled(false);
    assert.equal(manager.mainLlmFallbackEnabled(), false);
    assert.equal(manager.isMainLlmFallbackAvailable(), false);
    await assert.rejects(() => manager.requestFallback({ prompt: 'hi' }), /turned off/);
});

test('isMainLlmFallbackAvailable() is false when generateRaw is missing from this ST build, even with the toggle on', () => {
    const manager = makeManager(undefined, {});
    assert.equal(manager.isMainLlmFallbackAvailable(), false);
});

test('requestFallback() reaches the main LLM directly — no configured SideCar needed at all', async () => {
    const manager = makeManager({ sidecars: [{ id: 'primary', name: 'Primary', enabled: false }] });
    assert.equal(manager.isConfigured(), false, 'no real SideCar worker is configured');
    const result = await manager.requestFallback({ prompt: 'hi' });
    assert.equal(result, 'fallback answer');
});

test('a configured, healthy SideCar worker never gets bypassed in favor of the fallback — request() and requestFallback() are two entirely separate paths', async () => {
    let sidecarCalled = false;
    let fallbackCalled = false;
    const root = { sidecars: [{ id: 'primary', name: 'Primary', enabled: true, endpoint: 'https://example.test/v1', model: 'small' }] };
    const manager = makeManager(root, { generateRaw: async () => { fallbackCalled = true; return 'fallback'; } });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { sidecarCalled = true; return { ok: true, json: async () => ({ choices: [{ message: { content: 'sidecar answer' } }] }) }; };
    try {
        const result = await manager.request({ prompt: 'hi' });
        assert.equal(result, 'sidecar answer');
        assert.equal(sidecarCalled, true);
        assert.equal(fallbackCalled, false, 'request() must never silently reach for the fallback on its own');
    } finally { globalThis.fetch = originalFetch; }
});

test('forModule().requestFallback and .isFallbackAvailable are wired through to the manager', async () => {
    const manager = makeManager();
    const host = manager.forModule('some-module');
    assert.equal(host.isFallbackAvailable(), true);
    assert.equal(await host.requestFallback({ prompt: 'hi' }), 'fallback answer');
});

test('a released acquire() lease refuses requestFallback() too, same as request()', async () => {
    const manager = makeManager();
    const lease = manager.acquire('some-module');
    lease.release();
    assert.throws(() => lease.requestFallback({ prompt: 'hi' }), /lease has been released/);
});

// --- healthy / checkHealth() — drives the blinking-blue-border indicator on the
// outer SideCar Manager card (core/module-engine.js's mount()): null until checked
// (no blink), then true/false depending on whether anything actually answers.

test('healthy starts at null (unchecked) and checkHealth() sets it to false when nothing is configured at all — no network call needed', async () => {
    const root = { sidecars: [{ id: 'primary', name: 'Primary', enabled: false }] };
    const manager = new SidecarManager(() => root, () => {});
    assert.equal(manager.healthy(), null);

    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
    try {
        const ok = await manager.checkHealth();
        assert.equal(ok, false);
        assert.equal(manager.healthy(), false);
        assert.equal(called, false, 'nothing configured means nothing to probe — checkHealth must not call fetch at all');
    } finally { globalThis.fetch = originalFetch; }
});

test('checkHealth() sets healthy:true when at least one configured worker actually answers', async () => {
    const root = { sidecars: [{ id: 'primary', name: 'Primary', enabled: true, endpoint: 'https://example.test/v1', model: 'small' }] };
    const manager = new SidecarManager(() => root, () => {});

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) });
    try {
        const ok = await manager.checkHealth();
        assert.equal(ok, true);
        assert.equal(manager.healthy(), true);
    } finally { globalThis.fetch = originalFetch; }
});

test('checkHealth() sets healthy:false when every configured worker fails to answer', async () => {
    const root = {
        sidecars: [
            { id: 'primary', name: 'Primary', enabled: true, endpoint: 'https://example.test/v1', model: 'small' },
            { id: 'second', name: 'Second', enabled: true, endpoint: 'https://example.test/v2', model: 'small' },
        ],
    };
    const manager = new SidecarManager(() => root, () => {});

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 500 });
    try {
        const ok = await manager.checkHealth();
        assert.equal(ok, false);
        assert.equal(manager.healthy(), false);
    } finally { globalThis.fetch = originalFetch; }
});

test('checkHealth() sets healthy:true if only SOME configured workers fail — one working worker is enough', async () => {
    const root = {
        sidecars: [
            { id: 'primary', name: 'Primary', enabled: true, endpoint: 'https://broken.test/v1', model: 'small' },
            { id: 'second', name: 'Second', enabled: true, endpoint: 'https://good.test/v1', model: 'small' },
        ],
    };
    const manager = new SidecarManager(() => root, () => {});

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async url => (String(url).includes('good.test')
        ? { ok: true, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) }
        : { ok: false, status: 500 });
    try {
        assert.equal(await manager.checkHealth(), true);
    } finally { globalThis.fetch = originalFetch; }
});

test('never toasts — checkHealth() has no toast/notification parameter at all', () => {
    assert.equal(SidecarManager.prototype.checkHealth.length, 0);
});
