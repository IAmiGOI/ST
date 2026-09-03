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

// --- workerStates() — feeds state-track.js's per-worker live status; see core/state-track.js.

test('workerStates() reports idle/not-configured for a worker that has never made a request', () => {
    const root = { sidecars: [{ id: 'primary', name: 'Primary', enabled: false }] };
    const manager = new SidecarManager(() => root, () => {});
    assert.deepEqual(manager.workerStates(), [
        { id: 'primary', name: 'Primary', configured: false, status: 'idle', lastOutcome: null, lastError: null, lastAt: null },
    ]);
});

test('workerStates() shows "requesting" while a request is in flight, then settles back to idle with the outcome recorded', async () => {
    const root = { sidecars: [{ id: 'primary', name: 'Primary', enabled: true, endpoint: 'https://example.test/v1', model: 'small' }] };
    const manager = new SidecarManager(() => root, () => {});
    let resolveFetch;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => new Promise(resolve => { resolveFetch = resolve; });
    try {
        const pending = manager.request({ prompt: 'hi' });
        await Promise.resolve(); // let #pump() dispatch synchronously past the microtask queue
        assert.equal(manager.workerStates()[0].status, 'requesting');

        resolveFetch({ ok: true, json: async () => ({ choices: [{ message: { content: 'answer' } }] }) });
        await pending;
        const state = manager.workerStates()[0];
        assert.equal(state.status, 'idle');
        assert.equal(state.lastOutcome, 'success');
        assert.equal(state.lastError, null);
        assert.ok(state.lastAt > 0);
    } finally { globalThis.fetch = originalFetch; }
});

test('workerStates() records lastOutcome:failed and the error message after a failed request', async () => {
    const root = { sidecars: [{ id: 'primary', name: 'Primary', enabled: true, endpoint: 'https://example.test/v1', model: 'small' }] };
    const manager = new SidecarManager(() => root, () => {});
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'Internal Server Error' });
    try {
        await assert.rejects(() => manager.request({ prompt: 'hi' }));
        const state = manager.workerStates()[0];
        assert.equal(state.status, 'idle');
        assert.equal(state.lastOutcome, 'failed');
        assert.match(state.lastError, /500/);
    } finally { globalThis.fetch = originalFetch; }
});

test('remove() drops that worker\'s tracked state along with everything else', () => {
    const root = { sidecars: [{ id: 'primary', name: 'Primary' }, { id: 'second', name: 'Second' }] };
    const manager = new SidecarManager(() => root, () => {});
    manager.remove('second');
    assert.equal(manager.workerStates().length, 1);
    assert.equal(manager.workerStates()[0].id, 'primary');
});

// --- RoutePlanner integration (Phase 4 — the one place its decision actually
// changes real behavior). A fake RoutePlanner stands in here; the real
// decide()/waitFor() logic is covered by tests/route-planner.test.js — this
// only proves SidecarManager.request() honors whatever it's told.

function makeFakeRoutePlanner(decision) {
    return { decide: () => decision, waitFor: () => Promise.resolve() };
}

function makeTwoWorkerRoot() {
    return {
        sidecars: [
            { id: 'primary', name: 'Primary', enabled: true, endpoint: 'https://a.test/v1', model: 'small' },
            { id: 'second', name: 'Second', enabled: true, endpoint: 'https://b.test/v1', model: 'small' },
        ],
    };
}

test('request() behaves exactly as before when no RoutePlanner is given at all (the default) — every pre-existing test above already proves this, this just names it', async () => {
    const root = { sidecars: [{ id: 'primary', name: 'Primary', enabled: true, endpoint: 'https://a.test/v1', model: 'small' }] };
    const manager = new SidecarManager(() => root, () => {});
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) });
    try {
        assert.equal(await manager.request({ prompt: 'hi', moduleId: 'x' }), 'ok');
    } finally { globalThis.fetch = originalFetch; }
});

test('a "proceed" decision dispatches immediately, same as no RoutePlanner at all', async () => {
    const root = { sidecars: [{ id: 'primary', name: 'Primary', enabled: true, endpoint: 'https://a.test/v1', model: 'small' }] };
    const routePlanner = makeFakeRoutePlanner({ decision: 'proceed' });
    const manager = new SidecarManager(() => root, () => {}, () => ({}), () => routePlanner);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) });
    try {
        assert.equal(await manager.request({ prompt: 'hi', moduleId: 'x' }), 'ok');
    } finally { globalThis.fetch = originalFetch; }
});

test('after a "wait" decision resolves, dispatch prefers pickIdleWorker()\'s choice over the normal #pick() round-robin', async () => {
    const root = makeTwoWorkerRoot();
    const routePlanner = {
        decide: () => ({ decision: 'wait', for: 'st-event:GENERATION_ENDED' }),
        waitFor: () => Promise.resolve(),
        pickIdleWorker: () => ({ id: 'second' }),
    };
    const manager = new SidecarManager(() => root, () => {}, () => ({}), () => routePlanner);
    const calledUrls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async url => { calledUrls.push(String(url)); return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }; };
    try {
        await manager.request({ prompt: 'hi', moduleId: 'x' });
        assert.equal(calledUrls.length, 1);
        assert.match(calledUrls[0], /b\.test/, 'must have gone to worker "second" (b.test) — pickIdleWorker()\'s choice, not whichever #pick() would normally choose');
        assert.equal(manager.workerStates().find(w => w.id === 'second').status, 'idle', 'settles back to idle, same bookkeeping as the normal path');
        assert.equal(manager.workerStates().find(w => w.id === 'second').lastOutcome, 'success');
    } finally { globalThis.fetch = originalFetch; }
});

test('after a "wait" decision resolves, dispatch falls back to the normal queue when pickIdleWorker() finds nothing idle', async () => {
    const root = makeTwoWorkerRoot();
    const routePlanner = { decide: () => ({ decision: 'wait', for: 'st-event:GENERATION_ENDED' }), waitFor: () => Promise.resolve(), pickIdleWorker: () => null };
    const manager = new SidecarManager(() => root, () => {}, () => ({}), () => routePlanner);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) });
    try {
        assert.equal(await manager.request({ prompt: 'hi', moduleId: 'x' }), 'ok');
    } finally { globalThis.fetch = originalFetch; }
});

test('a "wait" decision genuinely delays dispatch until waitFor() resolves — nothing is sent before that', async () => {
    const root = { sidecars: [{ id: 'primary', name: 'Primary', enabled: true, endpoint: 'https://a.test/v1', model: 'small' }] };
    let releaseWait;
    const routePlanner = { decide: () => ({ decision: 'wait', for: 'st-event:GENERATION_ENDED' }), waitFor: () => new Promise(resolve => { releaseWait = resolve; }) };
    const manager = new SidecarManager(() => root, () => {}, () => ({}), () => routePlanner);
    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }; };
    try {
        const pending = manager.request({ prompt: 'hi', moduleId: 'x' });
        await Promise.resolve(); await Promise.resolve();
        assert.equal(fetchCalled, false, 'must not have dispatched yet — still waiting');
        releaseWait();
        assert.equal(await pending, 'ok');
        assert.equal(fetchCalled, true);
    } finally { globalThis.fetch = originalFetch; }
});

test('a "wait" decision on one module\'s request does not block a concurrent request from another module', async () => {
    const root = { sidecars: [{ id: 'primary', name: 'Primary', enabled: true, endpoint: 'https://a.test/v1', model: 'small' }] };
    const routePlanner = {
        decide: moduleId => moduleId === 'slow' ? { decision: 'wait', for: 'st-event:GENERATION_ENDED' } : { decision: 'proceed' },
        waitFor: () => new Promise(() => {}), // never resolves — proves the OTHER request isn't waiting on it
    };
    const manager = new SidecarManager(() => root, () => {}, () => ({}), () => routePlanner);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'fast-answer' } }] }) });
    try {
        manager.request({ prompt: 'x', moduleId: 'slow' }); // fire-and-forget — this one waits forever
        assert.equal(await manager.request({ prompt: 'y', moduleId: 'fast' }), 'fast-answer');
    } finally { globalThis.fetch = originalFetch; }
});
