import test from 'node:test';
import assert from 'node:assert/strict';
import { SidecarService } from '../core/sidecar-service.js';

function createService() {
    const root = {};
    let saves = 0;
    return { root, service: new SidecarService(() => root, () => saves++), saves: () => saves };
}

test('SideCar keeps credentials private and validates its shared configuration', () => {
    const { service, saves } = createService();
    assert.equal(service.isConfigured(), false);
    service.update({ enabled: true, endpoint: 'https://example.test/v1', apiKey: 'secret', model: 'small', format: 'invalid', maxTokens: 0 });
    assert.equal(service.isConfigured(), true);
    assert.equal(service.publicSettings().apiKey, undefined);
    assert.equal(service.publicSettings().format, 'openai');
    assert.equal(service.publicSettings().maxTokens, 1);
    assert.equal(saves(), 1);
});

test('SideCar sends an OpenAI-compatible request and module leases release cleanly', async () => {
    const { service } = createService();
    service.update({ enabled: true, endpoint: 'https://example.test/v1', apiKey: 'secret', model: 'small' });
    const originalFetch = globalThis.fetch;
    let call;
    globalThis.fetch = async (url, options) => {
        call = { url, options };
        return { ok: true, json: async () => ({ choices: [{ message: { content: ' done ' } }] }) };
    };
    try {
        const api = service.forModule('reader');
        const lease = api.acquire('reader-worker');
        assert.equal(service.publicSettings().activeLeases, 1);
        assert.equal(await lease.request({ prompt: 'hello', systemPrompt: 'system' }), 'done');
        assert.equal(call.url, 'https://example.test/v1/chat/completions');
        assert.equal(call.options.headers.Authorization, 'Bearer secret');
        assert.deepEqual(JSON.parse(call.options.body).messages, [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }]);
        lease.release();
        assert.equal(service.publicSettings().activeLeases, 0);
        assert.throws(() => lease.request({ prompt: 'again' }), /released/);
    } finally { globalThis.fetch = originalFetch; }
});

test('SideCar rejects incomplete configuration and empty requests', async () => {
    const { service } = createService();
    await assert.rejects(service.request({ prompt: 'hello' }), /not configured/);
    service.update({ enabled: true, endpoint: 'https://example.test', model: 'small' });
    await assert.rejects(service.request({ prompt: '' }), /requires a prompt/);
});
