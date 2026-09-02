import test from 'node:test';
import assert from 'node:assert/strict';
import { appendTime, buildTimeRequest, normalizeTime } from '../modules/time/index.js';

test('RP Time normalizes the one-line SideCar result', () => {
    assert.equal(normalizeTime('Time: "Day 2, 07:30"\nExplanation'), 'Day 2, 07:30 Explanation');
    assert.equal(normalizeTime('x'.repeat(200)).length, 120);
});

test('RP Time builds context for SideCar without asking it to rewrite the response', () => {
    const request = buildTimeRequest([
        { is_user: true, mes: 'We leave at dawn.' },
        { is_user: false, mes: 'The road is quiet.' },
    ], { mes: 'The sun reaches its highest point.' });
    assert.match(request.systemPrompt, /Return only one time label/);
    assert.match(request.prompt, /Player: We leave at dawn/);
    assert.match(request.prompt, /LATEST CHARACTER RESPONSE/);
    assert.equal(request.maxTokens, 48);
});

test('RP Time changes only the message tail and never appends twice', () => {
    const message = { mes: 'Existing character response.', extra: {} };
    assert.equal(appendTime(message, 'Day 1, 12:00'), true);
    assert.equal(message.mes, 'Existing character response.\n\n[RP Time: Day 1, 12:00]');
    assert.equal(message.extra.stme_rp_time, 'Day 1, 12:00');
    assert.equal(appendTime(message, 'Day 1, 12:01'), false);
    assert.equal(message.mes.match(/\[RP Time:/g).length, 1);
});
