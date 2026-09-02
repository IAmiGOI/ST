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
    assert.match(request.prompt, /character is about to respond/);
    assert.equal(request.maxTokens, undefined);
    assert.equal(request.temperature, undefined);
});

test('RP Time changes only the message tail and never appends twice', () => {
    const message = { mes: 'Existing character response.', extra: {} };
    assert.equal(appendTime(message, 'Day 1, 12:00'), true);
    assert.match(message.mes, /Existing character response/);
    assert.match(message.mes, /class="stme-rp-time"/);
    assert.match(message.mes, /Day 1, 12:00/);
    assert.equal(message.extra.stme_rp_time, 'Day 1, 12:00');
    assert.equal(appendTime(message, 'Day 1, 12:01'), false);
    assert.equal(message.mes.match(/data-stme-rp-time/g).length, 1);
});
