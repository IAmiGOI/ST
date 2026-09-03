import { h, list, signal, computed, onDispose, Button } from '../../core/widgets.js';

const MODULE_ID = 'lorebook';

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

export const lorebookModule = {
    id: MODULE_ID,
    title: 'Lorebook Scan',
    description: 'Reads the current character/chat lorebook and exposes it on the bus — an index for the UI, and a query tool for other modules.',
    about: 'Looks at your lorebook (the background info you\'ve written about the world/characters) and makes a simple list of what\'s in it, so the other tools here can find and use specific pieces of it without you doing anything extra.',
    defaultEnabled: false,

    activate(host) {
        const log = (...args) => console.info('[STME:lorebook]', ...args);
        let byUid = new Map();

        const scan = async () => {
            const context = host.context();
            const names = resolveBookNames(context);
            host.data.set('books', names);
            if (!names.length) {
                byUid = new Map();
                host.data.set('entries', []);
                log('scan(): no lorebook bound to this character/chat.');
                return;
            }
            const loaded = {};
            for (const name of names) {
                try { loaded[name] = await context.loadWorldInfo?.(name); }
                catch (error) { console.warn('[STME:lorebook] Failed to load lorebook', name, error); }
            }
            const merged = mergeBooks(loaded);
            byUid = merged.byUid;
            host.data.set('entries', merged.summaries);
            log(`scan(): ${merged.summaries.length} entr${merged.summaries.length === 1 ? 'y' : 'ies'} from ${names.join(', ')}.`);
        };

        host.data.reserve('entries', { name: 'Lorebook entries index', schema: { type: 'array' } });
        host.data.reserve('books', { name: 'Bound lorebook names', schema: { type: 'array' } });
        host.data.set('rescan', scan);
        host.services.register('lorebook', {
            /** Metadata-only entries matching every provided filter field (name/minLength/maxLength/key/disabled/constant) — all optional, an empty call lists everything. */
            find: filter => host.data.get('entries', []).filter(summary => matchesFilter(summary, filter)),
            /** One entry's full record (content included) by uid, or undefined. */
            get: uid => byUid.get(uid),
        });

        scan();
        const unsubscribe = host.onChatChanged(() => scan());
        return () => { unsubscribe(); host.services.unregister('lorebook'); };
    },

    render(container, host) {
        const entries = signal(host.data.get('entries', []));
        const books = signal(host.data.get('books', []));
        onDispose(container, host.data.subscribe(MODULE_ID, 'entries', next => entries.set(next ?? [])));
        onDispose(container, host.data.subscribe(MODULE_ID, 'books', next => books.set(next ?? [])));

        const status = computed(() => {
            const count = entries().length;
            if (!books().length) return 'No lorebook bound to this character/chat.';
            return `${count} entr${count === 1 ? 'y' : 'ies'} from ${books().join(', ')}.`;
        });

        container.append(
            h('p', { class: 'stme-lorebook-help' }, 'Read-only: shows what other modules can query via ', h('code', {}, "host.services.request('lorebook').find({...})"), '. Rescans automatically on chat change.'),
            h('div', { class: 'stme-lorebook-status' }, status, Button('Rescan', () => host.data.get('rescan')?.())),
            h('div', { class: 'stme-lorebook-list' },
                list(entries, entry => entry.uid, entry => h('div', { class: 'stme-lorebook-row' },
                    h('span', { class: 'stme-lorebook-row-name' }, entry.name || '(untitled)'),
                    h('code', { class: 'stme-lorebook-row-keys' }, entry.keys.join(', ') || '—'),
                    h('span', { class: 'stme-lorebook-row-flags' },
                        `${entry.length} chars`,
                        entry.constant ? ' · constant' : '',
                        entry.disabled ? ' · disabled' : '',
                    ),
                )),
            ),
        );
    },

    css: `
        .stme-settings .stme-lorebook-help { margin: 0 0 10px; line-height: 1.4; opacity: .85; }
        .stme-settings .stme-lorebook-status { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 10px; border: 1px solid var(--SmartThemeBorderColor); border-radius: 7px; background: var(--SmartThemeBlurTintColor); margin-bottom: 10px; }
        .stme-settings .stme-lorebook-list { display: flex; flex-direction: column; gap: 5px; max-height: 320px; overflow-y: auto; }
        .stme-settings .stme-lorebook-row { display: grid; grid-template-columns: minmax(100px, .3fr) 1fr auto; gap: 8px; align-items: center; padding: 5px 8px; border: 1px solid var(--SmartThemeBorderColor); border-radius: 6px; background: rgba(0, 0, 0, .06); font-size: .9em; }
        .stme-settings .stme-lorebook-row-name { font-weight: 600; overflow-wrap: anywhere; }
        .stme-settings .stme-lorebook-row-keys { opacity: .75; overflow-wrap: anywhere; }
        .stme-settings .stme-lorebook-row-flags { opacity: .65; white-space: nowrap; text-align: right; }
    `,
};
