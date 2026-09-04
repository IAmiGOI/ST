import test from 'node:test';
import assert from 'node:assert/strict';
import { ModuleDataBus } from '../core/data-bus.js';
import {
    LorebookService, resolveBookNames, summarizeEntry, matchesFilter, mergeBooks, macroSlug,
} from '../core/lorebook-service.js';
import { installFakeDom, captureRealDom, restoreRealDom } from './helpers/fake-dom.js';

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

// --- Regression: ST assigns uids per-file starting from 0, so two SEPARATELY
// bound books (a chat's own + its character's own — exactly what
// resolveBookNames() can return together) commonly share the same numeric uid
// for two completely different entries. #byUid used to be keyed by bare uid
// alone, so the SECOND book's entry silently overwrote the first's — get(uid)
// for the first book's entry would then return the wrong book's content
// entirely, which is exactly the kind of thing a "publish this entry as a
// macro" feature must never do.

test('mergeBooks keeps BOTH entries when two different books share the same numeric uid', () => {
    const { byUid } = mergeBooks({
        Chat: { entries: { 0: { uid: 0, comment: 'Chat Entry', content: 'chat content' } } },
        Character: { entries: { 0: { uid: 0, comment: 'Character Entry', content: 'character content' } } },
    });
    assert.equal(byUid.size, 2, 'both entries must survive — a bare-uid key would let one overwrite the other');
    assert.equal(byUid.get('Chat:0').content, 'chat content');
    assert.equal(byUid.get('Character:0').content, 'character content');
});

test('macroSlug produces a stable, collision-avoidant, lowercase macro name prefixed with "lorebook"', () => {
    assert.equal(macroSlug('My Book', 'Dragon Lore'), 'lorebook_my_book_dragon_lore');
    assert.equal(macroSlug('a', 'b'), 'lorebook_a_b');
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

// --- get(uid, book) disambiguation, against the REAL service (not just
// mergeBooks() in isolation) — two bound books sharing a numeric uid.

function makeTwoBookContext() {
    return {
        chatMetadata: { world_info: 'Chat Book' },
        characterId: 0,
        characters: [{ data: { extensions: { world: 'Character Book' } } }],
        eventTypes: {}, eventSource: { on() {}, off() {} },
        loadWorldInfo: async name => ({
            'Chat Book': { entries: { 0: { uid: 0, comment: 'Chat Entry', content: 'chat content' } } },
            'Character Book': { entries: { 0: { uid: 0, comment: 'Character Entry', content: 'character content' } } },
        }[name] ?? null),
        saveWorldInfo: async () => {},
    };
}

test('get(uid, book) disambiguates two bound books sharing the same numeric uid; bare get(uid) returns SOME real match, never a mix-up', async () => {
    const bus = new ModuleDataBus();
    const context = makeTwoBookContext();
    const service = new LorebookService(() => context, bus);
    await service.start();

    assert.equal(service.get(0, 'Chat Book').content, 'chat content');
    assert.equal(service.get(0, 'Character Book').content, 'character content');
    assert.ok(['chat content', 'character content'].includes(service.get(0).content));
});

// --- Publishing: toggle an entry into a real {{macro}} + bus channel ---

function makeMacroContext(overrides = {}) {
    const registered = new Map();
    return {
        registered,
        context: {
            chatMetadata: { world_info: 'Story Book' },
            characterId: 0, characters: [{ data: { extensions: {} } }],
            eventTypes: {}, eventSource: { on() {}, off() {} },
            extensionSettings: {},
            saveSettingsDebounced() {},
            registerMacro: (name, handler) => registered.set(name, handler),
            unregisterMacro: name => registered.delete(name),
            loadWorldInfo: async name => (name === 'Story Book' ? { entries: { 0: { uid: 0, comment: 'Dragon Lore', content: 'Dragons breathe fire.' } } } : null),
            saveWorldInfo: async () => {},
            ...overrides,
        },
    };
}

test('publishEntry registers a real ST macro and a bus value holding the entry\'s full content', async () => {
    const { context, registered } = makeMacroContext();
    const bus = new ModuleDataBus({ getContext: () => context }); // real macro registration needs the bus's own getContext wired, not just the service's
    const service = new LorebookService(() => context, bus);
    await service.start();

    assert.equal(service.isPublished('Story Book', 0), false);
    service.publishEntry('Story Book', 0);

    assert.equal(service.isPublished('Story Book', 0), true);
    assert.equal(registered.get('lorebook_story_book_dragon_lore')(), 'Dragons breathe fire.');
    assert.equal(bus.get('lorebook', 'entry:Story Book:0'), 'Dragons breathe fire.');
});

test('unpublishEntry retires both the macro and the bus value immediately', async () => {
    const { context, registered } = makeMacroContext();
    const bus = new ModuleDataBus({ getContext: () => context });
    const service = new LorebookService(() => context, bus);
    await service.start();
    service.publishEntry('Story Book', 0);

    service.unpublishEntry('Story Book', 0);

    assert.equal(service.isPublished('Story Book', 0), false);
    assert.equal(registered.has('lorebook_story_book_dragon_lore'), false);
    assert.equal(bus.get('lorebook', 'entry:Story Book:0'), undefined);
});

test('a published entry survives a rescan (e.g. a chat switch) as long as it still exists', async () => {
    const { context, registered } = makeMacroContext();
    const bus = new ModuleDataBus({ getContext: () => context });
    const service = new LorebookService(() => context, bus);
    await service.start();
    service.publishEntry('Story Book', 0);

    await service.scan();

    assert.equal(service.isPublished('Story Book', 0), true);
    assert.equal(registered.get('lorebook_story_book_dragon_lore')(), 'Dragons breathe fire.');
});

test('a published entry\'s macro/bus value is retired once the entry itself is deleted from the book', async () => {
    const { context, registered } = makeMacroContext();
    const bus = new ModuleDataBus({ getContext: () => context });
    const service = new LorebookService(() => context, bus);
    await service.start();
    service.publishEntry('Story Book', 0);

    context.loadWorldInfo = async () => ({ entries: {} }); // the entry is gone now
    await service.scan();

    assert.equal(registered.has('lorebook_story_book_dragon_lore'), false, 'a stale macro pointing at a deleted entry must not keep resolving');
    assert.equal(bus.get('lorebook', 'entry:Story Book:0'), undefined);
});

test('publishEntry persists across a fresh LorebookService instance reading the same context (survives a page reload)', async () => {
    const { context, registered } = makeMacroContext();
    const bus = new ModuleDataBus({ getContext: () => context });
    const service = new LorebookService(() => context, bus);
    await service.start();
    service.publishEntry('Story Book', 0);

    // A new instance, same context — simulates a page reload re-constructing the service.
    const bus2 = new ModuleDataBus({ getContext: () => context });
    const service2 = new LorebookService(() => context, bus2);
    await service2.start();

    assert.equal(service2.isPublished('Story Book', 0), true);
    assert.equal(registered.get('lorebook_story_book_dragon_lore')(), 'Dragons breathe fire.');
});

// --- render(): the real Base-settings card, through a real (if minimal) fake DOM ---

test('render() lists a real entry as a card and its Publish toggle actually calls publishEntry/unpublishEntry', async () => {
    const previousDom = captureRealDom();
    installFakeDom();
    try {
        const { context, registered } = makeMacroContext();
        const bus = new ModuleDataBus({ getContext: () => context });
        const service = new LorebookService(() => context, bus);
        await service.start();

        const container = document.createElement('div');
        const toasts = [];
        service.render(container, (level, message) => toasts.push({ level, message }));

        function findCheckbox(node) {
            if (node.type === 'checkbox') return node;
            for (const child of node.childNodes) { const found = findCheckbox(child); if (found) return found; }
            return null;
        }
        const checkbox = findCheckbox(container);
        assert.ok(checkbox, 'the Publish toggle checkbox was not found in the rendered card');
        assert.equal(service.isPublished('Story Book', 0), false);

        checkbox.checked = true;
        checkbox.fire('change');
        assert.equal(service.isPublished('Story Book', 0), true);
        assert.equal(registered.get('lorebook_story_book_dragon_lore')(), 'Dragons breathe fire.', 'the toggle must drive the SAME real publish path publishEntry() itself uses');

        checkbox.checked = false;
        checkbox.fire('change');
        assert.equal(service.isPublished('Story Book', 0), false);
        assert.equal(registered.has('lorebook_story_book_dragon_lore'), false);
    } finally { restoreRealDom(previousDom); }
});
