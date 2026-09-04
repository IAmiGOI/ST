import test from 'node:test';
import assert from 'node:assert/strict';
import { EmbeddingService } from '../core/embedding-service.js';

function createService() {
    const root = {};
    let saves = 0;
    return { root, service: new EmbeddingService(() => root, () => saves++), saves: () => saves };
}

test('Embedding SideCar keeps its API key private and validates its settings', () => {
    const { service, saves } = createService();
    assert.equal(service.isConfigured(), false);
    service.update({ enabled: true, endpoint: 'https://example.test/v1', apiKey: 'secret', model: 'text-embedding-3-small', format: 'invalid' });
    assert.equal(service.isConfigured(), true);
    assert.equal(service.publicSettings().apiKey, undefined);
    assert.equal(service.publicSettings().format, 'openai', 'an invalid format falls back to openai, same as generation SideCar');
    assert.equal(saves(), 1);
});

test('settings() is stored under its own "embedding" key — never mixed into the generation SideCar\'s "sidecar"/"sidecars" settings', () => {
    const { root, service } = createService();
    service.update({ enabled: true, endpoint: 'https://example.test/v1', model: 'm' });
    assert.ok(root.embedding);
    assert.equal(root.sidecar, undefined);
    assert.equal(root.sidecars, undefined);
});

test('a single string input returns one vector; an array input returns one vector per input, in order', async () => {
    const { service } = createService();
    service.update({ enabled: true, endpoint: 'https://example.test/v1', model: 'm' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options) => {
        const body = JSON.parse(options.body);
        return { ok: true, json: async () => ({ data: body.input.map((text, index) => ({ embedding: [index, text.length], index })) }) };
    };
    try {
        const single = await service.request('hello');
        assert.deepEqual(single, [0, 5]);

        const batch = await service.request(['ab', 'cde', 'f']);
        assert.deepEqual(batch, [[0, 2], [1, 3], [2, 1]]);
    } finally { globalThis.fetch = originalFetch; }
});

test('OpenAI-compatible request: correct endpoint, auth header, and body shape; response sorted by index regardless of arrival order', async () => {
    const { service } = createService();
    service.update({ enabled: true, endpoint: 'https://example.test/v1', apiKey: 'secret', model: 'text-embedding-3-small' });
    const originalFetch = globalThis.fetch;
    let call;
    globalThis.fetch = async (url, options) => {
        call = { url, options };
        // Deliberately out of order — the service must sort by `index`, not trust arrival order.
        return { ok: true, json: async () => ({ data: [{ embedding: [9, 9], index: 1 }, { embedding: [1, 1], index: 0 }] }) };
    };
    try {
        const vectors = await service.request(['a', 'b']);
        assert.equal(call.url, 'https://example.test/v1/embeddings');
        assert.equal(call.options.headers.Authorization, 'Bearer secret');
        assert.deepEqual(JSON.parse(call.options.body), { model: 'text-embedding-3-small', input: ['a', 'b'] });
        assert.deepEqual(vectors, [[1, 1], [9, 9]]);
    } finally { globalThis.fetch = originalFetch; }
});

test('OpenAI-compatible: throws a clear error when the response returns a different vector count than requested', async () => {
    const { service } = createService();
    service.update({ enabled: true, endpoint: 'https://example.test/v1', model: 'm' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ embedding: [1], index: 0 }] }) });
    try {
        await assert.rejects(service.request(['a', 'b']), /returned 1 vector\(s\) for 2 input\(s\)/);
    } finally { globalThis.fetch = originalFetch; }
});

test('Google format: correct batchEmbedContents endpoint/body, values extracted in response order', async () => {
    const { service } = createService();
    service.update({ enabled: true, endpoint: 'https://generativelanguage.googleapis.com/v1beta/models', apiKey: 'key', model: 'embedding-001', format: 'google' });
    const originalFetch = globalThis.fetch;
    let call;
    globalThis.fetch = async (url, options) => {
        call = { url, options };
        return { ok: true, json: async () => ({ embeddings: [{ values: [1, 2] }, { values: [3, 4] }] }) };
    };
    try {
        const vectors = await service.request(['a', 'b']);
        assert.equal(call.url, 'https://generativelanguage.googleapis.com/v1beta/models/embedding-001:batchEmbedContents?key=key');
        const body = JSON.parse(call.options.body);
        assert.deepEqual(body.requests, [
            { model: 'models/embedding-001', content: { parts: [{ text: 'a' }] } },
            { model: 'models/embedding-001', content: { parts: [{ text: 'b' }] } },
        ]);
        assert.deepEqual(vectors, [[1, 2], [3, 4]]);
    } finally { globalThis.fetch = originalFetch; }
});

test('rejects when not configured, and when given only empty input', async () => {
    const { service } = createService();
    await assert.rejects(service.request('hello'), /not configured/);
    service.update({ enabled: true, endpoint: 'https://example.test/v1', model: 'm' });
    await assert.rejects(service.request(''), /requires at least one non-empty input/);
    await assert.rejects(service.request(['', '  ']), /requires at least one non-empty input/);
});

test('test() reports the real vector dimensionality and latency using a real request under the hood', async () => {
    const { service } = createService();
    service.update({ enabled: true, endpoint: 'https://example.test/v1', model: 'm' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ embedding: [1, 2, 3, 4], index: 0 }] }) });
    try {
        const result = await service.test();
        assert.equal(result.dimensions, 4);
        assert.equal(typeof result.latencyMs, 'number');
    } finally { globalThis.fetch = originalFetch; }
});

test('forModule() exposes request/isConfigured tagged with the calling module id, independent of the generation SideCar', async () => {
    const { service } = createService();
    service.update({ enabled: true, endpoint: 'https://example.test/v1', model: 'm' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ embedding: [1], index: 0 }] }) });
    try {
        const api = service.forModule('some-module');
        assert.equal(api.isConfigured(), true);
        assert.deepEqual(await api.request('x'), [1]);
    } finally { globalThis.fetch = originalFetch; }
});
