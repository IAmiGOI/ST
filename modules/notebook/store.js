const METADATA_KEY = 'stme_notebook_notes';
const SETTINGS_KEY = 'stme_notebook_settings';
const defaults = Object.freeze({ maxNotes: 12, cleanupBatch: 4, injectionDepth: 4 });

function clamp(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
}

export function createNotebookStore(context) {
    const metadata = () => context().chatMetadata;
    const notes = () => (metadata()[METADATA_KEY] ??= []);
    const save = () => context().saveMetadataDebounced?.();
    // Only ever writes chatMetadata when a value is actually out of range — a
    // mere read (e.g. inject() on every CHAT_CHANGED) must not mutate chat state.
    // Previously this clamped and wrote all three fields unconditionally on every
    // call, so simply switching chats — no note ever touched — silently wrote to
    // chatMetadata each time. See MODULES.md's note on store `settings()`/`get()`
    // helpers for why that's the wrong default: a read that behaves like a write
    // is exactly the kind of thing an engine-level chat-changed storm guard exists
    // to catch, but it should never be needed for something this avoidable.
    const settings = () => {
        const value = metadata()[SETTINGS_KEY] ??= {};
        const nextMaxNotes = clamp(value.maxNotes, 1, 500, defaults.maxNotes);
        if (value.maxNotes !== nextMaxNotes) value.maxNotes = nextMaxNotes;
        const nextCleanupBatch = clamp(value.cleanupBatch, 1, value.maxNotes, defaults.cleanupBatch);
        if (value.cleanupBatch !== nextCleanupBatch) value.cleanupBatch = nextCleanupBatch;
        const nextInjectionDepth = clamp(value.injectionDepth, 0, 100, defaults.injectionDepth);
        if (value.injectionDepth !== nextInjectionDepth) value.injectionDepth = nextInjectionDepth;
        return value;
    };

    return {
        defaults,
        notes: () => notes().map(note => ({ ...note })),
        settings: () => ({ ...settings() }),
        setSettings(values) {
            const current = settings();
            if ('maxNotes' in values) current.maxNotes = clamp(values.maxNotes, 1, 500, defaults.maxNotes);
            if ('cleanupBatch' in values) current.cleanupBatch = clamp(values.cleanupBatch, 1, current.maxNotes, defaults.cleanupBatch);
            if ('injectionDepth' in values) current.injectionDepth = clamp(values.injectionDepth, 0, 100, defaults.injectionDepth);
            current.cleanupBatch = clamp(current.cleanupBatch, 1, current.maxNotes, defaults.cleanupBatch);
            save();
            return { ...current };
        },
        add(title, content) {
            title = String(title ?? '').trim();
            content = String(content ?? '').trim();
            if (!title || !content) throw new Error('Title and content are required.');
            const current = settings();
            let removed = 0;
            if (notes().length >= current.maxNotes) {
                removed = Math.min(notes().length, Math.max(current.cleanupBatch, notes().length + 1 - current.maxNotes));
                notes().splice(0, removed);
            }
            const note = { id: `note_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, title, content, updated: Date.now() };
            notes().push(note);
            save();
            return { ...note, removed };
        },
        update(id, title, content) {
            const note = notes().find(item => item.id === id);
            if (!note) throw new Error(`Note ${id} was not found.`);
            const nextTitle = title === undefined ? note.title : String(title ?? '').trim();
            const nextContent = content === undefined ? note.content : String(content ?? '').trim();
            if (!nextTitle || !nextContent) throw new Error('Title and content cannot be empty.');
            Object.assign(note, { title: nextTitle, content: nextContent, updated: Date.now() });
            save();
            return { ...note };
        },
        prompt() {
            const currentNotes = notes();
            if (!currentNotes.length) return '';
            return ['[Private Notebook — notes written by the assistant for its working memory.]', ...currentNotes.map(note => `- [${note.id}] ${note.title}: ${note.content}`)].join('\n');
        },
    };
}
