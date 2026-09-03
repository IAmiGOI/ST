import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotebookStore } from '../modules/notebook/store.js';

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
