import { EventEmitter } from './event-emitter.js';

/**
 * Which lorebook(s) are bound to the current character/chat, per ST's own binding
 * model (public/scripts/world-info.js): a chat binds to at most one book by name
 * (`chatMetadata.world_info`), and a character carries its own primary book
 * (`character.data.extensions.world`). Deliberately NOT replicating ST's full
 * resolution (globally-selected books, a character's extraBooks, char-lore recursion)
 * — this is the simple, common case; the two names above cover "this story's lorebook"
 * for the vast majority of setups.
 */
export function resolveBookNames(context) {
    const names = new Set();
    const chatBook = context?.chatMetadata?.world_info;
    if (chatBook) names.add(chatBook);
    const character = context?.characters?.[context?.characterId];
    const charBook = character?.data?.extensions?.world;
    if (charBook) names.add(charBook);
    return [...names];
}

/** One World Info entry, reduced to the metadata a consumer filters/browses by — never `content` (kept out of the bus index; see get()). */
export function summarizeEntry(entry, book) {
    return {
        uid: entry.uid,
        book,
        name: String(entry.comment ?? '').trim(),
        keys: Array.isArray(entry.key) ? entry.key : [],
        length: String(entry.content ?? '').length,
        disabled: Boolean(entry.disable),
        constant: Boolean(entry.constant),
    };
}

/** True if `summary` matches every provided filter field; an omitted field always matches. */
export function matchesFilter(summary, filter = {}) {
    const { name, minLength, maxLength, key, disabled, constant } = filter;
    if (name !== undefined && !summary.name.toLowerCase().includes(String(name).toLowerCase())) return false;
    if (minLength !== undefined && summary.length < minLength) return false;
    if (maxLength !== undefined && summary.length > maxLength) return false;
    if (key !== undefined && !summary.keys.some(item => String(item).toLowerCase().includes(String(key).toLowerCase()))) return false;
    if (disabled !== undefined && summary.disabled !== Boolean(disabled)) return false;
    if (constant !== undefined && summary.constant !== Boolean(constant)) return false;
    return true;
}

/** Merges `{ bookName: worldInfoData }` (worldInfoData = loadWorldInfo()'s `{ entries }` shape, or null/undefined for a book that failed to load) into a flat summary list plus a uid -> full entry map for get(). */
export function mergeBooks(booksByName) {
    const summaries = [];
    const byUid = new Map();
    for (const [book, data] of Object.entries(booksByName)) {
        const entries = data?.entries;
        if (!entries) continue;
        for (const entry of Object.values(entries)) {
            summaries.push(summarizeEntry(entry, book));
            byUid.set(entry.uid, { ...entry, book });
        }
    }
    return { summaries, byUid };
}

/** The next free uid for a book's `entries` map — one past the highest existing numeric uid, or 0 for an empty/new book. Independent of whatever scheme ST's own editor uses internally; only needs to be fresh and collision-free within this book. */
function nextUid(entries) {
    const used = Object.keys(entries ?? {}).map(Number).filter(Number.isFinite);
    return used.length ? Math.max(...used) + 1 : 0;
}

/** A brand-new entry's defaults before `patch` is applied — conservative, roughly matching what a freshly-created entry looks like in ST's own editor for the fields we know about. */
function blankEntry(uid) {
    return {
        uid, key: [], keysecondary: [], comment: '', content: '',
        constant: false, selective: true, disable: false,
        order: 100, position: 0, probability: 100,
    };
}

const NAMESPACE = 'lorebook';

/**
 * An independent core service — NOT a module, NOT owned by `ModuleEngine` (see
 * MODULES.md's "Independent core services" section for why). It only ever touches the
 * `ModuleDataBus` instance it's given; `core/module-engine.js` has no idea this class
 * exists. `index.js` constructs and starts it as a sibling to `ModuleEngine`, sharing
 * the same bus via `engine.bus`.
 *
 * Today this reads/writes SillyTavern's own World Info as its storage. The API is
 * deliberately shaped like a small mutable, observable store (read + write + events)
 * rather than "a WI reader" specifically, so a future, much bigger system — where WI
 * is just one storage backend for a node/connection graph the engine itself owns —
 * doesn't have to redesign this surface, only swap what's behind it. Nothing
 * node/graph-shaped is built here; this is only about not painting that door shut.
 *
 * Reached by modules purely through the bus — no `host` surface, no `ModuleEngine`
 * change: `host.data.read('lorebook', 'api')` returns a plain object of bound methods
 * (the same "publish a callable" idiom `modules/tracker/index.js`'s own `publish()`
 * already uses), and `api.on(type, listener)` subscribes to this service's events.
 */
export class LorebookService {
    #getContext;
    #bus;
    #emitter = new EventEmitter();
    #byUid = new Map();
    #chatChangedDispatching = false;
    #unsubscribeChatChanged = null;

    constructor(getContext, bus) {
        this.#getContext = getContext;
        this.#bus = bus;
        this.#bus.reserve(NAMESPACE, 'entries', { name: 'Lorebook entries index', schema: { type: 'array' } });
        this.#bus.reserve(NAMESPACE, 'books', { name: 'Bound lorebook names', schema: { type: 'array' } });
        this.#bus.set(NAMESPACE, 'api', {
            find: filter => this.find(filter),
            get: uid => this.get(uid),
            books: () => this.books(),
            createEntry: (patch, opts) => this.createEntry(patch, opts),
            updateEntry: (uid, patch) => this.updateEntry(uid, patch),
            deleteEntry: uid => this.deleteEntry(uid),
            on: (type, listener) => this.#emitter.on(type, listener),
        });
    }

    /** Runs an initial scan and starts reacting to chat/character switches. Call once, from `index.js`. */
    async start() {
        await this.scan();
        const context = this.#getContext();
        if (context.eventTypes?.CHAT_CHANGED && context.eventSource?.on) {
            // A lighter guard than ModuleEngine's own burst-windowed #dispatchChatChanged —
            // this service never calls anything on ST that plausibly re-triggers
            // CHAT_CHANGED during a plain scan() (no setExtensionPrompt, no chatMetadata
            // writes), so a simple "don't re-enter while already scanning" flag is enough.
            // Write operations (createEntry/updateEntry/deleteEntry) are explicit, on-demand
            // calls from a module — not something that fires automatically on every switch.
            const handler = () => {
                if (this.#chatChangedDispatching) return;
                this.#chatChangedDispatching = true;
                Promise.resolve(this.scan())
                    .catch(error => console.error('[STME:lorebook] scan() on CHAT_CHANGED failed:', error))
                    .finally(() => { this.#chatChangedDispatching = false; });
            };
            context.eventSource.on(context.eventTypes.CHAT_CHANGED, handler);
            this.#unsubscribeChatChanged = () => context.eventSource.off?.(context.eventTypes.CHAT_CHANGED, handler);
        }
    }

    /** Stops reacting to chat changes. Not currently called anywhere (this service lives for the page's lifetime), provided for symmetry/tests. */
    stop() {
        this.#unsubscribeChatChanged?.();
        this.#unsubscribeChatChanged = null;
    }

    on(type, listener) { return this.#emitter.on(type, listener); }

    // --- Read ---

    async scan() {
        const context = this.#getContext();
        const names = resolveBookNames(context);
        this.#bus.set(NAMESPACE, 'books', names);
        if (!names.length) {
            this.#byUid = new Map();
            this.#bus.set(NAMESPACE, 'entries', []);
            this.#emitter.emit('scan', { books: names, entries: [] });
            return;
        }
        const loaded = {};
        for (const name of names) {
            try { loaded[name] = await context.loadWorldInfo?.(name); }
            catch (error) { console.warn('[STME:lorebook] Failed to load lorebook', name, error); }
        }
        const merged = mergeBooks(loaded);
        this.#byUid = merged.byUid;
        this.#bus.set(NAMESPACE, 'entries', merged.summaries);
        this.#emitter.emit('scan', { books: names, entries: merged.summaries });
    }

    /** Metadata-only entries matching every provided filter field (name/minLength/maxLength/key/disabled/constant) — all optional, an empty call lists everything. */
    find(filter) {
        return this.#bus.get(NAMESPACE, 'entries', []).filter(summary => matchesFilter(summary, filter));
    }

    /** One entry's full record (content included) by uid, or undefined. */
    get(uid) {
        return this.#byUid.get(uid);
    }

    /** Currently bound lorebook name(s). */
    books() {
        return this.#bus.get(NAMESPACE, 'books', []);
    }

    // --- Write ---

    /**
     * Creates a new entry. `book` defaults to the first currently-bound book; throws if
     * none is bound and none was given explicitly (there's nowhere to write it).
     * Read-modify-write: loads the book's current full file, adds the entry to its
     * `.entries`, saves the whole object back — nothing else in the file is touched,
     * regardless of what else it may contain beyond `entries`. Re-scans before
     * resolving, so the index/bus are already fresh by the time this returns and
     * before 'entryCreated' fires.
     */
    async createEntry(patch = {}, { book } = {}) {
        const targetBook = book ?? this.books()[0];
        if (!targetBook) throw new Error('createEntry: no book bound to this chat/character, and none was given explicitly.');
        const context = this.#getContext();
        const data = (await context.loadWorldInfo?.(targetBook)) ?? { entries: {} };
        data.entries ??= {};
        const uid = nextUid(data.entries);
        const entry = { ...blankEntry(uid), ...patch, uid };
        data.entries[uid] = entry;
        await context.saveWorldInfo?.(targetBook, data);
        await this.scan();
        const full = { ...entry, book: targetBook };
        this.#emitter.emit('entryCreated', full);
        return full;
    }

    /** Merges `patch` into an existing entry (found via the current index, so `scan()` must have seen it) and saves. */
    async updateEntry(uid, patch = {}) {
        const owner = this.#byUid.get(uid);
        if (!owner) throw new Error(`updateEntry: no known entry with uid ${uid} (run scan() first, or it may not exist).`);
        const context = this.#getContext();
        const data = (await context.loadWorldInfo?.(owner.book)) ?? { entries: {} };
        data.entries ??= {};
        const existing = data.entries[uid] ?? { ...owner };
        const previous = { ...existing, book: owner.book };
        const updated = { ...existing, ...patch, uid };
        data.entries[uid] = updated;
        await context.saveWorldInfo?.(owner.book, data);
        await this.scan();
        const full = { ...updated, book: owner.book };
        this.#emitter.emit('entryUpdated', { entry: full, previous });
        return full;
    }

    /** Removes an entry by uid (found via the current index). */
    async deleteEntry(uid) {
        const owner = this.#byUid.get(uid);
        if (!owner) throw new Error(`deleteEntry: no known entry with uid ${uid} (run scan() first, or it may not exist).`);
        const context = this.#getContext();
        const data = (await context.loadWorldInfo?.(owner.book)) ?? { entries: {} };
        delete data.entries?.[uid];
        await context.saveWorldInfo?.(owner.book, data);
        await this.scan();
        this.#emitter.emit('entryDeleted', { uid, book: owner.book });
    }
}
