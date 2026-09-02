import test from 'node:test';
import assert from 'node:assert/strict';
import {
    sanitizeFields, describeFields, buildTrackerRequest, parseTrackerResponse, buildLabel, normalizeFieldName,
    describeBlockForBus, sanitizeVocabulary, buildClassifyRequest, parseClassifyResponse,
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

test('describeBlockForBus exposes only what the bus needs, never prompts or SideCar profile', () => {
    const block = {
        id: 'tracker_1', title: 'Vitals', enabled: true,
        fields: [{ name: 'health', instruction: 'secret reasoning the LLM sees' }],
        sidecarProfile: 'default', systemPromptTemplate: 'sensitive template', promptTemplate: 'sensitive',
    };
    const described = describeBlockForBus(block);
    assert.deepEqual(described, { id: 'tracker_1', title: 'Vitals', enabled: true, fields: ['health'] });
    assert.ok(!('sidecarProfile' in described));
    assert.ok(!('systemPromptTemplate' in described));
});

test('describeBlockForBus treats a missing enabled flag as enabled, but false stays false', () => {
    assert.equal(describeBlockForBus({ id: 'a', title: 'A', fields: [] }).enabled, true);
    assert.equal(describeBlockForBus({ id: 'b', title: 'B', fields: [], enabled: false }).enabled, false);
});

test('sanitizeVocabulary trims, dedupes, drops blanks, and caps at 50', () => {
    assert.deepEqual(sanitizeVocabulary([' combat ', 'combat', '', null, 'tavern']), ['combat', 'tavern']);
    const huge = Array.from({ length: 80 }, (_, i) => `key${i}`);
    assert.equal(sanitizeVocabulary(huge).length, 50);
    assert.equal(sanitizeVocabulary(null).length, 0);
});

test('buildClassifyRequest lists every vocabulary key and folds in recent context', () => {
    const chat = [{ is_user: true, mes: 'We enter the tavern.' }, { is_user: false, mes: 'The bard starts playing.' }];
    const request = buildClassifyRequest(['combat', 'tavern', 'night'], chat);
    assert.match(request.systemPrompt, /combat, tavern, night/);
    assert.match(request.systemPrompt, /Return ONLY a JSON array/);
    assert.match(request.prompt, /Player: We enter the tavern/);
});

test('parseClassifyResponse keeps only keys that are actually in the vocabulary', () => {
    const parsed = parseClassifyResponse('```json\n["tavern", "combat", "made-up-key"]\n```', ['combat', 'tavern', 'night']);
    assert.deepEqual(parsed.keys, ['tavern', 'combat']);
});

test('parseClassifyResponse returns no keys when the reply has no JSON array', () => {
    assert.deepEqual(parseClassifyResponse('I refuse to answer.', ['combat']), { keys: [] });
    assert.deepEqual(parseClassifyResponse('not json at all [', ['combat']), { keys: [] });
});
