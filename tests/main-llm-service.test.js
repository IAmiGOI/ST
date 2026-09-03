import test from 'node:test';
import assert from 'node:assert/strict';
import { MainLlmService } from '../core/main-llm-service.js';

test('isConfigured() is true only when this ST build exposes generateRaw', () => {
    assert.equal(new MainLlmService(() => ({ generateRaw: async () => '' })).isConfigured(), true);
    assert.equal(new MainLlmService(() => ({})).isConfigured(), false);
    assert.equal(new MainLlmService(() => null).isConfigured(), false);
});

test('request() calls context.generateRaw with systemPrompt/prompt and returns a trimmed string', async () => {
    let received;
    const context = { generateRaw: async args => { received = args; return '  the answer  '; } };
    const service = new MainLlmService(() => context);
    const result = await service.request({ prompt: 'What is 2+2?', systemPrompt: 'Be terse.', moduleId: 'test' });
    assert.equal(result, 'the answer');
    assert.deepEqual(received, { systemPrompt: 'Be terse.', prompt: 'What is 2+2?' });
});

test('request() defaults systemPrompt to an empty string when omitted', async () => {
    let received;
    const context = { generateRaw: async args => { received = args; return 'ok'; } };
    await new MainLlmService(() => context).request({ prompt: 'hi' });
    assert.equal(received.systemPrompt, '');
});

test('request() throws a clear error without a prompt, and never calls generateRaw', async () => {
    let called = false;
    const context = { generateRaw: async () => { called = true; return 'x'; } };
    await assert.rejects(() => new MainLlmService(() => context).request({ prompt: '' }), /requires a prompt/);
    assert.equal(called, false);
});

test('request() throws a clear error when generateRaw is not available in this ST build', async () => {
    await assert.rejects(() => new MainLlmService(() => ({})).request({ prompt: 'hi' }), /not available in this SillyTavern build/);
});

test('request() never renders/adds anything to chat — it only calls generateRaw and returns its result (no context.chat mutation)', async () => {
    const chat = [];
    const context = { chat, generateRaw: async () => 'quiet result' };
    const result = await new MainLlmService(() => context).request({ prompt: 'hi' });
    assert.equal(result, 'quiet result');
    assert.equal(chat.length, 0);
});
