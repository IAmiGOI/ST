import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotebookStore, stripLeadingTimeLine } from '../modules/notebook/store.js';

function makeStore() {
    const state = { chatMetadata: {}, saves: 0 };
    return { state, store: createNotebookStore(() => ({ chatMetadata: state.chatMetadata, saveMetadataDebounced: () => state.saves++ })) };
}

test('Notebook writes notes, retains them per chat, and builds a private prompt', () => {
    const { store, state } = makeStore();
    const note = store.add('Plan', 'Visit the observatory.');
    assert.match(note.id, /^note_/);
    assert.equal(store.notes().length, 1);
    assert.match(store.prompt(), /\[Private Notebook/);
    assert.match(store.prompt(), /Visit the observatory/);
    assert.equal(state.saves, 1);
});

test('Notebook removes the configured oldest batch when capacity is reached', () => {
    const { store } = makeStore();
    store.setSettings({ maxNotes: 2, cleanupBatch: 2 });
    store.add('First', 'a');
    store.add('Second', 'b');
    const final = store.add('Third', 'c');
    assert.equal(final.removed, 2);
    assert.deepEqual(store.notes().map(note => note.title), ['Third']);
});

test('Notebook updates a note and rejects empty values', () => {
    const { store } = makeStore();
    const note = store.add('Before', 'content');
    assert.equal(store.update(note.id, 'After', undefined).title, 'After');
    assert.throws(() => store.update(note.id, '', 'content'), /cannot be empty/);
});

// --- RP Time integration: timestamp comes in as a plain string from the caller
// (index.js resolves it via host.services, never chatMetadata directly — see
// MODULES.md) — the store just stores it and, only when one is actually supplied,
// strips a duplicate leading time-line the model wrote into content itself.

test('add() with no timestamp leaves the note untouched — no stamping, no stripping', () => {
    const { store } = makeStore();
    const note = store.add('Plan', 'Day 2, 14:00 (Afternoon)\nVisit the observatory.');
    assert.equal(note.timestamp, null);
    assert.equal(note.content, 'Day 2, 14:00 (Afternoon)\nVisit the observatory.', 'nothing to deduplicate against, so the line stays as written');
});

test('add() with a timestamp stores it and strips a duplicate leading time-line from content', () => {
    const { store } = makeStore();
    const note = store.add('Plan', 'Day 2, 14:00 (Afternoon)\nVisit the observatory.', 'Day 2, 14:00 (Afternoon)');
    assert.equal(note.timestamp, 'Day 2, 14:00 (Afternoon)');
    assert.equal(note.content, 'Visit the observatory.');
});

test('add() with a timestamp never strips real content just because it opens with a weekday/month word', () => {
    const { store } = makeStore();
    const note = store.add('Plan', "Monday's plan is to leave early.\nMore detail here.", 'Day 2, 14:00');
    assert.equal(note.content, "Monday's plan is to leave early.\nMore detail here.", 'the first line is a real sentence, not purely time-shaped — must survive whole-line-only matching');
});

test('add() with a timestamp does not touch a single-line note (nothing to strip a LINE from)', () => {
    const { store } = makeStore();
    const note = store.add('Plan', 'Just one line of content.', 'Day 2, 14:00');
    assert.equal(note.content, 'Just one line of content.');
});

test('update() backfills a missing timestamp but never overwrites an existing one', () => {
    const { store } = makeStore();
    const note = store.add('Plan', 'content', 'Day 1, 08:00'); // created with RP Time already on
    const updated = store.update(note.id, undefined, 'new content', 'Day 5, 20:00');
    assert.equal(updated.timestamp, 'Day 1, 08:00', 'a note keeps its ORIGINAL (creation) timestamp, not the latest edit time');

    const { store: store2 } = makeStore();
    const note2 = store2.add('Plan', 'content'); // created before RP Time was on
    assert.equal(note2.timestamp, null);
    const backfilled = store2.update(note2.id, undefined, 'new content', 'Day 5, 20:00');
    assert.equal(backfilled.timestamp, 'Day 5, 20:00', 'a note with no timestamp yet gets backfilled the first time RP Time is available');
});

test('prompt() includes each note\'s timestamp when it has one, and omits it cleanly when it does not', () => {
    const { store } = makeStore();
    store.add('Dated', 'has a time', 'Day 2, 14:00');
    store.add('Undated', 'no time yet');
    const prompt = store.prompt();
    assert.match(prompt, /\(Day 2, 14:00\) Dated: has a time/);
    assert.match(prompt, /\] Undated: no time yet/, 'no stray "()" for a note without a timestamp');
});

// --- stripLeadingTimeLine() in isolation ---

test('stripLeadingTimeLine strips a whole first line made only of date/time tokens', () => {
    assert.equal(stripLeadingTimeLine('Day 2, 14:00 (Afternoon)\nRest of the note.'), 'Rest of the note.');
    assert.equal(stripLeadingTimeLine('2026 March 5 09:20 AM(Morning)\nRest.'), 'Rest.');
    assert.equal(stripLeadingTimeLine('Monday\nRest.'), 'Rest.', 'a lone weekday word alone on its own line is still purely time-shaped');
});

test('stripLeadingTimeLine leaves content alone when the first line is not purely time-shaped, or there is no second line', () => {
    assert.equal(stripLeadingTimeLine("Monday's plan is to leave early.\nMore."), "Monday's plan is to leave early.\nMore.");
    assert.equal(stripLeadingTimeLine('Just one line, no newline at all.'), 'Just one line, no newline at all.');
    assert.equal(stripLeadingTimeLine(''), '');
});
