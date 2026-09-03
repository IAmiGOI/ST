import test from 'node:test';
import assert from 'node:assert/strict';
import {
    appendTime, buildTimeRequest, normalizeTime, parseTimeResponse, buildLabel,
    normalizeFieldName, sanitizeFields, TIME_PRESETS,
} from '../modules/time/index.js';

test('RP Time normalizes the one-line SideCar result', () => {
    assert.equal(normalizeTime('Time: "Day 2, 07:30"\nExplanation'), 'Day 2, 07:30 Explanation');
    assert.equal(normalizeTime('x'.repeat(200)).length, 120);
});

test('normalizeFieldName makes a raw field name JSON-key safe', () => {
    assert.equal(normalizeFieldName('  in world year  '), 'in_world_year');
    assert.equal(normalizeFieldName(''), '');
});

test('sanitizeFields dedupes by name and drops entries with no usable name', () => {
    const fields = sanitizeFields([
        { name: 'day', instruction: 'a number' },
        { name: 'day', instruction: 'a duplicate, dropped' },
        { name: '  ', instruction: 'blank name, dropped' },
        'time',
    ]);
    assert.deepEqual(fields, [{ name: 'day', instruction: 'a number' }, { name: 'time', instruction: '' }]);
});

test('buildLabel falls back to an automatic "name: value" list when no display template is set', () => {
    const label = buildLabel({ day: 'Day 2', time: '13:00' }, ['day', 'time'], '');
    assert.equal(label, 'day: Day 2 · time: 13:00');
});

test('buildLabel uses the display template when provided, ignoring the fallback shape entirely', () => {
    const label = buildLabel({ day: 'Day 2' }, ['day'], 'Day: {day}');
    assert.equal(label, 'Day: Day 2');
});

test('RP Time builds the SideCar prompt from the field list — one source of truth, not three synced strings', () => {
    const settings = {
        fields: [{ name: 'day', instruction: '' }, { name: 'time', instruction: '24-hour HH:MM' }],
        startTime: 'Day 1, 08:00',
    };
    const request = buildTimeRequest([
        { is_user: true, mes: 'We leave at dawn.' },
        { is_user: false, mes: 'The road is quiet.' },
    ], settings);
    assert.match(request.systemPrompt, /Return ONLY a JSON object/);
    assert.match(request.systemPrompt, /- day\n- time: 24-hour HH:MM/);
    assert.match(request.systemPrompt, /"day", "time"/);
    assert.match(request.systemPrompt, /Day 1, 08:00/);
    assert.match(request.prompt, /Player: We leave at dawn/);
    assert.match(request.prompt, /character just responded/);
});

test('RP Time changes only the message tail and never appends twice', () => {
    const message = { mes: 'Existing character response.', extra: {} };
    assert.equal(appendTime(message, 'Year 1, Month 1, Day 1, 12:00'), true);
    assert.equal(message.mes, 'Existing character response.');
    assert.equal(message.extra.stme_rp_time, 'Year 1, Month 1, Day 1, 12:00');
    assert.equal(appendTime(message, 'Day 1, 12:01'), false);
    assert.equal(message.extra.stme_rp_time, 'Year 1, Month 1, Day 1, 12:00');
});

test('RP Time parses a SideCar JSON reply into a display label using the configured fields', () => {
    const result = parseTimeResponse('{"day":"Day 2","time":"13:00"}', {
        fields: [{ name: 'day', instruction: '' }, { name: 'time', instruction: '' }],
        displayTemplate: '{day} — {time}',
    });
    assert.equal(result.label, 'Day 2 — 13:00');
});

test('RP Time ships three well-formed default presets, each with a matching field list and display template', () => {
    assert.equal(TIME_PRESETS.length, 3);
    for (const preset of TIME_PRESETS) {
        assert.ok(preset.id && preset.name && preset.startTime && preset.fields?.length && preset.displayTemplate);
        for (const field of preset.fields) assert.match(preset.displayTemplate, new RegExp(`\\{${field.name}\\}`));
    }
    assert.deepEqual(TIME_PRESETS.map(preset => preset.id), ['full-date', 'day-counter', 'natural-date-12h']);
    assert.deepEqual(TIME_PRESETS[0].fields.map(f => f.name), ['year', 'month', 'day', 'time', 'period']);
    assert.deepEqual(TIME_PRESETS[1].fields.map(f => f.name), ['day', 'time', 'period']);
    assert.deepEqual(TIME_PRESETS[2].fields.map(f => f.name), ['year', 'month', 'day', 'time', 'period']);
});

test('the natural-date-12h preset renders a compact "2026 March 5 09:20 AM(Morning)"-style label with no separators', () => {
    const preset = TIME_PRESETS.find(item => item.id === 'natural-date-12h');
    const result = parseTimeResponse(
        '{"year":"2026","month":"March","day":"5","time":"09:20 AM","period":"Morning"}',
        preset,
    );
    assert.equal(result.label, '2026 March 5 09:20 AM(Morning)');
});
