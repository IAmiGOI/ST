import test from 'node:test';
import assert from 'node:assert/strict';
import {
    sanitizeFields, describeFields, buildTrackerRequest, parseTrackerResponse, buildLabel, normalizeFieldName,
} from '../modules/tracker/index.js';

test('sanitizeFields normalizes names, drops duplicates and blanks', () => {
    const fields = sanitizeFields([
        { name: ' health ', instruction: 'Physical condition' },
        { name: 'health', instruction: 'duplicate, ignored' },
        { name: '  ', instruction: 'blank name, ignored' },
        { name: 'party size', instruction: '' },
    ]);
    assert.deepEqual(fields, [
        { name: 'health', instruction: 'Physical condition' },
        { name: 'party_size', instruction: '' },
    ]);
});

test('normalizeFieldName collapses whitespace and bounds length', () => {
    assert.equal(normalizeFieldName('  in world time  '), 'in_world_time');
    assert.equal(normalizeFieldName('x'.repeat(80)).length, 40);
});

test('describeFields turns each field into a bullet, with or without an instruction', () => {
    const text = describeFields([
        { name: 'health', instruction: 'One of: healthy, injured, critical.' },
        { name: 'location', instruction: '' },
    ]);
    assert.equal(text, '- health: One of: healthy, injured, critical.\n- location');
});

test('buildTrackerRequest fills a block\'s own templates with its own fields and current state', () => {
    const block = {
        fields: [{ name: 'health', instruction: 'Physical condition' }, { name: 'mood', instruction: '' }],
        systemPromptTemplate: 'Track: {fields}\nKeys: {fieldsJson}\nCurrent: {current}',
        promptTemplate: 'Context:\n{context}',
    };
    const chat = [
        { is_user: true, mes: 'We fight the wolf.' },
        { is_user: false, mes: 'The wolf bites your arm.' },
    ];
    const request = buildTrackerRequest(chat, block, { health: 'Healthy' });
    assert.match(request.systemPrompt, /- health: Physical condition/);
    assert.match(request.systemPrompt, /- mood$/m);
    assert.match(request.systemPrompt, /"health", "mood"/);
    assert.match(request.systemPrompt, /"health":"Healthy"/);
    assert.match(request.prompt, /Player: We fight the wolf/);
    assert.deepEqual(request.fields, ['health', 'mood']);
});

test('parseTrackerResponse keeps only the requested fields', () => {
    const parsed = parseTrackerResponse('```json\n{"health":"Injured","mood":"Tense","secret":"x"}\n```', ['health', 'mood']);
    assert.deepEqual(parsed.data, { health: 'Injured', mood: 'Tense' });
});

test('parseTrackerResponse reports no data when the reply has no JSON object', () => {
    const parsed = parseTrackerResponse('I cannot comply.', ['health']);
    assert.equal(parsed.data, null);
});

test('buildLabel falls back to an automatic list when no display template is set', () => {
    const label = buildLabel({ health: 'Injured', mood: 'Tense' }, ['health', 'mood'], '');
    assert.equal(label, 'health: Injured · mood: Tense');
});

test('buildLabel uses the display template when provided', () => {
    const label = buildLabel({ health: 'Injured' }, ['health'], 'HP: {health}');
    assert.equal(label, 'HP: Injured');
});
