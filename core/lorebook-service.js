import { EventEmitter } from './event-emitter.js';
import { h, list, show, signal, computed, Toggle, Button } from './widgets.js';

/**
 * Every lorebook ST would actually scan right now — the same 4 sources ST's own
 * getSortedEntries() (public/scripts/world-info.js) unions before a generation:
 * globally-selected (checked in the World Info panel dropdown), character-attached
 * (primary book + `world_info.charLore`'s extraBooks — in a group chat, every
 * ENABLED member, not just whichever character last spoke, so the active set
 * doesn't flip mid-conversation depending on turn order), chat-attached
 * (`chatMetadata.world_info`), and persona-attached
 * (`powerUserSettings.persona_description_lorebook`). `globalState` — the pieces
 * `getContext()` doesn't expose at all (see loadGlobalWorldInfoState()'s own doc
 * comment) — defaults to empty so a caller that only has `context` still gets
 * every source `resolveBookNames` CAN resolve from it alone.
 */
export function resolveBookNames(context, globalState = {}) {
    const names = new Set();

    for (const name of globalState.selectedWorldInfo ?? []) if (name) names.add(name);

    const chatBook = context?.chatMetadata?.world_info;
    if (chatBook) names.add(chatBook);

    const addCharacterBooks = index => {
        const character = context?.characters?.[index];
        if (!character) return;
        const primary = character?.data?.extensions?.world;
        if (primary) names.add(primary);
        const fileName = String(character.avatar ?? '').replace(/\.[^/.]+$/, '');
        const extraBooks = globalState.charLore?.find(entry => entry.name === fileName)?.extraBooks ?? [];
        for (const name of extraBooks) if (name) names.add(name);
    };

    if (context?.groupId) {
        const group = context?.groups?.find(item => item.id === context.groupId);
        const disabledMembers = new Set(group?.disabled_members ?? []);
        for (const avatar of group?.members ?? []) {
            if (disabledMembers.has(avatar)) continue;
            const index = context?.characters?.findIndex(item => item.avatar === avatar);
            if (index >= 0) addCharacterBooks(index);
        }
    } else if (context?.characterId !== undefined && context?.characterId !== null) {
        addCharacterBooks(context.characterId);
    }

    const personaBook = context?.powerUserSettings?.persona_description_lorebook;
    if (personaBook) names.add(personaBook);

    return [...names];
}

/**
 * Reads `selected_world_info` (the globally-checked World Info books) and
 * `world_info.charLore` (a character's extra books) straight from ST's own
 * world-info.js — neither is reachable through the public `getContext()` surface
 * at all (confirmed against SillyTavern's own public/scripts/st-context.js: it
 * exposes `powerUserSettings`, `groups`/`groupId`, `chatMetadata`, `characters` —
 * never the module-level WI-selection state). This is exactly what real
 * third-party extensions with this same need already do — e.g. TunnelVision's
 * `tool-registry.js`: `getActiveTunnelVisionBooks()`, a deep static import from
 * the same file.
 *
 * A DYNAMIC import (not a static one at module scope) deliberately: a static
 * import's resolution failure — wrong ST version/layout, or, as in this
 * project's own test suite, no real SillyTavern tree on disk at all — would
 * crash this whole file's module graph immediately. This way a failure only
 * degrades THIS ONE lookup (falls back to the sources resolveBookNames() can
 * still resolve from `context` alone), never the rest of the service.
 *
 * The relative path assumes the standard third-party extension layout —
 * `public/scripts/extensions/third-party/<this-extension>/core/lorebook-service.js`,
 * four levels below `public/scripts/world-info.js`.
 */
export async function loadGlobalWorldInfoState() {
    try {
        const worldInfo = await import('../../../../world-info.js');
        return { selectedWorldInfo: worldInfo.selected_world_info ?? [], charLore: worldInfo.world_info?.charLore ?? [] };
    } catch {
        return { selectedWorldInfo: [], charLore: [] };
    }
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

/**
 * Merges `{ bookName: worldInfoData }` (worldInfoData = loadWorldInfo()'s `{ entries }`
 * shape, or null/undefined for a book that failed to load) into a flat summary list
 * plus a `${book}:${uid}` -> full entry map for get(). Keyed by book AND uid, not uid
 * alone: ST assigns uids per-file starting from 0, so two SEPARATE active books (a
 * global selection + a chat's own bound book, say — any pair resolveBookNames() can
 * return) can easily share the same numeric uid for entirely different entries. A
 * bare-uid key would let the second book's entry silently overwrite the first's here.
 */
export function mergeBooks(booksByName) {
    const summaries = [];
    const byUid = new Map();
    for (const [book, data] of Object.entries(booksByName)) {
        const entries = data?.entries;
        if (!entries) continue;
        for (const entry of Object.values(entries)) {
            summaries.push(summarizeEntry(entry, book));
            byUid.set(`${book}:${entry.uid}`, { ...entry, book });
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
const SETTINGS_KEY = 'st_module_engine_lorebook';

/** Same collision-avoidant slug shape Tracker/Dice already use for their own per-entity macro names, prefixed with this service's own namespace so it can never collide with a different module's macro by coincidence. */
export function macroSlug(...parts) {
    return ['lorebook', ...parts].join('_')
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 60);
}

/**
 * An independent core service — NOT a module, NOT owned by `ModuleEngine` (see
 * MODULES.md's "Independent core services" section for why). It only ever touches the
 * `ModuleDataBus` instance it's given; `core/module-engine.js` has no idea this class
 * exists. `index.js` constructs and starts it as a sibling to `ModuleEngine`, sharing
 * the same bus via `engine.bus`, and gives it a first-class spot in Base settings via
 * `engine.addBaseCard()` — a real settings card, not a module you enable/disable.
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
 *
 * Publishing (new): any scanned entry can be toggled, from its own card in the
 * Base-settings window, into a real ST `{{macro}}` AND a plain bus channel holding
 * its full content — exactly the same dual exposure Tracker's per-field macros and
 * RP Time's `{{rp_time}}` already get, so a published entry is usable anywhere in
 * ST (prompts, World Info, another character card) or read by any module via
 * `host.data.read('lorebook', 'entry:<book>:<uid>')`, without that module needing
 * to know anything about World Info at all.
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
        this.#bus.reserve(NAMESPACE, 'books', { name: 'Active lorebook names', schema: { type: 'array' } });
        this.#bus.reserve(NAMESPACE, 'publishedEntries', { name: 'Published lorebook entries index', schema: { type: 'array' } });
        this.#bus.set(NAMESPACE, 'api', {
            find: filter => this.find(filter),
            get: (uid, book) => this.get(uid, book),
            books: () => this.books(),
            createEntry: (patch, opts) => this.createEntry(patch, opts),
            updateEntry: (uid, patch) => this.updateEntry(uid, patch),
            deleteEntry: uid => this.deleteEntry(uid),
            isPublished: (book, uid) => this.isPublished(book, uid),
            publishEntry: (book, uid) => this.publishEntry(book, uid),
            unpublishEntry: (book, uid) => this.unpublishEntry(book, uid),
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
        const globalState = await loadGlobalWorldInfoState();
        const names = resolveBookNames(context, globalState);
        this.#bus.set(NAMESPACE, 'books', names);
        if (!names.length) {
            this.#byUid = new Map();
            this.#bus.set(NAMESPACE, 'entries', []);
            this.#republishAll();
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
        // Re-establishes every published entry's macro/bus channel against the
        // FRESH scan (a book switch has an entirely different set of entries), and
        // unreserve()s one whose entry no longer exists — same "producer
        // republishes full current state" + "reconcile a shrinking set of
        // channels" patterns Tracker's own publish() already uses.
        this.#republishAll();
        this.#emitter.emit('scan', { books: names, entries: merged.summaries });
    }

    /** Metadata-only entries matching every provided filter field (name/minLength/maxLength/key/disabled/constant) — all optional, an empty call lists everything. */
    find(filter) {
        return this.#bus.get(NAMESPACE, 'entries', []).filter(summary => matchesFilter(summary, filter));
    }

    /**
     * One entry's full record (content included) by uid, optionally disambiguated
     * by `book`. Without `book`, returns the first match across whichever books are
     * currently active — ambiguous only when two DIFFERENT active books happen to
     * reuse the same numeric uid (see mergeBooks()'s own doc comment); every
     * internal caller in this file that already knows the book passes it.
     */
    get(uid, book) {
        if (book !== undefined) return this.#byUid.get(`${book}:${uid}`);
        for (const entry of this.#byUid.values()) if (entry.uid === uid) return entry;
        return undefined;
    }

    /** Currently active lorebook name(s) — see resolveBookNames()'s own doc comment for the full list of sources. */
    books() {
        return this.#bus.get(NAMESPACE, 'books', []);
    }

    // --- Publishing: toggle one entry into a real {{macro}} + bus channel ---
    //
    // Settings live in their own extensionSettings key — this service is
    // independent of ModuleEngine, so it can't reach engine.moduleSettings() (that
    // API is per-MODULE and this isn't one) and deliberately doesn't try to; it
    // manages its own tiny persisted slice the same direct way ModuleEngine
    // manages its own. Shaped as `{ [book]: { [uid]: true } }`, not a flat
    // `${book}:${uid}` string key — a lorebook's own name can itself contain a
    // colon, which would make a compound string key ambiguous to parse back apart.

    #settings() {
        const context = this.#getContext();
        const root = context.extensionSettings ?? (context.extensionSettings = {});
        const settings = root[SETTINGS_KEY] ?? (root[SETTINGS_KEY] = {});
        settings.published ??= {};
        return settings;
    }

    #saveSettings() {
        const context = this.#getContext();
        context.saveSettingsDebounced?.();
        context.saveSettings?.();
    }

    isPublished(book, uid) {
        return Boolean(this.#settings().published[book]?.[uid]);
    }

    /** Publishes (or re-publishes, if already on) one entry's full content as `{{macroSlug(book, name)}}` and `host.data.read('lorebook', 'entry:<book>:<uid>')`. Persists across reloads and survives a re-scan as long as the entry still exists. */
    publishEntry(book, uid) {
        const published = this.#settings().published;
        (published[book] ??= {})[uid] = true;
        this.#saveSettings();
        this.#applyPublished(book, uid);
        this.#refreshPublishedIndex();
    }

    /** Turns a published entry back off — retires its macro and bus channel immediately, not just on the next scan(). */
    unpublishEntry(book, uid) {
        const published = this.#settings().published;
        if (published[book]) {
            delete published[book][uid];
            if (!Object.keys(published[book]).length) delete published[book];
        }
        this.#saveSettings();
        this.#bus.unreserve(NAMESPACE, `entry:${book}:${uid}`);
        this.#refreshPublishedIndex();
    }

    /** Re-applies (or, if the entry is gone, retires) every entry currently marked published — called once at the end of every scan(), so a book switch or an entry's own deletion is reflected immediately rather than leaving a stale macro pointing at nothing. */
    #republishAll() {
        const published = this.#settings().published;
        for (const [book, uids] of Object.entries(published)) {
            for (const uid of Object.keys(uids)) this.#applyPublished(book, Number(uid));
        }
        this.#refreshPublishedIndex();
    }

    /**
     * Keeps `lorebook:publishedEntries` (a flat `{ book, uid, name, macro }[]`) in
     * sync with whatever's really published right now — the same "producer
     * republishes its own index" pattern `blocks`/`entries` above already use, so
     * a consumer (Macros' own insert-picker, see modules/macros/index.js) can just
     * `host.data.subscribe('lorebook', 'publishedEntries', ...)` instead of
     * re-deriving this from raw settings + host.data.listChannels() itself. Skips
     * an entry that's marked published but no longer exists — #applyPublished()
     * already unreserve()d its own channel above; this list must not lag behind.
     */
    #refreshPublishedIndex() {
        const published = this.#settings().published;
        const index = [];
        for (const [book, uids] of Object.entries(published)) {
            for (const uidKey of Object.keys(uids)) {
                const uid = Number(uidKey);
                const entry = this.get(uid, book);
                if (!entry) continue;
                const displayName = String(entry.comment ?? '').trim() || `${book} #${uid}`;
                index.push({ book, uid, name: displayName, macro: macroSlug(book, String(entry.comment ?? '').trim() || String(uid)) });
            }
        }
        this.#bus.set(NAMESPACE, 'publishedEntries', index);
    }

    #applyPublished(book, uid) {
        const busKey = `entry:${book}:${uid}`;
        // this.get() returns the RAW World Info entry (ST's own field is
        // `comment`) — not the metadata SUMMARY summarizeEntry() builds (which
        // renames it to `name` for display). Using entry.name here (undefined on
        // the raw shape) used to silently fall through to the bare uid for every
        // macro slug, disagreeing with what #renderEntryCard's own preview showed
        // the user (built from the summary's real `.name`).
        const entry = this.get(uid, book);
        if (!entry) { this.#bus.unreserve(NAMESPACE, busKey); return; }
        const displayName = String(entry.comment ?? '').trim() || `${book} #${uid}`;
        this.#bus.reserve(NAMESPACE, busKey, {
            name: `Lorebook — ${displayName}`,
            schema: { type: 'string' },
            macro: macroSlug(book, String(entry.comment ?? '').trim() || String(uid)),
        });
        this.#bus.set(NAMESPACE, busKey, entry.content ?? '');
    }

    // --- Write ---

    /**
     * Creates a new entry. `book` defaults to the first currently-active book; throws if
     * none is active and none was given explicitly (there's nowhere to write it).
     * Read-modify-write: loads the book's current full file, adds the entry to its
     * `.entries`, saves the whole object back — nothing else in the file is touched,
     * regardless of what else it may contain beyond `entries`. Re-scans before
     * resolving, so the index/bus are already fresh by the time this returns and
     * before 'entryCreated' fires.
     */
    async createEntry(patch = {}, { book } = {}) {
        const targetBook = book ?? this.books()[0];
        if (!targetBook) throw new Error('createEntry: no lorebook active for this chat/character, and none was given explicitly.');
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
        const owner = this.get(uid);
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
        const owner = this.get(uid);
        if (!owner) throw new Error(`deleteEntry: no known entry with uid ${uid} (run scan() first, or it may not exist).`);
        const context = this.#getContext();
        const data = (await context.loadWorldInfo?.(owner.book)) ?? { entries: {} };
        delete data.entries?.[uid];
        await context.saveWorldInfo?.(owner.book, data);
        await this.scan();
        this.#emitter.emit('entryDeleted', { uid, book: owner.book });
    }

    // --- UI: the Base-settings card (see index.js's engine.addBaseCard()) ---

    /**
     * Renders the whole card: one row per currently-scanned entry, each with a
     * Publish toggle. Deliberately does NOT expose editing (name/content/keys) —
     * that's still ST's own World Info editor's job; this card is about SURFACING
     * what's already there and exposing it to the rest of the engine, not
     * replacing WI's own UI. Reads/writes only through `this` (the same public
     * methods any module reaches via `host.data.read('lorebook', 'api')`), so a
     * future consumer copying this card's own logic has a real, already-used
     * example to follow.
     */
    render(container, toast) {
        const entries = signal(this.#bus.get(NAMESPACE, 'entries', []));
        this.#bus.subscribe(NAMESPACE, 'entries', next => entries.set(next ?? []));
        const books = signal(this.#bus.get(NAMESPACE, 'books', []));
        this.#bus.subscribe(NAMESPACE, 'books', next => books.set(next ?? []));

        const booksLine = computed(() => (books().length ? `Active: ${books().join(', ')}` : 'No lorebook is active for this chat/character yet.'));

        const rescan = Button('Rescan', async () => {
            try { await this.scan(); toast('success', 'Lorebook rescanned.', 'Lorebook'); }
            catch (error) { toast('error', error?.message || String(error), 'Lorebook'); }
        });

        container.append(
            h('p', { class: 'stme-lorebook-help' }, 'Every entry in your currently active lorebook(s) — global, character, chat, and persona — read-only — editing still happens in ST\'s own World Info panel. Toggle "Publish" to expose an entry\'s full content as a real ', h('code', {}, '{{macro}}'), ' and a bus value any module can read, the same way Tracker/RP Time already publish their own values.'),
            h('div', { class: 'stme-lorebook-books' }, h('span', {}, booksLine), rescan),
            show(computed(() => entries().length === 0), empty => empty ? h('p', { class: 'stme-lorebook-empty' }, 'No entries found in the active lorebook(s).') : null),
            h('div', { class: 'stme-lorebook-list' }, list(entries, entry => `${entry.book}:${entry.uid}`, entry => this.#renderEntryCard(entry))),
        );
    }

    #renderEntryCard(entry) {
        const published = signal(this.isPublished(entry.book, entry.uid));
        const macroName = macroSlug(entry.book, entry.name || String(entry.uid));
        const flags = [
            `${entry.length} char${entry.length === 1 ? '' : 's'}`,
            entry.disabled ? 'disabled in WI' : null,
            entry.constant ? 'constant' : null,
        ].filter(Boolean).join(' · ');

        return h('div', { class: 'stme-lorebook-entry' },
            h('div', { class: 'stme-lorebook-entry-head' },
                h('strong', {}, entry.name || `#${entry.uid}`),
                h('small', {}, `${entry.book} · ${flags}`),
            ),
            entry.keys.length ? h('div', { class: 'stme-lorebook-entry-keys' }, entry.keys.map(key => h('code', {}, key))) : null,
            Toggle(`Publish as {{${macroName}}}`, published, {
                hint: 'Exposes this entry\'s full content as a real ST macro and a bus value — usable in prompts, World Info, or read by any module, exactly like Tracker/RP Time.',
                onChange: checked => {
                    published.set(checked);
                    if (checked) this.publishEntry(entry.book, entry.uid);
                    else this.unpublishEntry(entry.book, entry.uid);
                },
            }),
        );
    }
}
