import test from 'node:test';
import assert from 'node:assert/strict';
import { ModuleDataBus } from '../core/data-bus.js';
import {
    LorebookService, resolveBookNames, summarizeEntry, matchesFilter, mergeBooks,
} from '../core/lorebook-service.js';

// --- Pure functions (carried over from the retired module — same behavior) ---

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

test('matchesFilter: an empty filter matches everything, name/key are substring, length/flags are exact', () => {
    const summary = summarizeEntry({ uid: 1, comment: 'Dragon Lore', key: ['fire', 'flame'], content: '1234567890', disable: true, constant: false }, 'B');
    assert.equal(matchesFilter(summary, {}), true);
    assert.equal(matchesFilter(summary, { name: 'DRAGON' }), true);
    assert.equal(matchesFilter(summary, { name: 'goblin' }), false);
    assert.equal(matchesFilter(summary, { minLength: 10 }), true);
    assert.equal(matchesFilter(summary, { minLength: 11 }), false);
    assert.equal(matchesFilter(summary, { key: 'fire' }), true);
    assert.equal(matchesFilter(summary, { disabled: true }), true);
});

test('mergeBooks flattens entries from multiple books and skips one that failed to load', () => {
    const { summaries, byUid } = mergeBooks({
        Bestiary: { entries: { 0: { uid: 0, comment: 'Dragon', content: 'x' } } },
        Bad: null,
    });
    assert.equal(summaries.length, 1);
    assert.equal(byUid.size, 1);
});

// --- LorebookService: independent of ModuleEngine, talks only to a bare ModuleDataBus ---

function makeFakeContext(initialBooks = {}) {
    const books = new Map(Object.entries(initialBooks).map(([name, data]) => [name, structuredClone(data)]));
    let chatChangedHandler = null;
    const context = {
        chatMetadata: { world_info: 'Story Book' },
        characterId: 0, characters: [{ data: { extensions: {} } }],
        eventTypes: { CHAT_CHANGED: 'CHAT_CHANGED' },
        eventSource: {
            on(type, handler) { if (type === 'CHAT_CHANGED') chatChangedHandler = handler; },
            off(type, handler) { if (type === 'CHAT_CHANGED' && chatChangedHandler === handler) chatChangedHandler = null; },
        },
        loadWorldInfo: async name => (books.has(name) ? structuredClone(books.get(name)) : null),
        saveWorldInfo: async (name, data) => { books.set(name, structuredClone(data)); },
    };
    return { context, books, fireChatChanged: () => chatChangedHandler?.() };
}

test('LorebookService works against a bare ModuleDataBus — no ModuleEngine involved at all', async () => {
    const bus = new ModuleDataBus();
    const { context } = makeFakeContext({ 'Story Book': { entries: { 0: { uid: 0, comment: 'Dragon Lore', key: ['dragon'], content: 'text' } } } });
    const service = new LorebookService(() => context, bus);
    await service.start();

    // Reached exactly the way a module would: through the bus, by well-known key.
    const api = bus.get('lorebook', 'api');
    assert.equal(typeof api.find, 'function');
    assert.deepEqual(api.find({ key: 'dragon' }).map(e => e.name), ['Dragon Lore']);
    assert.equal(bus.get('lorebook', 'books').length, 1);
});

test('scan() publishes an empty index and "books" when nothing is bound', async () => {
    const bus = new ModuleDataBus();
    const { context } = makeFakeContext();
    context.chatMetadata = {};
    const service = new LorebookService(() => context, bus);
    await service.start();
    assert.deepEqual(bus.get('lorebook', 'books'), []);
    assert.deepEqual(bus.get('lorebook', 'entries'), []);
});

test('createEntry: read-modify-write against the book, assigns a fresh uid, updates the index, emits entryCreated', async () => {
    const bus = new ModuleDataBus();
    const { context, books } = makeFakeContext({ 'Story Book': { entries: { 0: { uid: 0, comment: 'Existing', content: 'x' } }, someOtherField: 'preserved' } });
    const service = new LorebookService(() => context, bus);
    await service.start();

    let emitted = null;
    service.on('entryCreated', entry => { emitted = entry; });

    const created = await service.createEntry({ comment: 'New Entry', content: 'hello', key: ['a'] });

    assert.equal(created.uid, 1, 'fresh uid one past the existing uid 0');
    assert.equal(created.comment, 'New Entry');
    assert.equal(created.book, 'Story Book');
    assert.deepEqual(emitted, created);

    const saved = books.get('Story Book');
    assert.equal(saved.someOtherField, 'preserved', 'read-modify-write must not drop unrelated fields in the file');
    assert.equal(saved.entries[1].comment, 'New Entry');
    assert.equal(saved.entries[0].comment, 'Existing', 'the existing entry must be untouched');

    // Index/bus already reflect the write by the time createEntry() resolves.
    assert.equal(bus.get('lorebook', 'entries').length, 2);
    assert.ok(service.get(1));
});

test('createEntry defaults to the first bound book, and throws with a clear message when none is bound and none given', async () => {
    const bus = new ModuleDataBus();
    const { context } = makeFakeContext({ 'Story Book': { entries: {} } });
    const service = new LorebookService(() => context, bus);
    await service.start();
    const created = await service.createEntry({ comment: 'X' });
    assert.equal(created.book, 'Story Book');

    context.chatMetadata = {};
    await service.scan();
    await assert.rejects(() => service.createEntry({ comment: 'Y' }), /no book bound/);
});

test('updateEntry merges a patch into the existing entry and emits entryUpdated with both versions', async () => {
    const bus = new ModuleDataBus();
    const { context, books } = makeFakeContext({ 'Story Book': { entries: { 0: { uid: 0, comment: 'Old', content: 'x', key: ['a'] } } } });
    const service = new LorebookService(() => context, bus);
    await service.start();

    let emitted = null;
    service.on('entryUpdated', payload => { emitted = payload; });

    const updated = await service.updateEntry(0, { comment: 'New' });

    assert.equal(updated.comment, 'New');
    assert.deepEqual(updated.key, ['a'], 'fields not in the patch are preserved');
    assert.equal(emitted.previous.comment, 'Old');
    assert.equal(emitted.entry.comment, 'New');
    assert.equal(books.get('Story Book').entries[0].comment, 'New');
});

test('updateEntry rejects an unknown uid with a clear error', async () => {
    const bus = new ModuleDataBus();
    const { context } = makeFakeContext({ 'Story Book': { entries: {} } });
    const service = new LorebookService(() => context, bus);
    await service.start();
    await assert.rejects(() => service.updateEntry(999, { comment: 'X' }), /no known entry/);
});

test('deleteEntry removes the entry from the book and emits entryDeleted', async () => {
    const bus = new ModuleDataBus();
    const { context, books } = makeFakeContext({ 'Story Book': { entries: { 0: { uid: 0, comment: 'Gone soon', content: 'x' } } } });
    const service = new LorebookService(() => context, bus);
    await service.start();

    let emitted = null;
    service.on('entryDeleted', payload => { emitted = payload; });

    await service.deleteEntry(0);

    assert.deepEqual(emitted, { uid: 0, book: 'Story Book' });
    assert.equal(books.get('Story Book').entries[0], undefined);
    assert.equal(bus.get('lorebook', 'entries').length, 0);
    assert.equal(service.get(0), undefined);
});

test('CHAT_CHANGED triggers a rescan, and a reentrant fire during that scan is dropped rather than recursing', async () => {
    const bus = new ModuleDataBus();
    const { context, fireChatChanged } = makeFakeContext({ 'Story Book': { entries: {} } });
    const service = new LorebookService(() => context, bus);
    await service.start();

    let scans = 0;
    service.on('scan', () => { scans++; if (scans === 1) fireChatChanged(); }); // nested fire while still handling the first
    fireChatChanged();
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.equal(scans, 1, 'the nested CHAT_CHANGED fired synchronously from inside the scan handler must be dropped, not recursed into');
});

test('a listener that throws does not stop other listeners or break emit()', async () => {
    const bus = new ModuleDataBus();
    const { context } = makeFakeContext({ 'Story Book': { entries: {} } });
    const service = new LorebookService(() => context, bus);
    await service.start();
    let goodCalls = 0;
    service.on('entryCreated', () => { throw new Error('boom'); });
    service.on('entryCreated', () => { goodCalls++; });
    await assert.doesNotReject(() => service.createEntry({ comment: 'X' }));
    assert.equal(goodCalls, 1);
});
