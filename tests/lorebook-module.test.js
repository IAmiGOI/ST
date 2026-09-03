import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBookNames, summarizeEntry, matchesFilter, mergeBooks } from '../modules/lorebook/index.js';

test('resolveBookNames reads the chat-bound and character-bound book names, deduped', () => {
    const context = {
        chatMetadata: { world_info: 'Story Book' },
        characterId: 0,
        characters: [{ data: { extensions: { world: 'Story Book' } } }],
    };
    assert.deepEqual(resolveBookNames(context), ['Story Book']);
});

test('resolveBookNames returns both names when chat and character books differ', () => {
    const context = {
        chatMetadata: { world_info: 'Chat Book' },
        characterId: 0,
        characters: [{ data: { extensions: { world: 'Char Book' } } }],
    };
    assert.deepEqual(resolveBookNames(context), ['Chat Book', 'Char Book']);
});

test('resolveBookNames returns an empty list when nothing is bound', () => {
    assert.deepEqual(resolveBookNames({ chatMetadata: {}, characters: [] }), []);
    assert.deepEqual(resolveBookNames({}), []);
    assert.deepEqual(resolveBookNames(undefined), []);
});

test('summarizeEntry reduces a raw WI entry to metadata only, never content', () => {
    const summary = summarizeEntry({ uid: 3, comment: '  Dragon Lore  ', key: ['dragon', 'wyrm'], content: 'A long history of dragons.', disable: false, constant: true }, 'Bestiary');
    assert.deepEqual(summary, { uid: 3, book: 'Bestiary', name: 'Dragon Lore', keys: ['dragon', 'wyrm'], length: 'A long history of dragons.'.length, disabled: false, constant: true });
    assert.equal('content' in summary, false);
});

test('summarizeEntry tolerates missing optional fields', () => {
    const summary = summarizeEntry({ uid: 1 }, 'Book');
    assert.deepEqual(summary, { uid: 1, book: 'Book', name: '', keys: [], length: 0, disabled: false, constant: false });
});

test('matchesFilter: an empty filter matches everything', () => {
    const summary = summarizeEntry({ uid: 1, comment: 'X', key: ['a'], content: 'hi' }, 'B');
    assert.equal(matchesFilter(summary, {}), true);
    assert.equal(matchesFilter(summary, undefined), true);
});

test('matchesFilter: name is a case-insensitive substring match', () => {
    const summary = summarizeEntry({ uid: 1, comment: 'Dragon Lore' }, 'B');
    assert.equal(matchesFilter(summary, { name: 'dragon' }), true);
    assert.equal(matchesFilter(summary, { name: 'DRAGON' }), true);
    assert.equal(matchesFilter(summary, { name: 'goblin' }), false);
});

test('matchesFilter: length range and key/disabled/constant filters', () => {
    const summary = summarizeEntry({ uid: 1, comment: 'X', key: ['fire', 'flame'], content: '1234567890', disable: true, constant: false }, 'B');
    assert.equal(matchesFilter(summary, { minLength: 10 }), true);
    assert.equal(matchesFilter(summary, { minLength: 11 }), false);
    assert.equal(matchesFilter(summary, { maxLength: 10 }), true);
    assert.equal(matchesFilter(summary, { maxLength: 9 }), false);
    assert.equal(matchesFilter(summary, { key: 'fire' }), true);
    assert.equal(matchesFilter(summary, { key: 'ice' }), false);
    assert.equal(matchesFilter(summary, { disabled: true }), true);
    assert.equal(matchesFilter(summary, { disabled: false }), false);
    assert.equal(matchesFilter(summary, { constant: false }), true);
});

test('mergeBooks flattens entries from multiple books and tags each with its book name', () => {
    const { summaries, byUid } = mergeBooks({
        Bestiary: { entries: { 0: { uid: 0, comment: 'Dragon', content: 'x' }, 1: { uid: 1, comment: 'Goblin', content: 'y' } } },
        Geography: { entries: { 0: { uid: 0, comment: 'The Capital', content: 'z' } } },
    });
    assert.equal(summaries.length, 3);
    assert.deepEqual(summaries.map(s => s.book), ['Bestiary', 'Bestiary', 'Geography']);
    assert.equal(byUid.size, 2, 'uids collide across books in this map — last book wins, same as ST\'s own per-book uid scoping would need book-qualified lookup for a real collision, but get() is keyed by raw uid here');
});

test('mergeBooks skips a book that failed to load (null/undefined) without throwing', () => {
    const { summaries } = mergeBooks({ Good: { entries: { 0: { uid: 0, comment: 'A' } } }, Bad: null, Missing: undefined });
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].book, 'Good');
});

test('mergeBooks returns empty results for no books', () => {
    const { summaries, byUid } = mergeBooks({});
    assert.deepEqual(summaries, []);
    assert.equal(byUid.size, 0);
});
