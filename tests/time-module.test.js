import test from 'node:test';
import assert from 'node:assert/strict';
import { appendTime, buildTimeRequest, normalizeTime, parseTimeResponse, TIME_PRESETS } from '../modules/time/index.js';

test('RP Time normalizes the one-line SideCar result', () => {
    assert.equal(normalizeTime('Time: "Day 2, 07:30"\nExplanation'), 'Day 2, 07:30 Explanation');
    assert.equal(normalizeTime('x'.repeat(200)).length, 120);
});

test('RP Time builds context for SideCar without asking it to rewrite the response', () => {
    const request = buildTimeRequest([
        { is_user: true, mes: 'We leave at dawn.' },
        { is_user: false, mes: 'The road is quiet.' },
    ], { mes: 'The sun reaches its highest point.' });
    assert.match(request.systemPrompt, /Return ONLY a JSON object/);
    assert.match(request.systemPrompt, /year, month, day, time, period/);
    assert.match(request.prompt, /Player: We leave at dawn/);
    assert.match(request.prompt, /character is about to respond/);
    assert.equal(request.maxTokens, undefined);
    assert.equal(request.temperature, undefined);
});

test('RP Time changes only the message tail and never appends twice', () => {
    const message = { mes: 'Existing character response.', extra: {} };
    assert.equal(appendTime(message, 'Year 1, Month 1, Day 1, 12:00'), true);
    assert.equal(message.mes, 'Existing character response.');
    assert.equal(message.extra.stme_rp_time, 'Year 1, Month 1, Day 1, 12:00');
    assert.equal(appendTime(message, 'Day 1, 12:01'), false);
    assert.equal(message.extra.stme_rp_time, 'Year 1, Month 1, Day 1, 12:00');
});


test('RP Time parses configured JSON fields into a display label', () => {
    const result = parseTimeResponse('{"day":"Day 2","time":"13:00"}', { jsonFields: 'day,time', displayTemplate: '{day} — {time}' });
    assert.equal(result.label, 'Day 2 — 13:00');
});

test('RP Time ships two well-formed default presets', () => {
    assert.equal(TIME_PRESETS.length, 2);
    for (const preset of TIME_PRESETS) {
        assert.ok(preset.id && preset.name && preset.startTime && preset.format && preset.jsonFields && preset.displayTemplate);
        const fields = preset.jsonFields.split(',');
        for (const field of fields) assert.match(preset.format, new RegExp(`\\{${field}\\}`));
    }
    assert.deepEqual(TIME_PRESETS.map(preset => preset.id), ['full-date', 'day-counter']);
    assert.equal(TIME_PRESETS[0].jsonFields, 'year,month,day,time,period');
    assert.equal(TIME_PRESETS[1].jsonFields, 'day,time,period');
});
